package calendar

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const widgetPurpose = "calab/calendar-widget/v1"
const widgetMaxEvents = 100

type widgetClaims struct {
	Session string `json:"sid"`
	jwt.RegisteredClaims
}

type widgetService struct {
	cal                   *Service
	auth                  *auth.Service
	issueLimit, readLimit *redisx.RateLimiter
	external              func(context.Context, uuid.UUID, time.Time, time.Time) ([]*v1.CalendarWidgetEvent, error)
}

// WidgetRoutes isolates background read authority from the normal API bearer middleware.
func (s *Service) WidgetRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler, a *auth.Service, issue, read *redisx.RateLimiter, external func(context.Context, uuid.UUID, time.Time, time.Time) ([]*v1.CalendarWidgetEvent, error)) {
	w := &widgetService{cal: s, auth: a, issueLimit: issue, readLimit: read, external: external}
	mux.Handle("POST /api/me/calendar-widget", wrap(httpx.HandlerFunc(w.issue)))
	mux.Handle("GET /api/calendar-widget", httpx.HandlerFunc(w.agenda))
}

func widgetKey(secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(widgetPurpose))
	return mac.Sum(nil)
}

func (w *widgetService) principal(ctx context.Context, id auth.Identity) (auth.Identity, error) {
	if id.Machine() {
		return id, httpx.Forbidden("human session required")
	}
	p, err := w.auth.ResolvePrincipal(ctx, id)
	if errors.Is(err, auth.ErrSessionRevoked) {
		return id, httpx.Unauthenticated("session invalid")
	}
	if err != nil {
		return id, httpx.Unavailable(err)
	}
	if p.Bot || p.Guest || (p.Authority != identitypolicy.LocalAccount && p.Authority != identitypolicy.WorkspaceSSO) {
		return id, httpx.Forbidden("calendar unavailable for this session")
	}
	id.Principal = p
	return id, nil
}

func (w *widgetService) issue(out http.ResponseWriter, r *http.Request) error {
	out.Header().Set("Cache-Control", "no-store")
	id, err := w.principal(r.Context(), auth.MustFromContext(r.Context()))
	if err != nil {
		return err
	}
	if w.issueLimit != nil {
		if err := w.issueLimit.Take(r.Context(), id.SessionID.String()); err != nil {
			return err
		}
	}
	now := w.cal.Now()
	expires := now.Add(30 * 24 * time.Hour)
	if id.Principal.ExpiresAt.Before(expires) {
		expires = id.Principal.ExpiresAt
	}
	claims := widgetClaims{Session: id.SessionID.String(), RegisteredClaims: jwt.RegisteredClaims{Issuer: widgetPurpose, Subject: id.UserID.String(), Audience: jwt.ClaimStrings{"calendar-widget"}, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(expires)}}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token.Header["typ"] = "calendar-widget"
	signed, err := token.SignedString(widgetKey(w.cal.cfg.Secret))
	if err != nil {
		return err
	}
	httpx.Write(out, http.StatusOK, &v1.CalendarWidgetGrant{Token: signed, ExpiresAt: timestamppb.New(expires)})
	return nil
}

