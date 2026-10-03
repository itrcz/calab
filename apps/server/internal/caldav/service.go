// Package caldav connects a user's own CalDAV calendar (ADR-0041 §4): discovery of its
// calendars, the import of busy time (times only) into external_busy, and the push of the
// user's Calab meetings into the chosen calendar through an outbox (caldav_pushes).
package caldav

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/unfurl"
)

// Options tune the service; zero values are the production defaults.
type Options struct {
	// AllowAddr: which resolved addresses may be dialed (nil = unfurl.PublicAddr; tests allow
	// loopback). URLs are https only.
	AllowAddr func(netip.Addr) bool
	// RootCAs trusts extra certificate authorities (tests: httptest TLS servers); nil = system.
	RootCAs *x509.CertPool
	// SyncInterval: how often an account's busy time is imported (CALDAV_SYNC_INTERVAL, 15 min).
	SyncInterval time.Duration
	// ImportPoll: how often due imports are looked for (1 min).
	ImportPoll time.Duration
	// PushPoll: how often due pushes are looked for (2 s; a change wakes the worker at once).
	PushPoll time.Duration
	// PushBackoff: the wait before attempt n+1 of a push (1, 5, 15, 60 min).
	PushBackoff func(attempt int32) time.Duration
}

// PushAttempts is how many times a push is tried.
const PushAttempts = 5

// PushBackoff is the default retry schedule of pushes.
func PushBackoff(attempt int32) time.Duration {
	steps := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}
	return steps[min(max(int(attempt), 0), len(steps)-1)]
}

// Import window (ADR-0041 §4).
const (
	importBefore  = 24 * time.Hour
	importAfter   = 30 * 24 * time.Hour
	maxBusyRows   = 5000
	importBatch   = 20
	pushBatch     = 50
	pushLease     = 2 * time.Minute
	maxPassword   = 1024
	maxUsername   = 256
	maxURL        = 2048
	maxETag       = 256
	pushLockKey   = "caldav:push:worker"
	importLockKey = "caldav:import:worker"
)

// Service serves /api/me/caldav and runs the import sweeper and the push worker.
type Service struct {
	db      *db.DB
	redis   rueidis.Client
	cal     *calendar.Service
	box     *sealbox.Box
	dav     *davClient
	opts    Options
	connect *redisx.RateLimiter // connections per user (5 per hour)
	sync    *redisx.RateLimiter // manual imports per user (1 per minute)
	// DeleteLimit: deletions of external events per user (30 per minute, ADR-0045 amendment 1);
	// nil = unlimited.
	DeleteLimit *redisx.RateLimiter
	wake        chan struct{}
	token       string
	// AllowsCalDAV tells whether the plans of the user's workspaces include CalDAV (ADR-0024,
	// 30.09); nil allows everything (plans.Service.AllowsCalDAV).
	AllowsCalDAV func(ctx context.Context, user uuid.UUID) (bool, error)
	// Now is the clock.
	Now func() time.Time
}

// New creates the service; secret is JWT_SECRET (the password key is derived from it).
func New(d *db.DB, rc rueidis.Client, cal *calendar.Service, secret []byte, o Options, connect, sync *redisx.RateLimiter) *Service {
	if o.AllowAddr == nil {
		o.AllowAddr = unfurl.PublicAddr
	}
	if o.SyncInterval <= 0 {
		o.SyncInterval = 15 * time.Minute
	}
	if o.ImportPoll <= 0 {
		o.ImportPoll = time.Minute
	}
	if o.PushPoll <= 0 {
		o.PushPoll = 2 * time.Second
	}
	if o.PushBackoff == nil {
		o.PushBackoff = PushBackoff
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &Service{db: d, redis: rc, cal: cal, box: sealbox.New("calaba/caldav/v1", secret), dav: newDAVClient(o), opts: o,
		connect: connect, sync: sync, wake: make(chan struct{}, 1), token: hex.EncodeToString(b), Now: time.Now}
}

// Routes registers /api/me/caldav.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me/caldav", wrap(httpx.HandlerFunc(s.get)))
	mux.Handle("POST /api/me/caldav", wrap(httpx.HandlerFunc(s.connectAccount)))
	mux.Handle("PUT /api/me/caldav", wrap(httpx.HandlerFunc(s.update)))
	mux.Handle("PATCH /api/me/caldav", wrap(httpx.HandlerFunc(s.setShare)))
	mux.Handle("GET /api/me/external-events", wrap(httpx.HandlerFunc(s.externalEvents)))
	mux.Handle("DELETE /api/me/external-events", wrap(httpx.HandlerFunc(s.deleteExternal)))
	mux.Handle("DELETE /api/me/caldav", wrap(httpx.HandlerFunc(s.remove)))
	mux.Handle("POST /api/me/caldav/sync", wrap(httpx.HandlerFunc(s.syncNow)))
}

