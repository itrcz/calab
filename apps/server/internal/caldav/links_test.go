package caldav

import (
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// Real-world objects (ADR-0045 amendment 1): which link is the conference («Подключиться») and
// which the provider's page of the event («Открыть в календаре»).
func readFixture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name) //nolint:gosec // G304: a fixture of this package
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

var (
	day    = utc("2026-10-05T00:00:00Z")
	moscow = mustZone("Europe/Moscow")
)

func mustZone(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}

func TestLinksYandex(t *testing.T) {
	busy := BusyFromICS(readFixture(t, "yandex.ics"), day, day.Add(24*time.Hour), moscow)
	if len(busy) != 1 {
		t.Fatalf("%d intervals", len(busy))
	}
	b := busy[0]
	// URL is Yandex's page of the event, the Telemost link is in LOCATION.
	if b.URL != "https://telemost.yandex.ru/j/58291045771234" {
		t.Errorf("conference %q", b.URL)
	}
	if b.WebURL != "https://calendar.yandex.ru/event?event_id=2045113377" {
		t.Errorf("web page %q", b.WebURL)
	}
	if !b.Recurring || !b.Start.Equal(utc("2026-10-05T09:00:00Z")) || len(b.Attendees) != 2 || b.Attendees[1].Email != "boris@yandex.ru" {
		t.Errorf("event %+v %+v", b, b.Details)
	}
}

func TestLinksGoogle(t *testing.T) {
	busy := BusyFromICS(readFixture(t, "google.ics"), day, day.Add(24*time.Hour), time.UTC)
	if len(busy) != 2 {
		t.Fatalf("%d intervals", len(busy))
	}
	if busy[0].URL != "https://meet.google.com/abc-defg-hij" || busy[0].WebURL != "" || busy[0].Recurring {
		t.Errorf("meet %q web %q", busy[0].URL, busy[0].WebURL)
	}
	// An HTML description: &amp; decoded, Google's redirect unwrapped.
	if busy[1].URL != "https://us02web.zoom.us/j/8812345678?pwd=QWErty" || busy[1].WebURL != "" {
		t.Errorf("zoom %q web %q", busy[1].URL, busy[1].WebURL)
	}
}

func TestLinksICloud(t *testing.T) {
	busy := BusyFromICS(readFixture(t, "icloud.ics"), day, day.Add(24*time.Hour), time.UTC)
	if len(busy) != 1 {
		t.Fatalf("%d intervals", len(busy))
	}
	// An empty URL; the link folded inside the description, an escaped comma after it.
	if busy[0].URL != "https://us02web.zoom.us/j/88123456789?pwd=QWErty" || busy[0].WebURL != "" || busy[0].Location != "Zoom" {
		t.Errorf("icloud %q web %q", busy[0].URL, busy[0].WebURL)
	}
}

func TestLinksNextcloud(t *testing.T) {
	busy := BusyFromICS(readFixture(t, "nextcloud.ics"), day, day.Add(7*24*time.Hour), moscow)
	if len(busy) != 5 {
		t.Fatalf("%d intervals", len(busy))
	}
	for _, b := range busy {
		if b.URL != "https://cloud.example.org/call/abc12xyz" || !b.Recurring || b.WebURL != "" {
			t.Errorf("occurrence %+v %q", b, b.URL)
		}
	}
	href := "https://cloud.example.org/nc/remote.php/dav/calendars/anna/personal/9a1b2c3d.ics"
	want := "https://cloud.example.org/nc/index.php/apps/calendar/edit/" +
		base64.StdEncoding.EncodeToString([]byte("/nc/remote.php/dav/calendars/anna/personal/9a1b2c3d.ics"))
	if got := NextcloudPage(href); got != want {
		t.Errorf("nextcloud page %q", got)
	}
	for _, h := range []string{
		"https://caldav.yandex.ru/calendars/anna@yandex.ru/events-default/x.ics",
		"https://p42-caldav.icloud.com/123/calendars/home/x.ics",
		"https://cloud.example.org/remote.php/dav/calendars/anna/personal/",
		"http://cloud.example.org/remote.php/dav/calendars/anna/personal/x.ics",
	} {
		if NextcloudPage(h) != "" {
			t.Errorf("not a Nextcloud object: %s", h)
		}
	}
}

func TestLinksOrder(t *testing.T) {
	ev := func(props string) Busy {
		t.Helper()
		b := BusyFromICS("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261005T090000Z\r\nDTEND:20261005T100000Z\r\n"+props+"END:VEVENT\r\nEND:VCALENDAR\r\n", day, day.Add(24*time.Hour), time.UTC)
		if len(b) != 1 {
			t.Fatalf("%d intervals", len(b))
		}
		return b[0]
	}
	teams := "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
	if b := ev("X-MICROSOFT-SKYPETEAMSMEETINGURL:" + teams + "\r\nURL:https://other.example/x\r\n"); b.URL != teams {
		t.Errorf("teams %q", b.URL)
	}
	if b := ev("URL:https://zoom.us/j/1?a=1\\,2\r\nLOCATION:https://loc.example/\r\n"); b.URL != "https://zoom.us/j/1?a=1,2" {
		t.Errorf("URL escaped like TEXT %q", b.URL)
	}
	if b := ev("URL:HTTPS://Zoom.us/j/9\r\n"); b.URL != "https://Zoom.us/j/9" {
		t.Errorf("scheme in capitals %q", b.URL)
	}
	g := "https://calendar.google.com/calendar/event?eid=NnAxazJvOWg2ZGozY2I5biBhbm5hQGV4YW1wbGUuY29t"
	if b := ev("URL:" + g + "\r\nDESCRIPTION:join https://meet.google.com/x-y-z\r\n"); b.URL != "https://meet.google.com/x-y-z" || b.WebURL != g {
		t.Errorf("google page %q %q", b.URL, b.WebURL)
	}
	for _, s := range []string{"https://calendar.yandex.ru/event?event_id=12a", "https://calendar.yandex.ru/week?event_id=1", "https://evil.example/event?event_id=1"} {
		if eventPage(s) {
			t.Errorf("not an event page: %s", s)
		}
	}
}

