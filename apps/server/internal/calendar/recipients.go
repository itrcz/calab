package calendar

import (
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Who a meeting mail reaches (ADR-0038 §4, amendment «Кому уходит приглашение», 2026-10-06).
//
// The invariant, held here by construction instead of by every caller: an invitation — a
// METHOD:REQUEST mail with the answer buttons, which mail clients show as «<organizer>
// приглашает вас на встречу «<title>»» with Accept / Decline — reaches only explicit attendees
// of the meeting who are not its organizer and have not answered yet. Never anyone who merely
// sees the meeting (viewers of its room get EVENT_* on the gateway, no mail), and never the
// organizer: their own copy of a REQUEST with ORGANIZER = themselves makes third-party
// calendars (Google, Yandex, Outlook) adopt the meeting as theirs and send their own
// invitations to every ATTENDEE on each edit. The organizer's calendar follows through the
// CalDAV push (ADR-0041 §4), which carries no ORGANIZER / ATTENDEE lines for the same reason.

// mailRecipients narrows `to` (whom a caller wants to mail) to the rows tmpl may reach:
//   - rows of b.att only — a row that is not an attendee of b is dropped (a removed attendee is
//     cancelled through a bundle whose att holds the removed rows);
//   - a REQUEST (invite / update) never goes to the organizer;
//   - an invitation goes only to attendees who have not answered (status pending).
//
// A CANCEL reaches every attendee of b, the organizer included (someone else may have
// cancelled their meeting, and a cancellation makes no calendar adopt anything).
func mailRecipients(b *bundle, tmpl mail.Template, to []sqlc.EventAttendee) []sqlc.EventAttendee {
	if b == nil {
		return nil
	}
	rows := make(map[string]bool, len(b.att))
	for _, a := range b.att {
		rows[attendeeKey(a)] = true
	}
	request := tmpl == mail.TemplateEventInvite || tmpl == mail.TemplateEventUpdate
	out := make([]sqlc.EventAttendee, 0, len(to))
	for _, a := range to {
		if !rows[attendeeKey(a)] {
			continue
		}
		if request && a.UserID != nil && *a.UserID == b.ev.OrganizerID {
			continue
		}
		if tmpl == mail.TemplateEventInvite && a.Status != StatusPending {
			continue
		}
		out = append(out, a)
	}
	return out
}