// ---- secret ----

// seal binds the password to its user: a row copied to another user does not open.
func (s *Service) seal(user uuid.UUID, password string) ([]byte, error) {
	return s.box.Seal(append(user[:], password...))
}

func (s *Service) open(acc sqlc.CaldavAccount) (creds, error) {
	plain, err := s.box.Open(acc.SecretEnc)
	if err != nil || len(plain) < 16 || !bytes.Equal(plain[:16], acc.UserID[:]) {
		return creds{}, errors.New("caldav: the stored password does not open; connect again")
	}
	return creds{user: acc.Username, pass: string(plain[16:])}, nil
}

// ---- API ----

// person: the caller, a person (not a guest or a bot).
func (s *Service) person(r *http.Request) (uuid.UUID, error) {
	id := auth.MustFromContext(r.Context())
	if id.IsBot {
		return uuid.Nil, auth.ErrBotNotAllowed
	}
	u, err := s.db.Q.GetUser(r.Context(), id.UserID)
	if err != nil {
		return uuid.Nil, err
	}
	if u.IsGuest {
		return uuid.Nil, httpx.Forbidden("the calendar is not available for guests")
	}
	return id.UserID, nil
}

// allowed reports whether the user's plans include CalDAV.
func (s *Service) allowed(ctx context.Context, user uuid.UUID) (bool, error) {
	if s.AllowsCalDAV == nil {
		return true, nil
	}
	return s.AllowsCalDAV(ctx, user)
}

// paidPerson is person plus the plan check: without CalDAV in any of the user's plans the
// calls that connect, change, sync or read the calendar are refused (409 PLAN_LIMIT). Reading
// the account (get) and disconnecting (remove) stay open: nothing stored is deleted.
func (s *Service) paidPerson(r *http.Request) (uuid.UUID, error) {
	me, err := s.person(r)
	if err != nil {
		return uuid.Nil, err
	}
	ok, err := s.allowed(r.Context(), me)
	if err != nil {
		return uuid.Nil, err
	}
	if !ok {
		return uuid.Nil, plans.FeatureError("CalDAV")
	}
	return me, nil
}

func calendarsOfRow(acc sqlc.CaldavAccount) []Calendar {
	var cals []Calendar
	_ = json.Unmarshal(acc.Calendars, &cals) // written by the server only
	return cals
}

func accountProto(acc sqlc.CaldavAccount) *v1.CalDavAccount {
	out := &v1.CalDavAccount{Url: acc.Url, Username: acc.Username, Import: acc.Import, Push: acc.Push, LastError: acc.LastError,
		Calendars: []*v1.CalDavCalendar{}, ShareLevel: shareLevelProto(acc.ShareLevel)}
	if acc.CalendarHref != nil {
		out.CalendarHref = *acc.CalendarHref
	}
	if acc.LastSyncAt != nil {
		out.LastSyncAt = timestamppb.New(*acc.LastSyncAt)
	}
	for _, c := range calendarsOfRow(acc) {
		out.Calendars = append(out.Calendars, &v1.CalDavCalendar{Href: c.Href, Name: c.Name, Color: c.Color})
	}
	return out
}

func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	me, err := s.person(r)
	if err != nil {
		return err
	}
	ok, err := s.allowed(r.Context(), me)
	if err != nil {
		return err
	}
	acc, err := s.db.Q.GetCalDavAccount(r.Context(), me)
	if db.IsNotFound(err) {
		httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{PlanLocked: !ok})
		return nil
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{Account: accountProto(acc), PlanLocked: !ok})
	return nil
}

// discoverError maps a discovery failure to a field error.
func discoverError(err error) error {
	switch {
	case errors.Is(err, ErrAuth):
		return httpx.Validation("password", "the server did not accept the username and password")
	case errors.Is(err, ErrURL):
		return httpx.Validation("url", "an https address of a public CalDAV server is needed")
	case errors.Is(err, ErrRedirect):
		return httpx.Validation("url", "the server redirects elsewhere: enter the CalDAV address it points to")
	}
	var se *StatusError
	if errors.As(err, &se) {
		return httpx.Validation("url", fmt.Sprintf("no CalDAV calendars at this address (HTTP %d)", se.Status))
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return httpx.Validation("url", "the server did not answer in 10 seconds")
	}
	return httpx.Validation("url", "could not reach a CalDAV server at this address")
}

