package calendar

import (
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

const workdays = v1.EventRepeat_EVENT_REPEAT_WORKDAYS

// days lists the local dates of the occurrences.
func days(occ []Occurrence, loc *time.Location) string {
	out := make([]string, len(occ))
	for i, o := range occ {
		out[i] = o.Start.In(loc).Format("01-02")
	}
	return strings.Join(out, " ")
}

func workdaySeries(start time.Time, dur time.Duration, hol string) Series {
	return Series{Start: start.UTC(), End: start.Add(dur).UTC(), Loc: start.Location(), Rule: Rule{Repeat: workdays, Holidays: hol}}
}

func TestWorkdaysRuleRoundTrip(t *testing.T) {
	until := time.Date(2027, 3, 1, 20, 59, 59, 0, time.UTC)
	for _, r := range []Rule{
		{Repeat: workdays},
		{Repeat: workdays, Holidays: HolidaysRU},
		{Repeat: workdays, Holidays: HolidaysRU, Until: &until},
	} {
		got, err := ParseRule(r.String())
		if err != nil || got.Repeat != workdays || got.Holidays != r.Holidays || (r.Until == nil) != (got.Until == nil) {
			t.Errorf("%q: %+v %v", r.String(), got, err)
		}
	}
	if s := (Rule{Repeat: workdays, Holidays: HolidaysRU, Until: &until}).String(); s != "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270301T205959Z;X-CALAB-HOLIDAYS=RU" {
		t.Errorf("stored: %q", s)
	}
	// The private part never reaches an export.
	if s := (Rule{Repeat: workdays, Holidays: HolidaysRU}).format(false, time.UTC); s != "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" {
		t.Errorf("exported: %q", s)
	}
	for _, bad := range []string{"FREQ=WEEKLY;BYDAY=MO", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", "FREQ=WEEKLY;X-CALAB-HOLIDAYS=RU",
		"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;X-CALAB-HOLIDAYS=KZ", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR"} {
		if _, err := ParseRule(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestProdcalRUTable(t *testing.T) {
	// Labour Code art. 112 holidays are never working days in the covered years.
	for y := prodRUFirst; y <= prodRULast; y++ {
		for _, md := range [][2]int{{1, 1}, {1, 2}, {1, 3}, {1, 4}, {1, 5}, {1, 6}, {1, 7}, {1, 8}, {2, 23}, {3, 8}, {5, 1}, {5, 9}, {6, 12}, {11, 4}} {
			if isWorkday(HolidaysRU, y, time.Month(md[0]), md[1]) {
				t.Errorf("%d-%02d-%02d is a working day", y, md[0], md[1])
			}
		}
	}
	// The number of working days per year as published with the decrees.
	for y, want := range map[int]int{2025: 247, 2026: 247, 2027: 247} {
		n := 0
		for d := time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC); d.Year() == y; d = d.AddDate(0, 0, 1) {
			if isWorkday(HolidaysRU, y, d.Month(), d.Day()) {
				n++
			}
		}
		if n != want {
			t.Errorf("%d: %d working days, want %d", y, n, want)
		}
	}
}

func TestExpandWorkdaysRU(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	at := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, msk) }
	s := workdaySeries(time.Date(2025, 9, 1, 10, 0, 0, 0, msk), time.Hour, HolidaysRU)
	plain := workdaySeries(s.Start.In(msk), time.Hour, "")
	for _, c := range []struct {
		name     string
		from, to time.Time
		ru, plan string
	}{
		{"May 2026", at(2026, 4, 27), at(2026, 5, 16),
			"04-27 04-28 04-29 04-30 05-04 05-05 05-06 05-07 05-08 05-12 05-13 05-14 05-15",
			"04-27 04-28 04-29 04-30 05-01 05-04 05-05 05-06 05-07 05-08 05-11 05-12 05-13 05-14 05-15"},
		{"New Year 2027", at(2026, 12, 28), at(2027, 1, 16),
			"12-28 12-29 12-30 01-11 01-12 01-13 01-14 01-15",
			"12-28 12-29 12-30 12-31 01-01 01-04 01-05 01-06 01-07 01-08 01-11 01-12 01-13 01-14 01-15"},
		{"working Saturday 20.02.2027", at(2027, 2, 15), at(2027, 2, 27),
			"02-15 02-16 02-17 02-18 02-19 02-20 02-24 02-25 02-26",
			"02-15 02-16 02-17 02-18 02-19 02-22 02-23 02-24 02-25 02-26"},
		{"working Saturday 01.11.2025", at(2025, 10, 30), at(2025, 11, 8),
			"10-30 10-31 11-01 11-05 11-06 11-07",
			"10-30 10-31 11-03 11-04 11-05 11-06 11-07"},
	} {
		if got := days(s.Between(c.from, c.to), msk); got != c.ru {
			t.Errorf("%s ru:\n got %s\nwant %s", c.name, got, c.ru)
		}
		if got := days(plain.Between(c.from, c.to), msk); got != c.plan {
			t.Errorf("%s Mon–Fri:\n got %s\nwant %s", c.name, got, c.plan)
		}
	}
	// The wall-clock time and duration are kept; a cancelled occurrence is gone.
	occ := s.Between(at(2027, 2, 20), at(2027, 2, 21))
	if len(occ) != 1 || occ[0].Start.In(msk).Format("15:04") != "10:00" || occ[0].End.Sub(occ[0].Start) != time.Hour {
		t.Errorf("Saturday occurrence %v", occ)
	}
	s.Except = map[int64]bool{occ[0].Start.Unix(): true}
	if got := s.Between(at(2027, 2, 20), at(2027, 2, 21)); len(got) != 0 {
		t.Errorf("cancelled %v", got)
	}
	if s.IsOccurrence(time.Date(2026, 5, 11, 10, 0, 0, 0, msk)) || !s.IsOccurrence(time.Date(2026, 5, 12, 10, 0, 0, 0, msk)) {
		t.Error("IsOccurrence around May 11 2026")
	}
	// Beyond the table (2028): Mon–Fri.
	if got := days(s.Between(at(2028, 1, 1), at(2028, 1, 8)), msk); got != "01-03 01-04 01-05 01-06 01-07" {
		t.Errorf("2028 fallback %s", got)
	}
	// Until bounds the series.
	until := time.Date(2026, 5, 6, 10, 0, 0, 0, msk).UTC()
	s.Rule.Until = &until
	if got := days(s.Between(at(2026, 4, 30), at(2026, 5, 16)), msk); got != "04-30 05-04 05-05 05-06" {
		t.Errorf("until %s", got)
	}
}

// The date is the series' own: at 01:00 in Yekaterinburg (UTC+5) it is still the previous
// day in Moscow, and the holiday is the one of Yekaterinburg's date.
func TestExpandWorkdaysZone(t *testing.T) {
	ekb, msk := mustLoc(t, "Asia/Yekaterinburg"), mustLoc(t, "Europe/Moscow")
	s := workdaySeries(time.Date(2026, 5, 4, 1, 0, 0, 0, ekb), 30*time.Minute, HolidaysRU)
	occ := s.Between(time.Date(2026, 5, 7, 0, 0, 0, 0, ekb), time.Date(2026, 5, 14, 0, 0, 0, 0, ekb))
	if got := days(occ, ekb); got != "05-07 05-08 05-12 05-13" {
		t.Errorf("Yekaterinburg dates %s", got)
	}
	// The same instants in Moscow: the evening before (May 11 23:00 is a holiday there).
	if got := starts(occ, msk); strings.Join(got, ",") != "2026-05-06 23:00/30m0s,2026-05-07 23:00/30m0s,2026-05-11 23:00/30m0s,2026-05-12 23:00/30m0s" {
		t.Errorf("Moscow view %v", got)
	}
	// A Moscow series at the same instant follows Moscow's dates.
	m := workdaySeries(time.Date(2026, 5, 3, 23, 0, 0, 0, msk), 30*time.Minute, HolidaysRU)
	if got := days(m.Between(time.Date(2026, 5, 7, 0, 0, 0, 0, msk), time.Date(2026, 5, 13, 0, 0, 0, 0, msk)), msk); got != "05-07 05-08 05-12" {
		t.Errorf("Moscow dates %s", got)
	}
}

func TestExpandWorkdaysMatchesBruteForce(t *testing.T) {
	for _, zone := range []string{"Europe/Moscow", "Asia/Yekaterinburg", "America/New_York"} {
		loc := mustLoc(t, zone)
		for _, hol := range []string{"", HolidaysRU} {
			for _, dur := range []time.Duration{30 * time.Minute, 50 * time.Hour} {
				s := workdaySeries(time.Date(2024, 12, 30, 23, 30, 0, 0, loc), dur, hol)
				for _, from := range []time.Time{time.Date(2025, 4, 20, 0, 0, 0, 0, loc), time.Date(2026, 12, 1, 0, 0, 0, 0, loc),
					time.Date(2027, 10, 20, 0, 0, 0, 0, loc)} {
					to := from.Add(MaxListWindow)
					var want []Occurrence
					for n := 0; n < 5000; n++ {
						if o, ok := s.nth(n); ok && o.Start.Before(to) && o.End.After(from) {
							want = append(want, o)
						}
					}
					if got := s.Between(from, to); !slices.Equal(starts(got, loc), starts(want, loc)) {
						t.Errorf("%s %q %v from %v: got %d, want %d", zone, hol, dur, from, len(got), len(want))
					}
				}
			}
		}
	}
}

func TestShiftToWorkday(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	sat := time.Date(2026, 5, 9, 10, 0, 0, 0, msk) // Saturday before the May 11 holiday
	for _, c := range []struct {
		hol, want string
	}{{HolidaysRU, "2026-05-12 10:00"}, {"", "2026-05-11 10:00"}} {
		st, en := workdaySeries(sat, 90*time.Minute, c.hol).ShiftToWorkday()
		if st.In(msk).Format("2006-01-02 15:04") != c.want || en.Sub(st) != 90*time.Minute {
			t.Errorf("%q: %v–%v", c.hol, st.In(msk), en.In(msk))
		}
	}
	f := fields{title: "x", start: sat.UTC(), end: sat.Add(time.Hour).UTC(), tz: "Europe/Moscow", rule: Rule{Repeat: workdays, Holidays: HolidaysRU}}
	if err := f.normalize(); err != nil || f.start.In(msk).Format("01-02 15:04") != "05-12 10:00" {
		t.Errorf("normalize: %v %v", f.start.In(msk), err)
	}
	f = fields{title: "x", start: sat.UTC(), end: sat.Add(time.Hour).UTC(), tz: "Europe/Moscow", rule: Rule{Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, Holidays: HolidaysRU}}
	if err := f.normalize(); err != nil || !f.start.Equal(sat) || f.rule.Holidays != "" {
		t.Errorf("weekly normalize: %v %+v %v", f.start.In(msk), f.rule, err)
	}
}

func TestBuildICSWorkdays(t *testing.T) {
	msk := mustLoc(t, "Europe/Moscow")
	start := time.Date(2026, 10, 5, 10, 0, 0, 0, msk)
	e := ICSEvent{UID: "x@calab", Method: MethodRequest, Stamp: start, Title: "Daily",
		Series: workdaySeries(start, 15*time.Minute, HolidaysRU)}
	// A cancelled occurrence on a holiday is listed once.
	e.Series.Except = map[int64]bool{time.Date(2026, 11, 4, 10, 0, 0, 0, msk).Unix(): true, time.Date(2026, 10, 7, 10, 0, 0, 0, msk).Unix(): true}
	p := parseICS(t, BuildICS(e))
	if got := p["RRULE"]; len(got) != 1 || got[0] != "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" {
		t.Errorf("RRULE %v", got)
	}
	wantEx := []string{"20261007T100000", "20261104T100000", "20261231T100000", "20270101T100000", "20270104T100000",
		"20270105T100000", "20270106T100000", "20270107T100000", "20270108T100000", "20270222T100000", "20270223T100000",
		"20270308T100000", "20270503T100000", "20270510T100000", "20270614T100000", "20271104T100000", "20271105T100000",
		"20271231T100000"}
	if got := p["EXDATE;TZID=Europe/Moscow"]; !slices.Equal(got, wantEx) {
		t.Errorf("EXDATE\n got %v\nwant %v", got, wantEx)
	}
	if got := p["RDATE;TZID=Europe/Moscow"]; !slices.Equal(got, []string{"20270220T100000"}) {
		t.Errorf("RDATE %v", got)
	}
	// Until before the working Saturday: no RDATE; all-day: DATE values; Mon–Fri: neither.
	until := time.Date(2027, 1, 31, 0, 0, 0, 0, time.UTC)
	day := time.Date(2026, 12, 28, 0, 0, 0, 0, msk)
	e.Series = Series{Start: day.UTC(), End: day.AddDate(0, 0, 1).UTC(), AllDay: true, Loc: msk,
		Rule: Rule{Repeat: workdays, Holidays: HolidaysRU, Until: &until}}
	p = parseICS(t, BuildICS(e))
	if got := p["EXDATE;VALUE=DATE"]; strings.Join(got, ",") != "20261231,20270101,20270104,20270105,20270106,20270107,20270108" || len(p["RDATE;VALUE=DATE"]) != 0 {
		t.Errorf("all-day %v", p)
	}
	e.Series.Rule.Holidays = ""
	p = parseICS(t, BuildICS(e))
	if len(p["EXDATE;VALUE=DATE"])+len(p["RDATE;VALUE=DATE"]) != 0 || p["RRULE"][0] != "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270131" {
		t.Errorf("Mon–Fri %v", p)
	}
}

func TestHolidaysFor(t *testing.T) {
	for _, c := range []struct{ market, locale, want string }{
		{"ru", "en", HolidaysRU}, {"global", "ru", ""}, {"", "ru", HolidaysRU}, {"", "", ""}, {"", "es", ""},
	} {
		if got := holidaysFor(c.market, c.locale); got != c.want {
			t.Errorf("%+v: %q", c, got)
		}
	}
	if repeatText("ru", Rule{Repeat: workdays, Holidays: HolidaysRU}) != "в рабочие дни (по производственному календарю РФ)" ||
		repeatText("en", Rule{Repeat: workdays}) != "on working days (Mon–Fri)" {
		t.Error("repeatText")
	}
}
