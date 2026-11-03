package calendar

import (
	"errors"
	"fmt"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Rule is the repeat of a series: the RFC 5545 RRULE subset of ADR-0038 §1.
type Rule struct {
	Repeat v1.EventRepeat
	Until  *time.Time // last allowed occurrence start (inclusive); nil = no end
	// WORKDAYS only: the holiday calendar (HolidaysRU or "" = Mon–Fri), fixed when the repeat
	// was chosen (ADR-0136).
	Holidays string
}

// weekdaysRule is the RRULE of a working-days series (its holidays go to EXDATE / RDATE).
const weekdaysRule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"

// xHolidays is the private rule part that stores the holiday calendar in events.rrule; it is
// never exported (RFC 5545 RRULE has no extension parts).
const xHolidays = "X-CALAB-HOLIDAYS"

// String renders the rule as stored in events.rrule ("" for no repeat), e.g.
// "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T205959Z" or
// "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;X-CALAB-HOLIDAYS=RU".
func (r Rule) String() string {
	s := r.format(false, time.UTC)
	if s != "" && r.Repeat == v1.EventRepeat_EVENT_REPEAT_WORKDAYS && r.Holidays == HolidaysRU {
		s += ";" + xHolidays + "=RU"
	}
	return s
}

// format renders the RFC 5545 RRULE. allDay renders UNTIL as a DATE (RFC 5545: UNTIL has the
// value type of DTSTART), in loc.
func (r Rule) format(allDay bool, loc *time.Location) string {
	var s string
	switch r.Repeat {
	case v1.EventRepeat_EVENT_REPEAT_DAILY:
		s = "FREQ=DAILY"
	case v1.EventRepeat_EVENT_REPEAT_WEEKLY:
		s = "FREQ=WEEKLY"
	case v1.EventRepeat_EVENT_REPEAT_BIWEEKLY:
		s = "FREQ=WEEKLY;INTERVAL=2"
	case v1.EventRepeat_EVENT_REPEAT_MONTHLY:
		s = "FREQ=MONTHLY"
	case v1.EventRepeat_EVENT_REPEAT_WORKDAYS:
		s = weekdaysRule
	default:
		return ""
	}
	if r.Until != nil {
		if allDay {
			s += ";UNTIL=" + r.Until.In(loc).Format("20060102")
		} else {
			s += ";UNTIL=" + r.Until.UTC().Format("20060102T150405Z")
		}
	}
	return s
}

// ParseRule reads what String writes ("" = no repeat). Anything else is an error: the column
// only ever holds the server's own output.
func ParseRule(s string) (Rule, error) {
	var r Rule
	if s == "" {
		return r, nil
	}
	var freq, interval, byday string
	for _, part := range strings.Split(s, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return r, fmt.Errorf("rrule: bad part %q", part)
		}
		switch k {
		case "FREQ":
			freq = v
		case "INTERVAL":
			interval = v
		case "BYDAY":
			byday = v
		case xHolidays:
			if v != "RU" {
				return r, fmt.Errorf("rrule: unknown holidays %q", v)
			}
			r.Holidays = HolidaysRU
		case "UNTIL":
			t, err := time.Parse("20060102T150405Z", v)
			if err != nil {
				return r, fmt.Errorf("rrule: bad UNTIL %q", v)
			}
			r.Until = &t
		default:
			return r, fmt.Errorf("rrule: unsupported %q", k)
		}
	}
	if byday != "" && (freq != "WEEKLY" || interval != "" || byday != "MO,TU,WE,TH,FR") {
		return r, errors.New("rrule: unsupported BYDAY")
	}
	if r.Holidays != "" && byday == "" {
		return r, errors.New("rrule: holidays without BYDAY")
	}
	switch {
	case byday != "":
		r.Repeat = v1.EventRepeat_EVENT_REPEAT_WORKDAYS
	case freq == "DAILY" && interval == "":
		r.Repeat = v1.EventRepeat_EVENT_REPEAT_DAILY
	case freq == "WEEKLY" && interval == "":
		r.Repeat = v1.EventRepeat_EVENT_REPEAT_WEEKLY
	case freq == "WEEKLY" && interval == "2":
		r.Repeat = v1.EventRepeat_EVENT_REPEAT_BIWEEKLY
	case freq == "MONTHLY" && interval == "":
		r.Repeat = v1.EventRepeat_EVENT_REPEAT_MONTHLY
	default:
		return r, errors.New("rrule: unsupported FREQ/INTERVAL")
	}
	return r, nil
}

