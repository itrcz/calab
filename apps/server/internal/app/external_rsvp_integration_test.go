//go:build integration

package app_test

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Answering my imported events in my CalDAV calendar (ADR-0045 amendment 2): my answer read from
// PARTSTAT, written back with If-Match into every VEVENT of the series and imported again; none
// for the organizer or a non-attendee; a changed event (412 → 409), a read-only calendar (422);
// only the owner, never a bot.
func TestExternalEventRsvp(t *testing.T) {
	c := calSetup(t)
	base := nextMonday()
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())

	var resp v1.CalDavAccountResponse
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, nil)
	d := base.Format("20060102")
	me := strings.ToUpper(c.bob.email) // addresses compare case-insensitively
	obj := func(uid, props string) string {
		return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:" + uid + "\r\n" + props + "END:VEVENT\r\nEND:VCALENDAR\r\n"
	}
	fake.SetObject("invite.ics", obj("invite", "DTSTART:"+d+"T080000Z\r\nDTEND:"+d+"T090000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\n"+
		"ORGANIZER:mailto:boss@partner.org\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@partner.org\r\n"+
		"ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:"+me+"\r\n"))
	fake.SetObject("mine.ics", obj("mine", "DTSTART:"+d+"T100000Z\r\nDTEND:"+d+"T110000Z\r\n"+
		"ORGANIZER:mailto:"+c.bob.email+"\r\nATTENDEE:mailto:"+c.bob.email+"\r\nATTENDEE:mailto:guest@partner.org\r\n"))
	fake.SetObject("other.ics", obj("other", "DTSTART:"+d+"T120000Z\r\nDTEND:"+d+"T130000Z\r\nORGANIZER:mailto:boss@partner.org\r\nATTENDEE:mailto:x@partner.org\r\n"))
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
	if resp.GetAccount().GetLastError() != "" {
		t.Fatalf("sync %v", resp.GetAccount())
	}
	window := "from=" + url.QueryEscape(base.Format(time.RFC3339)) + "&to=" + url.QueryEscape(base.Add(3*24*time.Hour).Format(time.RFC3339))
	mine := func() map[string][]*v1.ExternalEvent {
		t.Helper()
		var r v1.ExternalEventsResponse
		c.bob.must(200, "GET", "/api/me/external-events?"+window, nil, &r)
		out := map[string][]*v1.ExternalEvent{}
		for _, e := range r.GetEvents() {
			out[e.GetSummary()] = append(out[e.GetSummary()], e)
		}
		return out
	}
	events := mine()
	pending, accepted, none := v1.AttendeeStatus_ATTENDEE_STATUS_PENDING, v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED, v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED
	if len(events["invite"]) != 2 || events["invite"][0].GetMyStatus() != pending || events["mine"][0].GetMyStatus() != none || events["other"][0].GetMyStatus() != none {
		t.Fatalf("my status %v", events)
	}
	if a := events["invite"][0].GetAttendees(); len(a) != 2 || a[0].GetStatus() != accepted || a[1].GetStatus() != pending {
		t.Fatalf("attendee statuses %v", a)
	}
	req := func(e *v1.ExternalEvent, st v1.AttendeeStatus) *v1.RespondExternalEventRequest {
		return &v1.RespondExternalEventRequest{Uid: e.GetUid(), Href: e.GetHref(), Start: e.GetStartsAt(), Status: st}
	}
	reason := func() string {
		t.Helper()
		var e v1.ApiError
		if err := protojson.Unmarshal(c.bob.lastBody, &e); err != nil {
			t.Fatal(err)
		}
		return e.GetReason()
	}
	const rsvp = "/api/me/external-events/rsvp"
	invite := events["invite"][1]

	// Who may and what: not a bot, not someone else; an answer only; an attendee only.
	b := createBot(t, c.o, c.ws.GetId(), "Cal")
	b.must(403, "POST", rsvp, req(invite, accepted), nil)
	if st := c.carol.do("POST", rsvp, req(invite, accepted), nil); st != 404 {
		t.Fatalf("carol %d %s", st, c.carol.lastBody)
	}
	c.bob.must(422, "POST", rsvp, req(invite, pending), nil)
	c.bob.must(422, "POST", rsvp, req(events["mine"][0], accepted), nil)
	if reason() != "NOT_AN_ATTENDEE" {
		t.Fatalf("organizer: %s", c.bob.lastBody)
	}
	c.bob.must(422, "POST", rsvp, req(events["other"][0], accepted), nil)
	if reason() != "NOT_AN_ATTENDEE" {
		t.Fatalf("not an attendee: %s", c.bob.lastBody)
	}

	// Accept (from the second occurrence): the series' PARTSTAT, a PUT with If-Match, imported again.
	c.bob.must(204, "POST", rsvp, req(invite, accepted), nil)
	data, _ := fake.Object(fake.Calendar() + "invite.ics")
	if !strings.Contains(data, "ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:"+me+"\r\n") || !strings.Contains(data, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@partner.org") {
		t.Fatalf("not written:\n%s", data)
	}
	put := fake.Requests()
	if p := put[len(put)-1]; p.Method != "REPORT" && p.Method != "PROPFIND" { // the import after the PUT
		t.Fatalf("last request %+v", p)
	}
	for _, e := range mine()["invite"] {
		if e.GetMyStatus() != accepted {
			t.Fatalf("after accept %v", e)
		}
	}
	// Then «Может быть» with the new ETag of the import.
	c.bob.must(204, "POST", rsvp, req(mine()["invite"][0], v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE), nil)
	if data, _ = fake.Object(fake.Calendar() + "invite.ics"); !strings.Contains(data, "PARTSTAT=TENTATIVE;RSVP=TRUE:mailto:"+me) {
		t.Fatalf("maybe:\n%s", data)
	}

	// Changed in the calendar since the import: 409, nothing written.
	stale := mine()["invite"][0]
	fake.SetObject("invite.ics", strings.Replace(data, "SUMMARY:invite", "SUMMARY:invite", 1)) // a new ETag
	c.bob.must(409, "POST", rsvp, req(stale, v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED), nil)
	if reason() != "EVENT_CHANGED" {
		t.Fatalf("reason %s", c.bob.lastBody)
	}
	if data, _ = fake.Object(fake.Calendar() + "invite.ics"); strings.Contains(data, "DECLINED") {
		t.Fatal("written despite the change")
	}

	// A read-only calendar: 422 with the reason.
	fake.ReadOnly = true
	c.bob.must(422, "POST", rsvp, req(mine()["invite"][0], v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED), nil)
	if reason() != "CALENDAR_READ_ONLY" {
		t.Fatalf("read-only: %s", c.bob.lastBody)
	}
	fake.ReadOnly = false
	c.bob.must(204, "POST", rsvp, req(mine()["invite"][0], v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED), nil)
	if got := mine()["invite"][0].GetMyStatus(); got != v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED {
		t.Fatalf("declined: %v", got)
	}
}
