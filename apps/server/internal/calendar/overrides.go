package calendar

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
)

// One occurrence or the following ones of a series (ADR-0157, board #147).
//
// «Только эту» makes the occurrence an override: an ordinary one-off meeting row that names its
// series and the occurrence it replaces (events.series_id / recurrence_at = RECURRENCE-ID). Every
// expansion path (lists, reminders, room badges, free/busy, widgets) sees it as a meeting of its
// own and the series skips the occurrence; exports and mails write it under the series' UID with
// RECURRENCE-ID, so mail and CalDAV calendars update that one occurrence.
//
// «Всю серию» (this and the following) splits the series: the old one ends before the
// occurrence (UNTIL), a new series starts there with the change. Cancelled and overridden
// occurrences after the split move to the new series when it repeats the same way (at the same
// place of the new rhythm); with another repeat the cancellations go and the overrides stay as
// meetings of their own.

// errNotOccurrence: the request names no live occurrence of the series.
var errNotOccurrence = httpx.Validation("occurrenceAt", "not a live occurrence of this series")

// liveOccurrence returns the occurrence of the series starting at `at`, unless it is cancelled
// or overridden.
func (b *bundle) liveOccurrence(at time.Time) (Occurrence, bool) {
	if b.series.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED || b.series.Except[at.Unix()] {
		return Occurrence{}, false
	}
	for _, o := range b.series.Between(at, at.Add(time.Second)) {
		if o.Start.Equal(at) {
			return o, true
		}
	}
	return Occurrence{}, false
}

// pushID is the meeting a change is pushed to CalDAV as: an override lives in its series'
// resource (one UID per resource, RFC 4791).
func pushID(ev sqlc.Event) uuid.UUID {
	if ev.SeriesID != nil {
		return *ev.SeriesID
	}
	return ev.ID
}

// icsIdentity is how a meeting is named in invite.ics: its UID and, for one occurrence of a
// series, the RECURRENCE-ID in the value type of the series' DTSTART.
type icsIdentity struct {
	uid      string
	instance time.Time // zero = the whole meeting / series
	allDay   bool
	loc      *time.Location
}

// identity of b: an override is the occurrence of its series; b.inst (a cancelled occurrence of
// a series, mailed alone) wins.
func (s *Service) identity(ctx context.Context, b *bundle) icsIdentity {
	if b.inst != nil {
		return *b.inst
	}
	if b.ev.SeriesID == nil || b.ev.RecurrenceAt == nil {
		return icsIdentity{uid: b.ev.ID.String() + "@calab"}
	}
	id := icsIdentity{uid: b.ev.SeriesID.String() + "@calab", instance: *b.ev.RecurrenceAt, loc: loadZone(b.ev.Tz)}
	if master, err := s.db.Q.GetEvent(ctx, *b.ev.SeriesID); err == nil {
		id.allDay, id.loc = master.AllDay, loadZone(master.Tz)
	} else {
		logErr(ctx, "override: series", err)
	}
	return id
}

// occurrenceBundle is the series b reduced to its occurrence o for a mail about o alone (a
// cancelled occurrence: CANCEL with RECURRENCE-ID).
func occurrenceBundle(b *bundle, o Occurrence) *bundle {
	one := *b
	one.series = Series{Start: o.Start, End: o.End, AllDay: b.series.AllDay, Loc: b.series.Loc}
	one.inst = &icsIdentity{uid: b.ev.ID.String() + "@calab", instance: o.Start, allDay: b.series.AllDay, loc: b.series.Loc}
	return &one
}

// shiftOccurrence maps an occurrence start t of a series whose occurrence `from` becomes `to`
// (a split or a moved series): the same number of calendar days after it, at to's wall-clock
// time in toLoc (an all-day series: midnight).
func shiftOccurrence(t, from, to time.Time, fromLoc, toLoc *time.Location, allDay bool) time.Time {
	days := civilDay(to.In(toLoc)) - civilDay(from.In(fromLoc))
	lt, lto := t.In(fromLoc), to.In(toLoc)
	h, m, sec := lto.Clock()
	if allDay {
		h, m, sec = 0, 0, 0
	}
	return time.Date(lt.Year(), lt.Month(), lt.Day()+days, h, m, sec, 0, toLoc).UTC()
}