// Occurrence is one occurrence of a series (UTC instants).
type Occurrence struct {
	Start, End time.Time
}

// Active reports whether now is in the occurrence's room window: from ActiveBefore before its
// start until its end (ADR-0038 §6).
func (o Occurrence) Active(now time.Time) bool {
	return !now.Before(o.Start.Add(-ActiveBefore)) && now.Before(o.End)
}

// ActiveBefore is how long before its start a room shows its meeting.
const ActiveBefore = 15 * time.Minute

// Series is an event's timing: its first occurrence, zone, repeat and cancelled occurrences.
type Series struct {
	Start, End time.Time
	AllDay     bool
	Loc        *time.Location
	Rule       Rule
	Except     map[int64]bool // skipped occurrence starts (Unix seconds): cancelled or moved
	// Moved: the occurrences among Except that an override replaces (ADR-0157). They are no
	// EXDATE in exports (the override's RECURRENCE-ID replaces them) and no cancellation.
	Moved map[int64]bool
}

// maxOccurrences bounds one expansion (a 62-day window of a daily series has 62).
const maxOccurrences = 1000

// nth returns the n-th occurrence (n ≥ 0) and false when that month has no such day (MONTHLY
// on the 29th–31st) or, for WORKDAYS (n counts calendar days), the day is not a working day of
// the series' holiday calendar in Loc. Wall-clock time in Loc is kept, so a 10:00 meeting
// stays at 10:00 across DST; a timed meeting keeps its duration, an all-day one its number of
// days.
func (s Series) nth(n int) (Occurrence, bool) {
	if n == 0 {
		if s.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_WORKDAYS {
			y, m, d := s.Start.In(s.Loc).Date()
			if !isWorkday(s.Rule.Holidays, y, m, d) {
				return Occurrence{}, false
			}
		}
		return Occurrence{s.Start, s.End}, true
	}
	l := s.Start.In(s.Loc)
	y, m, d := l.Date()
	hh, mm, ss := l.Clock()
	var st time.Time
	switch s.Rule.Repeat {
	case v1.EventRepeat_EVENT_REPEAT_DAILY:
		st = time.Date(y, m, d+n, hh, mm, ss, 0, s.Loc)
	case v1.EventRepeat_EVENT_REPEAT_WORKDAYS:
		dy, dm, dd := time.Date(y, m, d+n, 12, 0, 0, 0, time.UTC).Date()
		if !isWorkday(s.Rule.Holidays, dy, dm, dd) {
			return Occurrence{}, false
		}
		st = time.Date(dy, dm, dd, hh, mm, ss, 0, s.Loc)
	case v1.EventRepeat_EVENT_REPEAT_WEEKLY:
		st = time.Date(y, m, d+7*n, hh, mm, ss, 0, s.Loc)
	case v1.EventRepeat_EVENT_REPEAT_BIWEEKLY:
		st = time.Date(y, m, d+14*n, hh, mm, ss, 0, s.Loc)
	case v1.EventRepeat_EVENT_REPEAT_MONTHLY:
		st = time.Date(y, m+time.Month(n), d, hh, mm, ss, 0, s.Loc)
		if st.Day() != d {
			return Occurrence{}, false
		}
	default:
		return Occurrence{}, false
	}
	if s.AllDay {
		days := int(s.End.Sub(s.Start).Round(24*time.Hour) / (24 * time.Hour))
		sy, sm, sd := st.Date()
		return Occurrence{st.UTC(), time.Date(sy, sm, sd+max(days, 1), 0, 0, 0, 0, s.Loc).UTC()}, true
	}
	return Occurrence{st.UTC(), st.Add(s.End.Sub(s.Start)).UTC()}, true
}

// stepDays is the number of calendar days between two occurrences of a daily / weekly series.
func (s Series) stepDays() int {
	switch s.Rule.Repeat {
	case v1.EventRepeat_EVENT_REPEAT_WEEKLY:
		return 7
	case v1.EventRepeat_EVENT_REPEAT_BIWEEKLY:
		return 14
	}
	return 1
}

