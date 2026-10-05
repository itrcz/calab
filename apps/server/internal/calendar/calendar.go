// Package calendar implements the workspace calendar (ADR-0038): meetings with a voice room,
// attendees (members and external addresses), repeats, invitations by mail with invite.ics,
// answers, reminders, the room badge around a meeting and the link of a meeting's recording.
package calendar

import (
	"context"
	"errors"
	"net/http"
	"time"
	_ "time/tzdata" // IANA zones of meetings: the distroless image has no zoneinfo

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Attendee statuses (event_attendees.status).
const (
	StatusPending  = "pending"
	StatusAccepted = "accepted"
	StatusDeclined = "declined"
	StatusMaybe    = "maybe"
)

// Limits (ADR-0038 §1, «Дополнение»).
const (
	MaxTitle        = 120
	MaxDescription  = 4000
	MaxAttendees    = 100 // the organizer included
	MaxExternals    = 20
	MaxDuration     = 7 * 24 * time.Hour
	MaxListWindow   = 62 * 24 * time.Hour
	guestLinkBefore = ActiveBefore // a meeting's guest link works from 15 min before…
	guestLinkAfter  = time.Hour    // …until 1 h after the end
	seriesLinkSpan  = 90 * 24 * time.Hour
	lookAhead       = 400 * 24 * time.Hour // how far "the next occurrence" is looked for
)

// Config of the service.
type Config struct {
	PublicURL string // https://<APP_HOST>: /e/<id>, /r/<code>, RSVP links
	Secret    []byte // JWT_SECRET: the RSVP token key is derived from it
	MailFrom  string // SMTP_FROM address: the ORGANIZER of invitations of organizers without an address
}

// Service serves the calendar API and runs the reminder sweeper.
type Service struct {
	db     *db.DB
	ev     events.Publisher
	mail   *mail.Service
	cfg    Config
	key    []byte
	writes *redisx.RateLimiter // creates / changes per user
	public *redisx.RateLimiter // signed RSVP links per IP
	// Presence returns users' aggregated presence status (the gateway's); nil = unknown (no
	// DND check).
	Presence func(ctx context.Context, users []uuid.UUID) (map[uuid.UUID]v1.PresenceStatus, error)
	// Now is the clock (tests move it).
	Now func() time.Time
	// FreeBusyLimit / SuggestLimit: per-user budgets of freebusy and suggest (ADR-0041 §5);
	// nil = unlimited.
	FreeBusyLimit, SuggestLimit *redisx.RateLimiter
	// Changed is told after a meeting changed for the users involved before or after the change
	// (their CalDAV push, ADR-0041 §4); nil = nobody listens.
	Changed func(ctx context.Context, eventID uuid.UUID, users []uuid.UUID)
	// AllowsCalDAV tells whether the plans of a user's workspaces include CalDAV; the external
	// busy time of a user without it is not shown (ADR-0024, 30.09). nil = always.
	AllowsCalDAV func(ctx context.Context, user uuid.UUID) (bool, error)
	// Identity keeps meeting content inside the workspace identity policy when it leaves Calab
	// without a request (ADR-0054): the CalDAV push and the meeting mails. nil fails closed —
	// nothing is pushed and mails carry no meeting details; the app always sets it.
	Identity IdentityGate
	// EmailGate: whether adding outside attendees needs a confirmed address (ADR-0023,
	// EMAIL_VERIFICATION, ADR-0065). The zero value requires one.
	EmailGate auth.EmailGate
}

// IdentityGate is the background side of the identity policy (identitypolicy.Delivery).
type IdentityGate interface {
	Mode(ctx context.Context, ws uuid.UUID) (identitypolicy.Mode, error)
	Check(ctx context.Context, user, ws uuid.UUID) (identitypolicy.Decision, error)
}

// New creates the service. m may be disabled (no SMTP): no mail is sent then.
func New(cfg Config, d *db.DB, ev events.Publisher, m *mail.Service, writes, public *redisx.RateLimiter) *Service {
	return &Service{db: d, ev: ev, mail: m, cfg: cfg, key: tokenKey(cfg.Secret), writes: writes, public: public, Now: time.Now}
}

// Routes registers the routes; wrap applies auth + the permission resolver. The signed RSVP
// routes are public.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/events", wrap(httpx.HandlerFunc(s.list)))
	mux.Handle("POST /api/workspaces/{id}/events", wrap(httpx.HandlerFunc(s.create)))
	mux.Handle("GET /api/events/{id}", wrap(httpx.HandlerFunc(s.get)))
	mux.Handle("PATCH /api/events/{id}", wrap(httpx.HandlerFunc(s.update)))
	mux.Handle("DELETE /api/events/{id}", wrap(httpx.HandlerFunc(s.remove)))
	mux.Handle("PUT /api/events/{id}/rsvp", wrap(httpx.HandlerFunc(s.rsvp)))
	mux.Handle("GET /api/me/events/today", wrap(httpx.HandlerFunc(s.today)))
	mux.Handle("GET /api/workspaces/{id}/freebusy", wrap(httpx.HandlerFunc(s.freeBusy)))
	mux.Handle("POST /api/workspaces/{id}/freebusy/suggest", wrap(httpx.HandlerFunc(s.suggest)))
	mux.Handle("GET /api/event-rsvp", httpx.HandlerFunc(s.publicPreview))
	mux.Handle("POST /api/event-rsvp", httpx.HandlerFunc(s.publicAnswer))
}