// attendeeChange is what a scoped change does to the attendees copied from the series.
type attendeeChange struct {
	set  bool
	want []wantAttendee
}

// copyAttendees gives the new meeting `id` the attendees of src with their answers (a change of
// the list keeps those who stay, with the new required flags; new ones are pending). It returns
// the rows of src left out and the keys of the added ones.
func (s *Service) copyAttendees(ctx context.Context, q *sqlc.Queries, v *viewer, organizer, id uuid.UUID, src []sqlc.EventAttendee, ch attendeeChange) (removed []sqlc.EventAttendee, added map[string]bool, err error) {
	keep := map[string]wantAttendee{}
	for _, a := range ch.want {
		keep[a.key()] = a
	}
	have := map[string]bool{}
	for _, a := range src {
		k := attendeeKey(a)
		have[k] = true
		w := wantAttendee{user: a.UserID, email: deref(a.Email), required: a.Required}
		if ch.set {
			wa, ok := keep[k]
			if !ok {
				removed = append(removed, a)
				continue
			}
			w.required = wa.required
		}
		if err := insertAttendee(ctx, q, id, w, a.Status, a.RespondedAt); err != nil {
			return nil, nil, err
		}
	}
	added = map[string]bool{}
	var addWant []wantAttendee
	for _, a := range ch.want {
		if ch.set && !have[a.key()] {
			addWant = append(addWant, a)
		}
	}
	if hasExternals(addWant) {
		// ADR-0051: a bot adds outside addresses only to the meetings it organizes.
		if v.bot && organizer != v.user {
			return nil, nil, httpx.Forbidden("a bot adds outside addresses only to the meetings it organizes")
		}
		if _, err := s.EmailGate.User(ctx, q, v.user); err != nil {
			return nil, nil, err
		}
	}
	for _, a := range addWant {
		if err := insertAttendee(ctx, q, id, a, StatusPending, nil); err != nil {
			return nil, nil, err
		}
		added[a.key()] = true
	}
	return removed, added, nil
}

func addedRows(b *bundle, keys map[string]bool) []sqlc.EventAttendee {
	var out []sqlc.EventAttendee
	for _, a := range b.att {
		if keys[attendeeKey(a)] {
			out = append(out, a)
		}
	}
	return out
}

// scopedChange is a validated PATCH of one occurrence (THIS) or of it and the following ones
// (FOLLOWING): f holds the occurrence's new values, occ the occurrence as it was.
type scopedChange struct {
	scope v1.EventScope
	occ   Occurrence
	f     fields
	att   attendeeChange
}

// significantFor: a change the attendees are mailed about (time, room, title, description,
// repeat), against the occurrence as it was.
func (c scopedChange) significantFor(b *bundle) bool {
	e := b.ev
	return !c.f.start.Equal(c.occ.Start) || !c.f.end.Equal(c.occ.End) || c.f.allDay != e.AllDay || c.f.tz != e.Tz ||
		!sameRoom(c.f.room, e.RoomID) || c.f.title != e.Title || c.f.desc != e.Description ||
		(c.scope == v1.EventScope_EVENT_SCOPE_FOLLOWING && c.f.rule.String() != b.series.Rule.String())
}