func (s *Service) connectAccount(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	var req v1.ConnectCalDavRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	raw := strings.TrimSpace(req.GetUrl())
	if len(raw) > maxURL {
		return httpx.Validation("url", "the address is too long")
	}
	u, err := CheckURL(raw, s.opts.AllowAddr)
	if err != nil {
		return httpx.Validation("url", "an https address of a public CalDAV server is needed")
	}
	user := strings.TrimSpace(req.GetUsername())
	if user == "" || utf8.RuneCountInString(user) > maxUsername {
		return httpx.Validation("username", "username is 1..256 characters")
	}
	if req.GetPassword() == "" || len(req.GetPassword()) > maxPassword {
		return httpx.Validation("password", "password is required")
	}
	if err := s.connect.Take(ctx, me.String()); err != nil {
		return err
	}
	cals, err := s.dav.Discover(ctx, u.String(), creds{user: user, pass: req.GetPassword()})
	if err != nil {
		slog.InfoContext(ctx, "caldav: discovery failed", "err", err)
		return discoverError(err)
	}
	if len(cals) == 0 {
		return httpx.Validation("url", "no event calendars found for this account")
	}
	sealed, err := s.seal(me, req.GetPassword())
	if err != nil {
		return err
	}
	calJSON, err := json.Marshal(cals)
	if err != nil {
		return err
	}
	// Connecting again (a new password) keeps the choice when the calendar is still there.
	p := sqlc.UpsertCalDavAccountParams{UserID: me, Url: u.String(), Username: user, SecretEnc: sealed, Calendars: calJSON, Import: true}
	if old, err := s.db.Q.GetCalDavAccount(ctx, me); err == nil && old.Url == u.String() && old.Username == user && old.CalendarHref != nil {
		for _, c := range cals {
			if c.Href == *old.CalendarHref {
				p.CalendarHref, p.Import, p.Push = old.CalendarHref, old.Import, old.Push
			}
		}
	}
	acc, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.CaldavAccount, error) { return guarded.UpsertCalDavAccount(ctx, p) })
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{Account: accountProto(acc)})
	return nil
}

func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	var req v1.UpdateCalDavRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	old, err := s.db.Q.GetCalDavAccount(ctx, me)
	if db.IsNotFound(err) {
		return httpx.NotFound("CalDAV account")
	}
	if err != nil {
		return err
	}
	var href *string
	if h := req.GetCalendarHref(); h != "" {
		found := false
		for _, c := range calendarsOfRow(old) {
			found = found || c.Href == h
		}
		if !found {
			return httpx.Validation("calendarHref", "not one of the calendars of this account")
		}
		href = &h
	}
	var acc sqlc.CaldavAccount
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if acc, err = q.UpdateCalDavAccount(ctx, sqlc.UpdateCalDavAccountParams{UserID: me, CalendarHref: href, Import: req.GetImport(), Push: req.GetPush()}); err != nil {
			return err
		}
		sameCal := href != nil && old.CalendarHref != nil && *href == *old.CalendarHref
		if !acc.Import || !sameCal {
			// Busy time of another calendar, or of none any more, is dropped; the import
			// sweeper fetches the new one soon (last_sync_at cleared).
			if err := q.DeleteExternalBusy(ctx, me); err != nil {
				return err
			}
			if acc, err = q.SetCalDavSynced(ctx, sqlc.SetCalDavSyncedParams{UserID: me, LastSyncAt: nil, LastError: ""}); err != nil {
				return err
			}
		}
		if !acc.Push || href == nil {
			return q.DeleteCalDavPushes(ctx, me)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if acc.Push && href != nil && (!old.Push || old.CalendarHref == nil || *old.CalendarHref != *href) {
		s.backfill(ctx, me)
	}
	httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{Account: accountProto(acc)})
	return nil
}

// backfill queues the user's current meetings when the push is turned on.
func (s *Service) backfill(ctx context.Context, user uuid.UUID) {
	ids, err := s.cal.UserEventIDs(ctx, user)
	if err != nil {
		slog.WarnContext(ctx, "caldav: backfill", "err", err)
		return
	}
	for _, id := range ids {
		if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
			return guarded.EnqueueCalDavPushes(ctx, sqlc.EnqueueCalDavPushesParams{EventID: id, Ids: []uuid.UUID{user}})
		}); err != nil {
			slog.WarnContext(ctx, "caldav: backfill", "err", err)
			return
		}
	}
	s.poke()
}

