package caldav

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// DueReminders returns the reminders of imported events due at now (ADR-0045 amendment 3) for the
// calendar sweep (calendar.Service.ExternalReminders), which sends them like the meetings' ones.
// Accounts with remind on and the import of a chosen calendar; timed events only (the query);
// not for users whose plans lost CalDAV, nor for events I declined.
func (s *Service) DueReminders(ctx context.Context, now time.Time) ([]calendar.ExternalReminder, error) {
	rows, err := s.db.Q.ListDueExternalReminders(ctx, sqlc.ListDueExternalRemindersParams{
		Now: now, To: now.Add(time.Duration(calendar.ReminderChoices[len(calendar.ReminderChoices)-1]) * time.Minute), Since: now.Add(-calendar.ReminderGrace),
	})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	allowed := map[uuid.UUID]bool{}
	mine := map[uuid.UUID]map[string]bool{}
	var out []calendar.ExternalReminder
	for _, r := range rows {
		ok, seen := allowed[r.UserID]
		if !seen {
			if ok, err = s.allowed(ctx, r.UserID); err != nil {
				return nil, err
			}
			allowed[r.UserID] = ok
		}
		if !ok {
			continue
		}
		var atts []Attendee
		_ = json.Unmarshal(r.Attendees, &atts) // written by the import only
		addrs, seen := mine[r.UserID]
		if !seen {
			addrs = s.myAddresses(ctx, r.UserID, r.Login)
			mine[r.UserID] = addrs
		}
		my := myStatus(r.Organizer, atts, addrs)
		if my == v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED {
			continue
		}
		row := sqlc.ExternalBusy{UserID: r.UserID, Uid: r.Uid, StartsAt: r.StartsAt, EndsAt: r.EndsAt, Summary: r.Summary, Location: r.Location,
			Organizer: r.Organizer, Url: r.Url, Href: r.Href, Recurring: r.Recurring, WebUrl: r.WebUrl}
		out = append(out, calendar.ExternalReminder{User: r.UserID, Event: externalProto(row, atts, nil, my), Minutes: int(r.Minutes), DND: r.EventRemindersDnd})
	}
	return out, nil
}
