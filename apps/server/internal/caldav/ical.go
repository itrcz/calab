package caldav

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Reading busy time out of iCalendar data (ADR-0041 §4). Of a VEVENT its timing is used —
// DTSTART, DTEND / DURATION, RRULE, EXDATE, RECURRENCE-ID, STATUS, TRANSP and the UID (hashed)
// — and its details for the owner (ADR-0045 §1): SUMMARY, LOCATION, ATTENDEE, ORGANIZER and URL
// (else the first https:// link of DESCRIPTION; the description itself is dropped). Transparent («free») and cancelled events are skipped, and so are the
// meetings Calab itself put there (UID …@calab): they are busy time already.
//
// The link of an event (ADR-0045 amendment 1) is the conference to join: X-GOOGLE-CONFERENCE /
// X-MICROSOFT-SKYPETEAMSMEETINGURL, else URL — unless URL is the provider's own page of the event
// (Yandex writes calendar.yandex.ru/event?event_id=…, and the Telemost link into LOCATION), which
// is kept apart as the web page («Открыть в календаре») — else the first https:// of LOCATION,
// else of DESCRIPTION. HTML descriptions (Google) are read with &amp; decoded and the
// google.com/url?q= redirect unwrapped.
//
// Recurrence: the RFC 5545 rules calendars actually write — FREQ DAILY / WEEKLY / MONTHLY /
// YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals for MONTHLY / YEARLY), BYMONTHDAY
// and BYMONTH — in wall-clock time of the event's zone, like the calendar's own expander.
// Other parts (BYSETPOS, BYHOUR, …) are ignored.

// Busy is one imported busy interval.
type Busy struct {
	UID        string // hash of the VEVENT UID
	Start, End time.Time
	AllDay     bool
	Recurring  bool   // an occurrence of a series (RRULE or RECURRENCE-ID)
	WebURL     string // the provider's web page of the event, when reliable; else ""
	Href, ETag string // the calendar object (set by the import, not by BusyFromICS)
	*Details          // shared by the occurrences of a series; never nil from BusyFromICS
}

// Attendee is one ATTENDEE of an event.
type Attendee struct {
	Email  string `json:"email"`            // lower case
	Name   string `json:"name,omitempty"`   // CN
	Status string `json:"status,omitempty"` // PARTSTAT in upper case (ACCEPTED, TENTATIVE, …); "" = none
}

// Details are what the owner sees of an event (ADR-0045 §1), clipped to the column limits.
type Details struct {
	Summary   string
	Location  string
	Attendees []Attendee
	Organizer string
	URL       string
}

// Limits of the details (the columns of external_busy).
const (
	MaxSummary   = 200
	MaxLocation  = 200
	MaxAttendees = 50
	maxName      = 200
	maxEmail     = 320
	maxLink      = 500
)

// icsTime is a DATE or DATE-TIME value.
type icsTime struct {
	t    time.Time // a DATE: midnight in the fallback zone
	date bool
}

type vevent struct {
	uid              string
	start, end       icsTime
	startTZID        string // DTSTART's TZID as written ("" = UTC, floating or a DATE)
	startUTC         bool
	hasEnd           bool
	dur              time.Duration
	hasDur           bool
	rrule            string
	exdates          []icsTime
	recurrenceID     *icsTime
	status           string
	transp           string
	recurrenceIDLine string // RECURRENCE-ID as an EXDATE content line of the master
	details          Details
	confURL          string // X-GOOGLE-CONFERENCE / X-MICROSOFT-SKYPETEAMSMEETINGURL
	urlProp          string // URL
	locURL           string // the first https:// link of LOCATION
	descURL          string // the first https:// link of DESCRIPTION
}

