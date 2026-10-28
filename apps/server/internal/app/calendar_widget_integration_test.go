//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// The native feed must follow the same working-day recurrence and occurrence cancellations
// as the calendar, including after the workdays feature is integrated from main.
func TestCalendarWidgetWorkdayRecurrence(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	var profile v1.GetMeResponse
	c.o.must(200, "GET", "/api/me", nil, &profile)
	previousLocale := profile.GetMe().GetLocale()
	t.Cleanup(func() {
		c.o.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Locale: &previousLocale}, nil)
	})
	locale := "en"
	c.o.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Locale: &locale}, nil)
	start := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -7).Add(9 * time.Hour)
	ev := createEvent(t, c.bob, c.ws.Id, &v1.CreateCalendarEventRequest{
		Title: "Workday meeting", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", Repeat: v1.EventRepeat_EVENT_REPEAT_WORKDAYS,
	})
	if ev.HolidayCalendar != "" {
		t.Fatal("fixture must use Monday-Friday recurrence")
	}
	status, grant := widgetHTTP(t, c.bob.token, "POST", "/api/me/calendar-widget")
	if status != 200 {
		t.Fatalf("grant: %d", status)
	}
	token := grant["token"].(string)
	check := func(want int) []*v1.CalendarEvent {
		t.Helper()
		status, feed := widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC")
		if status != 200 {
			t.Fatalf("feed: %d %v", status, feed)
		}
		from, err := time.Parse(time.RFC3339, feed["from"].(string))
		if err != nil {
			t.Fatal(err)
		}
		to, err := time.Parse(time.RFC3339, feed["to"].(string))
		if err != nil {
			t.Fatal(err)
		}
		listed := listEvents(t, c.bob, c.ws.Id, from, to)
		entries := feed["events"].([]any)
		if len(listed) != want || len(entries) != want {
			t.Fatalf("calendar/widget counts: %d/%d, want %d", len(listed), len(entries), want)
		}
		for i, item := range entries {
			e := item.(map[string]any)
			occurrence := listed[i].OccurrenceAt.AsTime()
			if e["eventId"] != ev.Id || e["occurrenceAt"] != occurrence.UTC().Format(time.RFC3339) ||
				occurrence.Weekday() == time.Saturday || occurrence.Weekday() == time.Sunday || occurrence.Hour() != 9 {
				t.Fatalf("widget differs from workday calendar: %v", e)
			}
		}
		return listed
	}
	listed := check(5)
	occurrence := url.QueryEscape(listed[0].OccurrenceAt.AsTime().UTC().Format(time.RFC3339))
	c.bob.must(204, "DELETE", "/api/events/"+ev.Id+"?occurrence="+occurrence, nil, nil)
	check(4)
}

// Calendar sweeps in other integration tests use the shared database. In particular, the
// bounded-feed fixture creates more than a thousand future meetings: remove only this
// test's events so their reminders cannot affect those sweeps.
func cleanupWidgetEvents(t *testing.T, workspaceID string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM events WHERE workspace_id=$1", workspaceID); err != nil {
			t.Errorf("clean up widget meetings: %v", err)
		}
	})
}

func widgetHTTP(t *testing.T, token, method, path string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode == 200 && res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("widget credentials/content must not be cached by intermediaries")
	}
	return res.StatusCode, out
}

// Catches missing routes, capability confusion and session revocation bypass.
func TestCalendarWidgetGrantAndRevocation(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	bot := createBot(t, c.o, c.ws.Id, "widget-denied")
	bot.must(403, "POST", "/api/me/calendar-widget", nil, nil)
	bot.must(401, "GET", "/api/calendar-widget?tz=UTC", nil, nil)
	if status, _ := widgetHTTP(t, "", "GET", "/api/calendar-widget?tz=UTC"); status != 401 {
		t.Fatalf("anonymous widget read: %d", status)
	}
	now := time.Now().UTC().Add(time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Widget visible", StartsAt: ts(now), EndsAt: ts(now.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	status, grant := widgetHTTP(t, c.bob.token, "POST", "/api/me/calendar-widget")
	if status != 200 {
		t.Fatalf("grant: %d %v", status, grant)
	}
	token, ok := grant["token"].(string)
	if !ok || token == "" {
		t.Fatal("missing scoped token")
	}
	status, feed := widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC")
	if status != 200 {
		t.Fatalf("feed: %d %v", status, feed)
	}
	events, ok := feed["events"].([]any)
	if !ok || len(events) != 1 || events[0].(map[string]any)["eventId"] != ev.Id {
		t.Fatalf("own agenda: %v", feed)
	}
	c.bob.must(401, "GET", "/api/calendar-widget?tz=UTC", nil, nil)
	scoped := &client{t: t, token: token}
	scoped.must(401, "GET", "/api/me", nil, nil)
	if status, _ = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=Not/AZone"); status != 422 {
		t.Fatalf("invalid zone: %d", status)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET revoked_at=now() WHERE id=$1", c.bob.session); err != nil {
		t.Fatal(err)
	}
	if status, _ = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC"); status != 401 {
		t.Fatalf("revoked grant survived: %d", status)
	}
}

