package caldav

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

var widgetColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// WidgetEvents projects only the owner's imported occurrences, after global authority was checked.
// The plan gate is re-evaluated on each fetch; no provider credentials leave this service.
func (s *Service) WidgetEvents(ctx context.Context, user uuid.UUID, from, to time.Time) ([]*v1.CalendarWidgetEvent, error) {
	allowed, err := s.allowed(ctx, user)
	if err != nil || !allowed {
		return nil, err
	}
	acc, err := s.db.Q.GetCalDavAccount(ctx, user)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !acc.Import {
		return nil, nil
	}
	rows, err := s.db.Q.ListWidgetExternalEvents(ctx, sqlc.ListWidgetExternalEventsParams{UserID: user, From: from, To: to})
	if err != nil {
		return nil, err
	}
	if len(rows) > 1000 {
		return nil, httpx.Unavailable(errors.New("calendar widget external candidate limit"))
	}
	u, err := s.db.Q.GetUser(ctx, user)
	if err != nil {
		return nil, err
	}
	mine := map[string]bool{}
	if address := mailto(acc.Username); address != "" {
		mine[address] = true
	}
	if u.Email != nil {
		if address := mailto(*u.Email); address != "" {
			mine[address] = true
		}
	}
	color := "#5C9AFF"
	for _, c := range calendarsOfRow(acc) {
		if acc.CalendarHref != nil && c.Href == *acc.CalendarHref && widgetColor.MatchString(c.Color) {
			color = c.Color
		}
	}
	zone := time.UTC
	if u.Timezone != nil {
		if location, e := time.LoadLocation(*u.Timezone); e == nil {
			zone = location
		}
	}
	result := make([]*v1.CalendarWidgetEvent, 0, len(rows))
	for _, row := range rows {
		var attendees []Attendee
		if err := json.Unmarshal(row.Attendees, &attendees); err != nil {
			return nil, err
		}
		if myStatus(row.Organizer, attendees, mine) == v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED {
			continue
		}
		e := &v1.CalendarWidgetEvent{Key: row.Uid + "@" + row.StartsAt.UTC().Format(time.RFC3339), ExternalUid: row.Uid, Title: row.Summary, OccurrenceAt: timestamppb.New(row.StartsAt), StartsAt: timestamppb.New(row.StartsAt), EndsAt: timestamppb.New(row.EndsAt), AllDay: row.AllDay, Color: color, Source: "external"}
		if row.AllDay {
			e.StartDate, e.EndDate = row.StartDate, row.EndDate
			if e.StartDate == "" || e.EndDate == "" {
				// Compatibility with imports written before migration 00133, until the next sync.
				e.StartDate = row.StartsAt.In(zone).Format(time.DateOnly)
				e.EndDate = row.EndsAt.In(zone).Format(time.DateOnly)
			}
		}
		result = append(result, e)
	}
	return result, nil
}
