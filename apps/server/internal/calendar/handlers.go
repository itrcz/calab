package calendar

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// occurrenceRow is one occurrence of a list, for sorting.
type occurrenceRow struct {
	b   *bundle
	occ Occurrence
}

func sortRows(rows []occurrenceRow) {
	slices.SortStableFunc(rows, func(a, b occurrenceRow) int {
		if c := a.occ.Start.Compare(b.occ.Start); c != 0 {
			return c
		}
		return a.occ.End.Compare(b.occ.End)
	})
}

// list: GET /api/workspaces/{id}/events?from&to.
func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	v, err := requestViewer(r, wsID, s.db.Q)
	if err != nil {
		return err
	}
	from, err1 := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	to, err2 := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if err1 != nil || err2 != nil {
		return httpx.Validation("from", "from and to are RFC 3339 times")
	}
	if !to.After(from) || to.Sub(from) > MaxListWindow {
		return httpx.Validation("to", "to must be after from, at most 62 days later")
	}
	evs, err := s.db.Q.ListWorkspaceEvents(ctx, sqlc.ListWorkspaceEventsParams{WorkspaceID: wsID, From: &from, To: to})
	if err != nil {
		return err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return err
	}
	var rows []occurrenceRow
	for _, b := range bs {
		if !v.sees(b) {
			continue
		}
		for _, o := range b.series.Between(from, to) {
			rows = append(rows, occurrenceRow{b, o})
		}
	}
	sortRows(rows)
	out := &v1.ListCalendarEventsResponse{Events: make([]*v1.CalendarEvent, 0, len(rows))}
	for _, row := range rows {
		out.Events = append(out.Events, row.b.proto(&row.occ, v))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// event loads the event of the path for the caller: 404 when it does not exist or they cannot
// see it. A guest of the workspace who can view the event's room gets the bundle with
// errGuest (403 unless the caller serves them, see get).
func (s *Service) event(r *http.Request, q *sqlc.Queries) (*bundle, *viewer, error) {
	id, err := httpx.PathUUID(r, "id", "event")
	if err != nil {
		return nil, nil, err
	}
	ev, err := q.GetEvent(r.Context(), id)
	if db.IsNotFound(err) {
		return nil, nil, httpx.NotFound("event")
	}
	if err != nil {
		return nil, nil, err
	}
	v, err := requestViewer(r, ev.WorkspaceID, q)
	if errors.Is(err, errGuest) {
		return s.guestEvent(r, q, ev)
	}
	if err != nil {
		if httpx.AsError(err) != nil {
			return nil, nil, httpx.NotFound("event")
		}
		return nil, nil, err
	}
	b, err := loadOne(r.Context(), q, ev)
	if err != nil {
		return nil, nil, err
	}
	if !v.sees(b) {
		return nil, nil, httpx.NotFound("event")
	}
	return b, v, nil
}

// guestEvent: a guest (ADR-0016) reaches a meeting only through a room it can view
// («Диплинки для приглашённых»): the bundle and errGuest then, else 404.
func (s *Service) guestEvent(r *http.Request, q *sqlc.Queries, ev sqlc.Event) (*bundle, *viewer, error) {
	if ev.RoomID == nil || ev.CancelledAt != nil {
		return nil, nil, httpx.NotFound("event")
	}
	acc, err := perm.FromContext(r.Context()).Room(r.Context(), *ev.RoomID, auth.MustFromContext(r.Context()).UserID)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
		return nil, nil, httpx.NotFound("event")
	}
	if err != nil {
		return nil, nil, err
	}
	b, err := loadOne(r.Context(), q, ev)
	if err != nil {
		return nil, nil, err
	}
	return b, nil, errGuest
}

// get: GET /api/events/{id} — the series (a cancelled event too, with cancelled_at). A guest
// gets the occurrence active now in a room it can view, without attendees; else 404.
func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	b, v, err := s.event(r, s.db.Q)
	if errors.Is(err, errGuest) {
		o, ok := activeOcc(b, s.Now())
		if !ok {
			return httpx.NotFound("event")
		}
		httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: pbconv.EventForGuest(b.proto(&o, nil))})
		return nil
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: b.proto(nil, v)})
	return nil
}