func (s *Service) remove(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.person(r)
	if err != nil {
		return err
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.DeleteCalDavAccount(ctx, me); err != nil {
			return err
		}
		if err := q.DeleteExternalBusy(ctx, me); err != nil {
			return err
		}
		return q.DeleteCalDavPushes(ctx, me)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) syncNow(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	acc, err := s.db.Q.GetCalDavAccount(ctx, me)
	if db.IsNotFound(err) {
		return httpx.NotFound("CalDAV account")
	}
	if err != nil {
		return err
	}
	if acc.CalendarHref == nil || !acc.Import {
		return httpx.Validation("calendarHref", "choose a calendar and turn the import on first")
	}
	if err := s.sync.Take(ctx, me.String()); err != nil {
		return err
	}
	if acc, err = s.Import(ctx, me); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{Account: accountProto(acc)})
	return nil
}

// ---- import ----

// Import fetches the busy time of the user's chosen calendar and replaces their
// external_busy. A failure of the server is kept in last_error (the previous busy time stays);
// only database errors are returned.
func (s *Service) Import(ctx context.Context, user uuid.UUID) (sqlc.CaldavAccount, error) {
	acc, err := s.db.Q.GetCalDavAccount(ctx, user)
	if err != nil {
		return acc, err
	}
	if acc.CalendarHref == nil || !acc.Import {
		return acc, nil
	}
	now := s.Now()
	if ok, err := s.allowed(ctx, user); err != nil {
		return acc, err
	} else if !ok {
		// Stopped, not deleted (the stored config and busy time stay). Stamped as synced, so a
		// locked account does not stay first in the due list and starve the others.
		return db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.CaldavAccount, error) {
			return guarded.SetCalDavSynced(ctx, sqlc.SetCalDavSyncedParams{UserID: user, LastSyncAt: &now, LastError: "CalDAV is not included in the plan"})
		})
	}
	busy, fetchErr := s.fetch(ctx, acc, now)
	if fetchErr != nil {
		slog.InfoContext(ctx, "caldav: import failed", "user_id", user, "err", fetchErr)
		return db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.CaldavAccount, error) {
			return guarded.SetCalDavSynced(ctx, sqlc.SetCalDavSyncedParams{UserID: user, LastSyncAt: &now, LastError: clipErr("import: " + fetchErr.Error())})
		})
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.LockCalDavAccount(ctx, user) // serializes imports of one user
		if err != nil {
			return err
		}
		if cur.CalendarHref == nil || *cur.CalendarHref != *acc.CalendarHref || !cur.Import {
			acc = cur // changed meanwhile: drop this result
			return nil
		}
		if err := q.DeleteExternalBusy(ctx, user); err != nil {
			return err
		}
		if len(busy) > 0 {
			p, err := insertParams(user, busy)
			if err != nil {
				return err
			}
			if err := q.InsertExternalBusy(ctx, p); err != nil {
				return err
			}
		}
		acc, err = q.SetCalDavSynced(ctx, sqlc.SetCalDavSyncedParams{UserID: user, LastSyncAt: &now, LastError: ""})
		return err
	})
	return acc, err
}

// insertParams: the rows of busy (the details of a series are encoded once).
func insertParams(user uuid.UUID, busy []Busy) (sqlc.InsertExternalBusyParams, error) {
	p := sqlc.InsertExternalBusyParams{UserID: user}
	enc := map[*Details]string{}
	for _, b := range busy {
		d := b.Details
		if d == nil {
			d = &Details{}
		}
		att, ok := enc[d]
		if !ok {
			list := d.Attendees
			if list == nil {
				list = []Attendee{}
			}
			raw, err := json.Marshal(list)
			if err != nil {
				return p, err
			}
			att = string(raw)
			enc[d] = att
		}
		p.Uids, p.Starts, p.Ends, p.AllDays = append(p.Uids, b.UID), append(p.Starts, b.Start), append(p.Ends, b.End), append(p.AllDays, b.AllDay)
		p.Summaries, p.Locations, p.Attendees = append(p.Summaries, d.Summary), append(p.Locations, d.Location), append(p.Attendees, att)
		p.Organizers, p.Urls = append(p.Organizers, d.Organizer), append(p.Urls, d.URL)
		p.Hrefs, p.Etags, p.Recurrings, p.WebUrls = append(p.Hrefs, b.Href), append(p.Etags, b.ETag), append(p.Recurrings, b.Recurring), append(p.WebUrls, b.WebURL)
	}
	return p, nil
}

