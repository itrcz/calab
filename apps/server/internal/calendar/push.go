package calendar

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// The calendar side of the CalDAV push (ADR-0041 §4): who is told about a change, and what
// a user's calendar should hold for a meeting now.

// ErrWithheld is returned when the workspace identity policy does not let the content leave Calab
// for this user now (CalDAV push): the push is dropped, nothing is sent.
var ErrWithheld = errors.New("calendar: withheld by the workspace identity policy")

// mayDeliver tells whether content of workspace ws may leave Calab for user outside a request
// (identitypolicy.Delivery). A denial is (false, nil); only dependency errors return err.
func (s *Service) mayDeliver(ctx context.Context, user, ws uuid.UUID) (bool, error) {
	if s.Identity == nil {
		return false, nil
	}
	d, err := s.Identity.Check(ctx, user, ws)
	if err != nil {
		return false, err
	}
	return d.Allowed, nil
}

// contentFree tells whether meeting mails of workspace ws must leave out the meeting's details
// (enforced SSO: the link alone, opening it needs the organization's sign-in). Unknown → true.
func (s *Service) contentFree(ctx context.Context, ws uuid.UUID) bool {
	if s.Identity == nil {
		return true
	}
	m, err := s.Identity.Mode(ctx, ws)
	if err != nil {
		logErr(ctx, "mail: identity policy", err)
		return true
	}
	return m != identitypolicy.Off && m != identitypolicy.Optional
}

// PushTargets keeps the users a change of the meeting may be pushed to (CalDAV push enqueue):
// a user whose calendar should hold the meeting needs its workspace identity policy to let the
// content out now (mayDeliver); a removal carries no content and is always kept. withheld are
// the users the policy holds the change back from (their earlier copy is withdrawn and the
// push catches up later). A dependency error returns no targets (best-effort: the next change
// or delivery decides again).
func (s *Service) PushTargets(ctx context.Context, eventID uuid.UUID, users []uuid.UUID) (targets, withheld []uuid.UUID, err error) {
	ev, err := s.db.Q.GetEvent(ctx, eventID)
	if db.IsNotFound(err) || err == nil && ev.CancelledAt != nil {
		return users, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	b, err := loadOne(ctx, s.db.Q, ev)
	if err != nil {
		return nil, nil, err
	}
	targets = make([]uuid.UUID, 0, len(users))
	for _, u := range users {
		if busyIn(b, u) {
			ok, err := s.mayDeliver(ctx, u, ev.WorkspaceID)
			if err != nil {
				return nil, nil, err
			}
			if !ok {
				withheld = append(withheld, u)
				continue
			}
		}
		targets = append(targets, u)
	}
	return targets, withheld, nil
}

// changed tells Changed about the members involved in any of the states of one meeting
// (before and after a change: removed attendees get the meeting deleted).
func (s *Service) changed(ctx context.Context, states ...*bundle) {
	if s.Changed == nil {
		return
	}
	var id uuid.UUID
	seen := map[uuid.UUID]bool{}
	var users []uuid.UUID
	add := func(u uuid.UUID) {
		if !seen[u] {
			seen[u] = true
			users = append(users, u)
		}
	}
	for _, b := range states {
		if b == nil {
			continue
		}
		id = pushID(b.ev)
		add(b.ev.OrganizerID)
		for _, a := range b.att {
			if a.UserID != nil {
				add(*a.UserID)
			}
		}
	}
	if id != uuid.Nil {
		s.Changed(ctx, id, users)
	}
}

// EventForCalDAV returns the .ics the user's CalDAV calendar should hold for the meeting —
// the invitation's VEVENT without METHOD, ORGANIZER and ATTENDEE lines (a CalDAV server that
// schedules would mail the attendees again) — or live = false when it should not be there:
// the meeting is gone or cancelled, the user declined it, left it or the workspace.
func (s *Service) EventForCalDAV(ctx context.Context, eventID, user uuid.UUID) (ics string, live bool, err error) {
	ev, err := s.db.Q.GetEvent(ctx, eventID)
	if db.IsNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if ev.CancelledAt != nil || ev.SeriesID != nil { // an override lives in its series' resource
		return "", false, nil
	}
	b, err := loadOne(ctx, s.db.Q, ev)
	if err != nil {
		return "", false, err
	}
	ovs, err := loadOverrides(ctx, s.db.Q, []uuid.UUID{ev.ID})
	if err != nil {
		return "", false, err
	}
	var mine []*bundle
	for _, o := range ovs[ev.ID] {
		if busyIn(o, user) {
			mine = append(mine, o)
		}
	}
	if !busyIn(b, user) && len(mine) == 0 {
		return "", false, nil
	}
	members, err := s.db.Q.ListFreeBusyMembers(ctx, sqlc.ListFreeBusyMembersParams{WorkspaceID: ev.WorkspaceID, Ids: []uuid.UUID{user}})
	if err != nil {
		return "", false, err
	}
	if len(members) == 0 {
		return "", false, nil
	}
	if ok, err := s.mayDeliver(ctx, user, ev.WorkspaceID); err != nil {
		return "", false, err
	} else if !ok {
		return "", false, ErrWithheld
	}
	rooms := map[uuid.UUID]string{}
	conv := func(m *bundle) ICSEvent {
		e := ICSEvent{UID: m.ev.ID.String() + "@calab", Sequence: int(m.ev.Sequence), Series: m.series, Title: m.ev.Title,
			Description: m.ev.Description, URL: s.eventURL(m.ev.ID), Stamp: s.Now()}
		if m.ev.RoomID != nil {
			name, ok := rooms[*m.ev.RoomID]
			if !ok {
				if r, err := s.db.Q.GetRoom(ctx, *m.ev.RoomID); err == nil {
					name = r.Name
				}
				rooms[*m.ev.RoomID] = name
			}
			if name != "" {
				e.Location = "Calab: " + name
			}
		}
		return e
	}
	e, _ := seriesExport(b, busyIn(b, user), mine, conv)
	return BuildICS(e), true, nil
}

// UserEventIDs lists the meetings the user organizes or attends (not declined) that have an
// occurrence in the coming year and whose workspace identity policy lets them be pushed to the
// user now: pushed when the push is turned on.
func (s *Service) UserEventIDs(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error) {
	now := s.Now()
	evs, err := s.db.Q.ListUserEvents(ctx, sqlc.ListUserEventsParams{UserID: user, From: &now, To: now.Add(365 * 24 * time.Hour)})
	if err != nil {
		return nil, err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return nil, err
	}
	var out []uuid.UUID
	allowed := map[uuid.UUID]bool{} // per workspace, decided once
	listed := map[uuid.UUID]bool{}
	for _, b := range bs {
		id := pushID(b.ev) // an override is pushed in its series' resource (ADR-0157)
		if !busyIn(b, user) || listed[id] {
			continue
		}
		ok, seen := allowed[b.ev.WorkspaceID]
		if !seen {
			if ok, err = s.mayDeliver(ctx, user, b.ev.WorkspaceID); err != nil {
				return nil, err
			}
			allowed[b.ev.WorkspaceID] = ok
		}
		if ok {
			listed[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}