// Windows zone names some servers (Exchange, Outlook) write as TZID.
var windowsZones = map[string]string{
	"Russian Standard Time": "Europe/Moscow", "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
	"N. Central Asia Standard Time": "Asia/Novosibirsk", "North Asia Standard Time": "Asia/Krasnoyarsk",
	"Kaliningrad Standard Time": "Europe/Kaliningrad", "Samara Standard Time": "Europe/Samara",
	"W. Europe Standard Time": "Europe/Berlin", "Central European Standard Time": "Europe/Warsaw",
	"Romance Standard Time": "Europe/Paris", "GMT Standard Time": "Europe/London", "UTC": "UTC",
	"FLE Standard Time": "Europe/Kiev", "E. Europe Standard Time": "Europe/Chisinau",
	"Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago",
	"Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles",
	"China Standard Time": "Asia/Shanghai", "Tokyo Standard Time": "Asia/Tokyo", "India Standard Time": "Asia/Kolkata",
}

// zone resolves a TZID: an IANA name, a path ending in one («/…/Europe/Moscow»), a Windows
// name; else fallback.
func zone(tzid string, fallback *time.Location) *time.Location {
	tzid = strings.Trim(tzid, `"`)
	if tzid == "" {
		return fallback
	}
	if w, ok := windowsZones[tzid]; ok {
		tzid = w
	}
	parts := strings.Split(strings.Trim(tzid, "/"), "/")
	for i := range parts {
		if loc, err := time.LoadLocation(strings.Join(parts[i:], "/")); err == nil && parts[i] != "" {
			return loc
		}
	}
	return fallback
}

// parseTime reads a DATE / DATE-TIME value with its parameters. Floating times and DATEs are
// in fallback (the user's zone).
func parseTime(val string, params map[string]string, fallback *time.Location) (icsTime, error) {
	val = strings.TrimSpace(val)
	if params["VALUE"] == "DATE" || len(val) == 8 {
		t, err := time.ParseInLocation("20060102", val, fallback)
		return icsTime{t: t, date: true}, err
	}
	if strings.HasSuffix(val, "Z") {
		t, err := time.Parse("20060102T150405Z", val)
		return icsTime{t: t}, err
	}
	t, err := time.ParseInLocation("20060102T150405", val, zone(params["TZID"], fallback))
	return icsTime{t: t}, err
}

// parseDuration reads an RFC 5545 DURATION (P1W, P1DT2H, PT30M, …; a negative one is 0).
func parseDuration(s string) (time.Duration, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "+")
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	if !strings.HasPrefix(s, "P") {
		return 0, errors.New("bad duration")
	}
	s = s[1:]
	var d time.Duration
	inTime := false
	num := ""
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			num += string(r)
		case r == 'T':
			inTime = true
		default:
			n, err := strconv.Atoi(num)
			if err != nil {
				return 0, errors.New("bad duration")
			}
			num = ""
			switch {
			case r == 'W':
				d += time.Duration(n) * 7 * 24 * time.Hour
			case r == 'D':
				d += time.Duration(n) * 24 * time.Hour
			case r == 'H' && inTime:
				d += time.Duration(n) * time.Hour
			case r == 'M' && inTime:
				d += time.Duration(n) * time.Minute
			case r == 'S' && inTime:
				d += time.Duration(n) * time.Second
			default:
				return 0, errors.New("bad duration")
			}
		}
	}
	if neg {
		return 0, nil
	}
	return d, nil
}

// contentLine splits "NAME;P=V;Q=\"x:y\":value".
func contentLine(line string) (name string, params map[string]string, value string) {
	inQuote := false
	colon := -1
	for i, r := range line {
		if r == '"' {
			inQuote = !inQuote
		} else if r == ':' && !inQuote {
			colon = i
			break
		}
	}
	if colon < 0 {
		return "", nil, ""
	}
	head, value := line[:colon], line[colon+1:]
	parts := splitUnquoted(head, ';')
	name = strings.ToUpper(parts[0])
	params = map[string]string{}
	for _, p := range parts[1:] {
		if k, v, ok := strings.Cut(p, "="); ok {
			params[strings.ToUpper(k)] = strings.Trim(v, `"`)
		}
	}
	return name, params, value
}

