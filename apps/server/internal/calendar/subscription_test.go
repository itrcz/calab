package calendar

import (
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestCalendarFeedTimezonesAndAllDay(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2020, 1, 1, 9, 0, 0, 0, loc)
	later := start.AddDate(15, 0, 0)
	a := ICSEvent{UID: "a@calab", Title: "A\nBEGIN:VEVENT", Series: Series{Start: start, End: start.Add(time.Hour), Loc: loc, Rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY}}, Stamp: start}
	b := a
	b.UID = "b@calab"
	b.Series.Start = later
	b.Series.End = later.Add(time.Hour)
	c := a
	c.UID = "c@calab"
	c.Series.AllDay = true
	c.Series.Start = time.Date(2026, 3, 29, 0, 0, 0, 0, loc)
	c.Series.End = c.Series.Start.AddDate(0, 0, 1)
	out := buildCalendarICS("My calendar", []ICSEvent{a, b, c}, start.AddDate(6, 0, 0))
	parseICS(t, out)
	for _, want := range []string{"RDATE:2044", "DTSTART;VALUE=DATE:20260329", "DTEND;VALUE=DATE:20260330", `SUMMARY:A\nBEGIN:VEVENT`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Count(out, "BEGIN:VTIMEZONE") != 1 || strings.Count(out, "\r\nBEGIN:VEVENT\r\n") != 3 {
		t.Fatal("duplicate zone or unescaped event text")
	}
}
