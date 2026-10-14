//go:build integration

package app_test

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Reminders of imported CalDAV events (ADR-0045 amendment 3): off by default, turned on with
// PATCH /api/me/caldav {remind}; sent by the calendar sweep as EVENT_REMINDER with external_event
// at the user's event_reminders, once; not for events I declined, nor all-day ones; none when off.
func TestExternalEventReminders(t *testing.T) {
	c := calSetup(t)
	ctx := context.Background()
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())

	var resp v1.CalDavAccountResponse
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, &resp)
	if resp.GetAccount().GetRemind() {
		t.Fatal("remind on by default")
	}
	// PATCH changes only what is given.
	c.bob.must(422, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{}, nil)
	on, off := true, false
	c.bob.must(200, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{Remind: &on}, &resp)
	if !resp.GetAccount().GetRemind() || resp.GetAccount().GetShareLevel() != v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_BUSY {
		t.Fatalf("remind on: %v", resp.GetAccount())
	}
	c.bob.must(200, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE}, &resp)
	if !resp.GetAccount().GetRemind() || resp.GetAccount().GetShareLevel() != v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE {
		t.Fatalf("share level kept remind? %v", resp.GetAccount())
	}

	// bob keeps the default reminders: 60 and 5 minutes.
	start := time.Now().UTC().Add(3 * time.Hour).Truncate(time.Minute)
	stamp := start.Format("20060102T150405Z")
	end := start.Add(time.Hour).Format("20060102T150405Z")
	day := start.AddDate(0, 0, 2).Format("20060102")
	obj := func(uid, props string) string {
		return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:" + uid + "\r\n" + props + "END:VEVENT\r\nEND:VCALENDAR\r\n"
	}
	fake.SetObject("meet.ics", obj("meet", "DTSTART:"+stamp+"\r\nDTEND:"+end+"\r\nLOCATION:https://meet.example.org/x\r\n"+
		"ORGANIZER:mailto:boss@partner.org\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@partner.org\r\n"+
		"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:"+c.bob.email+"\r\n"))
	fake.SetObject("declined.ics", obj("declined", "DTSTART:"+stamp+"\r\nDTEND:"+end+"\r\n"+
		"ORGANIZER:mailto:boss@partner.org\r\nATTENDEE;PARTSTAT=DECLINED:mailto:"+strings.ToUpper(c.bob.email)+"\r\n"))
	fake.SetObject("allday.ics", obj("allday", "DTSTART;VALUE=DATE:"+day+"\r\nDTEND;VALUE=DATE:"+start.AddDate(0, 0, 3).Format("20060102")+"\r\n"))
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
	if resp.GetAccount().GetLastError() != "" {
		t.Fatalf("sync %v", resp.GetAccount())
	}

	bg := dialGW(t)
	defer func() { _ = bg.ws.CloseNow() }()
	bg.identify(c.bob.token)

	// 60 minutes before: one reminder (not the declined event).
	at := start.Add(-time.Hour + 20*time.Second)
	if n, err := testApp.Calendar.Sweep(ctx, at); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	e := bg.wait("EVENT_REMINDER of the external event", func(e *v1.DispatchEvent) bool { return e.GetEventReminder().GetExternalEvent() != nil })
	rem := e.GetEventReminder()
	ev := rem.GetExternalEvent()
	if rem.GetEvent() != nil || rem.GetMinutes() != 60 || !rem.GetOccurrenceAt().AsTime().Equal(start) || ev.GetSummary() != "meet" ||
		ev.GetUrl() != "https://meet.example.org/x" || ev.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_PENDING {
		t.Fatalf("reminder %v", rem)
	}
	// Once only, also from another instance; the import that replaces the rows does not repeat it.
	if _, err := testApp.CalDAV.Import(ctx, uuid.MustParse(c.bob.id)); err != nil {
		t.Fatal(err)
	}
	if n, _ := testApp.Calendar.Sweep(ctx, at.Add(30*time.Second)); n != 0 {
		t.Fatalf("second sweep sent %d", n)
	}
	bg.quiet("duplicate", 400*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventReminder() != nil })

	// All-day events are not reminded of.
	var list v1.ExternalEventsResponse
	window := "from=" + url.QueryEscape(start.Format(time.RFC3339)) + "&to=" + url.QueryEscape(start.AddDate(0, 0, 4).Format(time.RFC3339))
	c.bob.must(200, "GET", "/api/me/external-events?"+window, nil, &list)
	var allDay time.Time
	for _, x := range list.GetEvents() {
		if x.GetAllDay() {
			allDay = x.GetStartsAt().AsTime()
		}
	}
	if allDay.IsZero() {
		t.Fatalf("no all-day event imported: %v", list.GetEvents())
	}
	if n, _ := testApp.Calendar.Sweep(ctx, allDay.Add(-5*time.Minute+10*time.Second)); n != 0 {
		t.Fatalf("all-day reminded: %d", n)
	}

	// Turned off: no reminder 5 minutes before.
	c.bob.must(200, "PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{Remind: &off}, &resp)
	if resp.GetAccount().GetRemind() {
		t.Fatal("remind still on")
	}
	if n, _ := testApp.Calendar.Sweep(ctx, start.Add(-5*time.Minute+10*time.Second)); n != 0 {
		t.Fatalf("reminded while off: %d", n)
	}
	bg.quiet("reminder while off", 400*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventReminder() != nil })
}
