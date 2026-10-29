package calendar

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// ICS methods (RFC 5546).
const (
	MethodRequest = "REQUEST"
	MethodCancel  = "CANCEL"
)

// ICSPerson is an ORGANIZER / ATTENDEE of an invitation.
type ICSPerson struct {
	Name     string
	Email    string
	Optional bool   // ATTENDEE ROLE=OPT-PARTICIPANT
	PartStat string // NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE; "" = NEEDS-ACTION
}

// ICSEvent is what an invitation describes (ADR-0038 §4).
type ICSEvent struct {
	UID         string // <event id>@calab
	Sequence    int
	Method      string // "" = none (a CalDAV object)
	Series      Series
	Title       string
	Description string
	Location    string
	URL         string
	Organizer   ICSPerson
	Attendees   []ICSPerson
	Stamp       time.Time
}

const icsDate, icsUTC, icsLocal = "20060102", "20060102T150405Z", "20060102T150405"

// BuildICS renders a VCALENDAR with one VEVENT (CRLF lines folded at 75 octets). Times are UTC,
// except a repeating timed series in a zone with DST: its DTSTART / DTEND carry the TZID with a
// VTIMEZONE (the transitions of ten years), so calendars keep its wall-clock time.
func BuildICS(e ICSEvent) string {
	var b strings.Builder
	line := func(s string) { b.WriteString(fold(s)) }
	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	line("PRODID:-//Calab//Calendar//EN")
	line("CALSCALE:GREGORIAN")
	if e.Method != "" { // a CalDAV object resource has no METHOD (RFC 4791 §4.1)
		line("METHOD:" + e.Method)
	}
	appendICSEvent(&b, e, map[string]bool{})
	line("END:VCALENDAR")
	return b.String()
}

// buildCalendarICS writes a subscription, not an invitation. Time zones are shared by
// all events and included once; event UIDs and sequences remain the source's identity.
func buildCalendarICS(name string, events []ICSEvent, at time.Time) string {
	var b strings.Builder
	b.WriteString("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calab//Calendar//EN\r\nCALSCALE:GREGORIAN\r\n")
	b.WriteString(fold("X-WR-CALNAME:" + icsText(name)))
	zones := map[string]bool{}
	type zoneSpan struct {
		loc         *time.Location
		first, last time.Time
	}
	spans := map[string]zoneSpan{}
	for _, e := range events {
		s := e.Series
		if s.AllDay || s.Rule.Repeat == 0 {
			continue
		}
		name := s.Loc.String()
		z, ok := spans[name]
		if !ok {
			z = zoneSpan{s.Loc, s.Start, at}
		}
		if s.Start.Before(z.first) {
			z.first = s.Start
		}
		if s.Start.After(z.last) {
			z.last = s.Start
		}
		spans[name] = z
	}
	names := make([]string, 0, len(spans))
	for name := range spans {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		z := spans[name]
		lines, ok := vtimezoneBetween(z.loc, z.first, z.last.AddDate(10, 0, 0))
		zones[name] = ok
		for _, line := range lines {
			b.WriteString(fold(line))
		}
	}
	for _, e := range events {
		e.Method, e.Organizer, e.Attendees = "", ICSPerson{}, nil
		appendICSEvent(&b, e, zones)
	}
	b.WriteString("END:VCALENDAR\r\n")
	return b.String()
}