// A visible room is not an invitation; declined meetings and lost memberships disappear.
func TestCalendarWidgetOwnOnlyAndMembership(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	start := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Minute)
	makeEvent := func(title string, attendees ...*v1.CalendarEventAttendeeInput) *v1.CalendarEvent {
		return createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: title, RoomId: c.voice.Id, StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: attendees})
	}
	makeEvent("Room visible but not mine")
	mine := makeEvent("Mine", att(c.bob.id, true))
	declined := makeEvent("Declined", att(c.bob.id, true))
	c.bob.must(200, "PUT", "/api/events/"+declined.Id+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	status, grant := widgetHTTP(t, c.bob.token, "POST", "/api/me/calendar-widget")
	if status != 200 {
		t.Fatalf("grant %d %v", status, grant)
	}
	token := grant["token"].(string)
	status, feed := widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC")
	if status != 200 {
		t.Fatalf("feed %d", status)
	}
	list := feed["events"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["eventId"] != mine.Id {
		t.Fatalf("not own-only: %v", feed)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", c.ws.Id, c.bob.id); err != nil {
		t.Fatal(err)
	}
	status, feed = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC")
	if status != 200 || len(feed["events"].([]any)) != 0 {
		t.Fatalf("lost membership leaked: %d %v", status, feed)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET disabled_at=now() WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	if status, _ = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC"); status != 401 {
		t.Fatalf("disabled user survived: %d", status)
	}
}

// Same person, different exact session: SSO sees its workspace; local session cannot borrow its proof.
func TestCalendarWidgetSSOExactSession(t *testing.T) {
	f := identitySetup(t, "enforced")
	cleanupWidgetEvents(t, f.a.Id)
	start := time.Now().UTC().Add(time.Hour).Truncate(time.Minute)
	createEvent(t, f.scoped, f.a.Id, &v1.CreateCalendarEventRequest{Title: "SSO meeting", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC"})
	for _, tc := range []struct {
		u    *user
		want int
	}{{f.scoped, 1}, {f.local, 0}} {
		status, g := widgetHTTP(t, tc.u.token, "POST", "/api/me/calendar-widget")
		if status != 200 {
			t.Fatalf("SSO issuance %d %v", status, g)
		}
		status, feed := widgetHTTP(t, g["token"].(string), "GET", "/api/calendar-widget?tz=UTC")
		if status != 200 || len(feed["events"].([]any)) != tc.want {
			t.Fatalf("scope: %d %v want %d", status, feed, tc.want)
		}
	}
}

// DATE values must not change when profile/device timezone changes after import.
func TestCalendarWidgetExternalDatesSurviveZoneChange(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	ctx := context.Background()
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET timezone='Pacific/Auckland' WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())
	var account v1.CalDavAccountResponse
	c.bob.must(200, "POST", "/api/me/caldav", &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}, &account)
	c.bob.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, nil)
	day := time.Now().UTC().AddDate(0, 0, 2)
	end := day.AddDate(0, 0, 1)
	object := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:date-private@example.org\r\nSUMMARY:Day off\r\nDTSTART;VALUE=DATE:" + day.Format("20060102") + "\r\nDTEND;VALUE=DATE:" + end.Format("20060102") + "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	fake.SetObject("date.ics", object)
	fake.SetObject("duplicate.ics", object)
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &account)
	if account.Account.LastError != "" {
		t.Fatal(account.Account.LastError)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET timezone='America/Los_Angeles' WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	status, g := widgetHTTP(t, c.bob.token, "POST", "/api/me/calendar-widget")
	if status != 200 {
		t.Fatalf("grant %d", status)
	}
	status, f := widgetHTTP(t, g["token"].(string), "GET", "/api/calendar-widget?tz=America/Los_Angeles")
	if status != 200 {
		t.Fatalf("feed %d %v", status, f)
	}
	es := f["events"].([]any)
	if len(es) != 1 {
		t.Fatalf("external event missing %v", f)
	}
	e := es[0].(map[string]any)
	if e["startDate"] != day.Format(time.DateOnly) || e["endDate"] != end.Format(time.DateOnly) {
		t.Fatalf("DATE shifted after timezone change: %v", e)
	}
	for _, key := range []string{"attendees", "href", "url", "organizer", "description"} {
		if _, ok := e[key]; ok {
			t.Fatalf("private detail %s escaped", key)
		}
	}
}

func TestCalendarWidgetBoundsAndExpiredSession(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	ctx := context.Background()
	start := time.Now().UTC().Add(time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.bob, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Many meetings", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC"})
	insert := func(count int) {
		t.Helper()
		_, err := testDB.Pool.Exec(ctx, `INSERT INTO events(workspace_id,title,starts_at,ends_at,tz,organizer_id,until_at)
    SELECT workspace_id,title,starts_at+n*interval '1 minute',ends_at+n*interval '1 minute',tz,organizer_id,ends_at+n*interval '1 minute'
    FROM events CROSS JOIN generate_series(1,$2::int) n WHERE id=$1`, ev.Id, count)
		if err != nil {
			t.Fatal(err)
		}
	}
	insert(101)
	status, g := widgetHTTP(t, c.bob.token, "POST", "/api/me/calendar-widget")
	if status != 200 {
		t.Fatalf("grant %d", status)
	}
	token := g["token"].(string)
	status, f := widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC")
	if status != 200 || len(f["events"].([]any)) != 100 || f["completeUntil"] == f["to"] {
		t.Fatalf("truncation not explicit: %d %v", status, f)
	}
	insert(1001)
	if status, _ = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC"); status != 503 {
		t.Fatalf("candidate bound: %d", status)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", c.bob.session); err != nil {
		t.Fatal(err)
	}
	if status, _ = widgetHTTP(t, token, "GET", "/api/calendar-widget?tz=UTC"); status != 401 {
		t.Fatalf("expired session survived: %d", status)
	}
}
