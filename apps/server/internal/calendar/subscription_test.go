package calendar

import (
	"context"
	"errors"
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
	out, err := buildCalendarICS(context.Background(), "My calendar", []ICSEvent{a, b, c}, start.AddDate(6, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
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

func TestCalendarFixedOffsetRecurrenceKeepsLocalDates(t *testing.T) {
	for _, tc := range []struct {
		zone, start, rule string
		repeat            v1.EventRepeat
	}{
		{"Europe/Moscow", "2026-03-01T01:00:00", "FREQ=MONTHLY", v1.EventRepeat_EVENT_REPEAT_MONTHLY},
		{"Asia/Tokyo", "2026-11-02T08:00:00", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", v1.EventRepeat_EVENT_REPEAT_WORKDAYS},
	} {
		t.Run(tc.zone, func(t *testing.T) {
			loc := mustLoc(t, tc.zone)
			start, err := time.ParseInLocation("2006-01-02T15:04:05", tc.start, loc)
			if err != nil {
				t.Fatal(err)
			}
			e := ICSEvent{UID: "local@calab", Series: Series{Start: start, End: start.Add(time.Hour), Loc: loc, Rule: Rule{Repeat: tc.repeat}}, Stamp: start}
			feed, err := buildCalendarICS(context.Background(), "Work", []ICSEvent{e}, start)
			if err != nil {
				t.Fatal(err)
			}
			for _, out := range []string{BuildICS(e), feed} {
				parseICS(t, out)
				for _, want := range []string{"BEGIN:VTIMEZONE", "DTSTART;TZID=" + tc.zone + ":" + start.Format(icsLocal), "RRULE:" + tc.rule} {
					if !strings.Contains(out, want+"\r\n") {
						t.Errorf("missing %q in %s", want, out)
					}
				}
			}
		})
	}
}

func TestCalendarSerializationHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	loc := mustLoc(t, "Europe/Berlin")
	start := time.Date(2000, 1, 1, 9, 0, 0, 0, loc)
	if _, _, err := vtimezoneBetween(ctx, loc, start, start.AddDate(210, 0, 0)); !errors.Is(err, context.Canceled) {
		t.Fatalf("zone cancellation: %v", err)
	}
	if out, err := buildCalendarICS(ctx, "Work", nil, start); !errors.Is(err, context.Canceled) || out != "" {
		t.Fatalf("feed cancellation: %q %v", out, err)
	}
}

func TestCalendarTimezoneExpansionStopsAtDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	loc := mustLoc(t, "Europe/Berlin")
	start := time.Date(2000, 1, 1, 9, 0, 0, 0, loc)
	if _, _, err := vtimezoneBetween(ctx, loc, start, start.AddDate(8000, 0, 0)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unbounded timezone expansion did not stop at deadline: %v", err)
	}
}