func appendICSEvent(b *strings.Builder, e ICSEvent, zones map[string]bool) {
	line := func(s string) { b.WriteString(fold(s)) }
	s := e.Series
	var tzid string
	if !s.AllDay && s.Rule.Repeat != 0 {
		name := s.Loc.String()
		enabled, cached := zones[name]
		if !cached {
			vtz, ok := vtimezone(s.Loc, s.Start)
			enabled = ok
			zones[name] = ok
			for _, l := range vtz {
				line(l)
			}
		}
		if enabled {
			tzid = name
		}
	}
	line("BEGIN:VEVENT")
	line("UID:" + e.UID)
	line("SEQUENCE:" + fmt.Sprint(e.Sequence))
	line("DTSTAMP:" + e.Stamp.UTC().Format(icsUTC))
	switch {
	case s.AllDay:
		line("DTSTART;VALUE=DATE:" + s.Start.In(s.Loc).Format(icsDate))
		line("DTEND;VALUE=DATE:" + s.End.In(s.Loc).Format(icsDate))
	case tzid != "":
		line("DTSTART;TZID=" + tzid + ":" + s.Start.In(s.Loc).Format(icsLocal))
		line("DTEND;TZID=" + tzid + ":" + s.End.In(s.Loc).Format(icsLocal))
	default:
		line("DTSTART:" + s.Start.UTC().Format(icsUTC))
		line("DTEND:" + s.End.UTC().Format(icsUTC))
	}
	if rr := s.Rule.format(s.AllDay, s.Loc); rr != "" {
		line("RRULE:" + rr)
		// A date-time property in the value type of DTSTART.
		prop := func(name string, t time.Time) string {
			switch {
			case s.AllDay:
				return name + ";VALUE=DATE:" + t.In(s.Loc).Format(icsDate)
			case tzid != "":
				return name + ";TZID=" + tzid + ":" + t.In(s.Loc).Format(icsLocal)
			}
			return name + ":" + t.UTC().Format(icsUTC)
		}
		ex := make([]int64, 0, len(s.Except))
		for k := range s.Except {
			ex = append(ex, k)
		}
		off, working := s.holidayDates()
		for _, t := range off {
			if !s.Except[t.Unix()] {
				ex = append(ex, t.Unix())
			}
		}
		slices.Sort(ex)
		for _, k := range ex {
			line(prop("EXDATE", time.Unix(k, 0)))
		}
		for _, t := range working {
			line(prop("RDATE", t))
		}
	}
	line("SUMMARY:" + icsText(e.Title))
	if e.Description != "" {
		line("DESCRIPTION:" + icsText(e.Description))
	}
	if e.Location != "" {
		line("LOCATION:" + icsText(e.Location))
	}
	if e.URL != "" {
		line("URL:" + e.URL)
	}
	if e.Method == MethodCancel {
		line("STATUS:CANCELLED")
	} else {
		line("STATUS:CONFIRMED")
	}
	if e.Organizer.Email != "" {
		line("ORGANIZER;CN=" + icsParam(e.Organizer.Name) + ":mailto:" + e.Organizer.Email)
	}
	for _, a := range e.Attendees {
		role := "REQ-PARTICIPANT"
		if a.Optional {
			role = "OPT-PARTICIPANT"
		}
		ps := a.PartStat
		if ps == "" {
			ps = "NEEDS-ACTION"
		}
		cn := ""
		if a.Name != "" {
			cn = ";CN=" + icsParam(a.Name)
		}
		line("ATTENDEE" + cn + ";ROLE=" + role + ";PARTSTAT=" + ps + ";RSVP=TRUE:mailto:" + a.Email)
	}
	line("END:VEVENT")
}

// PartStat maps an attendee status to iCalendar PARTSTAT.
func PartStat(status string) string {
	switch status {
	case StatusAccepted:
		return "ACCEPTED"
	case StatusDeclined:
		return "DECLINED"
	case StatusMaybe:
		return "TENTATIVE"
	}
	return "NEEDS-ACTION"
}

// icsText escapes a TEXT value (RFC 5545 §3.3.11); control characters other than the line
// break and the tab are dropped (TEXT excludes them).
func icsText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\n", `\n`).Replace(s)
}

// icsParam quotes a parameter value; DQUOTE and control characters are dropped.
func icsParam(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '"' || r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return `"` + s + `"`
}

// fold splits a content line into ≤ 75-octet lines (continuations start with a space),
// never inside a UTF-8 sequence, and ends it with CRLF.
func fold(s string) string {
	var b strings.Builder
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut] + "\r\n ")
		s = s[cut:]
		limit = 74 // the leading space counts
	}
	b.WriteString(s + "\r\n")
	return b.String()
}

