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

// Deleting my imported events from my CalDAV calendar (ADR-0045 amendment 1): a whole event, one
// occurrence of a series (EXDATE), a whole series, a changed event (412 → 409), a read-only
// calendar (403 → 422); only the owner, never a bot or a guest.
func TestExternalEventDelete(t *testing.T) {
	c := calSetup(t)
	base := nextMonday()
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())

	var resp v1.CalDavAccountResponse
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &resp)
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, nil)
	d := base.Format("20060102")
	obj := func(uid, props string) string {
		return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:" + uid + "\r\n" + props + "END:VEVENT\r\nEND:VCALENDAR\r\n"
	}
	fake.SetObject("single.ics", obj("single", "DTSTART:"+d+"T080000Z\r\nDTEND:"+d+"T090000Z\r\nURL:https://calendar.yandex.ru/event?event_id=42\r\nLOCATION:https://telemost.yandex.ru/j/1\r\n"))
	fake.SetObject("daily.ics", obj("daily", "DTSTART:"+d+"T100000Z\r\nDTEND:"+d+"T103000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n"))
	fake.SetObject("weekly.ics", obj("weekly", "DTSTART:"+d+"T120000Z\r\nDTEND:"+d+"T130000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n"))
	sync := func() {
		t.Helper()
		c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
		if resp.GetAccount().GetLastError() != "" {
			t.Fatalf("sync %v", resp.GetAccount())
		}
	}
	sync()
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
	if len(events["single"]) != 1 || len(events["daily"]) != 3 || len(events["weekly"]) != 3 {
		t.Fatalf("imported %v", events)
	}
	single := events["single"][0]
	if single.GetHref() != fake.URL+fake.Calendar()+"single.ics" || single.GetRecurring() || !events["daily"][1].GetRecurring() {
		t.Fatalf("href / recurring %v %v", single, events["daily"][1])
	}
	// «Подключиться» is the Telemost link of LOCATION; «Открыть в календаре» Yandex's page.
	if single.GetUrl() != "https://telemost.yandex.ru/j/1" || single.GetWebUrl() != "https://calendar.yandex.ru/event?event_id=42" {
		t.Fatalf("links %q %q", single.GetUrl(), single.GetWebUrl())
	}
	req := func(e *v1.ExternalEvent, scope v1.ExternalDeleteScope) *v1.DeleteExternalEventRequest {
		return &v1.DeleteExternalEventRequest{Uid: e.GetUid(), Href: e.GetHref(), Start: e.GetStartsAt(), Scope: scope}
	}
	this, series := v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_THIS, v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_SERIES
	reason := func(body []byte) string {
		t.Helper()
		var e v1.ApiError
		if err := protojson.Unmarshal(body, &e); err != nil {
			t.Fatal(err)
		}
		return e.GetReason()
	}

	// Who may: not a bot, not an anonymous guest, not someone else (their own rows only).
	b := createBot(t, c.o, c.ws.GetId(), "Cal")
	b.must(403, "DELETE", "/api/me/external-events", req(single, this), nil)
	anon, _ := anonGuest(t, roomLink(t, c.o, c.voice.GetId(), &v1.CreateRoomInviteRequest{}).GetCode(), "Guest")
	anon.must(403, "DELETE", "/api/me/external-events", req(single, this), nil)
	c.carol.must(404, "DELETE", "/api/me/external-events", req(single, this), nil)
	c.bob.must(422, "DELETE", "/api/me/external-events", req(single, v1.ExternalDeleteScope_EXTERNAL_DELETE_SCOPE_UNSPECIFIED), nil)
	wrong := req(single, this)
	wrong.Href = fake.URL + fake.Calendar() + "daily.ics"
	c.bob.must(404, "DELETE", "/api/me/external-events", wrong, nil)
	if _, ok := fake.Object(fake.Calendar() + "single.ics"); !ok {
		t.Fatal("deleted by a refused request")
	}

	// An event without repeats: DELETE with If-Match.
	c.bob.must(204, "DELETE", "/api/me/external-events", req(single, this), nil)
	if _, ok := fake.Object(fake.Calendar() + "single.ics"); ok {
		t.Fatal("still in the calendar")
	}
	last := fake.Requests()[len(fake.Requests())-1]
	if last.Method != "DELETE" || last.Path != fake.Calendar()+"single.ics" {
		t.Fatalf("last request %+v", last)
	}
	if len(mine()["single"]) != 0 {
		t.Fatal("the local row stayed")
	}

	// One occurrence of a series: a PUT with an EXDATE; the other occurrences stay.
	second := events["daily"][1]
	c.bob.must(204, "DELETE", "/api/me/external-events", req(second, this), nil)
	data, _ := fake.Object(fake.Calendar() + "daily.ics")
	if !strings.Contains(data, "EXDATE:"+base.Add(24*time.Hour).Format("20060102")+"T100000Z\r\nEND:VEVENT") {
		t.Fatalf("no EXDATE:\n%s", data)
	}
	if got := mine()["daily"]; len(got) != 2 || got[0].GetStartsAt().AsTime().Equal(second.GetStartsAt().AsTime()) || got[1].GetStartsAt().AsTime().Equal(second.GetStartsAt().AsTime()) {
		t.Fatalf("daily after one %v", got)
	}

	// Changed in the calendar since the import: 412 → 409, imported again; then it works.
	weekly := mine()["weekly"]
	fake.SetObject("weekly.ics", obj("weekly", "DTSTART:"+d+"T120000Z\r\nDTEND:"+d+"T133000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n"))
	c.bob.must(409, "DELETE", "/api/me/external-events", req(weekly[0], series), nil)
	if reason(c.bob.lastBody) != "EVENT_CHANGED" {
		t.Fatalf("reason %s", c.bob.lastBody)
	}
	if _, ok := fake.Object(fake.Calendar() + "weekly.ics"); !ok {
		t.Fatal("deleted despite the change")
	}
	weekly = mine()["weekly"]      // imported again with the new ETag and end
	if len(mine()["daily"]) != 2 { // the import confirms the EXDATE
		t.Fatal("the occurrence came back")
	}
	if len(weekly) != 3 || !weekly[0].GetEndsAt().AsTime().Equal(base.Add(13*time.Hour+30*time.Minute)) {
		t.Fatalf("not imported again %v", weekly)
	}
	c.bob.must(204, "DELETE", "/api/me/external-events", req(weekly[1], this), nil)
	puts := 0
	for _, r := range fake.Requests() {
		if r.Method == "PUT" {
			puts++
		}
	}
	if puts != 2 {
		t.Fatalf("%d PUTs", puts)
	}
	// A stale occurrence (its object changed after the import) is a conflict too.
	fake.SetObject("weekly.ics", obj("weekly", "DTSTART:"+d+"T120000Z\r\nDTEND:"+d+"T133000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:"+base.Add(24*time.Hour).Format("20060102")+"T120000Z\r\n"))
	c.bob.must(409, "DELETE", "/api/me/external-events", req(weekly[2], this), nil)
	c.bob.must(204, "DELETE", "/api/me/external-events", req(mine()["weekly"][0], series), nil)
	if _, ok := fake.Object(fake.Calendar() + "weekly.ics"); ok || len(mine()["weekly"]) != 0 {
		t.Fatal("the series stayed")
	}

	// A read-only calendar: 422 with the reason; nothing removed here.
	fake.ReadOnly = true
	daily := mine()["daily"]
	c.bob.must(422, "DELETE", "/api/me/external-events", req(daily[0], series), nil)
	if reason(c.bob.lastBody) != "CALENDAR_READ_ONLY" || len(mine()["daily"]) != 2 {
		t.Fatalf("read-only: %s", c.bob.lastBody)
	}
	c.bob.must(422, "DELETE", "/api/me/external-events", req(daily[0], this), nil)
	fake.ReadOnly = false

	// Disconnected: nothing of mine any more.
	c.bob.must(204, "DELETE", "/api/me/caldav", nil, nil)
	c.bob.must(404, "DELETE", "/api/me/external-events", req(daily[0], series), nil)
}