// updateOccurrence: PATCH with scope THIS — the occurrence becomes an override of the series.
func (s *Service) updateOccurrence(w http.ResponseWriter, r *http.Request, before *bundle, v *viewer, c scopedChange) error {
	ctx := r.Context()
	var series, ov *bundle
	var removed []sqlc.EventAttendee
	var added map[string]bool
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetEventForUpdate(ctx, before.ev.ID)
		if db.IsNotFound(err) {
			return httpx.NotFound("event")
		}
		if err != nil {
			return err
		}
		curB, err := loadOne(ctx, q, cur)
		if err != nil {
			return err
		}
		if _, ok := curB.liveOccurrence(c.occ.Start); !ok {
			return errNotOccurrence
		}
		end := c.f.end
		row, err := q.InsertEventOverride(ctx, sqlc.InsertEventOverrideParams{
			WorkspaceID: cur.WorkspaceID, RoomID: c.f.room, Title: c.f.title, Description: c.f.desc, StartsAt: c.f.start, EndsAt: c.f.end,
			AllDay: c.f.allDay, Tz: c.f.tz, OrganizerID: cur.OrganizerID, Record: c.f.record, UntilAt: &end,
			Sequence: cur.Sequence + 1, SeriesID: &cur.ID, RecurrenceAt: &c.occ.Start,
		})
		if err != nil {
			return err
		}
		if removed, added, err = s.copyAttendees(ctx, q, v, cur.OrganizerID, row.ID, curB.att, c.att); err != nil {
			return err
		}
		if ov, err = loadOne(ctx, q, row); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, ov, true, true); err != nil {
			return err
		}
		if ov, err = loadOne(ctx, q, row); err != nil {
			return err
		}
		series, err = loadOne(ctx, q, cur)
		return err
	})
	if err != nil {
		return err
	}
	wsID := series.ev.WorkspaceID
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: series.proto(nil, nil)}}})
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: ov.proto(nil, nil)}}})
	s.roomSignals(ctx, before, series)
	s.roomSignals(ctx, nil, ov)
	// Only the occurrence's attendees, only about it (RECURRENCE-ID): the series is untouched.
	newbies := addedRows(ov, added)
	if c.significantFor(before) {
		s.sendMails(ctx, ov, mail.TemplateEventUpdate, MethodRequest, without(ov.att, newbies))
	}
	s.sendMails(ctx, ov, mail.TemplateEventInvite, MethodRequest, newbies)
	if len(removed) > 0 {
		gone := *ov
		gone.att = removed
		s.sendMails(ctx, &gone, mail.TemplateEventCancel, MethodCancel, removed)
	}
	s.changed(ctx, before, ov)
	httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: ov.proto(nil, v)})
	return nil
}

