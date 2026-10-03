package caldav

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Deleting my imported event from my CalDAV calendar (ADR-0045 amendment 1). Only the account's
// own user (the route is /me and the event is looked up among their rows by uid, start and
// href); the href must be inside the chosen calendar. The provider decides about the attendees:
// an organizer's delete sends the cancellation from their calendar (RFC 6638 implicit
// scheduling), an attendee's removes it only from theirs.

// Reasons of the delete's errors (ApiError.reason).
const (
	ReasonEventChanged     = "EVENT_CHANGED"
	ReasonCalendarReadOnly = "CALENDAR_READ_ONLY"
)

func errChanged() error {
	return httpx.Conflict("the event changed in the calendar: reload").WithDetails(ReasonEventChanged, 0, 0)
}

// deleteExternal: DELETE /api/me/external-events {uid, href, start, scope}.
func (s *Service) deleteExternal(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	var req v1.DeleteExternalEventRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	scope := req.GetScope()
	switch {
	case req.GetUid() == "" || len(req.GetUid()) > 64:
		return httpx.Validation("uid", "the event's uid is required")
	case req.GetHref() == "" || len(req.GetHref()) > maxURL:
		return httpx.Validation("href", "the event's href is required")
	case req.GetStart() == nil || !req.GetStart().IsValid():
		return httpx.Validation("start", "the occurrence's start is required")
	case scope != v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_THIS && scope != v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_SERIES:
		return httpx.Validation("scope", "THIS or SERIES")
	}
	if s.DeleteLimit != nil {
		if err := s.DeleteLimit.Take(ctx, me.String()); err != nil {
			return err
		}
	}
	start := req.GetStart().AsTime()
	acc, err := s.db.Q.GetCalDavAccount(ctx, me)
	if db.IsNotFound(err) {
		return httpx.NotFound("external event")
	}
	if err != nil {
		return err
	}
	row, err := s.db.Q.GetMyExternalEvent(ctx, sqlc.GetMyExternalEventParams{UserID: me, Uid: req.GetUid(), StartsAt: start, Href: req.GetHref()})
	if db.IsNotFound(err) || (err == nil && (acc.CalendarHref == nil || !strings.HasPrefix(row.Href, *acc.CalendarHref))) {
		return httpx.NotFound("external event")
	}
	if err != nil {
		return err
	}
	cr, err := s.open(acc)
	if err != nil {
		return httpx.Validation("password", "the stored password does not open: connect the calendar again")
	}
	series := scope == v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_SERIES || !row.Recurring
	if !series {
		var whole bool
		if whole, err = s.deleteOccurrence(ctx, me, row, cr); err == nil && whole {
			series = true
		}
	} else {
		err = s.dav.DeleteIf(ctx, row.Href, cr, row.Etag)
	}
	if err != nil {
		return s.deleteError(ctx, me, err)
	}
	err = db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		if series {
			_, err := guarded.DeleteMyExternalSeries(ctx, sqlc.DeleteMyExternalSeriesParams{UserID: me, Uid: row.Uid})
			return err
		}
		_, err := guarded.DeleteMyExternalOccurrence(ctx, sqlc.DeleteMyExternalOccurrenceParams{UserID: me, Uid: row.Uid, StartsAt: row.StartsAt})
		return err
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// deleteOccurrence removes one occurrence of a series: the object read again (it must still be
// the imported version), an EXDATE added, written back with If-Match. whole: nothing would be left
// of the object, so it was deleted.
func (s *Service) deleteOccurrence(ctx context.Context, user uuid.UUID, row sqlc.ExternalBusy, cr creds) (bool, error) {
	obj, err := s.dav.Get(ctx, row.Href, cr)
	if err != nil {
		return false, err
	}
	etag := obj.ETag
	if row.Etag != "" {
		if etag != "" && !sameETag(etag, row.Etag) {
			return false, ErrChanged
		}
		etag = row.Etag
	}
	data, whole, err := excludeOccurrence(obj.Data, row.Uid, row.StartsAt, s.zoneOf(ctx, user))
	if errors.Is(err, errNoOccurrence) {
		return false, ErrChanged
	}
	if err != nil {
		return false, err
	}
	if whole {
		return true, s.dav.DeleteIf(ctx, row.Href, cr, etag)
	}
	return false, s.dav.PutIf(ctx, row.Href, cr, data, etag)
}

// deleteError maps a failure of the provider; a changed event is imported again (best effort),
// so the client's reload shows the calendar as it is.
func (s *Service) deleteError(ctx context.Context, user uuid.UUID, err error) error {
	var se *StatusError
	switch {
	case errors.Is(err, ErrChanged):
		ictx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*requestTimeout)
		defer cancel()
		if _, e := s.Import(ictx, user); e != nil {
			slog.WarnContext(ctx, "caldav: import after a conflict", "user_id", user, "err", e)
		}
		return errChanged()
	case errors.Is(err, ErrReadOnly):
		return httpx.Validation("href", "the calendar is read-only").WithDetails(ReasonCalendarReadOnly, 0, 0)
	case errors.Is(err, ErrAuth):
		return httpx.Validation("password", "the server did not accept the username and password")
	case errors.As(err, &se), errors.Is(err, ErrURL), errors.Is(err, ErrRedirect), errors.Is(err, ErrTooLarge), errors.Is(err, context.DeadlineExceeded):
		slog.InfoContext(ctx, "caldav: delete failed", "user_id", user, "err", err)
		return httpx.Unavailable(err)
	}
	return err
}

// zoneOf is the user's zone (the zone of floating times and dates of their calendar); UTC by default.
func (s *Service) zoneOf(ctx context.Context, user uuid.UUID) *time.Location {
	if u, err := s.db.Q.GetUser(ctx, user); err == nil && u.Timezone != nil {
		if l, err := time.LoadLocation(*u.Timezone); err == nil {
			return l
		}
	}
	return time.UTC
}