// fetch reads the calendar's busy time of −1…+30 days in the user's zone.
func (s *Service) fetch(ctx context.Context, acc sqlc.CaldavAccount, now time.Time) ([]Busy, error) {
	cr, err := s.open(acc)
	if err != nil {
		return nil, err
	}
	loc := s.zoneOf(ctx, acc.UserID)
	from, to := now.Add(-importBefore), now.Add(importAfter)
	objs, err := s.dav.Query(ctx, *acc.CalendarHref, cr, from, to)
	if err != nil {
		return nil, err
	}
	var out []Busy
	for _, o := range objs {
		busy := BusyFromICS(o.Data, from, to, loc)
		if len(o.Href) > maxURL || len(o.ETag) > maxETag || o.ETag == "" || !InCalendar(o.Href, *acc.CalendarHref) {
			// Not deletable from Calab (no If-Match, or not an object of this calendar); still busy time.
			o.Href, o.ETag = "", ""
		}
		page := NextcloudPage(o.Href)
		for i := range busy {
			busy[i].Href, busy[i].ETag = o.Href, o.ETag
			if busy[i].WebURL == "" {
				busy[i].WebURL = page
			}
		}
		out = append(out, busy...)
		if len(out) >= maxBusyRows {
			return out[:maxBusyRows], nil
		}
	}
	return out, nil
}

func clipErr(s string) string {
	if len(s) > 300 {
		s = s[:300]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// ---- push ----

// EventChanged queues a meeting for the involved users who push (calendar.Service.Changed).
func (s *Service) EventChanged(ctx context.Context, eventID uuid.UUID, users []uuid.UUID) {
	if len(users) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	// Only users who push are asked about (identity policy checks are not free), then only
	// those the meeting's workspace policy lets the content reach (ADR-0054).
	var pushers []uuid.UUID
	for _, u := range users {
		acc, err := s.db.Q.GetCalDavAccount(ctx, u)
		if err == nil && acc.Push && acc.CalendarHref != nil {
			pushers = append(pushers, u)
		} else if err != nil && !db.IsNotFound(err) {
			slog.WarnContext(ctx, "caldav: enqueue push", "event_id", eventID, "err", err)
			return
		}
	}
	if len(pushers) == 0 {
		return
	}
	pushers, withheld, err := s.cal.PushTargets(ctx, eventID, pushers)
	if err != nil {
		slog.WarnContext(ctx, "caldav: enqueue push", "event_id", eventID, "err", err)
		return
	}
	for _, u := range withheld {
		s.withhold(ctx, u, eventID)
	}
	if len(pushers) == 0 {
		return
	}
	n, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.EnqueueCalDavPushes(ctx, sqlc.EnqueueCalDavPushesParams{EventID: eventID, Ids: pushers})
	})
	if err != nil {
		slog.WarnContext(ctx, "caldav: enqueue push", "event_id", eventID, "err", err)
		return
	}
	if n > 0 {
		s.poke()
	}
}

func (s *Service) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// ProcessPushes delivers the due pushes; it returns how many succeeded. The caller holds the
// push lock (tests call it directly).
func (s *Service) ProcessPushes(ctx context.Context) (int, error) {
	done := 0
	for range 20 {
		rows, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]sqlc.CaldavPush, error) {
			return guarded.ClaimCalDavPushes(ctx, sqlc.ClaimCalDavPushesParams{
				Lease: pgtype.Interval{Microseconds: pushLease.Microseconds(), Valid: true}, Lim: pushBatch,
			})
		})
		if err != nil {
			return done, err
		}
		for _, row := range rows {
			if s.push(ctx, row) {
				done++
			}
		}
		if len(rows) < pushBatch {
			break
		}
	}
	return done, nil
}