// splitSeries: PATCH with scope FOLLOWING (not from the first occurrence) — the series ends
// before the occurrence, a new series starts there with the change.
func (s *Service) splitSeries(w http.ResponseWriter, r *http.Request, before *bundle, v *viewer, c scopedChange) error {
	ctx := r.Context()
	var old, next *bundle
	var removed []sqlc.EventAttendee
	var added map[string]bool
	var moved []uuid.UUID // overrides that changed series or became meetings of their own
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetEventForUpdate(ctx, before.ev.ID)
		if db.IsNotFound(err) {
			return httpx.NotFound("event")
		}
		if err != nil {
			return err
		}
		curB, err := loadOne(ctx, q, cur)
		if err != nil {
			return err
		}
		if _, ok := curB.liveOccurrence(c.occ.Start); !ok || c.occ.Start.Equal(cur.StartsAt) {
			return errNotOccurrence
		}
		// The old series: its last occurrence is the one before.
		of := fromFields(cur)
		until := c.occ.Start.Add(-time.Second)
		of.rule.Until = &until
		oldEv, err := q.UpdateEvent(ctx, sqlc.UpdateEventParams{
			ID: cur.ID, RoomID: of.room, Title: of.title, Description: of.desc, StartsAt: of.start, EndsAt: of.end, AllDay: of.allDay,
			Tz: of.tz, Record: of.record, Rrule: rrulePtr(of.rule), UntilAt: of.series().UntilAt(), Bump: 1, TempRoom: false,
		})
		if err != nil {
			return err
		}
		nf := c.f
		row, err := q.InsertEvent(ctx, sqlc.InsertEventParams{
			WorkspaceID: cur.WorkspaceID, RoomID: nf.room, Title: nf.title, Description: nf.desc, StartsAt: nf.start, EndsAt: nf.end,
			AllDay: nf.allDay, Tz: nf.tz, OrganizerID: cur.OrganizerID, Record: nf.record, Rrule: rrulePtr(nf.rule),
			UntilAt: nf.series().UntilAt(),
		})
		if err != nil {
			return err
		}
		if removed, added, err = s.copyAttendees(ctx, q, v, cur.OrganizerID, row.ID, curB.att, c.att); err != nil {
			return err
		}
		// Cancelled and overridden occurrences from the split on follow the new series.
		same := nf.rule.Repeat == of.rule.Repeat && nf.rule.Holidays == of.rule.Holidays
		ns := nf.series()
		oldLoc, newLoc := loadZone(cur.Tz), loadZone(nf.tz)
		shift := func(t time.Time) (time.Time, bool) {
			if !same {
				return time.Time{}, false
			}
			nt := shiftOccurrence(t, c.occ.Start, nf.start, oldLoc, newLoc, nf.allDay)
			return nt, ns.IsOccurrence(nt)
		}
		from := c.occ.Start
		for k := range curB.series.Except {
			t := time.Unix(k, 0).UTC()
			if curB.series.Moved[k] || t.Before(from) {
				continue
			}
			if nt, ok := shift(t); ok {
				if _, err := q.InsertEventException(ctx, sqlc.InsertEventExceptionParams{EventID: row.ID, OccurrenceAt: nt}); err != nil {
					return err
				}
			}
		}
		if err := q.DeleteEventExceptions(ctx, sqlc.DeleteEventExceptionsParams{EventID: cur.ID, From: &from}); err != nil {
			return err
		}
		ovs, err := q.ListEventOverrides(ctx, []uuid.UUID{cur.ID})
		if err != nil {
			return err
		}
		for _, o := range ovs {
			if o.RecurrenceAt.Before(from) {
				continue
			}
			p := sqlc.SetEventOverrideOfParams{ID: o.ID}
			if nt, ok := shift(*o.RecurrenceAt); ok {
				p.SeriesID, p.RecurrenceAt = &row.ID, &nt
			}
			if err := q.SetEventOverrideOf(ctx, p); err != nil {
				return err
			}
			moved = append(moved, o.ID)
		}
		if old, err = loadOne(ctx, q, oldEv); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, old, false, true); err != nil {
			return err
		}
		if next, err = loadOne(ctx, q, row); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, next, true, true); err != nil {
			return err
		}
		if old, err = loadOne(ctx, q, oldEv); err != nil {
			return err
		}
		next, err = loadOne(ctx, q, row)
		return err
	})
	if err != nil {
		return err
	}
	wsID := old.ev.WorkspaceID
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: old.proto(nil, nil)}}})
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: next.proto(nil, nil)}}})
	s.publishMoved(ctx, moved)
	s.roomSignals(ctx, before, old)
	s.roomSignals(ctx, nil, next)
	// The old series' attendees learn it ends (UNTIL); the new series is mailed as a meeting of
	// its own (its own UID) to everyone on it.
	s.sendMails(ctx, old, mail.TemplateEventUpdate, MethodRequest, old.att)
	newbies := addedRows(next, added)
	s.sendMails(ctx, next, mail.TemplateEventUpdate, MethodRequest, without(next.att, newbies))
	s.sendMails(ctx, next, mail.TemplateEventInvite, MethodRequest, newbies)
	_ = removed // they keep the past occurrences of the old series, which the update above ends
	s.changed(ctx, before, old)
	s.changed(ctx, next)
	httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: next.proto(nil, v)})
	return nil
}

// publishMoved sends EVENT_UPDATE of overrides that changed series (their series_id).
func (s *Service) publishMoved(ctx context.Context, ids []uuid.UUID) {
	if len(ids) == 0 {
		return
	}
	evs, err := s.db.Q.ListEventsByIDs(ctx, ids)
	if err != nil {
		logErr(ctx, "overrides: reload", err)
		return
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		logErr(ctx, "overrides: reload", err)
		return
	}
	for _, b := range bs {
		s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: b.proto(nil, nil)}}})
	}
}