func parseWidgetGrant(secret []byte, raw string, now time.Time) (auth.Identity, time.Time, error) {
	c := widgetClaims{}
	if len(raw) > 2048 {
		return auth.Identity{}, time.Time{}, auth.ErrInvalidToken
	}
	t, err := jwt.ParseWithClaims(raw, &c, func(t *jwt.Token) (any, error) {
		if t.Header["typ"] != "calendar-widget" {
			return nil, auth.ErrInvalidToken
		}
		return widgetKey(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(widgetPurpose), jwt.WithAudience("calendar-widget"), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(func() time.Time { return now }))
	if err != nil || !t.Valid || c.IssuedAt == nil || c.ExpiresAt.Sub(c.IssuedAt.Time) > 30*24*time.Hour {
		return auth.Identity{}, time.Time{}, auth.ErrInvalidToken
	}
	user, e1 := uuid.Parse(c.Subject)
	session, e2 := uuid.Parse(c.Session)
	if e1 != nil || e2 != nil || user == uuid.Nil || session == uuid.Nil {
		return auth.Identity{}, time.Time{}, auth.ErrInvalidToken
	}
	return auth.Identity{UserID: user, SessionID: session}, c.ExpiresAt.Time, nil
}

func (w *widgetService) agenda(out http.ResponseWriter, r *http.Request) error {
	out.Header().Set("Cache-Control", "no-store")
	bounded, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(bounded)
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return httpx.Unauthenticated("widget grant required")
	}
	now := w.cal.Now()
	id, expiry, err := parseWidgetGrant(w.cal.cfg.Secret, raw, now)
	if err != nil {
		return httpx.Unauthenticated("invalid widget grant")
	}
	id, err = w.principal(r.Context(), id)
	if err != nil {
		return err
	}
	if w.readLimit != nil {
		if err := w.readLimit.Take(r.Context(), id.SessionID.String()); err != nil {
			return err
		}
	}
	tz := r.URL.Query().Get("tz")
	loc, err := time.LoadLocation(tz)
	if tz == "" || err != nil {
		return httpx.Validation("tz", "an IANA time zone is required")
	}
	y, m, d := now.In(loc).Date()
	from := time.Date(y, m, d, 0, 0, 0, 0, loc)
	to := from.AddDate(0, 0, 7)
	ctx := auth.WithIdentity(r.Context(), id)
	ctx = perm.WithResolver(ctx, w.cal.db.Q)
	ctx = w.auth.WithPolicy(ctx, id, identitypolicy.WorkspaceRead)
	events, err := w.cal.widgetMeetings(ctx, id, from, to)
	if err != nil {
		return err
	}
	if id.Principal.Authority == identitypolicy.LocalAccount && w.external != nil {
		if err := w.auth.CheckGlobal(ctx, id, identitypolicy.GlobalRead); err != nil {
			return err
		}
		external, err := w.external(ctx, id.UserID, from.AddDate(0, 0, -1), to.AddDate(0, 0, 1))
		if err != nil {
			return err
		}
		events = append(events, external...)
	}
	// Filter after all-day projection: source dates remain dates when the device changes zones.
	visible := events[:0]
	seen := make(map[string]bool, len(events))
	for _, e := range events {
		if e.AllDay {
			a, e1 := time.ParseInLocation(time.DateOnly, e.StartDate, loc)
			b, e2 := time.ParseInLocation(time.DateOnly, e.EndDate, loc)
			if e1 != nil || e2 != nil || !b.After(a) {
				continue
			}
			e.StartsAt = timestamppb.New(a)
			e.EndsAt = timestamppb.New(b)
		}
		if e.StartsAt.AsTime().Before(to) && e.EndsAt.AsTime().After(from) && !seen[e.Key] {
			seen[e.Key] = true
			visible = append(visible, e)
		}
	}
	sort.Slice(visible, func(i, j int) bool {
		a, b := visible[i], visible[j]
		if a.StartsAt.AsTime().Equal(b.StartsAt.AsTime()) {
			return a.Key < b.Key
		}
		return a.StartsAt.AsTime().Before(b.StartsAt.AsTime())
	})
	complete := to
	if len(visible) > widgetMaxEvents {
		complete = visible[widgetMaxEvents].StartsAt.AsTime()
		if complete.Before(from) {
			complete = from
		}
		visible = visible[:widgetMaxEvents]
	}
	valid := to
	if expiry.Before(valid) {
		valid = expiry
	}
	if id.Principal.ExpiresAt.Before(valid) {
		valid = id.Principal.ExpiresAt
	}
	httpx.Write(out, http.StatusOK, &v1.CalendarWidgetAgenda{Version: 1, GeneratedAt: timestamppb.New(now), ValidUntil: timestamppb.New(valid), From: timestamppb.New(from), To: timestamppb.New(to), Timezone: tz, Events: visible, CompleteUntil: timestamppb.New(complete)})
	return nil
}

func (s *Service) widgetMeetings(ctx context.Context, id auth.Identity, from, to time.Time) ([]*v1.CalendarWidgetEvent, error) {
	// The same own-only query and recurrence engine as today(); broaden a day for DATE events.
	start, end := from.AddDate(0, 0, -1), to.AddDate(0, 0, 1)
	evs, err := s.db.Q.ListWidgetEvents(ctx, sqlc.ListWidgetEventsParams{UserID: id.UserID, From: start, To: end})
	if err != nil {
		return nil, err
	}
	if len(evs) > 1000 {
		return nil, httpx.Unavailable(errors.New("calendar widget candidate limit"))
	}
	bundles, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return nil, err
	}
	result := make([]*v1.CalendarWidgetEvent, 0)
	views := map[uuid.UUID]*viewer{}
	for _, b := range bundles {
		v, checked := views[b.ev.WorkspaceID]
		if !checked {
			v, err = viewerOf(ctx, s.db.Q, b.ev.WorkspaceID, id.UserID, false)
			if err != nil {
				if httpx.AsError(err).Status >= 500 {
					return nil, err
				}
				v = nil
			}
			views[b.ev.WorkspaceID] = v
		}
		if v == nil {
			continue
		}
		if a, ok := b.attendee(id.UserID); ok && a.Status == StatusDeclined {
			continue
		}
		for _, o := range b.series.Between(start, end) {
			e := &v1.CalendarWidgetEvent{Key: b.ev.ID.String() + "@" + o.Start.UTC().Format(time.RFC3339), EventId: b.ev.ID.String(), WorkspaceId: b.ev.WorkspaceID.String(), Title: b.ev.Title, OccurrenceAt: timestamppb.New(o.Start), StartsAt: timestamppb.New(o.Start), EndsAt: timestamppb.New(o.End), AllDay: b.ev.AllDay, Color: "#8B7CF8", Source: "calab"}
			if e.AllDay {
				e.StartDate = o.Start.In(b.series.Loc).Format(time.DateOnly)
				e.EndDate = o.End.In(b.series.Loc).Format(time.DateOnly)
			}
			result = append(result, e)
		}
	}
	return result, nil
}