// splitUnquoted splits s at sep outside double quotes (CN="Petrov; Ivan").
func splitUnquoted(s string, sep rune) []string {
	var out []string
	inQuote, from := false, 0
	for i, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == sep && !inQuote:
			out = append(out, s[from:i])
			from = i + 1
		}
	}
	return append(out, s[from:])
}

// unescapeText reads an RFC 5545 TEXT value: \n and \N are new lines, \, \; \\ the character.
func unescapeText(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 == len(s) {
			b.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 'n', 'N':
			b.WriteByte('\n')
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// clipLine keeps at most n characters of s trimmed, on one line (control characters become spaces).
func clipLine(s string, n int) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f {
			return ' '
		}
		return r
	}, s))
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n]))
}

// mailto reads a CAL-ADDRESS: the lower-cased e-mail of "mailto:x@y", else "".
func mailto(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 7 && strings.EqualFold(v[:7], "mailto:") {
		v = v[7:]
	}
	v = strings.ToLower(strings.TrimSpace(v))
	at := strings.IndexByte(v, '@')
	if at <= 0 || at == len(v)-1 || len(v) > maxEmail || !utf8.ValidString(v) || strings.ContainsAny(v, " \t<>\"(),;:\\") {
		return ""
	}
	return v
}

// webLink is v when it is an http(s) URL (https only with httpsOnly) of at most maxLink bytes;
// the scheme is written in lower case (the clients open http:// and https:// only).
func webLink(v string, httpsOnly bool) string {
	v = strings.TrimSpace(v)
	if len(v) > maxLink || strings.ContainsAny(v, " \t\r\n\\") || !utf8.ValidString(v) {
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || (u.Scheme != "https" && (httpsOnly || u.Scheme != "http")) {
		return ""
	}
	return u.Scheme + v[len(u.Scheme):]
}

// firstHTTPS is the first https:// link of a text (a description, a place), trailing punctuation
// cut; &amp; of an HTML description decoded and Google's redirect (google.com/url?q=…) unwrapped.
func firstHTTPS(text string) string {
	i := strings.Index(strings.ToLower(text), "https://")
	if i < 0 {
		return ""
	}
	rest := text[i:]
	if j := strings.IndexFunc(rest, func(r rune) bool { return r <= ' ' || strings.ContainsRune(`<>"'`, r) }); j >= 0 {
		rest = rest[:j]
	}
	rest = strings.ReplaceAll(rest, "&amp;", "&")
	link := webLink(strings.TrimRight(rest, ".,;:!?)]}"), true)
	if u, err := url.Parse(link); err == nil && link != "" && u.Path == "/url" && (u.Host == "www.google.com" || u.Host == "google.com") {
		if q := webLink(u.Query().Get("q"), true); q != "" {
			return q
		}
	}
	return link
}

// eventPage tells whether a link is a calendar provider's own web page of an event (not a
// conference): Yandex Calendar (calendar.yandex.<tld>/event?event_id=N) and Google Calendar
// (calendar.google.com/calendar/event?eid=…, www.google.com/calendar/event?eid=…).
func eventPage(link string) bool {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	q := u.Query()
	switch {
	case strings.HasPrefix(host, "calendar.yandex.") && strings.TrimSuffix(u.Path, "/") == "/event":
		n := q.Get("event_id")
		return n != "" && strings.Trim(n, "0123456789") == ""
	case host == "calendar.google.com" || host == "www.google.com":
		return strings.HasPrefix(u.Path, "/calendar/") && strings.HasSuffix(strings.TrimSuffix(u.Path, "/"), "/event") && q.Get("eid") != ""
	}
	return false
}

// NextcloudPage is the Nextcloud Calendar app's page of a calendar object (its own deep link:
// <root>/index.php/apps/calendar/edit/<base64 of the object's DAV path>), or "" when href is not a
// Nextcloud DAV object (…/remote.php/dav/calendars/<user>/<calendar>/<object>.ics).
func NextcloudPage(href string) string {
	u, err := url.Parse(href)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	i := strings.Index(u.Path, "/remote.php/dav/calendars/")
	if i < 0 || strings.HasSuffix(u.Path, "/") || strings.Count(u.Path[i:], "/") != 6 {
		return ""
	}
	page := "https://" + u.Host + u.Path[:i] + "/index.php/apps/calendar/edit/" + base64.StdEncoding.EncodeToString([]byte(u.Path))
	if len(page) > maxLink*4 {
		return ""
	}
	return page
}

// parseEvents reads the VEVENTs of a VCALENDAR (bad values skip the event).
func parseEvents(data string, fallback *time.Location) []vevent {
	data = strings.NewReplacer("\r\n ", "", "\r\n\t", "", "\n ", "", "\n\t", "").Replace(data)
	var out []vevent
	var stack []string
	var cur *vevent
	bad := false
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimRight(line, "\r")
		name, params, val := contentLine(line)
		switch name {
		case "BEGIN":
			comp := strings.ToUpper(strings.TrimSpace(val))
			stack = append(stack, comp)
			if comp == "VEVENT" {
				cur, bad = &vevent{}, false
			}
			continue
		case "END":
			if len(stack) > 0 {
				if stack[len(stack)-1] == "VEVENT" && cur != nil {
					if !bad && !cur.start.t.IsZero() {
						out = append(out, *cur)
					}
					cur = nil
				}
				stack = stack[:len(stack)-1]
			}
			continue
		}
		if cur == nil || len(stack) == 0 || stack[len(stack)-1] != "VEVENT" {
			continue // VALARM and others
		}
		var err error
		switch name {
		case "UID":
			cur.uid = strings.TrimSpace(val)
		case "DTSTART":
			cur.start, err = parseTime(val, params, fallback)
			cur.startTZID = strings.Trim(params["TZID"], `"`)
			cur.startUTC = strings.HasSuffix(strings.TrimSpace(val), "Z")
		case "DTEND":
			cur.end, err = parseTime(val, params, fallback)
			cur.hasEnd = true
		case "DURATION":
			cur.dur, err = parseDuration(val)
			cur.hasDur = true
		case "RRULE":
			cur.rrule = strings.TrimSpace(val)
		case "EXDATE":
			for _, v := range strings.Split(val, ",") {
				t, e := parseTime(v, params, fallback)
				if e == nil {
					cur.exdates = append(cur.exdates, t)
				}
			}
		case "RECURRENCE-ID":
			var t icsTime
			if t, err = parseTime(val, params, fallback); err == nil {
				cur.recurrenceID = &t
				cur.recurrenceIDLine = exdateLine(params, strings.TrimSpace(val))
			}
		case "STATUS":
			cur.status = strings.ToUpper(strings.TrimSpace(val))
		case "TRANSP":
			cur.transp = strings.ToUpper(strings.TrimSpace(val))
		case "SUMMARY":
			cur.details.Summary = clipLine(unescapeText(val), MaxSummary)
		case "LOCATION":
			loc := unescapeText(val)
			cur.details.Location = clipLine(loc, MaxLocation)
			cur.locURL = firstHTTPS(loc)
		case "ORGANIZER":
			cur.details.Organizer = mailto(val)
		case "ATTENDEE":
			email := mailto(val)
			if email != "" && len(cur.details.Attendees) < MaxAttendees &&
				!slices.ContainsFunc(cur.details.Attendees, func(a Attendee) bool { return a.Email == email }) {
				cur.details.Attendees = append(cur.details.Attendees, Attendee{Email: email, Name: clipLine(params["CN"], maxName),
					Status: partstatOf(params["PARTSTAT"])})
			}
		case "URL":
			// A URI, but some servers escape it like TEXT (\, \;).
			cur.urlProp = webLink(unescapeText(val), false)
		case "X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL":
			if cur.confURL == "" {
				cur.confURL = webLink(unescapeText(val), true)
			}
		case "DESCRIPTION":
			cur.descURL = firstHTTPS(unescapeText(val))
		}
		if err != nil {
			bad = true
		}
	}
	return out
}

