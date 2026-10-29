//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Exercises real authorization, serialization and durable capability revocation.
func calendarHTTP(t *testing.T, bearer, method, path string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header, string(b)
}

func subscriptionPath(t *testing.T, bearer, method, path string) string {
	t.Helper()
	code, _, raw := calendarHTTP(t, bearer, method, path)
	if code != 200 {
		t.Fatalf("subscription %s: %d %s", method, code, raw)
	}
	var grant map[string]string
	if err := json.Unmarshal([]byte(raw), &grant); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(grant["feedUrl"])
	if err != nil || u.Path != "/api/calendar-feed.ics" || u.Query().Get("t") == "" {
		t.Fatalf("missing feed URL: %s", raw)
	}
	return u.RequestURI()
}

func TestCalendarSubscriptionLifecycle(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	start := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Personal meeting", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "Europe/Berlin", Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Colleague only", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: c.voice.Id})
	path := "/api/workspaces/" + c.ws.Id + "/calendar-subscription"
	feed := subscriptionPath(t, c.bob.token, "POST", path)
	if again := subscriptionPath(t, c.bob.token, "POST", path); again != feed {
		t.Fatal("activation must be idempotent")
	}
	if got := subscriptionPath(t, c.bob.token, "GET", path); got != feed {
		t.Fatal("grant retrieval changed link")
	}
	code, headers, body := calendarHTTP(t, "", "GET", feed)
	if code != 200 {
		t.Fatalf("feed: %d %s", code, body)
	}
	if !strings.HasPrefix(headers.Get("Content-Type"), "text/calendar") || headers.Get("Cache-Control") != "no-store" {
		t.Fatal("unsafe feed headers")
	}
	body = unfoldICS(body)
	for _, s := range []string{"BEGIN:VCALENDAR", "UID:" + ev.Id + "@calab", "SUMMARY:Personal meeting", "RRULE:FREQ=WEEKLY"} {
		if !strings.Contains(body, s) {
			t.Errorf("missing %s", s)
		}
	}
	for _, s := range []string{"Colleague only", "ATTENDEE", "ORGANIZER", "METHOD:"} {
		if strings.Contains(body, s) {
			t.Errorf("leaked %s", s)
		}
	}
	if strings.Count(body, "BEGIN:VCALENDAR") != 1 || strings.Count(body, "BEGIN:VEVENT") != 1 {
		t.Fatal("invalid calendar structure")
	}
	// The capability is not an API access token.
	u, _ := url.Parse(feed)
	if code, _, _ := calendarHTTP(t, u.Query().Get("t"), "GET", "/api/me"); code != 401 {
		t.Fatal("feed capability accepted as account token")
	}
	connect := strings.Replace(feed, "calendar-feed.ics", "calendar-connect", 1)
	if code, h, html := calendarHTTP(t, "", "GET", connect); code != 200 || h.Get("Referrer-Policy") != "no-referrer" || !strings.Contains(html, "webcal://") || strings.Contains(html, "Personal meeting") {
		t.Fatalf("connect page: %d", code)
	}
	if code, _, _ := calendarHTTP(t, "", "GET", feed+"tampered"); code != 404 {
		t.Fatalf("tampered token: %d", code)
	}
	// Removing an occurrence preserves a real recurrence exception.
	c.o.must(204, "DELETE", "/api/events/"+ev.Id+"?occurrence="+url.QueryEscape(start.Format(time.RFC3339)), nil, nil)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || !strings.Contains(raw, "EXDATE") {
		t.Fatal("cancelled occurrence not reflected")
	}
	rotated := subscriptionPath(t, c.bob.token, "PUT", path)
	if rotated == feed {
		t.Fatal("rotation did not change link")
	}
	if code, _, _ := calendarHTTP(t, "", "GET", feed); code != 404 {
		t.Fatal("old link survived rotation")
	}
	c.bob.must(204, "DELETE", path, nil, nil)
	if code, _, _ := calendarHTTP(t, "", "GET", rotated); code != 404 {
		t.Fatal("revoked link survived")
	}
	if code, _, _ := calendarHTTP(t, "", "GET", strings.Replace(rotated, "calendar-feed.ics", "calendar-connect", 1)); code != 404 {
		t.Fatal("revoked connect page survived")
	}
}