// create: POST /api/workspaces/{id}/events.
func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	v, err := requestViewer(r, wsID, s.db.Q)
	if err != nil {
		return err
	}
	var req v1.CreateCalendarEventRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := s.writes.Take(ctx, me.String()); err != nil {
		return err
	}
	f := fields{title: req.GetTitle(), desc: req.GetDescription(), start: tsTime(req.GetStartsAt()), end: tsTime(req.GetEndsAt()),
		allDay: req.GetAllDay(), tz: req.GetTz(), record: req.GetRecord(), rule: Rule{Repeat: req.GetRepeat()}}
	if u := req.GetRepeatUntil(); u != nil {
		t := tsTime(u)
		f.rule.Until = &t
	}
	if f.tz == "" {
		f.tz = s.userZone(ctx, me)
	}
	if err := f.normalize(); err != nil {
		return err
	}
	if req.GetRoomId() != "" {
		rid, err := uuid.Parse(req.GetRoomId())
		if err != nil {
			return httpx.Validation("roomId", "no such room in this workspace")
		}
		if err := checkRoom(ctx, s.db.Q, wsID, me, rid); err != nil {
			return err
		}
		f.room = &rid
	}
	want, err := parseAttendees(req.GetAttendees())
	if err != nil {
		return err
	}
	if err := checkAttendees(ctx, s.db.Q, wsID, me, v.bot, want); err != nil {
		return err
	}
	if hasExternals(want) { // mail to outside addresses needs a confirmed sender (ADR-0023, ADR-0065)
		if _, err := s.EmailGate.User(ctx, s.db.Q, me); err != nil {
			return err
		}
	}
	var b *bundle
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		series := f.series()
		ev, err := q.InsertEvent(ctx, sqlc.InsertEventParams{
			WorkspaceID: wsID, RoomID: f.room, Title: f.title, Description: f.desc, StartsAt: f.start, EndsAt: f.end,
			AllDay: f.allDay, Tz: f.tz, OrganizerID: me, Record: f.record, Rrule: rrulePtr(f.rule), UntilAt: series.UntilAt(),
		})
		if err != nil {
			return err
		}
		now := s.Now()
		if !v.bot { // a bot organizes but never attends (ADR-0051)
			if err := insertAttendee(ctx, q, ev.ID, wantAttendee{user: &me, required: true}, StatusAccepted, &now); err != nil {
				return err
			}
		}
		for _, a := range want {
			if a.user != nil && *a.user == me {
				continue // the organizer is in already
			}
			if err := insertAttendee(ctx, q, ev.ID, a, StatusPending, nil); err != nil {
				return err
			}
		}
		if b, err = loadOne(ctx, q, ev); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, b, true, false); err != nil {
			return err
		}
		b, err = loadOne(ctx, q, ev)
		return err
	})
	if err != nil {
		return err
	}
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: b.proto(nil, nil)}}})
	s.roomSignals(ctx, nil, b)
	s.sendMails(ctx, b, mail.TemplateEventInvite, MethodRequest, b.att)
	s.changed(ctx, b)
	httpx.Write(w, http.StatusCreated, &v1.CalendarEventResponse{Event: b.proto(nil, v)})
	return nil
}

func insertAttendee(ctx context.Context, q *sqlc.Queries, eventID uuid.UUID, a wantAttendee, status string, at *time.Time) error {
	p := sqlc.InsertEventAttendeeParams{EventID: eventID, UserID: a.user, Required: a.required, Status: status, RespondedAt: at}
	if a.user == nil {
		e := a.email
		p.Email = &e
	}
	return q.InsertEventAttendee(ctx, p)
}

func rrulePtr(r Rule) *string {
	s := r.String()
	if s == "" {
		return nil
	}
	return &s
}

// isBot reports whether the user is a bot account (ADR-0051: a bot organizer is no attendee).
func (s *Service) isBot(ctx context.Context, id uuid.UUID) (bool, error) {
	u, err := s.db.Q.GetUser(ctx, id)
	if db.IsNotFound(err) {
		return false, nil
	}
	return u.IsBot, err
}

// userZone is the user's profile zone, else UTC.
func (s *Service) userZone(ctx context.Context, id uuid.UUID) string {
	u, err := s.db.Q.GetUser(ctx, id)
	if err == nil && u.Timezone != nil {
		if _, err := time.LoadLocation(*u.Timezone); err == nil {
			return *u.Timezone
		}
	}
	return "UTC"
}

