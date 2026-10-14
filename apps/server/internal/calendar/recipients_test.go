package calendar

import (
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// The invitation audience (recipients.go): a REQUEST never reaches the organizer or anyone who
// is not an attendee row of the meeting; an invitation only the unanswered; a CANCEL everyone
// on the list, the organizer included.
func TestMailRecipients(t *testing.T) {
	organizer, pending, accepted, declined, stranger := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	partner := "partner@outside.org"
	row := func(u *uuid.UUID, email, status string) sqlc.EventAttendee {
		var e *string
		if email != "" {
			e = &email
		}
		return sqlc.EventAttendee{UserID: u, Email: e, Status: status}
	}
	b := &bundle{ev: sqlc.Event{ID: uuid.New(), OrganizerID: organizer}, att: []sqlc.EventAttendee{
		row(&organizer, "", StatusAccepted), row(&pending, "", StatusPending), row(&accepted, "", StatusAccepted),
		row(&declined, "", StatusDeclined), row(nil, partner, StatusPending),
	}}
	// A caller that asks for everyone, a stranger included (as the whole attendee list plus a row
	// that is not on it).
	all := append(slices.Clone(b.att), row(&stranger, "", StatusPending))
	names := func(rows []sqlc.EventAttendee) []string {
		var out []string
		for _, a := range rows {
			switch {
			case a.UserID != nil && *a.UserID == organizer:
				out = append(out, "organizer")
			case a.UserID != nil && *a.UserID == pending:
				out = append(out, "pending")
			case a.UserID != nil && *a.UserID == accepted:
				out = append(out, "accepted")
			case a.UserID != nil && *a.UserID == declined:
				out = append(out, "declined")
			case a.UserID != nil && *a.UserID == stranger:
				out = append(out, "stranger")
			default:
				out = append(out, "partner")
			}
		}
		return out
	}
	cases := []struct {
		tmpl mail.Template
		want []string
	}{
		{mail.TemplateEventInvite, []string{"pending", "partner"}},
		{mail.TemplateEventUpdate, []string{"pending", "accepted", "declined", "partner"}},
		{mail.TemplateEventCancel, []string{"organizer", "pending", "accepted", "declined", "partner"}},
	}
	for _, c := range cases {
		if got := names(mailRecipients(b, c.tmpl, all)); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.tmpl, got, c.want)
		}
	}
	// Removed attendees are cancelled through a bundle whose att is the removed rows: the rows
	// still on the meeting are not on that list and get nothing from it.
	gone := &bundle{ev: b.ev, att: []sqlc.EventAttendee{row(&accepted, "", StatusAccepted)}}
	if got := names(mailRecipients(gone, mail.TemplateEventCancel, all)); !slices.Equal(got, []string{"accepted"}) {
		t.Errorf("removed: %v", got)
	}
	// The organizer alone (a temporary room's meeting, ADR-0044): nothing is ever mailed.
	solo := &bundle{ev: b.ev, att: []sqlc.EventAttendee{row(&organizer, "", StatusAccepted)}}
	for _, tmpl := range []mail.Template{mail.TemplateEventInvite, mail.TemplateEventUpdate} {
		if got := mailRecipients(solo, tmpl, solo.att); len(got) != 0 {
			t.Errorf("%s to the organizer alone: %v", tmpl, names(got))
		}
	}
	if mailRecipients(nil, mail.TemplateEventInvite, all) != nil {
		t.Error("nil bundle")
	}
}
