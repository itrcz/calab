package caldav

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Answering an imported event (ADR-0045 amendment 2): PARTSTAT of my ATTENDEE in every VEVENT of
// the uid (a folded line with a quoted CN, an override), nothing else touched.
func TestSetPartstat(t *testing.T) {
	data := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
		"BEGIN:VEVENT\r\nUID:series@x\r\nDTSTART:20261005T100000Z\r\nDTEND:20261005T110000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n" +
		"ORGANIZER:mailto:boss@x.org\r\n" +
		"ATTENDEE;CN=\"Anna; Petrova\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Ann\r\n a@x.org\r\n" +
		"ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@x.org\r\n" +
		"DESCRIPTION:a long folded description that must stay exactly as the server wrote i\r\n t\r\n" +
		"END:VEVENT\r\n" +
		"BEGIN:VEVENT\r\nUID:series@x\r\nRECURRENCE-ID:20261006T100000Z\r\nDTSTART:20261006T120000Z\r\nDTEND:20261006T130000Z\r\n" +
		"ATTENDEE:mailto:anna@x.org\r\nEND:VEVENT\r\n" +
		"BEGIN:VEVENT\r\nUID:other@x\r\nDTSTART:20261005T100000Z\r\nDTEND:20261005T110000Z\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:anna@x.org\r\nEND:VEVENT\r\n" +
		"END:VCALENDAR\r\n"
	mine := map[string]bool{"anna@x.org": true}
	out, err := setPartstat(data, uidHash("series@x"), mine, "ACCEPTED")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"ATTENDEE;CN=\"Anna; Petrova\";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:Anna@x.org\r\n",
		"ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@x.org\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:other@x",
		"ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@x.org\r\n",
		"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:anna@x.org\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", // the other event untouched
	} {
		if !strings.Contains(out, want) && !strings.Contains(strings.ReplaceAll(out, "\r\n ", ""), want) {
			t.Fatalf("missing %q in\n%s", want, out)
		}
	}
	if !strings.Contains(out, "DESCRIPTION:a long folded description that must stay exactly as the server wrote i\r\n t\r\n") {
		t.Fatal("an untouched line was refolded")
	}
	// Read back: my answer in both VEVENTs of the series.
	evs := parseEvents(out, time.UTC)
	for _, ev := range evs[:2] {
		if got := myStatus(ev.details.Organizer, ev.details.Attendees, mine); ev.uid == "series@x" && got != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED {
			t.Fatalf("status %v of %+v", got, ev.details)
		}
	}

	if _, err := setPartstat(data, uidHash("series@x"), map[string]bool{"nobody@x.org": true}, "DECLINED"); !errors.Is(err, errNotAttendee) {
		t.Fatalf("not an attendee: %v", err)
	}
	if _, err := setPartstat(data, uidHash("series@x"), map[string]bool{"boss@x.org": true}, "DECLINED"); !errors.Is(err, errNotAttendee) {
		t.Fatalf("the organizer: %v", err)
	}
	if _, err := setPartstat(data, uidHash("gone@x"), mine, "DECLINED"); !errors.Is(err, errNoOccurrence) {
		t.Fatalf("no such event: %v", err)
	}
}

func TestMyStatus(t *testing.T) {
	att := []Attendee{{Email: "boss@x.org", Status: "ACCEPTED"}, {Email: "anna@x.org", Status: "TENTATIVE"}, {Email: "bob@x.org"}}
	cases := []struct {
		org  string
		mine map[string]bool
		want v1.AttendeeStatus
	}{
		{"boss@x.org", map[string]bool{"anna@x.org": true}, v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE},
		{"boss@x.org", map[string]bool{"bob@x.org": true}, v1.AttendeeStatus_ATTENDEE_STATUS_PENDING},
		{"boss@x.org", map[string]bool{"boss@x.org": true}, v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED}, // the organizer
		{"boss@x.org", map[string]bool{"eve@x.org": true}, v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED},
		{"boss@x.org", nil, v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED},
	}
	for _, c := range cases {
		if got := myStatus(c.org, att, c.mine); got != c.want {
			t.Errorf("myStatus(%q, %v) = %v, want %v", c.org, c.mine, got, c.want)
		}
	}
	// Long lines refold at 75 octets without splitting a UTF-8 sequence.
	long := "ATTENDEE;CN=" + strings.Repeat("Ж", 60) + ":mailto:a@x.org"
	for _, l := range strings.Split(strings.TrimSuffix(foldLine(long), "\r\n"), "\r\n") {
		if len(l) > 75 || !utf8.ValidString(l) {
			t.Fatalf("fold %q", l)
		}
	}
	if un := strings.ReplaceAll(foldLine(long), "\r\n ", ""); un != long+"\r\n" {
		t.Fatalf("unfold %q", un)
	}
}
