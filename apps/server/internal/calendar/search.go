package calendar

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// SearchViewer is who searches the events of one workspace (unified search, ADR-0062): the
// calendar's own viewer, so that search finds exactly the events the calendar shows with
// details. Events a member sees only as busy time (another person's meeting in freebusy,
// ADR-0041/0045) are never matched.
type SearchViewer struct{ v *viewer }

// NewSearchViewer builds the viewer of member m (user; bot for a bot token) whose effective
// bits in the workspace's visible rooms are roomBits (rooms.VisibleBits). Guests have no
// calendar (viewerOf): nil.
func NewSearchViewer(m perm.Member, user uuid.UUID, bot bool, roomBits map[uuid.UUID]perm.Bits) *SearchViewer {
	if m.Role == perm.RoleGuest || m.Role == "" {
		return nil
	}
	return &SearchViewer{v: &viewer{user: user, bot: bot, ws: m.Workspace(), rooms: roomBits}}
}

// Cond is viewer.sees as SQL over events e — the organizer, an attendee (people only), or
// VIEW_ROOM in the event's room — to narrow the candidates in the database; add appends a
// parameter and returns its placeholder. Hits re-checks every row with sees itself.
func (s *SearchViewer) Cond(add func(any) string) string {
	var viewRooms []uuid.UUID
	for id, b := range s.v.rooms {
		if b.Has(perm.ViewRoom) {
			viewRooms = append(viewRooms, id)
		}
	}
	me := add(s.v.user)
	cond := "(e.organizer_id = " + me + " OR (e.room_id IS NOT NULL AND e.room_id = ANY(" + add(viewRooms) + "::uuid[]))"
	if !s.v.bot {
		cond += " OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = " + me + ")"
	}
	return cond + ")"
}

// SearchHit is a found event the viewer sees, with the occurrence to show: the next one from
// now, else the last one (a series that is over), else the first.
type SearchHit struct {
	Event     sqlc.Event
	Start     time.Time
	End       time.Time
	Recurring bool
}

// Hits loads the events ids (search candidates of this viewer's workspace) and returns, in the
// order of ids, those the viewer sees with details (viewer.sees) and not cancelled.
func (s *SearchViewer) Hits(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID, now time.Time) ([]SearchHit, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	evs, err := q.ListEventsByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	bs, err := load(ctx, q, evs)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]*bundle, len(bs))
	for _, b := range bs {
		byID[b.ev.ID] = b
	}
	out := make([]SearchHit, 0, len(ids))
	for _, id := range ids {
		b, ok := byID[id]
		if !ok || b.ev.CancelledAt != nil || !s.v.sees(b) {
			continue
		}
		h := SearchHit{Event: b.ev, Start: b.ev.StartsAt, End: b.ev.EndsAt, Recurring: b.ev.Rrule != nil}
		if o, ok := b.series.Next(now, lookAhead); ok {
			h.Start, h.End = o.Start, o.End
		} else if past := b.series.Between(now.Add(-lookAhead), now); len(past) > 0 {
			h.Start, h.End = past[len(past)-1].Start, past[len(past)-1].End
		}
		out = append(out, h)
	}
	return out, nil
}