// update: PATCH /api/events/{id}.
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	before, v, err := s.event(r, s.db.Q)
	if err != nil {
		return err
	}
	if before.ev.CancelledAt != nil {
		return httpx.NotFound("event")
	}
	if !v.canEdit(before) {
		return httpx.Forbidden("only the organizer or a room manager may change the meeting")
	}
	var req v1.UpdateCalendarEventRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := s.writes.Take(ctx, me.String()); err != nil {
		return err
	}
	f := fromFields(before.ev)
	if req.Title != nil {
		f.title = req.GetTitle()
	}
	if req.Description != nil {
		f.desc = req.GetDescription()
	}
	if req.GetStartsAt() != nil {
		f.start = tsTime(req.GetStartsAt())
	}
	if req.GetEndsAt() != nil {
		f.end = tsTime(req.GetEndsAt())
	}
	if req.AllDay != nil {
		f.allDay = req.GetAllDay()
	}
	if req.Tz != nil {
		f.tz = req.GetTz()
	}
	if req.Record != nil {
		f.record = req.GetRecord()
	}
	if req.Repeat != nil {
		f.rule.Repeat = req.GetRepeat()
	}
	if req.GetRepeatUntil() != nil {
		t := tsTime(req.GetRepeatUntil())
		f.rule.Until = &t
	}
	if req.GetClearRepeatUntil() {
		f.rule.Until = nil
	}
	if err := f.normalize(); err != nil {
		return err
	}
	if req.RoomId != nil {
		f.room = nil
		if req.GetRoomId() != "" {
			rid, err := uuid.Parse(req.GetRoomId())
			if err != nil {
				return httpx.Validation("roomId", "no such room in this workspace")
			}
			if before.ev.RoomID == nil || *before.ev.RoomID != rid {
				if err := checkRoom(ctx, s.db.Q, before.ev.WorkspaceID, me, rid); err != nil {
					return err
				}
			}
			f.room = &rid
		}
	}
	var want []wantAttendee
	if req.GetSetAttendees() {
		if want, err = parseAttendees(req.GetAttendees()); err != nil {
			return err
		}
		organizer := before.ev.OrganizerID
		var orgBot bool
		if orgBot, err = s.isBot(ctx, organizer); err != nil {
			return err
		}
		if !hasUser(want, organizer) && !orgBot {
			want = append([]wantAttendee{{user: &organizer, required: true}}, want...)
		}
		if err := checkAttendees(ctx, s.db.Q, before.ev.WorkspaceID, organizer, orgBot, want); err != nil {
			return err
		}
	}
	old := fromFields(before.ev)
	roomChanged := !sameRoom(old.room, f.room)
	timeChanged := !old.start.Equal(f.start) || !old.end.Equal(f.end) || old.allDay != f.allDay || old.tz != f.tz ||
		old.rule.String() != f.rule.String()
	significant := roomChanged || timeChanged || old.title != f.title || old.desc != f.desc

	var added, removed []sqlc.EventAttendee
	var after *bundle
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
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
		var addWant []wantAttendee
		if req.GetSetAttendees() {
			keep := map[string]wantAttendee{}
			for _, a := range want {
				keep[a.key()] = a
			}
			have := map[string]bool{}
			for _, a := range curB.att {
				k := attendeeKey(a)
				have[k] = true
				wa, ok := keep[k]
				switch {
				case !ok:
					removed = append(removed, a)
					if err := deleteAttendee(ctx, q, a); err != nil {
						return err
					}
				case wa.required != a.Required:
					if err := setRequired(ctx, q, a, wa.required); err != nil {
						return err
					}
				}
			}
			for _, a := range want {
				if !have[a.key()] {
					addWant = append(addWant, a)
				}
			}
			// A bot adds outside addresses only to the meetings it organizes (ADR-0051): on a
			// person's meeting they would get the person's guest links to the room (links are
			// made by people only, ADR-0031) and mail in the person's name.
			if hasExternals(addWant) && v.bot && cur.OrganizerID != me {
				return httpx.Forbidden("a bot adds outside addresses only to the meetings it organizes")
			}
			if hasExternals(addWant) {
				if _, err := s.EmailGate.User(ctx, q, me); err != nil {
					return err
				}
			}
			for _, a := range addWant {
				if err := insertAttendee(ctx, q, cur.ID, a, StatusPending, nil); err != nil {
					return err
				}
			}
		}
		bump := int32(0)
		if significant || len(removed) > 0 {
			bump = 1
		}
		series := f.series()
		ev, err := q.UpdateEvent(ctx, sqlc.UpdateEventParams{
			ID: cur.ID, RoomID: f.room, Title: f.title, Description: f.desc, StartsAt: f.start, EndsAt: f.end, AllDay: f.allDay,
			Tz: f.tz, Record: f.record, Rrule: rrulePtr(f.rule), UntilAt: series.UntilAt(), Bump: bump,
		})
		if err != nil {
			return err
		}
		if err := revokeLinks(ctx, q, cur.ID, removed); err != nil {
			return err
		}
		if after, err = loadOne(ctx, q, ev); err != nil {
			return err
		}
		if err := s.syncLinks(ctx, q, after, roomChanged, timeChanged); err != nil {
			return err
		}
		if after, err = loadOne(ctx, q, ev); err != nil {
			return err
		}
		for _, a := range after.att {
			for _, w := range addWant {
				if attendeeKey(a) == w.key() {
					added = append(added, a)
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	wsID := after.ev.WorkspaceID
	// Those who may lose the event (another room, removed from the list) get EVENT_DELETE of
	// the previous state first; EVENT_UPDATE follows for everyone who still sees it.
	if roomChanged || len(removed) > 0 {
		s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: before.proto(nil, nil)}}})
	}
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: after.proto(nil, nil)}}})
	s.roomSignals(ctx, before, after)
	if significant {
		s.sendMails(ctx, after, mail.TemplateEventUpdate, MethodRequest, without(after.att, added))
	}
	s.sendMails(ctx, after, mail.TemplateEventInvite, MethodRequest, added)
	if len(removed) > 0 {
		gone := *after
		gone.att = removed
		s.sendMails(ctx, &gone, mail.TemplateEventCancel, MethodCancel, removed)
	}
	s.changed(ctx, before, after)
	httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: after.proto(nil, v)})
	return nil
}

