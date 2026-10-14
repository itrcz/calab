package caldav

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Answering my imported event (ADR-0045 amendment 2): «Принять / Отклонить / Может быть» write
// PARTSTAT of my ATTENDEE into my own copy of the event in my CalDAV calendar; the provider sends
// the reply to the organizer (RFC 6638 implicit scheduling — Google, Yandex, iCloud, Nextcloud,
// Fastmail). The answer covers the whole series (every VEVENT of the uid), like Calab's own.
// My addresses: my Calab e-mail and the CalDAV login when it is an address.

// ReasonNotAttendee is the reason of an answer to an event I am not an attendee of (or organize).
const ReasonNotAttendee = "NOT_AN_ATTENDEE"

// errNotAttendee: none of my addresses is an ATTENDEE of the object (or I am its organizer).
var errNotAttendee = errors.New("caldav: not an attendee of the event")

// partstatOf normalizes a PARTSTAT parameter (upper case; "" = none).
func partstatOf(v string) string {
	return strings.ToUpper(strings.TrimSpace(v))
}

// statusOfPartstat maps a PARTSTAT to the attendee status of the contract.
func statusOfPartstat(p string) v1.AttendeeStatus {
	switch p {
	case "ACCEPTED":
		return v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED
	case "DECLINED":
		return v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED
	case "TENTATIVE":
		return v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE
	}
	return v1.AttendeeStatus_ATTENDEE_STATUS_PENDING
}

// partstatOfStatus is the PARTSTAT of an answer; "" = not an answer.
func partstatOfStatus(s v1.AttendeeStatus) string {
	switch s {
	case v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED:
		return "ACCEPTED"
	case v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED:
		return "DECLINED"
	case v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE:
		return "TENTATIVE"
	}
	return ""
}

// myAddresses are the addresses that are me in my calendar: my Calab e-mail and the CalDAV login
// when it is an address (lower case).
func (s *Service) myAddresses(ctx context.Context, me uuid.UUID, login string) map[string]bool {
	out := map[string]bool{}
	if u, err := s.db.Q.GetUser(ctx, me); err == nil && u.Email != nil {
		if e := mailto(*u.Email); e != "" {
			out[e] = true
		}
	}
	if e := mailto(login); e != "" {
		out[e] = true
	}
	return out
}

// myStatus is my answer to an event: UNSPECIFIED when I organize it or am not an attendee.
func myStatus(organizer string, attendees []Attendee, mine map[string]bool) v1.AttendeeStatus {
	if len(mine) == 0 || mine[organizer] {
		return v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED
	}
	for _, a := range attendees {
		if mine[a.Email] {
			return statusOfPartstat(a.Status)
		}
	}
	return v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED
}

// respondExternal: POST /api/me/external-events/rsvp {uid, href, start, status}.
func (s *Service) respondExternal(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	var req v1.RespondExternalEventRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	partstat := partstatOfStatus(req.GetStatus())
	switch {
	case req.GetUid() == "" || len(req.GetUid()) > 64:
		return httpx.Validation("uid", "the event's uid is required")
	case req.GetHref() == "" || len(req.GetHref()) > maxURL:
		return httpx.Validation("href", "the event's href is required")
	case req.GetStart() == nil || !req.GetStart().IsValid():
		return httpx.Validation("start", "the occurrence's start is required")
	case partstat == "":
		return httpx.Validation("status", "ACCEPTED, DECLINED or MAYBE")
	}
	if s.DeleteLimit != nil { // writes to the external calendar share one budget
		if err := s.DeleteLimit.Take(ctx, me.String()); err != nil {
			return err
		}
	}
	acc, row, cr, err := s.myExternal(ctx, me, req.GetUid(), req.GetHref(), req.GetStart().AsTime())
	if err != nil {
		return err
	}
	mine := s.myAddresses(ctx, me, acc.Username)
	if mine[row.Organizer] {
		return errNotAttendeeHTTP()
	}
	if err := s.answer(ctx, row.Href, row.Etag, row.Uid, mine, partstat, cr); err != nil {
		if errors.Is(err, errNotAttendee) {
			return errNotAttendeeHTTP()
		}
		return s.writeError(ctx, me, err)
	}
	// The new answer and ETag in my rows at once (the provider may have changed more).
	ictx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*requestTimeout)
	defer cancel()
	if _, err := s.Import(ictx, me); err != nil {
		slog.WarnContext(ctx, "caldav: import after an answer", "user_id", me, "err", err)
	}
	httpx.NoContent(w)
	return nil
}

