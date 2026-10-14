//go:build integration

package app_test

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// Who an invitation reaches (ADR-0038 amendment «Кому уходит приглашение», 2026-10-06): only an
// explicit attendee who is not the organizer. A member who merely sees the meeting's room gets
// EVENT_* on the gateway without an attendee row or my_status — never a mail; the organizer gets
// no REQUEST of their own meeting (a temporary room's meeting mails nobody); an attendee added
// later is the only one invited by that change.
func TestEventInviteAudience(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	dave := register(t, invite(t, c.o, wsID)) // sees the voice room, invited to nothing
	dg := dialGW(t)
	defer func() { _ = dg.ws.CloseNow() }()
	dg.identify(dave.token)
	eventMail := func(to string) func(mail.Message) bool {
		return func(m mail.Message) bool {
			return m.To == to && (m.Template == mail.TemplateEventInvite || m.Template == mail.TemplateEventUpdate || m.Template == mail.TemplateEventCancel)
		}
	}

	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Обсуждение", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "Europe/Moscow", RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	waitMail(t, c.bob.email, mail.TemplateEventInvite, 1)
	// The room viewer: the meeting on the gateway and by GET, but no row of his and no answer.
	got := dg.wait("EVENT_CREATE", func(e *v1.DispatchEvent) bool { return e.GetEventCreate().GetEvent().GetId() == ev.GetId() })
	if attendeeOf(got.GetEventCreate().GetEvent(), dave.id, "") != nil || got.GetEventCreate().GetEvent().GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED {
		t.Errorf("a room viewer looks invited on the gateway: %v", got.GetEventCreate().GetEvent())
	}
	var dv v1.CalendarEventResponse
	dave.must(200, "GET", "/api/events/"+ev.GetId(), nil, &dv)
	if attendeeOf(dv.GetEvent(), dave.id, "") != nil || dv.GetEvent().GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED {
		t.Errorf("a room viewer looks invited by GET: %v", dv.GetEvent())
	}
	dave.must(403, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED}, nil)

	// A change mails the attendee an update; adding carol invites carol alone.
	title := "Обсуждение Calab"
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	waitMail(t, c.bob.email, mail.TemplateEventUpdate, 1)
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{SetAttendees: true,
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), att(c.carol.id, true)}}, nil)
	waitMail(t, c.carol.email, mail.TemplateEventInvite, 1)

	// A temporary room's meeting (the organizer alone) and its extension: nobody is mailed.
	tr := tempRoom(t, c.o, wsID, &v1.CreateTempRoomRequest{Name: "Созвон", TtlSeconds: 3600, WithEvent: true})
	if tr.GetEvent() == nil || len(tr.GetEvent().GetAttendees()) != 1 {
		t.Fatalf("temp room meeting: %v", tr.GetEvent())
	}
	var ur v1.UpdateRoomResponse
	c.o.must(200, "PATCH", "/api/rooms/"+tr.GetRoom().GetId(), &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(time.Now().Add(2 * time.Hour).Truncate(time.Second))}, &ur)
	dg.wait("EVENT_UPDATE of the extended meeting", func(e *v1.DispatchEvent) bool {
		return e.GetEventUpdate().GetEvent().GetId() == tr.GetEvent().GetId()
	})

	time.Sleep(400 * time.Millisecond) // let any stray mail land
	for who, want := range map[*user]int{c.o: 0, dave: 0, c.bob: 2, c.carol: 1} {
		if n := testMail.Count(eventMail(who.email)); n != want {
			t.Errorf("%s got %d meeting mails, want %d", who.email, n, want)
		}
	}
	// No mail to the organizer rode in on another template either.
	if n := testMail.Count(func(m mail.Message) bool { return m.To == c.o.email && m.Calendar != "" }); n != 0 {
		t.Errorf("the organizer got %d mails with an .ics of their own meeting", n)
	}
}
