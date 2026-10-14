package caldav

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Details of imported events (ADR-0045 §1): a fixture with folding, escaping, quoted parameters,
// duplicate and non-mail attendees, a VALARM description and links.
func TestDetailsFromICS(t *testing.T) {
	raw, err := os.ReadFile("testdata/details.ics")
	if err != nil {
		t.Fatal(err)
	}
	busy := BusyFromICS(string(raw), utc("2026-10-05T00:00:00Z"), utc("2026-10-06T00:00:00Z"), time.UTC)
	if len(busy) != 3 {
		t.Fatalf("%d intervals: %+v", len(busy), busy)
	}
	meet, call, plain := busy[0], busy[1], busy[2]
	if meet.Summary != "Квартальный обзор, план; бюджет" || meet.Location != "Переговорная «Волга» 3 этаж" {
		t.Errorf("summary %q location %q", meet.Summary, meet.Location)
	}
	if meet.Organizer != "anna@example.com" {
		t.Errorf("organizer %q", meet.Organizer)
	}
	want := []Attendee{{Email: "ivan.petrov@example.com", Name: "Petrov; Ivan", Status: "ACCEPTED"}, {Email: "anna@example.com", Name: "Anna Ivanova"}, {Email: "guest@partner.org"}}
	if !reflect.DeepEqual(meet.Attendees, want) {
		t.Errorf("attendees %+v", meet.Attendees)
	}
	if meet.URL != "https://telemost.yandex.ru/j/12345" {
		t.Errorf("link from the description %q", meet.URL)
	}
	if call.Summary != "Call" || call.URL != "https://zoom.us/j/777" || call.Attendees != nil {
		t.Errorf("call %+v", call.Details)
	}
	if plain.Summary != "" || plain.URL != "" {
		t.Errorf("plain %+v", plain.Details)
	}
}

func TestDetailsLimitsAndSeries(t *testing.T) {
	var b strings.Builder
	for i := range 60 {
		fmt.Fprintf(&b, "ATTENDEE:mailto:p%d@x.org\r\n", i)
	}
	long := strings.Repeat("я", 250)
	data := ics("BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:" + long + "\r\nLOCATION:" + long + "\r\nURL:https://x.org/" + strings.Repeat("a", 600) + "\r\n" +
		b.String() + "DTSTART:20261005T090000Z\r\nDTEND:20261005T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n")
	busy := BusyFromICS(data, utc("2026-10-05T00:00:00Z"), utc("2026-10-10T00:00:00Z"), time.UTC)
	if len(busy) != 3 {
		t.Fatalf("%d occurrences", len(busy))
	}
	d := busy[0].Details
	if len([]rune(d.Summary)) != MaxSummary || len([]rune(d.Location)) != MaxLocation || len(d.Attendees) != MaxAttendees || d.URL != "" {
		t.Errorf("limits: %d %d %d %q", len([]rune(d.Summary)), len([]rune(d.Location)), len(d.Attendees), d.URL)
	}
	if busy[1].Details != d || busy[2].Details != d {
		t.Error("the occurrences of a series share their details")
	}
}

func TestDetailsHelpers(t *testing.T) {
	for in, want := range map[string]string{
		"mailto:A@B.ru": "a@b.ru", "MAILTO: x@y.z ": "x@y.z", "urn:uuid:1": "", "mailto:@x": "", "mailto:a b@x": "", "mailto:x@": "",
	} {
		if got := mailto(in); got != want {
			t.Errorf("mailto(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{ //nolint:gosec // G101: meeting links of test descriptions, not credentials
		"join: https://meet.example/a?b=1).": "https://meet.example/a?b=1", "<https://x.org/y>": "https://x.org/y",
		"http://x.org": "", "nothing": "", "HTTPS://x.org/Q": "https://x.org/Q",
		`<a href="https://zoom.us/j/1?pwd=x&amp;from=addon">`:                                             "https://zoom.us/j/1?pwd=x&from=addon",
		"https://www.google.com/url?q=https://zoom.us/j/2?pwd%3Dy&amp;sa=D&amp;source=calendar&amp;ust=1": "https://zoom.us/j/2?pwd=y",
		`https://x.org/a\b`: "",
	} {
		if got := firstHTTPS(in); got != want {
			t.Errorf("firstHTTPS(%q) = %q, want %q", in, got, want)
		}
	}
	if webLink("http://x.org", false) != "http://x.org" || webLink("ftp://x.org", false) != "" || webLink("https://", false) != "" {
		t.Error("webLink")
	}
	if got := unescapeText(`a\,b\;c\\d\ne\N`); got != "a,b;c\\d\ne\n" {
		t.Errorf("unescape %q", got)
	}
}

func TestInsertParamsEncodesOncePerSeries(t *testing.T) {
	d := &Details{Summary: "S", Attendees: []Attendee{{Email: "a@b.c", Name: "A"}}}
	p, err := insertParams([16]byte{1}, []Busy{{UID: "u", Details: d}, {UID: "u", Details: d}, {UID: "v"}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Attendees[0] != `[{"email":"a@b.c","name":"A"}]` || p.Attendees[2] != "[]" || p.Summaries[1] != "S" || len(p.Urls) != 3 {
		t.Errorf("params %+v", p)
	}
}