// ---- recurrence ----

type byDay struct {
	n  int // 0 = every such weekday of the period; ±n = the n-th (from the end)
	wd time.Weekday
}

type rule struct {
	freq       string
	interval   int
	count      int
	until      *time.Time
	byDay      []byDay
	byMonthDay []int
	byMonth    []int
}

var weekdays = map[string]time.Weekday{"MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday,
	"TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday, "SU": time.Sunday}

func parseRule(s string, loc *time.Location) (rule, error) {
	r := rule{interval: 1}
	for _, part := range strings.Split(s, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.ToUpper(k) {
		case "FREQ":
			r.freq = strings.ToUpper(v)
		case "INTERVAL":
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				r.interval = n
			}
		case "COUNT":
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				r.count = n
			}
		case "UNTIL":
			t, err := parseTime(v, nil, loc)
			if err != nil {
				return r, err
			}
			u := t.t
			if t.date {
				u = u.Add(24*time.Hour - time.Second) // the whole last day
			}
			r.until = &u
		case "BYDAY":
			for _, d := range strings.Split(v, ",") {
				d = strings.ToUpper(strings.TrimSpace(d))
				if len(d) < 2 {
					continue
				}
				wd, ok := weekdays[d[len(d)-2:]]
				if !ok {
					continue
				}
				n := 0
				if num := d[:len(d)-2]; num != "" {
					n, _ = strconv.Atoi(strings.TrimPrefix(num, "+"))
				}
				r.byDay = append(r.byDay, byDay{n, wd})
			}
		case "BYMONTHDAY":
			for _, d := range strings.Split(v, ",") {
				if n, err := strconv.Atoi(d); err == nil && n != 0 && n >= -31 && n <= 31 {
					r.byMonthDay = append(r.byMonthDay, n)
				}
			}
		case "BYMONTH":
			for _, d := range strings.Split(v, ",") {
				if n, err := strconv.Atoi(d); err == nil && n >= 1 && n <= 12 {
					r.byMonth = append(r.byMonth, n)
				}
			}
		}
	}
	switch r.freq {
	case "DAILY", "WEEKLY", "MONTHLY", "YEARLY":
		return r, nil
	}
	return r, errors.New("unsupported FREQ")
}