// civilDay numbers the calendar day of t (in its location).
func civilDay(t time.Time) int {
	y, m, d := t.Date()
	return int(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

// Between returns the live occurrences overlapping [from, to) (end > from, start < to), in
// order, at most maxOccurrences.
func (s Series) Between(from, to time.Time) []Occurrence {
	var out []Occurrence
	if s.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED {
		o := Occurrence{s.Start, s.End}
		if o.End.After(from) && o.Start.Before(to) && !s.Except[o.Start.Unix()] {
			out = append(out, o)
		}
		return out
	}
	// Skip ahead by calendar days / months (exact, whatever the age of the series): occurrence
	// n starts on the n-th step's local date, so every occurrence before the chosen n starts at
	// least a day before from − duration and cannot overlap [from, to).
	n := 0
	if gap := from.Sub(s.End); gap > 0 {
		if s.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_MONTHLY {
			// Months are 28–31 days: skip by calendar months instead.
			fy, fm, _ := from.In(s.Loc).Date()
			sy, sm, _ := s.Start.In(s.Loc).Date()
			n = max((fy-sy)*12+int(fm-sm)-2, 0)
		} else {
			ref := from.Add(-s.End.Sub(s.Start)).In(s.Loc)
			days := civilDay(ref) - civilDay(s.Start.In(s.Loc))
			n = max(days/s.stepDays()-1, 0)
		}
	}
	for steps := 0; steps < maxOccurrences*3 && len(out) < maxOccurrences; steps, n = steps+1, n+1 {
		o, ok := s.nth(n)
		if !ok {
			continue
		}
		if !o.Start.Before(to) || (s.Rule.Until != nil && o.Start.After(*s.Rule.Until)) {
			break
		}
		if o.End.After(from) && !s.Except[o.Start.Unix()] {
			out = append(out, o)
		}
	}
	return out
}

// Next returns the first live occurrence that ends after now, looking at most `within` ahead.
func (s Series) Next(now time.Time, within time.Duration) (Occurrence, bool) {
	occ := s.Between(now, now.Add(within))
	if len(occ) == 0 {
		return Occurrence{}, false
	}
	return occ[0], true
}

// IsOccurrence reports whether start is the start of an occurrence of the series (cancelled
// ones included).
func (s Series) IsOccurrence(start time.Time) bool {
	s.Except = nil // s is a copy
	for _, o := range s.Between(start, start.Add(time.Second)) {
		if o.Start.Equal(start) {
			return true
		}
	}
	return false
}

// ShiftToWorkday moves the start (and the end with it, keeping the wall-clock times in Loc) of
// a WORKDAYS series to its first working day on or after the start: the first occurrence of a
// series is its DTSTART, which RFC 5545 counts even off the rule (ADR-0136).
func (s Series) ShiftToWorkday() (start, end time.Time) {
	if s.Rule.Repeat != v1.EventRepeat_EVENT_REPEAT_WORKDAYS {
		return s.Start, s.End
	}
	ls, le := s.Start.In(s.Loc), s.End.In(s.Loc)
	for k := 0; k < 31; k++ {
		y, m, d := time.Date(ls.Year(), ls.Month(), ls.Day()+k, 12, 0, 0, 0, time.UTC).Date()
		if !isWorkday(s.Rule.Holidays, y, m, d) {
			continue
		}
		if k == 0 {
			return s.Start, s.End
		}
		shift := func(t time.Time) time.Time {
			return time.Date(t.Year(), t.Month(), t.Day()+k, t.Hour(), t.Minute(), t.Second(), 0, s.Loc).UTC()
		}
		return shift(ls), shift(le)
	}
	return s.Start, s.End
}

// UntilAt is the column events.until_at: an upper bound of the end of the last occurrence
// (nil for an endless series).
func (s Series) UntilAt() *time.Time {
	if s.Rule.Repeat == v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED {
		t := s.End
		return &t
	}
	if s.Rule.Until == nil {
		return nil
	}
	t := s.Rule.Until.Add(s.End.Sub(s.Start) + 2*time.Hour) // + DST slack
	return &t
}