// followOverrides keeps the cancellations and overrides of a series changed as a whole on their
// occurrences: a new start moves them by as many days and to the new clock time; with another
// repeat the overrides become meetings of their own. Called in the PATCH transaction.
func followOverrides(ctx context.Context, q *sqlc.Queries, before *bundle, f fields) ([]uuid.UUID, error) {
	old := before.series
	if old.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED || len(old.Except) == 0 {
		return nil, nil
	}
	ns := f.series()
	same := f.rule.Repeat == old.Rule.Repeat && f.rule.Holidays == old.Rule.Holidays
	oldLoc, newLoc := old.Loc, loadZone(f.tz)
	if same && old.Start.Equal(ns.Start) && oldLoc.String() == newLoc.String() && old.AllDay == f.allDay {
		return nil, nil
	}
	shift := func(t time.Time) (time.Time, bool) {
		if !same {
			return time.Time{}, false
		}
		nt := shiftOccurrence(t, old.Start, ns.Start, oldLoc, newLoc, f.allDay)
		return nt, ns.IsOccurrence(nt)
	}
	var cancelled []time.Time
	for k := range old.Except {
		if !old.Moved[k] {
			cancelled = append(cancelled, time.Unix(k, 0).UTC())
		}
	}
	if same && len(cancelled) > 0 {
		if err := q.DeleteEventExceptions(ctx, sqlc.DeleteEventExceptionsParams{EventID: before.ev.ID}); err != nil {
			return nil, err
		}
		for _, t := range cancelled {
			if nt, ok := shift(t); ok {
				if _, err := q.InsertEventException(ctx, sqlc.InsertEventExceptionParams{EventID: before.ev.ID, OccurrenceAt: nt}); err != nil {
					return nil, err
				}
			}
		}
	}
	if len(old.Moved) == 0 {
		return nil, nil
	}
	ovs, err := q.ListEventOverrides(ctx, []uuid.UUID{before.ev.ID})
	if err != nil {
		return nil, err
	}
	// The index (series_id, recurrence_at) is checked row by row: move the farthest first in
	// the direction of the shift.
	if len(ovs) > 1 && ns.Start.After(old.Start) {
		slices.Reverse(ovs)
	}
	var moved []uuid.UUID
	for _, o := range ovs {
		p := sqlc.SetEventOverrideOfParams{ID: o.ID}
		if nt, ok := shift(*o.RecurrenceAt); ok {
			p.SeriesID, p.RecurrenceAt = &before.ev.ID, &nt
		}
		if err := q.SetEventOverrideOf(ctx, p); err != nil {
			return nil, err
		}
		moved = append(moved, o.ID)
	}
	return moved, nil
}

// removeOccurrence: DELETE ?occurrence= (scope THIS) — that occurrence of the series is
// cancelled; its attendees get a CANCEL of it alone (RECURRENCE-ID).
func (s *Service) removeOccurrence(ctx context.Context, before *bundle, occ Occurrence) error {
	var after *bundle
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.GetEventForUpdate(ctx, before.ev.ID); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("event")
			}
			return err
		}
		n, err := q.InsertEventException(ctx, sqlc.InsertEventExceptionParams{EventID: before.ev.ID, OccurrenceAt: occ.Start})
		if err != nil || n == 0 {
			return err
		}
		ev, err := q.BumpEventSequence(ctx, before.ev.ID)
		if err != nil {
			return err
		}
		after, err = loadOne(ctx, q, ev)
		return err
	})
	if err != nil || after == nil {
		return err
	}
	s.ev.Workspace(ctx, after.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: after.proto(nil, nil)}}})
	s.roomSignals(ctx, before, after)
	one := occurrenceBundle(after, occ)
	s.sendMails(ctx, one, mail.TemplateEventCancel, MethodCancel, one.att)
	s.changed(ctx, after)
	return nil
}

// removeFollowing: DELETE ?occurrence=&scope=following (not the first occurrence) — the series
// ends before it; overrides from it on are cancelled with it.
func (s *Service) removeFollowing(ctx context.Context, before *bundle, occ Occurrence) error {
	var after *bundle
	var gone []sqlc.Event
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetEventForUpdate(ctx, before.ev.ID)
		if db.IsNotFound(err) {
			return httpx.NotFound("event")
		}
		if err != nil {
			return err
		}
		f := fromFields(cur)
		until := occ.Start.Add(-time.Second)
		f.rule.Until = &until
		ev, err := q.UpdateEvent(ctx, sqlc.UpdateEventParams{
			ID: cur.ID, RoomID: f.room, Title: f.title, Description: f.desc, StartsAt: f.start, EndsAt: f.end, AllDay: f.allDay,
			Tz: f.tz, Record: f.record, Rrule: rrulePtr(f.rule), UntilAt: f.series().UntilAt(), Bump: 1, TempRoom: false,
		})
		if err != nil {
			return err
		}
		from := occ.Start
		if err := q.DeleteEventExceptions(ctx, sqlc.DeleteEventExceptionsParams{EventID: cur.ID, From: &from}); err != nil {
			return err
		}
		if gone, err = q.CancelSeriesOverrides(ctx, sqlc.CancelSeriesOverridesParams{SeriesID: &cur.ID, From: &from}); err != nil {
			return err
		}
		for _, g := range gone {
			if err := q.RevokeEventRoomInvites(ctx, sqlc.RevokeEventRoomInvitesParams{EventID: &g.ID}); err != nil {
				return err
			}
		}
		if after, err = loadOne(ctx, q, ev); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, after, false, true); err != nil {
			return err
		}
		after, err = loadOne(ctx, q, ev)
		return err
	})
	if err != nil {
		return err
	}
	wsID := after.ev.WorkspaceID
	goneB := s.publishCancelled(ctx, gone)
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: after.proto(nil, nil)}}})
	s.roomSignals(ctx, before, after)
	s.sendMails(ctx, after, mail.TemplateEventUpdate, MethodRequest, after.att)
	s.mailOverrideOnly(ctx, after, goneB)
	s.changed(ctx, append([]*bundle{before, after}, goneB...)...)
	return nil
}