// Expansion bounds.
const (
	maxPeriods     = 20000 // periods walked per series (a daily series of 50 years)
	maxOccurrences = 2000  // occurrences kept per series in a window
)

// monthDays: the days of month (y, m) the rule picks (sorted); d0 = the start's day.
func (r rule) monthDays(y int, m time.Month, d0 int, loc *time.Location) []int {
	last := time.Date(y, m+1, 0, 0, 0, 0, 0, loc).Day()
	var days []int
	switch {
	case len(r.byMonthDay) > 0:
		for _, d := range r.byMonthDay {
			if d < 0 {
				d = last + 1 + d
			}
			if d >= 1 && d <= last {
				days = append(days, d)
			}
		}
	case len(r.byDay) > 0:
		for _, b := range r.byDay {
			var match []int
			for d := 1; d <= last; d++ {
				if time.Date(y, m, d, 0, 0, 0, 0, loc).Weekday() == b.wd {
					match = append(match, d)
				}
			}
			switch {
			case b.n == 0:
				days = append(days, match...)
			case b.n > 0 && b.n <= len(match):
				days = append(days, match[b.n-1])
			case b.n < 0 && -b.n <= len(match):
				days = append(days, match[len(match)+b.n])
			}
		}
	default:
		if d0 <= last {
			days = append(days, d0)
		}
	}
	slices.Sort(days)
	return slices.Compact(days)
}