func TestCalendarExportPermissions(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	one := createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "My export", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Other person's meeting", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: c.voice.Id})
	base := "/api/workspaces/" + c.ws.Id
	query := "?from=" + url.QueryEscape(start.Add(-time.Hour).Format(time.RFC3339)) + "&to=" + url.QueryEscape(start.Add(2*time.Hour).Format(time.RFC3339))
	code, h, raw := calendarHTTP(t, c.bob.token, "GET", base+"/calendar.ics"+query)
	if code != 200 || !strings.Contains(raw, "SUMMARY:My export") || strings.Contains(raw, "Other person's meeting") || !strings.Contains(h.Get("Content-Disposition"), "attachment") {
		t.Fatalf("export: %d %s", code, raw)
	}
	if code, _, _ := calendarHTTP(t, c.bob.token, "GET", base+"/calendar.ics?from=invalid&to=invalid"); code != 422 {
		t.Fatalf("range validation: %d", code)
	}
	for _, query := range []string{
		"from=1999-01-01T00:00:00Z&to=1999-02-01T00:00:00Z",
		"from=2201-01-01T00:00:00Z&to=2201-02-01T00:00:00Z",
		"from=9998-01-01T00:00:00Z&to=9999-01-01T00:00:00Z",
	} {
		if code, _, _ := calendarHTTP(t, c.bob.token, "GET", base+"/calendar.ics?"+query); code != 422 {
			t.Errorf("unsupported export year accepted: %s status=%d", query, code)
		}
	}
	if code, _, raw := calendarHTTP(t, c.bob.token, "GET", "/api/events/"+one.Id+"/calendar.ics"); code != 200 || !strings.Contains(raw, "My export") {
		t.Fatalf("single export: %d", code)
	}
	c.gus.must(403, "GET", base+"/calendar.ics"+query, nil, nil)
	c.gus.must(403, "POST", base+"/calendar-subscription", nil, nil)
	bot := createBot(t, c.o, c.ws.Id, "no-calendar-export")
	bot.must(403, "POST", base+"/calendar-subscription", nil, nil)
	bot.must(403, "GET", base+"/calendar.ics"+query, nil, nil)
	c.carol.must(404, "GET", "/api/events/"+one.Id+"/calendar.ics", nil, nil)
	feed := subscriptionPath(t, c.bob.token, "POST", base+"/calendar-subscription")
	// Membership demotion differs from users.is_guest; public links must recheck both.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspace_members SET role='guest' WHERE workspace_id=$1 AND user_id=$2", c.ws.Id, c.bob.id); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{feed, strings.Replace(feed, "calendar-feed.ics", "calendar-connect", 1)} {
		if code, _, raw := calendarHTTP(t, "", "GET", path); code != 404 || strings.Contains(raw, "My export") {
			t.Errorf("demoted guest kept public access: %d", code)
		}
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", c.ws.Id, c.bob.id); err != nil {
		t.Fatal(err)
	}
	// Disabled users and departed members cannot keep reading an old link.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET disabled_at=now() WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code == 200 || strings.Contains(raw, "My export") {
		t.Fatal("disabled owner leaked calendar")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET disabled_at=NULL WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", c.ws.Id, c.bob.id); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := calendarHTTP(t, "", "GET", feed); code != 404 {
		t.Fatal("left workspace link survived")
	}
}

func TestCalendarSubscriptionCurrentPolicy(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	base := "/api/workspaces/" + c.ws.Id + "/calendar-subscription"
	feed := subscriptionPath(t, c.bob.token, "POST", base)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := testDB.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Empty feed is still a complete, importable calendar.
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || !strings.Contains(raw, "END:VCALENDAR") || strings.Contains(raw, "BEGIN:VEVENT") {
		t.Fatalf("empty feed: %d %s", code, raw)
	}
	exec("INSERT INTO workspace_identity_policies (workspace_id, mode) VALUES ($1, 'enforced') ON CONFLICT (workspace_id) DO UPDATE SET mode='enforced'", c.ws.Id)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 403 || !strings.Contains(raw, "CALENDAR_SUBSCRIPTION_SSO") || strings.Contains(raw, "ERROR_CODE_SSO_REQUIRED") {
		t.Fatalf("enforced SSO feed: %d %s", code, raw)
	}
	exec("UPDATE workspace_identity_policies SET mode='off' WHERE workspace_id=$1", c.ws.Id)
	exec("UPDATE workspaces SET suspended_at=now() WHERE id=$1", c.ws.Id)
	if code, _, _ := calendarHTTP(t, "", "GET", feed); code != 404 {
		t.Fatalf("suspended workspace feed: %d", code)
	}
	exec("UPDATE workspaces SET suspended_at=NULL WHERE id=$1", c.ws.Id)
	testApp.SetBilling(nil, true, true)
	t.Cleanup(func() { testApp.SetBilling(nil, false, false) })
	billingAccount(t, c.ws.Id, "suspended", true)
	if code, _, _ := calendarHTTP(t, "", "GET", feed); code == 200 {
		t.Fatal("billing-suspended workspace leaked calendar")
	}
}

func TestCalendarSubscriptionTracksChanges(t *testing.T) {
	c := calSetup(t)
	cleanupWidgetEvents(t, c.ws.Id)
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, c.ws.Id, &v1.CreateCalendarEventRequest{Title: "Before", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	feed := subscriptionPath(t, c.bob.token, "POST", "/api/workspaces/"+c.ws.Id+"/calendar-subscription")
	title := "After"
	c.o.must(200, "PATCH", "/api/events/"+ev.Id, &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || !strings.Contains(raw, "SUMMARY:After") || strings.Contains(raw, "SUMMARY:Before") {
		t.Fatalf("update absent: %d", code)
	}
	c.bob.must(200, "PUT", "/api/events/"+ev.Id+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || strings.Contains(raw, "BEGIN:VEVENT") {
		t.Fatalf("declined event stayed: %d", code)
	}
	c.bob.must(200, "PUT", "/api/events/"+ev.Id+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED}, nil)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || !strings.Contains(unfoldICS(raw), "UID:"+ev.Id+"@calab") {
		t.Fatalf("accepted event absent: %d", code)
	}
	c.o.must(204, "DELETE", "/api/events/"+ev.Id, nil, nil)
	if code, _, raw := calendarHTTP(t, "", "GET", feed); code != 200 || strings.Contains(raw, "BEGIN:VEVENT") {
		t.Fatalf("cancelled event stayed: %d", code)
	}
}