// publishCancelled sends EVENT_DELETE of overrides cancelled with their series (or its end) and
// returns their bundles: the series' mail covers them for its attendees, mailOverrideOnly the rest.
func (s *Service) publishCancelled(ctx context.Context, evs []sqlc.Event) []*bundle {
	if len(evs) == 0 {
		return nil
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		logErr(ctx, "overrides: cancelled", err)
		return nil
	}
	for _, b := range bs {
		s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: b.proto(nil, nil)}}})
		s.roomSignals(ctx, b, nil)
	}
	return bs
}

// mailOverrideOnly: the series' CANCEL / REQUEST reaches its attendees, not those invited to an
// override alone — they get a CANCEL of that occurrence (RECURRENCE-ID) instead.
func (s *Service) mailOverrideOnly(ctx context.Context, series *bundle, gone []*bundle) {
	for _, g := range gone {
		if only := without(g.att, series.att); len(only) > 0 {
			s.sendMails(ctx, g, mail.TemplateEventCancel, MethodCancel, only)
		}
	}
}

// scopeOf reads the scope of a DELETE (?scope=following; else that occurrence only).
func scopeOf(r *http.Request) v1.EventScope {
	if r.URL.Query().Get("scope") == "following" {
		return v1.EventScope_EVENT_SCOPE_FOLLOWING
	}
	return v1.EventScope_EVENT_SCOPE_THIS
}

// loadOverrides returns the live overrides of the series, by series.
func loadOverrides(ctx context.Context, q *sqlc.Queries, series []uuid.UUID) (map[uuid.UUID][]*bundle, error) {
	if len(series) == 0 {
		return nil, nil
	}
	rows, err := q.ListEventOverrides(ctx, series)
	if err != nil {
		return nil, err
	}
	bs, err := load(ctx, q, rows)
	if err != nil {
		return nil, err
	}
	out := map[uuid.UUID][]*bundle{}
	for _, o := range bs {
		out[*o.ev.SeriesID] = append(out[*o.ev.SeriesID], o)
	}
	return out, nil
}

// seriesExport writes series b (when in) with the overrides ovs under its UID (RECURRENCE-ID):
// one ICSEvent holding the rest in Overrides. An override left out of ovs (declined by the
// reader) is an EXDATE of the series instead. Without the series the overrides stand alone
// (RFC 5545 allows instances without their master). conv renders one meeting.
func seriesExport(b *bundle, in bool, ovs []*bundle, conv func(*bundle) ICSEvent) (ICSEvent, bool) {
	uid := b.ev.ID.String() + "@calab"
	parts := make([]ICSEvent, 0, len(ovs))
	moved := make(map[int64]bool, len(ovs))
	for _, o := range ovs {
		e := conv(o)
		e.UID, e.Instance, e.InstanceAllDay, e.InstanceLoc = uid, *o.ev.RecurrenceAt, b.ev.AllDay, b.series.Loc
		parts = append(parts, e)
		moved[o.ev.RecurrenceAt.Unix()] = true
	}
	if !in {
		if len(parts) == 0 {
			return ICSEvent{}, false
		}
		first := parts[0]
		first.Overrides = parts[1:]
		return first, true
	}
	m := conv(b)
	m.Series.Moved = moved
	m.Overrides = parts
	return m, true
}