// dates returns the dates (y, m, d as midnight in loc) of period k of the rule, sorted.
func (r rule) dates(k int, start time.Time, loc *time.Location) []time.Time {
	y, m, d := start.Date()
	var out []time.Time
	switch r.freq {
	case "DAILY":
		t := time.Date(y, m, d+k*r.interval, 0, 0, 0, 0, loc)
		if len(r.byMonth) > 0 && !slices.Contains(r.byMonth, int(t.Month())) {
			return nil
		}
		if len(r.byDay) > 0 && !slices.ContainsFunc(r.byDay, func(b byDay) bool { return b.wd == t.Weekday() }) {
			return nil
		}
		out = append(out, t)
	case "WEEKLY":
		monday := d - (int(start.Weekday())+6)%7
		base := monday + 7*k*r.interval
		wds := []time.Weekday{start.Weekday()}
		if len(r.byDay) > 0 {
			wds = wds[:0]
			for _, b := range r.byDay {
				wds = append(wds, b.wd)
			}
		}
		for _, wd := range wds {
			out = append(out, time.Date(y, m, base+(int(wd)+6)%7, 0, 0, 0, 0, loc))
		}
	case "MONTHLY":
		first := time.Date(y, m+time.Month(k*r.interval), 1, 0, 0, 0, 0, loc)
		if len(r.byMonth) > 0 && !slices.Contains(r.byMonth, int(first.Month())) {
			return nil
		}
		for _, day := range r.monthDays(first.Year(), first.Month(), d, loc) {
			out = append(out, time.Date(first.Year(), first.Month(), day, 0, 0, 0, 0, loc))
		}
	case "YEARLY":
		yy := y + k*r.interval
		months := r.byMonth
		if len(months) == 0 {
			months = []int{int(m)}
		}
		for _, mo := range months {
			for _, day := range r.monthDays(yy, time.Month(mo), d, loc) { // BYDAY: within that month
				out = append(out, time.Date(yy, time.Month(mo), day, 0, 0, 0, 0, loc))
			}
		}
	}
	slices.SortFunc(out, func(a, b time.Time) int { return a.Compare(b) })
	return out
}

// skipPeriods is how many whole periods can be skipped before from without missing an
// occurrence that ends after it (only without COUNT, which counts from the start).
func (r rule) skipPeriods(start, from time.Time, dur time.Duration) int {
	if r.count > 0 {
		return 0
	}
	gap := from.Add(-dur).Sub(start)
	if gap <= 0 {
		return 0
	}
	days := int(gap / (24 * time.Hour))
	var per int
	switch r.freq {
	case "DAILY":
		per = r.interval
	case "WEEKLY":
		per = 7 * r.interval
	case "MONTHLY":
		per = 31 * r.interval
	default:
		per = 366 * r.interval
	}
	return max(days/per-1, 0)
}

