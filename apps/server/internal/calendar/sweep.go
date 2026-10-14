package calendar

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
)

// Reminders and room signals (ADR-0038 §5–6), and the reminders of imported CalDAV events
// (ADR-0045 amendment 3). Every instance sweeps; the dedup rows (event_reminders_sent,
// external_reminders_sent, event_room_signals) make each reminder / signal go out once.

// Tick is the sweep interval in production.
const Tick = 30 * time.Second

// ReminderGrace is how long after its moment a reminder is still sent. A meeting created later
// than a reminder's moment skips that reminder instead of sending "in 60 minutes" 10 minutes
// before the start; a server down for longer loses it.
const ReminderGrace = 2 * time.Minute

// endedGrace: ROOM_EVENT_ENDED is still sent this long after the end (downtime).
const endedGrace = time.Hour

// ReminderChoices are the allowed reminder minutes (ADR-0038 §1).
var ReminderChoices = []int{5, 10, 15, 30, 60, 120, 1440}

// Run sweeps every interval until ctx is done.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	var lastCleanup time.Time
	for {
		now := s.Now()
		if n, err := s.Sweep(ctx, now); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "calendar: sweep", "err", err)
		} else if n > 0 {
			slog.InfoContext(ctx, "calendar: reminders sent", "count", n)
		}
		if now.Sub(lastCleanup) > time.Hour {
			lastCleanup = now
			logErr(ctx, "cleanup", db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error { return guarded.DeleteOldEventSignals(ctx, now.Add(-72*time.Hour)) }))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ExternalReminder is a due reminder of an imported CalDAV event (ADR-0045 amendment 3); the
// sweep sends it like a meeting's: the same grace, DND rule, once-only claim and EVENT_REMINDER.
type ExternalReminder struct {
	User    uuid.UUID
	Event   *v1.ExternalEvent // the occurrence (uid and starts_at name it)
	Minutes int
	DND     bool // remind during DND
}

type pendingReminder struct {
	b       *bundle           // a meeting, or nil
	ext     *v1.ExternalEvent // an imported event (b nil)
	occ     Occurrence
	user    uuid.UUID
	minutes int
	dnd     bool // remind during DND
}

// Sweep sends the room signals and reminders due at now; it returns the number of reminders.
func (s *Service) Sweep(ctx context.Context, now time.Time) (int, error) {
	ctx = events.WithBudget(ctx, events.RequestBudget)
	due, err := s.dueMeetingReminders(ctx, now)
	if err != nil {
		return 0, err
	}
	if s.ExternalReminders != nil {
		ext, err := s.ExternalReminders(ctx, now)
		logErr(ctx, "external reminders", err)
		for _, r := range ext {
			due = append(due, pendingReminder{ext: r.Event, user: r.User, minutes: r.Minutes, dnd: r.DND})
		}
	}
	return s.remind(ctx, due), nil
}

// dueMeetingReminders sends the room signals due at now and returns the meeting reminders due.
func (s *Service) dueMeetingReminders(ctx context.Context, now time.Time) ([]pendingReminder, error) {
	from, to := now.Add(-endedGrace), now.Add(25*time.Hour)
	evs, err := s.db.Q.ListDueEvents(ctx, sqlc.ListDueEventsParams{From: &from, To: to})
	if err != nil || len(evs) == 0 {
		return nil, err
	}
	bs, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return nil, err
	}
	var withFuture []uuid.UUID
	occs := make(map[uuid.UUID][]Occurrence, len(bs))
	for _, b := range bs {
		os := b.series.Between(from, to)
		occs[b.ev.ID] = os
		for _, o := range os {
			s.signal(ctx, b, o, now)
			if o.Start.After(now) {
				withFuture = append(withFuture, b.ev.ID)
			}
		}
	}
	if len(withFuture) == 0 {
		return nil, nil
	}
	slices.SortFunc(withFuture, func(a, b uuid.UUID) int { return compareUUID(a, b) })
	withFuture = slices.Compact(withFuture)
	targets, err := s.db.Q.ListReminderTargets(ctx, withFuture)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]*bundle, len(bs))
	for _, b := range bs {
		byID[b.ev.ID] = b
	}
	var due []pendingReminder
	for _, t := range targets {
		if t.Status == StatusDeclined {
			continue
		}
		b := byID[t.EventID]
		for _, o := range occs[t.EventID] {
			if !o.Start.After(now) {
				continue
			}
			for _, m := range t.EventReminders {
				at := o.Start.Add(-time.Duration(m) * time.Minute)
				if !now.Before(at) && now.Before(at.Add(ReminderGrace)) {
					due = append(due, pendingReminder{b: b, occ: o, user: t.UserID, minutes: int(m), dnd: t.EventRemindersDnd})
				}
			}
		}
	}
	return due, nil
}

