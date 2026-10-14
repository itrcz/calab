package caldav

import (
	"errors"
	"strings"
	"time"
)

// Deleting one occurrence of a series in the owner's calendar object (ADR-0045 amendment 1): the
// object is rewritten as little as possible — the master VEVENT gets an EXDATE (in the form of its
// DTSTART: a DATE, a TZID local time, UTC or floating) and a changed occurrence (a VEVENT with that
// RECURRENCE-ID) is dropped. Every other line, folding included, stays as the server wrote it.

// errNoOccurrence: the object has no such occurrence (it changed since the import).
var errNoOccurrence = errors.New("caldav: the occurrence is not in the calendar object")

// exdateLine is the EXDATE content line of a RECURRENCE-ID (its TZID / VALUE kept, RANGE dropped).
func exdateLine(params map[string]string, val string) string {
	var b strings.Builder
	b.WriteString("EXDATE")
	if v := params["VALUE"]; v != "" {
		b.WriteString(";VALUE=" + v)
	}
	if tz := params["TZID"]; tz != "" {
		b.WriteString(";TZID=" + quoteParam(tz))
	}
	b.WriteString(":" + val)
	return b.String()
}

// quoteParam quotes a parameter value with : ; or , (RFC 5545 §3.2).
func quoteParam(v string) string {
	if strings.ContainsAny(v, ":;,") {
		return `"` + strings.ReplaceAll(v, `"`, "") + `"`
	}
	return v
}

// exdateFor is the EXDATE line of the master's occurrence at start, in the form of its DTSTART.
func (ev vevent) exdateFor(start time.Time) string {
	loc := ev.start.t.Location()
	switch {
	case ev.start.date:
		return "EXDATE;VALUE=DATE:" + start.In(loc).Format("20060102")
	case ev.startUTC:
		return "EXDATE:" + start.UTC().Format("20060102T150405Z")
	case ev.startTZID != "":
		return "EXDATE;TZID=" + quoteParam(ev.startTZID) + ":" + start.In(loc).Format("20060102T150405")
	}
	return "EXDATE:" + start.In(loc).Format("20060102T150405") // floating: in the zone it was read in
}

// icsBlock is a VEVENT of an object: its logical lines [from, to] (BEGIN … END) and what it is.
type icsBlock struct {
	from, to int
	ev       vevent
	ok       bool
}

// excludeOccurrence returns the object data without the occurrence of the event uid (the hash)
// starting at start, read with fallback as the zone of floating times (as the import did). whole:
// nothing of the object would be left — delete it instead.
func excludeOccurrence(data, uid string, start time.Time, fallback *time.Location) (out string, whole bool, err error) {
	lines, logical := icsLines(data) // logical lines, each with its physical (folded) lines
	var blocks []icsBlock
	depth, open := 0, -1
	for i := range lines {
		name, _, val := contentLine(logical(i))
		comp := strings.ToUpper(strings.TrimSpace(val))
		switch name {
		case "BEGIN":
			depth++
			if comp == "VEVENT" && depth == 2 {
				open = i
			}
		case "END":
			if comp == "VEVENT" && depth == 2 && open >= 0 {
				var b strings.Builder
				for j := open; j <= i; j++ {
					b.WriteString(logical(j) + "\n")
				}
				evs := parseEvents(b.String(), fallback)
				blk := icsBlock{from: open, to: i}
				if len(evs) == 1 {
					blk.ev, blk.ok = evs[0], true
				}
				blocks = append(blocks, blk)
				open = -1
			}
			depth--
		}
	}
	mine := func(b icsBlock) bool { return b.ok && uidHash(b.ev.uid) == uid }
	master, drop, exdate := -1, -1, ""
	for i, b := range blocks {
		switch {
		case !mine(b):
		case b.ev.recurrenceID == nil:
			master = i
		case drop < 0 && b.ev.start.t.Equal(start):
			drop, exdate = i, b.ev.recurrenceIDLine
		}
	}
	if drop < 0 {
		if master < 0 {
			return "", false, errNoOccurrence
		}
		ev := blocks[master].ev
		// The master's occurrences there, with the changed ones excluded (as BusyFromICS does).
		for _, b := range blocks {
			if mine(b) && b.ev.recurrenceID != nil {
				ev.exdates = append(ev.exdates, *b.ev.recurrenceID)
			}
		}
		found := false
		for _, o := range ev.occurrences(start.Add(-time.Second), start.Add(time.Second)) {
			found = found || o.Start.Equal(start)
		}
		if !found {
			return "", false, errNoOccurrence
		}
		if ev.rrule == "" { // no series: the event itself
			if len(blocks) == 1 {
				return "", true, nil
			}
			return "", false, errNoOccurrence
		}
		exdate = ev.exdateFor(start)
	} else if len(blocks) == 1 {
		return "", true, nil // the only changed occurrence, without a master
	}
	var b strings.Builder
	for i := range lines {
		if drop >= 0 && i >= blocks[drop].from && i <= blocks[drop].to {
			continue
		}
		if master >= 0 && i == blocks[master].to && exdate != "" {
			b.WriteString(exdate + "\r\n")
		}
		for _, p := range lines[i] {
			b.WriteString(p + "\r\n")
		}
	}
	return b.String(), false, nil
}