// occurrences expands ev into [start, end) intervals overlapping [from, to).
func (ev vevent) occurrences(from, to time.Time) []Busy {
	loc := ev.start.t.Location()
	start := ev.start.t
	allDay := ev.start.date
	// Duration: DTEND, else DURATION, else a day for a DATE and nothing for a DATE-TIME.
	days := 1
	var dur time.Duration
	switch {
	case ev.hasEnd && allDay:
		days = int(ev.end.t.Sub(start).Round(24*time.Hour) / (24 * time.Hour))
	case ev.hasEnd:
		dur = ev.end.t.Sub(start)
	case ev.hasDur && allDay:
		days = int(ev.dur.Round(24*time.Hour) / (24 * time.Hour))
	case ev.hasDur:
		dur = ev.dur
	}
	if allDay {
		days = max(days, 1)
		dur = time.Duration(days) * 24 * time.Hour // for the window arithmetic only
	} else if dur <= 0 {
		return nil
	}
	span := func(s time.Time) (time.Time, time.Time) {
		if allDay {
			y, m, d := s.Date()
			return s, time.Date(y, m, d+days, 0, 0, 0, 0, loc)
		}
		return s, s.Add(dur)
	}
	hash := uidHash(ev.uid)
	det, web := ev.links()
	recurring := ev.rrule != "" || ev.recurrenceID != nil
	var out []Busy
	emit := func(s time.Time) {
		st, en := span(s)
		if en.After(from) && st.Before(to) {
			out = append(out, Busy{UID: hash, Start: st.UTC(), End: en.UTC(), AllDay: allDay, Recurring: recurring, WebURL: web, Details: &det})
		}
	}
	excluded := map[int64]bool{}
	for _, x := range ev.exdates {
		excluded[x.t.Unix()] = true
	}
	if ev.rrule == "" {
		if !excluded[start.Unix()] {
			emit(start)
		}
		return out
	}
	r, err := parseRule(ev.rrule, loc)
	if err != nil {
		emit(start)
		return out
	}
	hh, mm, ss := start.Clock()
	n := 1 // DTSTART is the first occurrence
	if !excluded[start.Unix()] {
		emit(start)
	}
	for k := r.skipPeriods(start, from, dur); k < maxPeriods && len(out) < maxOccurrences; k++ {
		for _, day := range r.dates(k, start, loc) {
			y, m, d := day.Date()
			s := time.Date(y, m, d, hh, mm, ss, 0, loc)
			if !s.After(start) {
				continue
			}
			if r.count > 0 && n >= r.count {
				return out
			}
			if (r.until != nil && s.After(*r.until)) || !s.Before(to) {
				return out
			}
			n++
			if !excluded[s.Unix()] {
				emit(s)
			}
		}
	}
	return out
}

// links: the details with the conference link chosen, and the provider's page of the event.
func (ev vevent) links() (Details, string) {
	det := ev.details
	web := ""
	if ev.urlProp != "" && eventPage(ev.urlProp) {
		web = ev.urlProp
	}
	switch {
	case ev.confURL != "":
		det.URL = ev.confURL
	case ev.urlProp != "" && web == "":
		det.URL = ev.urlProp
	case ev.locURL != "":
		det.URL = ev.locURL
	default:
		det.URL = ev.descURL
	}
	return det, web
}

func uidHash(uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return hex.EncodeToString(sum[:8])
}

// BusyFromICS returns the busy intervals of one calendar object overlapping [from, to).
// fallback is the zone of floating times and dates (the user's).
func BusyFromICS(data string, from, to time.Time, fallback *time.Location) []Busy {
	evs := parseEvents(data, fallback)
	// Changed occurrences (RECURRENCE-ID) replace the master's occurrence at that time.
	overridden := map[string]map[int64]bool{}
	for _, ev := range evs {
		if ev.recurrenceID != nil {
			if overridden[ev.uid] == nil {
				overridden[ev.uid] = map[int64]bool{}
			}
			overridden[ev.uid][ev.recurrenceID.t.Unix()] = true
		}
	}
	var out []Busy
	for _, ev := range evs {
		if strings.HasSuffix(strings.ToLower(ev.uid), "@calab") {
			continue // a meeting Calab pushed: busy as a MEETING already
		}
		if ev.recurrenceID == nil {
			for k := range overridden[ev.uid] {
				ev.exdates = append(ev.exdates, icsTime{t: time.Unix(k, 0)})
			}
		} else {
			ev.rrule = "" // an override is one occurrence
		}
		if ev.status == "CANCELLED" || ev.transp == "TRANSPARENT" {
			continue
		}
		out = append(out, ev.occurrences(from, to)...)
	}
	return out
}