func compareUUID(a, b uuid.UUID) int {
	for i := range a {
		if a[i] != b[i] {
			return int(a[i]) - int(b[i])
		}
	}
	return 0
}

// signal sends the room badge signals of one occurrence that are due at now.
func (s *Service) signal(ctx context.Context, b *bundle, o Occurrence, now time.Time) {
	if b.ev.RoomID == nil {
		return
	}
	kind := ""
	switch {
	case o.Active(now):
		kind = signalActive
	case !now.Before(o.End) && now.Sub(o.End) < endedGrace:
		kind = signalEnded
	default:
		return
	}
	n, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.ClaimEventRoomSignal(ctx, sqlc.ClaimEventRoomSignalParams{EventID: b.ev.ID, OccurrenceAt: o.Start, Kind: kind})
	})
	if err != nil || n == 0 {
		logErr(ctx, "claim room signal", err)
		return
	}
	if kind == signalActive {
		s.publishActive(ctx, b, o)
	} else {
		s.publishEnded(ctx, b.ev.WorkspaceID, *b.ev.RoomID, b.ev.ID, o.Start)
	}
}

// remind sends the due reminders (EVENT_REMINDER on the user channel) except to users in DND
// who do not want them then.
func (s *Service) remind(ctx context.Context, due []pendingReminder) int {
	if len(due) == 0 {
		return 0
	}
	var ask []uuid.UUID
	for _, r := range due {
		if !r.dnd {
			ask = append(ask, r.user)
		}
	}
	dnd := map[uuid.UUID]bool{}
	if len(ask) > 0 && s.Presence != nil {
		st, err := s.Presence(ctx, ask)
		logErr(ctx, "presence", err)
		for u, p := range st {
			dnd[u] = p == v1.PresenceStatus_PRESENCE_STATUS_DND
		}
	}
	sent := 0
	for _, r := range due {
		if !r.dnd && dnd[r.user] {
			continue // not claimed: sent after DND ends if still within the grace
		}
		n, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
			if r.ext != nil {
				return guarded.ClaimExternalReminder(ctx, sqlc.ClaimExternalReminderParams{
					UserID: r.user, Uid: r.ext.GetUid(), OccurrenceAt: r.ext.GetStartsAt().AsTime(), Minutes: int16(r.minutes), //nolint:gosec // ≤ 1440
				})
			}
			return guarded.ClaimEventReminder(ctx, sqlc.ClaimEventReminderParams{
				EventID: r.b.ev.ID, OccurrenceAt: r.occ.Start, UserID: r.user, Minutes: int16(r.minutes), //nolint:gosec // ≤ 1440
			})
		})
		if err != nil || n == 0 {
			logErr(ctx, "claim reminder", err)
			continue
		}
		rem := &v1.CalendarEventReminder{Minutes: uint32(r.minutes)} //nolint:gosec // ≤ 1440
		if r.ext != nil {
			rem.ExternalEvent, rem.OccurrenceAt = r.ext, r.ext.GetStartsAt()
		} else {
			rem.Event, rem.OccurrenceAt = r.b.proto(&r.occ, &viewer{user: r.user}), timestamppb.New(r.occ.Start)
		}
		s.ev.User(ctx, r.user, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventReminder{EventReminder: rem}})
		sent++
	}
	return sent
}