// push PUTs or DELETEs one meeting in the user's calendar and records the outcome.
func (s *Service) push(ctx context.Context, row sqlc.CaldavPush) bool {
	drop := func() {
		if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			return guarded.DeleteCalDavPush(ctx, sqlc.DeleteCalDavPushParams{UserID: row.UserID, EventID: row.EventID, Gen: row.Gen})
		}); err != nil {
			slog.WarnContext(ctx, "caldav: drop push", "err", err)
		}
	}
	acc, err := s.db.Q.GetCalDavAccount(ctx, row.UserID)
	if err != nil || !acc.Push || acc.CalendarHref == nil {
		drop() // disconnected or turned off meanwhile
		return false
	}
	if ok, err := s.allowed(ctx, row.UserID); err == nil && !ok {
		drop() // the plan no longer includes CalDAV: nothing is pushed
		return false
	}
	err = s.deliver(ctx, acc, row.EventID)
	if err == nil {
		drop()
		return true
	}
	if errors.Is(err, calendar.ErrWithheld) {
		// The workspace identity policy keeps the meeting in Calab for now: the earlier copy
		// is withdrawn and the push catches up later (withheld.go).
		drop()
		s.withhold(ctx, row.UserID, row.EventID)
		return false
	}
	msg := clipErr("push: " + err.Error())
	slog.InfoContext(ctx, "caldav: push failed", "user_id", row.UserID, "event_id", row.EventID, "attempt", row.Attempts+1, "err", err)
	if row.Attempts+1 >= PushAttempts {
		drop()
		if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			return guarded.SetCalDavError(ctx, sqlc.SetCalDavErrorParams{UserID: row.UserID, LastError: msg})
		}); e != nil {
			slog.WarnContext(ctx, "caldav: push error", "err", e)
		}
		return false
	}
	if e := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.RetryCalDavPush(ctx, sqlc.RetryCalDavPushParams{UserID: row.UserID, EventID: row.EventID, Gen: row.Gen,
			NextAt: s.Now().Add(s.opts.PushBackoff(row.Attempts)), Error: msg})
	}); e != nil {
		slog.WarnContext(ctx, "caldav: push retry", "err", e)
	}
	return false
}

func (s *Service) deliver(ctx context.Context, acc sqlc.CaldavAccount, eventID uuid.UUID) error {
	cr, err := s.open(acc)
	if err != nil {
		return err
	}
	ics, live, err := s.cal.EventForCalDAV(ctx, eventID, acc.UserID)
	if err != nil {
		return err
	}
	target := strings.TrimRight(*acc.CalendarHref, "/") + "/" + eventID.String() + ".ics"
	if live {
		return s.dav.Put(ctx, target, cr, ics)
	}
	return s.dav.Delete(ctx, target, cr)
}

// ---- workers ----

var lockScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`)

// lock takes or renews a cluster-wide worker lock held by this instance.
func (s *Service) lock(ctx context.Context, key string, ttl time.Duration) bool {
	n, err := lockScript.Exec(ctx, s.redis, []string{redisx.Key(key)}, []string{s.token, fmt.Sprint(ttl.Milliseconds())}).AsInt64()
	if err != nil {
		slog.WarnContext(ctx, "caldav: worker lock", "err", err)
		return false
	}
	return n == 1
}

// Run runs the push worker and the import sweeper until ctx is done; each works on one
// instance of the cluster at a time (Valkey locks).
func (s *Service) Run(ctx context.Context) {
	go s.runImports(ctx)
	t := time.NewTicker(s.opts.PushPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.wake:
		}
		if !s.lock(ctx, pushLockKey, max(3*s.opts.PushPoll, pushLease)) {
			continue
		}
		if _, err := s.ProcessPushes(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "caldav: pushes", "err", err)
		}
		if _, err := s.ProcessWithheld(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "caldav: withheld", "err", err)
		}
	}
}

func (s *Service) runImports(ctx context.Context) {
	t := time.NewTicker(s.opts.ImportPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		// One batch takes at most importBatch × 10 s; the lock outlives it.
		if !s.lock(ctx, importLockKey, max(3*s.opts.ImportPoll, importBatch*requestTimeout)) {
			continue
		}
		if _, err := s.ImportDue(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "caldav: imports", "err", err)
		}
	}
}

// ImportDue imports the accounts whose last import is older than SyncInterval.
func (s *Service) ImportDue(ctx context.Context) (int, error) {
	before := s.Now().Add(-s.opts.SyncInterval)
	ids, err := s.db.Q.ListDueCalDavImports(ctx, sqlc.ListDueCalDavImportsParams{Before: &before, Lim: importBatch})
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if _, err := s.Import(ctx, id); err != nil {
			if ctx.Err() != nil {
				return 0, err
			}
			slog.WarnContext(ctx, "caldav: import", "user_id", id, "err", err) // deleted meanwhile, …
		}
	}
	return len(ids), nil
}