// ---- loading ----

// bundle is an event with what its cards need.
type bundle struct {
	ev     sqlc.Event
	series Series
	att    []sqlc.EventAttendee
	recs   map[int64]uuid.UUID // occurrence start (Unix s) → recording
}

func loadZone(tz string) *time.Location {
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.UTC
}

func seriesOf(ev sqlc.Event, except []time.Time) Series {
	rule, _ := ParseRule(deref(ev.Rrule)) // written by the server only
	s := Series{Start: ev.StartsAt, End: ev.EndsAt, AllDay: ev.AllDay, Loc: loadZone(ev.Tz), Rule: rule}
	if len(except) > 0 {
		s.Except = make(map[int64]bool, len(except))
		for _, t := range except {
			s.Except[t.Unix()] = true
		}
	}
	return s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// load builds the bundles of evs (three queries whatever their number).
func load(ctx context.Context, q *sqlc.Queries, evs []sqlc.Event) ([]*bundle, error) {
	if len(evs) == 0 {
		return nil, nil
	}
	ids := make([]uuid.UUID, len(evs))
	for i, e := range evs {
		ids[i] = e.ID
	}
	att, err := q.ListEventAttendees(ctx, ids)
	if err != nil {
		return nil, err
	}
	exc, err := q.ListEventExceptions(ctx, ids)
	if err != nil {
		return nil, err
	}
	recs, err := q.ListEventRecordings(ctx, ids)
	if err != nil {
		return nil, err
	}
	byAtt := map[uuid.UUID][]sqlc.EventAttendee{}
	for _, a := range att {
		byAtt[a.EventID] = append(byAtt[a.EventID], a)
	}
	byExc := map[uuid.UUID][]time.Time{}
	for _, x := range exc {
		byExc[x.EventID] = append(byExc[x.EventID], x.OccurrenceAt)
	}
	byRec := map[uuid.UUID]map[int64]uuid.UUID{}
	for _, r := range recs {
		if byRec[r.EventID] == nil {
			byRec[r.EventID] = map[int64]uuid.UUID{}
		}
		byRec[r.EventID][r.OccurrenceAt.Unix()] = r.RecordingID
	}
	out := make([]*bundle, len(evs))
	for i, e := range evs {
		out[i] = &bundle{ev: e, series: seriesOf(e, byExc[e.ID]), att: byAtt[e.ID], recs: byRec[e.ID]}
	}
	return out, nil
}

func loadOne(ctx context.Context, q *sqlc.Queries, ev sqlc.Event) (*bundle, error) {
	bs, err := load(ctx, q, []sqlc.Event{ev})
	if err != nil {
		return nil, err
	}
	return bs[0], nil
}

// attendee returns the user's row among the event's attendees.
func (b *bundle) attendee(user uuid.UUID) (sqlc.EventAttendee, bool) {
	for _, a := range b.att {
		if a.UserID != nil && *a.UserID == user {
			return a, true
		}
	}
	return sqlc.EventAttendee{}, false
}

func (b *bundle) involves(user uuid.UUID) bool {
	_, ok := b.attendee(user)
	return ok || b.ev.OrganizerID == user
}

// ---- viewers ----

// viewer is who looks at events of one workspace: a member (not a guest) with their bits.
type viewer struct {
	user  uuid.UUID
	bot   bool
	ws    perm.Bits
	rooms map[uuid.UUID]perm.Bits // visible rooms only
}

var errGuest = httpx.Forbidden("the calendar is not available for guests")

// viewerOf resolves the member's view of a workspace: 404 for non-members, 403 for guests.
func viewerOf(ctx context.Context, q *sqlc.Queries, wsID, user uuid.UUID, bot bool) (*viewer, error) {
	m, err := perm.FromContext(ctx).Member(ctx, wsID, user)
	if errors.Is(err, perm.ErrNotMember) {
		return nil, httpx.NotFound("workspace")
	}
	if err != nil {
		return nil, err
	}
	if m.Role == perm.RoleGuest {
		return nil, errGuest
	}
	ws, err := q.GetWorkspace(ctx, wsID)
	if err != nil {
		return nil, err
	}
	bits, err := rooms.VisibleBits(ctx, q, ws, m)
	if err != nil {
		return nil, err
	}
	return &viewer{user: user, bot: bot, ws: m.Workspace(), rooms: bits}, nil
}

func requestViewer(r *http.Request, wsID uuid.UUID, q *sqlc.Queries) (*viewer, error) {
	id := auth.MustFromContext(r.Context())
	return viewerOf(r.Context(), q, wsID, id.UserID, id.IsBot)
}

// sees: the organizer, an attendee, or a viewer of the meeting's room. A bot is never an
// attendee (ADR-0051): it sees the meetings it organizes and those of the rooms it views.
func (v *viewer) sees(b *bundle) bool {
	if b.ev.OrganizerID == v.user || (b.involves(v.user) && !v.bot) {
		return true
	}
	return b.ev.RoomID != nil && v.rooms[*b.ev.RoomID].Has(perm.ViewRoom)
}

// canEdit: the organizer; else MANAGE_ROOM in the meeting's room, or MANAGE_EVENTS (ADR-0048)
// for a meeting without a room or in a room the viewer sees (ADR-0038 §2; a closed room stays
// closed). Bots by the same rules (ADR-0051).
func (v *viewer) canEdit(b *bundle) bool {
	switch {
	case b.ev.OrganizerID == v.user:
		return true
	case b.ev.RoomID != nil:
		rb := v.rooms[*b.ev.RoomID]
		return rb.Has(perm.ManageRoom) || (rb.Has(perm.ViewRoom) && v.ws.Has(perm.ManageEvents))
	}
	return v.ws.Has(perm.ManageEvents)
}

func (v *viewer) emails(b *bundle) pbconv.EmailView {
	switch {
	case v == nil:
		return pbconv.EmailsFull
	case v.canEdit(b) || (b.involves(v.user) && !v.bot):
		return pbconv.EmailsFull
	case v.bot: // ADR-0051: addresses only to a bot that may change the meeting
		return pbconv.EmailsNone
	}
	return pbconv.EmailsMasked
}

// ---- conversion ----

func statusProto(s string) v1.AttendeeStatus {
	switch s {
	case StatusPending:
		return v1.AttendeeStatus_ATTENDEE_STATUS_PENDING
	case StatusAccepted:
		return v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED
	case StatusDeclined:
		return v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED
	case StatusMaybe:
		return v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE
	}
	return v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED
}

func statusFromProto(s v1.AttendeeStatus) string {
	switch s {
	case v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED:
		return StatusAccepted
	case v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED:
		return StatusDeclined
	case v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE:
		return StatusMaybe
	}
	return ""
}

func attendeeProto(a sqlc.EventAttendee) *v1.CalendarEventAttendee {
	out := &v1.CalendarEventAttendee{Required: a.Required, Status: statusProto(a.Status)}
	if a.UserID != nil {
		out.UserId = a.UserID.String()
	}
	if a.Email != nil {
		out.Email = *a.Email
	}
	if a.RespondedAt != nil {
		out.RespondedAt = timestamppb.New(*a.RespondedAt)
	}
	return out
}

func counts(att []sqlc.EventAttendee) *v1.CalendarEventCounts {
	c := &v1.CalendarEventCounts{}
	for _, a := range att {
		switch a.Status {
		case StatusAccepted:
			c.Accepted++
		case StatusDeclined:
			c.Declined++
		case StatusMaybe:
			c.Maybe++
		default:
			c.Pending++
		}
	}
	return c
}

// proto converts b (occ = one occurrence, nil = the series) as v sees it; v nil = a gateway
// payload (all addresses: the gateway filters per recipient; no my_status / can_edit).
func (b *bundle) proto(occ *Occurrence, v *viewer) *v1.CalendarEvent {
	e := b.ev
	out := &v1.CalendarEvent{
		Id: e.ID.String(), WorkspaceId: e.WorkspaceID.String(), Title: e.Title, Description: e.Description,
		StartsAt: timestamppb.New(e.StartsAt), EndsAt: timestamppb.New(e.EndsAt), AllDay: e.AllDay, Tz: e.Tz,
		OrganizerId: e.OrganizerID.String(), Record: e.Record, Repeat: b.series.Rule.Repeat,
		Counts: counts(b.att), CreatedAt: timestamppb.New(e.CreatedAt), UpdatedAt: timestamppb.New(e.UpdatedAt),
		Sequence: uint32(max(e.Sequence, 0)), //nolint:gosec // non-negative counter
	}
	if e.RoomID != nil {
		out.RoomId = e.RoomID.String()
	}
	if u := b.series.Rule.Until; u != nil {
		out.RepeatUntil = timestamppb.New(*u)
	}
	if e.CancelledAt != nil {
		out.CancelledAt = timestamppb.New(*e.CancelledAt)
	}
	if occ != nil {
		out.StartsAt, out.EndsAt, out.OccurrenceAt = timestamppb.New(occ.Start), timestamppb.New(occ.End), timestamppb.New(occ.Start)
		if rid, ok := b.recs[occ.Start.Unix()]; ok {
			out.RecordingId = rid.String()
		}
	}
	for k := range b.series.Except {
		out.CancelledOccurrences = append(out.CancelledOccurrences, timestamppb.New(time.Unix(k, 0)))
	}
	sortTimestamps(out.CancelledOccurrences)
	externals, linked := 0, 0
	for _, a := range b.att {
		out.Attendees = append(out.Attendees, attendeeProto(a))
		if a.Email != nil {
			externals++
			if a.InviteID != nil {
				linked++
			}
		}
	}
	out.GuestLinks = e.RoomID != nil && externals > 0 && linked == externals
	if v != nil {
		if a, ok := b.attendee(v.user); ok {
			out.MyStatus = statusProto(a.Status)
		}
		out.CanEdit = v.canEdit(b)
		return pbconv.EventForViewer(out, v.emails(b))
	}
	return out
}

func sortTimestamps(ts []*timestamppb.Timestamp) {
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && ts[j].AsTime().Before(ts[j-1].AsTime()); j-- {
			ts[j], ts[j-1] = ts[j-1], ts[j]
		}
	}
}