func without(all, some []sqlc.EventAttendee) []sqlc.EventAttendee {
	skip := map[string]bool{}
	for _, a := range some {
		skip[attendeeKey(a)] = true
	}
	var out []sqlc.EventAttendee
	for _, a := range all {
		if !skip[attendeeKey(a)] {
			out = append(out, a)
		}
	}
	return out
}

func sameRoom(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func deleteAttendee(ctx context.Context, q *sqlc.Queries, a sqlc.EventAttendee) error {
	if a.UserID != nil {
		return q.DeleteEventAttendee(ctx, sqlc.DeleteEventAttendeeParams{EventID: a.EventID, UserID: a.UserID})
	}
	return q.DeleteExternalAttendee(ctx, sqlc.DeleteExternalAttendeeParams{EventID: a.EventID, Email: a.Email})
}

func setRequired(ctx context.Context, q *sqlc.Queries, a sqlc.EventAttendee, req bool) error {
	if a.UserID != nil {
		return q.UpdateEventAttendeeRequired(ctx, sqlc.UpdateEventAttendeeRequiredParams{EventID: a.EventID, UserID: a.UserID, Required: req})
	}
	return q.UpdateExternalAttendeeRequired(ctx, sqlc.UpdateExternalAttendeeRequiredParams{EventID: a.EventID, Email: a.Email, Required: req})
}

// remove: DELETE /api/events/{id}[?occurrence=<RFC 3339>] — cancels the event, or one
// occurrence of a series.
func (s *Service) remove(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	before, v, err := s.event(r, s.db.Q)
	if err != nil {
		return err
	}
	if before.ev.CancelledAt != nil {
		return httpx.NotFound("event")
	}
	if !v.canEdit(before) {
		return httpx.Forbidden("only the organizer or a room manager may cancel the meeting")
	}
	// Each cancelled occurrence mails every attendee and grows the EXDATE list: same budget as
	// the other changes.
	if err := s.writes.Take(ctx, auth.MustFromContext(ctx).UserID.String()); err != nil {
		return err
	}
	wsID := before.ev.WorkspaceID
	if occStr := r.URL.Query().Get("occurrence"); occStr != "" {
		occ, err := time.Parse(time.RFC3339, occStr)
		if err != nil || before.series.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED || !before.series.IsOccurrence(occ.UTC()) {
			return httpx.Validation("occurrence", "not an occurrence of this series")
		}
		var after *bundle
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			if _, err := q.GetEventForUpdate(ctx, before.ev.ID); err != nil {
				if db.IsNotFound(err) {
					return httpx.NotFound("event")
				}
				return err
			}
			n, err := q.InsertEventException(ctx, sqlc.InsertEventExceptionParams{EventID: before.ev.ID, OccurrenceAt: occ.UTC()})
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
		if err != nil {
			return err
		}
		if after != nil {
			s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: after.proto(nil, nil)}}})
			s.roomSignals(ctx, before, after)
			s.sendMails(ctx, after, mail.TemplateEventUpdate, MethodRequest, after.att)
			s.changed(ctx, after)
		}
		httpx.NoContent(w)
		return nil
	}
	var after *bundle
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		ev, err := q.CancelEvent(ctx, before.ev.ID)
		if db.IsNotFound(err) {
			return httpx.NotFound("event")
		}
		if err != nil {
			return err
		}
		if err := q.RevokeEventRoomInvites(ctx, sqlc.RevokeEventRoomInvitesParams{EventID: &ev.ID}); err != nil {
			return err
		}
		after, err = loadOne(ctx, q, ev)
		return err
	})
	if err != nil {
		return err
	}
	s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: after.proto(nil, nil)}}})
	s.roomSignals(ctx, before, nil)
	s.sendMails(ctx, after, mail.TemplateEventCancel, MethodCancel, after.att)
	s.changed(ctx, after)
	httpx.NoContent(w)
	return nil
}

