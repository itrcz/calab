package calendar

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestShiftOccurrence(t *testing.T) {
	msk, ber := mustLoc(t, "Europe/Moscow"), mustLoc(t, "Europe/Berlin")
	from := time.Date(2026, 11, 10, 10, 0, 0, 0, msk)
	cases := []struct {
		name     string
		t, to    time.Time
		toLoc    *time.Location
		allDay   bool
		expected time.Time
	}{
		{"same day later", from.AddDate(0, 0, 14), from.Add(2 * time.Hour), msk, false, time.Date(2026, 11, 24, 12, 0, 0, 0, msk)},
		{"next day", from.AddDate(0, 0, 7), from.AddDate(0, 0, 1), msk, false, time.Date(2026, 11, 18, 10, 0, 0, 0, msk)},
		// Wall-clock time in the new zone, whatever its DST: March 30 is summer time in Berlin.
		{"other zone over DST", time.Date(2027, 3, 30, 10, 0, 0, 0, msk), time.Date(2026, 11, 10, 9, 0, 0, 0, ber), ber, false, time.Date(2027, 3, 30, 9, 0, 0, 0, ber)},
		{"all day", time.Date(2026, 11, 17, 0, 0, 0, 0, msk), time.Date(2026, 11, 11, 0, 0, 0, 0, msk), msk, true, time.Date(2026, 11, 18, 0, 0, 0, 0, msk)},
	}
	for _, c := range cases {
		if got := shiftOccurrence(c.t, from, c.to, msk, c.toLoc, c.allDay); !got.Equal(c.expected) {
			t.Errorf("%s: %v, want %v", c.name, got.In(c.toLoc), c.expected)
		}
	}
}

// A series with its overrides under one UID: RECURRENCE-ID in the value type of the series'
// DTSTART; a moved occurrence is no EXDATE, a cancelled one and an override left out are.
func TestSeriesExportICS(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	start := time.Date(2026, 11, 10, 0, 0, 0, 0, msk)
	id := uuid.New()
	rule := "FREQ=WEEKLY"
	master := &bundle{ev: sqlc.Event{ID: id, Title: "Series", AllDay: true, Tz: "Europe/Moscow", Rrule: &rule},
		series: seriesOf(sqlc.Event{StartsAt: start.UTC(), EndsAt: start.AddDate(0, 0, 1).UTC(), AllDay: true, Tz: "Europe/Moscow", Rrule: &rule},
			[]time.Time{start.AddDate(0, 0, 21).UTC()}, []time.Time{start.AddDate(0, 0, 7).UTC(), start.AddDate(0, 0, 14).UTC()})}
	override := func(week int) *bundle {
		at := start.AddDate(0, 0, 7*week).UTC()
		s := at.Add(10 * time.Hour)
		return &bundle{ev: sqlc.Event{ID: uuid.New(), Title: "Moved", SeriesID: &id, RecurrenceAt: &at},
			series: Series{Start: s, End: s.Add(time.Hour), Loc: msk}}
	}
	conv := func(b *bundle) ICSEvent {
		return ICSEvent{UID: b.ev.ID.String() + "@calab", Series: b.series, Title: b.ev.Title, Stamp: start}
	}
	// The reader keeps week 1's override, not week 2's (declined): week 2 becomes an EXDATE.
	e, ok := seriesExport(master, true, []*bundle{override(1)}, conv)
	if !ok {
		t.Fatal("nothing exported")
	}
	ics := BuildICS(e)
	for _, want := range []string{"RRULE:FREQ=WEEKLY", "RECURRENCE-ID;VALUE=DATE:20261117", "EXDATE;VALUE=DATE:20261124", "EXDATE;VALUE=DATE:20261201"} {
		if !strings.Contains(ics, want) {
			t.Errorf("no %q in\n%s", want, ics)
		}
	}
	if strings.Count(ics, "UID:"+id.String()+"@calab") != 2 || strings.Contains(ics, "EXDATE;VALUE=DATE:20261117") {
		t.Errorf("series and override:\n%s", ics)
	}
	// Without the series (the reader is on the occurrence only): the override alone, same UID.
	e, ok = seriesExport(master, false, []*bundle{override(1)}, conv)
	if ics := BuildICS(e); !ok || strings.Contains(ics, "RRULE") || !strings.Contains(ics, "UID:"+id.String()+"@calab") {
		t.Errorf("override alone:\n%s", ics)
	}
	if _, ok := seriesExport(master, false, nil, conv); ok {
		t.Error("an empty export")
	}
}

func TestLiveOccurrence(t *testing.T) {
	start := time.Date(2026, 11, 10, 7, 0, 0, 0, time.UTC)
	rule := "FREQ=DAILY"
	ev := sqlc.Event{StartsAt: start, EndsAt: start.Add(time.Hour), Tz: "UTC", Rrule: &rule}
	b := &bundle{ev: ev, series: seriesOf(ev, []time.Time{start.AddDate(0, 0, 1)}, []time.Time{start.AddDate(0, 0, 2)})}
	for d, want := range map[int]bool{0: true, 1: false, 2: false, 3: true} {
		if _, ok := b.liveOccurrence(start.AddDate(0, 0, d)); ok != want {
			t.Errorf("day %d: %v", d, ok)
		}
	}
	if _, ok := b.liveOccurrence(start.Add(time.Minute)); ok {
		t.Error("not an occurrence")
	}
	one := &bundle{ev: sqlc.Event{StartsAt: start, EndsAt: start.Add(time.Hour)}, series: Series{Start: start, End: start.Add(time.Hour), Loc: time.UTC}}
	if _, ok := one.liveOccurrence(start); ok || one.series.Rule.Repeat != v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED {
		t.Error("a one-off meeting has no occurrences to scope")
	}
}