// vtimezone describes loc's UTC offset changes from a year before start to ten years after it
// (STANDARD / DAYLIGHT with RDATEs); false = the offset never changes there (UTC is enough).
func vtimezone(loc *time.Location, start time.Time) ([]string, bool) {
	return vtimezoneBetween(loc, start, start.AddDate(10, 0, 0))
}

func vtimezoneBetween(loc *time.Location, start, end time.Time) ([]string, bool) {
	type change struct {
		at       time.Time // the instant of the change
		from, to int       // offsets in seconds
		name     string
	}
	var changes []change
	t := start.AddDate(-1, 0, 0).UTC().Truncate(24 * time.Hour)
	_, prev := t.In(loc).Zone()
	for ; t.Before(end); t = t.Add(24 * time.Hour) {
		next := t.Add(24 * time.Hour)
		name, off := next.In(loc).Zone()
		if off == prev {
			continue
		}
		lo, hi := t, next // the change is in (lo, hi]
		for hi.Sub(lo) > time.Second {
			mid := lo.Add(hi.Sub(lo) / 2)
			if _, o := mid.In(loc).Zone(); o == prev {
				lo = mid
			} else {
				hi = mid
			}
		}
		changes = append(changes, change{hi, prev, off, name})
		prev = off
	}
	if len(changes) == 0 {
		return nil, false
	}
	// The larger offset of a pair is daylight time.
	maxOff := changes[0].to
	for _, c := range changes {
		maxOff = max(maxOff, c.to, c.from)
	}
	offset := func(sec int) string {
		sign := "+"
		if sec < 0 {
			sign, sec = "-", -sec
		}
		return fmt.Sprintf("%s%02d%02d", sign, sec/3600, sec%3600/60)
	}
	out := []string{"BEGIN:VTIMEZONE", "TZID:" + loc.String()}
	for _, kind := range []string{"DAYLIGHT", "STANDARD"} {
		var group []change
		for _, c := range changes {
			if (c.to == maxOff) == (kind == "DAYLIGHT") {
				group = append(group, c)
			}
		}
		if len(group) == 0 {
			continue
		}
		// DTSTART / RDATE are local times of the offset in effect before the change.
		local := func(c change) string { return c.at.Add(time.Duration(c.from) * time.Second).UTC().Format(icsLocal) }
		out = append(out, "BEGIN:"+kind, "DTSTART:"+local(group[0]),
			"TZOFFSETFROM:"+offset(group[0].from), "TZOFFSETTO:"+offset(group[0].to), "TZNAME:"+group[0].name)
		for _, c := range group[1:] {
			out = append(out, "RDATE:"+local(c))
		}
		out = append(out, "END:"+kind)
	}
	return append(out, "END:VTIMEZONE"), true
}

// holidayDates are the occurrence starts that a working-days series on the Russian calendar
// differs by from its RRULE (Mon–Fri) in the years the table covers (ADR-0136): off = weekday
// holidays (EXDATE), working = transferred working Saturdays / Sundays (RDATE, bounded by
// UNTIL, which does not limit RDATE in RFC 5545). Both from the series' start on, in order.
func (s Series) holidayDates() (off, working []time.Time) {
	if s.Rule.Repeat != v1.EventRepeat_EVENT_REPEAT_WORKDAYS || s.Rule.Holidays != HolidaysRU {
		return nil, nil
	}
	ls := s.Start.In(s.Loc)
	last := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
	if u := s.Rule.Until; u != nil {
		last = u.In(s.Loc)
	}
	from := time.Date(ls.Year(), ls.Month(), ls.Day(), 0, 0, 0, 0, time.UTC)
	to := time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, time.UTC)
	at := func(d time.Time) time.Time {
		if s.AllDay {
			return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, s.Loc).UTC()
		}
		return time.Date(d.Year(), d.Month(), d.Day(), ls.Hour(), ls.Minute(), ls.Second(), 0, s.Loc).UTC()
	}
	offD, workD := prodRUChanges(from, to)
	for _, d := range offD {
		off = append(off, at(d))
	}
	for _, d := range workD {
		if t := at(d); s.Rule.Until == nil || !t.After(*s.Rule.Until) {
			working = append(working, t)
		}
	}
	return off, working
}
