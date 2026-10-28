package caldav

import (
	"testing"
	"time"
)

func TestBusyPreservesSourceDates(t *testing.T) {
	data := ics("BEGIN:VEVENT\r\nUID:dates\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261026\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n")
	for _, zone := range []string{"Europe/Berlin", "Pacific/Auckland", "America/Los_Angeles"} {
		t.Run(zone, func(t *testing.T) {
			loc := mustLoc(t, zone)
			got := BusyFromICS(data, utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), loc)
			if len(got) != 3 {
				t.Fatalf("got %d occurrences", len(got))
			}
			for i, b := range got {
				start := time.Date(2026, 10, 24+i, 0, 0, 0, 0, loc)
				end := start.AddDate(0, 0, 2)
				if !b.AllDay || b.StartDate != start.Format(time.DateOnly) || b.EndDate != end.Format(time.DateOnly) {
					t.Fatalf("occurrence %d lost exclusive source dates: %+v", i, b)
				}
				if !b.Start.Equal(start) || !b.End.Equal(end) {
					t.Fatalf("occurrence %d changed the existing instant interval: %+v", i, b)
				}
			}
		})
	}
	timed := BusyFromICS(ics("BEGIN:VEVENT\r\nUID:timed\r\nDTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z\r\nEND:VEVENT\r\n"), utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), time.UTC)
	if len(timed) != 1 || timed[0].StartDate != "" || timed[0].EndDate != "" {
		t.Fatalf("timed event acquired DATE fields: %+v", timed)
	}
	params, err := insertParams([16]byte{1}, append(BusyFromICS(data, utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), time.UTC), timed...))
	if err != nil {
		t.Fatal(err)
	}
	if len(params.StartDates) != 4 || len(params.EndDates) != 4 || params.StartDates[0] != "2026-10-24" || params.EndDates[2] != "2026-10-28" || params.StartDates[3] != "" || params.EndDates[3] != "" {
		t.Fatalf("batch date arrays lost alignment: %+v", params)
	}
}
