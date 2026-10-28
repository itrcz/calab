//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Exercise import and persisted DATE values without depending on the widget API.
func TestCalDAVDatePersistence(t *testing.T) {
	c := calSetup(t)
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
	end := day.AddDate(0, 0, 2)
	fake.SetObject("date.ics", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dates@example.test\r\nDTSTART;VALUE=DATE:"+day.Format("20060102")+"\r\nDTEND;VALUE=DATE:"+end.Format("20060102")+"\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
	c.bob.must(200, "POST", "/api/me/caldav/sync", nil, &account)
	if account.Account.LastError != "" {
		t.Fatal(account.Account.LastError)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET timezone='America/Los_Angeles' WHERE id=$1", c.bob.id); err != nil {
		t.Fatal(err)
	}
	var startDate, endDate string
	var startAt, endAt time.Time
	if err := testDB.Pool.QueryRow(ctx, "SELECT start_date,end_date,starts_at,ends_at FROM external_busy WHERE user_id=$1", c.bob.id).Scan(&startDate, &endDate, &startAt, &endAt); err != nil {
		t.Fatal(err)
	}
	zone, err := time.LoadLocation("Pacific/Auckland")
	if err != nil {
		t.Fatal(err)
	}
	wantStart := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, zone)
	if startDate != day.Format(time.DateOnly) || endDate != end.Format(time.DateOnly) || !startAt.Equal(wantStart) || !endAt.Equal(wantStart.AddDate(0, 0, 2)) {
		t.Fatalf("source date interval lost: %s/%s (%s/%s)", startDate, endDate, startAt, endAt)
	}
	// Old deployments do not name the new columns; additive defaults keep their writes valid.
	if err := testDB.Pool.QueryRow(ctx, "INSERT INTO external_busy(user_id,uid,starts_at,ends_at,all_day) VALUES($1,'legacy-date',$2,$3,true) RETURNING start_date,end_date", c.bob.id, startAt, endAt).Scan(&startDate, &endDate); err != nil {
		t.Fatal(err)
	}
	if startDate != "" || endDate != "" {
		t.Fatalf("legacy writer defaults: %q/%q", startDate, endDate)
	}
}