func errNotAttendeeHTTP() error {
	return httpx.Validation("status", "not an attendee of the event").WithDetails(ReasonNotAttendee, 0, 0)
}

// answer writes my PARTSTAT into the object: read again (it must still be the imported version),
// rewritten, put back with If-Match.
func (s *Service) answer(ctx context.Context, href, etag, uid string, mine map[string]bool, partstat string, cr creds) error {
	obj, err := s.dav.Get(ctx, href, cr)
	if err != nil {
		return err
	}
	if obj.ETag != "" && !sameETag(obj.ETag, etag) {
		return ErrChanged
	}
	data, err := setPartstat(obj.Data, uid, mine, partstat)
	if err != nil {
		return err
	}
	return s.dav.PutIf(ctx, href, cr, data, etag)
}

// setPartstat returns the object data with PARTSTAT=partstat on my ATTENDEE lines in every VEVENT
// of the event uid (the hash). Only those lines change (refolded); every other line, folding
// included, stays as the server wrote it. errNotAttendee: no such line (or I organize it);
// errNoOccurrence: no VEVENT of the uid.
func setPartstat(data, uid string, mine map[string]bool, partstat string) (string, error) {
	lines, logical := icsLines(data)
	type block struct{ from, to int }
	var blocks []block
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
				blocks = append(blocks, block{open, i})
				open = -1
			}
			depth--
		}
	}
	replace := map[int]string{}
	found, organizer := false, false
	for _, b := range blocks {
		ours := false
		for i := b.from; i <= b.to; i++ {
			if name, _, val := contentLine(logical(i)); name == "UID" && uidHash(strings.TrimSpace(val)) == uid {
				ours = true
			}
		}
		if !ours {
			continue
		}
		found = true
		for i := b.from; i <= b.to; i++ {
			name, _, val := contentLine(logical(i))
			switch {
			case name == "ORGANIZER" && mine[mailto(val)]:
				organizer = true
			case name == "ATTENDEE" && mine[mailto(val)]:
				replace[i] = withParam(logical(i), "PARTSTAT", partstat)
			}
		}
	}
	switch {
	case !found:
		return "", errNoOccurrence
	case organizer || len(replace) == 0:
		return "", errNotAttendee
	}
	var b strings.Builder
	for i := range lines {
		if l, ok := replace[i]; ok {
			b.WriteString(foldLine(l))
			continue
		}
		for _, p := range lines[i] {
			b.WriteString(p + "\r\n")
		}
	}
	return b.String(), nil
}

// icsLines splits iCalendar data into logical lines, each with its physical (folded) lines;
// logical(i) is line i unfolded.
func icsLines(data string) (lines [][]string, logical func(int) string) {
	for _, phys := range strings.Split(strings.ReplaceAll(data, "\r\n", "\n"), "\n") {
		if (strings.HasPrefix(phys, " ") || strings.HasPrefix(phys, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] = append(lines[len(lines)-1], phys)
			continue
		}
		if phys == "" {
			continue
		}
		lines = append(lines, []string{phys})
	}
	logical = func(i int) string {
		var b strings.Builder
		for j, p := range lines[i] {
			if j > 0 {
				p = p[1:]
			}
			b.WriteString(p)
		}
		return b.String()
	}
	return lines, logical
}

// withParam sets a parameter of a content line (replacing it, else appended after the others);
// the other parameters and the value stay as written.
func withParam(line, key, value string) string {
	inQuote, colon := false, -1
	for i, r := range line {
		if r == '"' {
			inQuote = !inQuote
		} else if r == ':' && !inQuote {
			colon = i
			break
		}
	}
	if colon < 0 {
		return line
	}
	parts := splitUnquoted(line[:colon], ';')
	set := false
	for i, p := range parts[1:] {
		if k, _, ok := strings.Cut(p, "="); ok && strings.EqualFold(k, key) {
			parts[i+1] = key + "=" + value
			set = true
		}
	}
	if !set {
		parts = append(parts, key+"="+value)
	}
	return strings.Join(parts, ";") + line[colon:]
}

// foldLine splits a content line into ≤ 75-octet lines (continuations start with a space), never
// inside a UTF-8 sequence, and ends it with CRLF (RFC 5545 §3.1).
func foldLine(s string) string {
	var b strings.Builder
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut] + "\r\n ")
		s = s[cut:]
		limit = 74
	}
	b.WriteString(s + "\r\n")
	return b.String()
}