// rsvp: PUT /api/events/{id}/rsvp — the caller's own answer.
func (s *Service) rsvp(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	b, v, err := s.event(r, s.db.Q)
	if err != nil {
		return err
	}
	if b.ev.CancelledAt != nil {
		return httpx.NotFound("event")
	}
	var req v1.RsvpCalendarEventRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	status := statusFromProto(req.GetStatus())
	if status == "" {
		return httpx.Validation("status", "status must be ACCEPTED, DECLINED or MAYBE")
	}
	prev, ok := b.attendee(me)
	if !ok {
		return httpx.Forbidden("only attendees answer")
	}
	if err := s.writes.Take(ctx, me.String()); err != nil { // every answer is a workspace broadcast
		return err
	}
	a, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.EventAttendee, error) {
		return guarded.SetEventAttendeeStatus(ctx, sqlc.SetEventAttendeeStatusParams{EventID: b.ev.ID, UserID: &me, Status: status})
	})
	if err != nil {
		return err
	}
	if b, err = loadOne(ctx, s.db.Q, b.ev); err != nil {
		return err
	}
	s.publishRSVP(ctx, b, a)
	if (prev.Status == StatusDeclined) != (status == StatusDeclined) && s.Changed != nil {
		s.Changed(ctx, b.ev.ID, []uuid.UUID{me}) // a declined meeting leaves the user's calendar
	}
	httpx.Write(w, http.StatusOK, &v1.CalendarEventResponse{Event: b.proto(nil, v)})
	return nil
}

func (s *Service) publishRSVP(ctx context.Context, b *bundle, a sqlc.EventAttendee) {
	s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{
		WorkspaceId: b.ev.WorkspaceID.String(), EventId: b.ev.ID.String(), Attendee: attendeeProto(a), Counts: counts(b.att),
		Event: b.proto(nil, nil),
	}}})
}

// today: GET /api/me/events/today?tz= — the caller's upcoming meetings of today.
func (s *Service) today(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	tz := r.URL.Query().Get("tz")
	if tz == "" {
		tz = s.userZone(ctx, id.UserID)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return httpx.Validation("tz", "unknown time zone")
	}
	now := s.Now()
	y, m, d := now.In(loc).Date()
	dayEnd := time.Date(y, m, d+1, 0, 0, 0, 0, loc)
	evs, err := s.db.Q.ListUserEvents(ctx, sqlc.ListUserEventsParams{UserID: id.UserID, From: &now, To: dayEnd})
	if err != nil {
		return err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return err
	}
	viewers := map[uuid.UUID]*viewer{}
	var rows []occurrenceRow
	for _, b := range bs {
		if err := perm.CheckAccess(ctx, b.ev.WorkspaceID, id.UserID); err != nil {
			if httpx.AsError(err).Status >= 500 {
				return err
			}
			continue
		}
		if a, ok := b.attendee(id.UserID); ok && a.Status == StatusDeclined {
			continue
		}
		for _, o := range b.series.Between(now, dayEnd) {
			rows = append(rows, occurrenceRow{b, o})
		}
	}
	sortRows(rows)
	out := &v1.TodayCalendarEventsResponse{Events: []*v1.CalendarEvent{}}
	for _, row := range rows {
		wsID := row.b.ev.WorkspaceID
		v, ok := viewers[wsID]
		if !ok {
			if v, err = viewerOf(ctx, s.db.Q, wsID, id.UserID, id.IsBot); err != nil {
				if httpx.AsError(err) == nil {
					return err
				}
				v = nil
			}
			viewers[wsID] = v
		}
		if v == nil {
			continue
		}
		out.Events = append(out.Events, row.b.proto(&row.occ, v))
	}
	out.Count = uint32(len(out.Events)) //nolint:gosec // small
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func logErr(ctx context.Context, what string, err error) {
	if err != nil {
		slog.WarnContext(ctx, "calendar: "+what, "err", err)
	}
}