// One occurrence out of a series: an EXDATE in the form of DTSTART, a changed occurrence dropped,
// the rest of the object byte for byte.
func TestExcludeOccurrence(t *testing.T) {
	nc := readFixture(t, "nextcloud.ics")
	uid := uidHash("9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")

	out, whole, err := excludeOccurrence(nc, uid, utc("2026-10-06T13:00:00Z"), moscow)
	if err != nil || whole {
		t.Fatalf("exclude: %v %v", whole, err)
	}
	if !strings.Contains(out, "RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE;TZID=Europe/Moscow:20261006T160000\r\nEND:VEVENT\r\n") {
		t.Errorf("EXDATE not before the master's END:\n%s", out)
	}
	if strings.Replace(out, "EXDATE;TZID=Europe/Moscow:20261006T160000\r\n", "", 1) != nc {
		t.Error("the rest of the object changed")
	}
	left := BusyFromICS(out, day, day.Add(7*24*time.Hour), moscow)
	if len(left) != 4 {
		t.Fatalf("%d occurrences left", len(left))
	}
	for _, b := range left {
		if b.Start.Equal(utc("2026-10-06T13:00:00Z")) {
			t.Error("the occurrence is still there")
		}
	}

	// The changed occurrence (moved to 18:00): its VEVENT goes, the master excludes its RECURRENCE-ID.
	out, whole, err = excludeOccurrence(nc, uid, utc("2026-10-07T15:00:00Z"), moscow)
	if err != nil || whole || strings.Contains(out, "Retro (moved)") || !strings.Contains(out, "EXDATE;TZID=Europe/Moscow:20261007T160000\r\nEND:VEVENT") {
		t.Fatalf("override: %v %v\n%s", whole, err, out)
	}
	if n := len(BusyFromICS(out, day, day.Add(7*24*time.Hour), moscow)); n != 4 {
		t.Errorf("%d occurrences after dropping the override", n)
	}

	// A folded Yandex series keeps its folding.
	ya := readFixture(t, "yandex.ics")
	out, _, err = excludeOccurrence(ya, uidHash("Ab3dEf9Gyandex.ru"), utc("2026-10-12T09:00:00Z"), moscow)
	if err != nil || !strings.Contains(out, "mailto:anna@\r\n yandex.ru") || !strings.Contains(out, "EXDATE;TZID=Europe/Moscow:20261012T120000\r\nEND:VEVENT") {
		t.Fatalf("yandex: %v\n%s", err, out)
	}
	if !strings.Contains(out, "END:VALARM\r\nEXDATE") {
		t.Error("the EXDATE goes after the alarm, before END:VEVENT of the event")
	}

	// UTC and all-day series.
	utcSeries := "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261005T090000Z\r\nDTEND:20261005T100000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	if out, _, err := excludeOccurrence(utcSeries, uidHash("u"), utc("2026-10-06T09:00:00Z"), moscow); err != nil || !strings.Contains(out, "EXDATE:20261006T090000Z\r\n") {
		t.Errorf("utc: %v %s", err, out)
	}
	allDay := "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261005\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	if out, _, err := excludeOccurrence(allDay, uidHash("d"), time.Date(2026, 10, 12, 0, 0, 0, 0, moscow), moscow); err != nil || !strings.Contains(out, "EXDATE;VALUE=DATE:20261012\r\n") {
		t.Errorf("all day: %v %s", err, out)
	}

	// Not an occurrence; another uid; an event without repeats; a lone changed occurrence.
	if _, _, err := excludeOccurrence(nc, uid, utc("2026-10-06T14:00:00Z"), moscow); !errors.Is(err, errNoOccurrence) {
		t.Errorf("not an occurrence: %v", err)
	}
	if _, _, err := excludeOccurrence(nc, uidHash("other"), utc("2026-10-06T13:00:00Z"), moscow); !errors.Is(err, errNoOccurrence) {
		t.Errorf("another uid: %v", err)
	}
	single := "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261005T090000Z\r\nDTEND:20261005T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	if _, whole, err := excludeOccurrence(single, uidHash("s"), utc("2026-10-05T09:00:00Z"), moscow); err != nil || !whole {
		t.Errorf("single: %v %v", whole, err)
	}
	lone := "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:l\r\nRECURRENCE-ID:20261005T090000Z\r\nDTSTART:20261005T100000Z\r\nDTEND:20261005T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	if _, whole, err := excludeOccurrence(lone, uidHash("l"), utc("2026-10-05T10:00:00Z"), moscow); err != nil || !whole {
		t.Errorf("lone override: %v %v", whole, err)
	}
}
