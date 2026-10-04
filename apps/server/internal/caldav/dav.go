package caldav

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/unfurl"
)

// The WebDAV / CalDAV client (RFC 4918, 4791, 6764 without the well-known redirect). SSRF:
// https only, addresses checked at connect time by the unfurl policy (and literal hosts up
// front), 10 s per request, answers ≤ 2 MB, redirects are errors (never followed).

const (
	requestTimeout = 10 * time.Second
	maxBody        = 2 << 20
	userAgent      = "Calab-CalDAV/1.0"
)

// Errors of the client.
var (
	ErrAuth     = errors.New("caldav: the server did not accept the username and password")
	ErrRedirect = errors.New("caldav: the server redirects; enter the address it points to")
	ErrTooLarge = errors.New("caldav: the answer is larger than 2 MB")
	ErrURL      = errors.New("caldav: only https addresses of public servers")
)

// StatusError is an unexpected HTTP status.
type StatusError struct {
	Status int
	Body   string
}

func (e *StatusError) Error() string { return fmt.Sprintf("caldav: HTTP %d", e.Status) }

type davClient struct {
	http  *http.Client
	allow func(netip.Addr) bool
}

func newDAVClient(o Options) *davClient {
	tr := unfurl.SafeTransport(requestTimeout, o.AllowAddr)
	if o.RootCAs != nil {
		tr.TLSClientConfig = &tls.Config{RootCAs: o.RootCAs, MinVersion: tls.VersionTLS12}
	}
	return &davClient{allow: o.AllowAddr, http: &http.Client{
		Transport: tr, Timeout: requestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// CheckURL accepts an absolute https URL without credentials whose literal address (if any) the
// policy allows.
func CheckURL(raw string, allow func(netip.Addr) bool) (*url.URL, error) {
	u, err := unfurl.CheckURL(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" {
		return nil, ErrURL
	}
	host := strings.ToLower(u.Hostname())
	if a, err := netip.ParseAddr(host); err == nil && !allow(a) {
		return nil, ErrURL
	}
	if (host == "localhost" || strings.HasSuffix(host, ".localhost")) && !allow(netip.MustParseAddr("127.0.0.1")) {
		return nil, ErrURL
	}
	return u, nil
}

type creds struct{ user, pass string }

// do sends one request and returns the status and the body (≤ 2 MB).
func (c *davClient) do(ctx context.Context, method, target string, cr creds, depth, contentType string, body []byte) (int, []byte, error) {
	h := http.Header{}
	if depth != "" {
		h.Set("Depth", depth)
	}
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	st, _, data, err := c.send(ctx, method, target, cr, h, body)
	return st, data, err
}

// send is do with any request headers, also returning the answer's headers.
func (c *davClient) send(ctx context.Context, method, target string, cr creds, h http.Header, body []byte) (int, http.Header, []byte, error) {
	if _, err := CheckURL(target, c.allow); err != nil {
		return 0, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd) //nolint:gosec // G704: https only, SSRF-safe dialer
	if err != nil {
		return 0, nil, nil, err
	}
	for k, v := range h {
		req.Header[k] = v
	}
	req.SetBasicAuth(cr.user, cr.pass)
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.http.Do(req) //nolint:gosec // G704: see above
	if err != nil {
		if errors.Is(err, unfurl.ErrBlocked) {
			return 0, nil, nil, ErrURL
		}
		return 0, nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return resp.StatusCode, resp.Header, nil, err
	}
	if len(data) > maxBody {
		return resp.StatusCode, resp.Header, nil, ErrTooLarge
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return resp.StatusCode, resp.Header, data, ErrAuth
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return resp.StatusCode, resp.Header, data, ErrRedirect
	}
	return resp.StatusCode, resp.Header, data, nil
}

// ---- multistatus ----

type hrefProp struct {
	Hrefs []string `xml:"DAV: href"`
}

type prop struct {
	CurrentUserPrincipal *hrefProp `xml:"DAV: current-user-principal"`
	CalendarHomeSet      *hrefProp `xml:"urn:ietf:params:xml:ns:caldav calendar-home-set"`
	ResourceType         *struct {
		Calendar *struct{} `xml:"urn:ietf:params:xml:ns:caldav calendar"`
	} `xml:"DAV: resourcetype"`
	DisplayName   string `xml:"DAV: displayname"`
	CalendarColor string `xml:"http://apple.com/ns/ical/ calendar-color"`
	Components    *struct {
		Comps []struct {
			Name string `xml:"name,attr"`
		} `xml:"urn:ietf:params:xml:ns:caldav comp"`
	} `xml:"urn:ietf:params:xml:ns:caldav supported-calendar-component-set"`
	CalendarData string `xml:"urn:ietf:params:xml:ns:caldav calendar-data"`
	ETag         string `xml:"DAV: getetag"`
}

type propstat struct {
	Status string `xml:"DAV: status"`
	Prop   prop   `xml:"DAV: prop"`
}

type response struct {
	Href      string     `xml:"DAV: href"`
	Propstats []propstat `xml:"DAV: propstat"`
}

type multistatus struct {
	XMLName   xml.Name   `xml:"DAV: multistatus"`
	Responses []response `xml:"DAV: response"`
}

// okProp merges the props of the 2xx propstats of r.
func (r response) okProp() prop {
	var p prop
	for _, ps := range r.Propstats {
		f := strings.Fields(ps.Status)
		if len(f) >= 2 && !strings.HasPrefix(f[1], "2") {
			continue
		}
		q := ps.Prop
		if q.CurrentUserPrincipal != nil {
			p.CurrentUserPrincipal = q.CurrentUserPrincipal
		}
		if q.CalendarHomeSet != nil {
			p.CalendarHomeSet = q.CalendarHomeSet
		}
		if q.ResourceType != nil {
			p.ResourceType = q.ResourceType
		}
		if q.DisplayName != "" {
			p.DisplayName = q.DisplayName
		}
		if q.CalendarColor != "" {
			p.CalendarColor = q.CalendarColor
		}
		if q.Components != nil {
			p.Components = q.Components
		}
		if q.CalendarData != "" {
			p.CalendarData = q.CalendarData
		}
		if q.ETag != "" {
			p.ETag = q.ETag
		}
	}
	return p
}

func parseMultistatus(data []byte) (*multistatus, error) {
	var ms multistatus
	if err := xml.Unmarshal(data, &ms); err != nil { //nolint:gosec // G709: a size-limited WebDAV answer into a plain struct (encoding/xml has no entity expansion)
		return nil, fmt.Errorf("caldav: not a WebDAV answer: %w", err)
	}
	return &ms, nil
}

// resolve makes href absolute against base; only https results are used.
func resolve(base *url.URL, href string) (*url.URL, bool) {
	h, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return nil, false
	}
	u := base.ResolveReference(h)
	return u, u.Scheme == "https"
}

// InCalendar tells whether href is an object of the calendar collection cal (ADR-0045 amendment
// 1: the only targets of a write): the same https origin, one path segment right inside the
// collection (calendar collections hold no sub-collections, RFC 4791 §4.2), no dot segments
// (also percent-encoded), no userinfo, query or fragment.
func InCalendar(href, cal string) bool {
	h, err := url.Parse(href)
	if err != nil || h.Scheme != "https" || h.Opaque != "" || h.User != nil || h.RawQuery != "" || h.ForceQuery || h.Fragment != "" {
		return false
	}
	c, err := url.Parse(cal)
	if err != nil || c.Scheme != "https" || c.Host == "" || !strings.EqualFold(h.Host, c.Host) {
		return false
	}
	dir := c.Path
	if !strings.HasSuffix(dir, "/") {
		dir += "/"
	}
	name, ok := strings.CutPrefix(h.Path, dir)
	return ok && name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\\")
}

// ---- discovery ----

// Calendar is an event calendar found on the server.
type Calendar struct {
	Href  string `json:"href"` // absolute URL, ending with /
	Name  string `json:"name"`
	Color string `json:"color"`
}

const propfindPrincipal = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop>
</d:propfind>`

const propfindCalendars = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`

func (c *davClient) propfind(ctx context.Context, target string, cr creds, depth, body string) (*multistatus, error) {
	st, data, err := c.do(ctx, "PROPFIND", target, cr, depth, "application/xml; charset=utf-8", []byte(body))
	if err != nil {
		return nil, err
	}
	if st != http.StatusMultiStatus {
		return nil, &StatusError{Status: st}
	}
	return parseMultistatus(data)
}

// firstHref: the first https href of p resolved against base.
func firstHref(base *url.URL, p *hrefProp) (*url.URL, bool) {
	if p == nil {
		return nil, false
	}
	for _, h := range p.Hrefs {
		if u, ok := resolve(base, h); ok {
			return u, true
		}
	}
	return nil, false
}

// Discover finds the user's event calendars: current-user-principal → calendar-home-set →
// its calendars (collections of VEVENTs). The URL may be the server, the principal, the home
// or a calendar.
func (c *davClient) Discover(ctx context.Context, raw string, cr creds) ([]Calendar, error) {
	base, err := CheckURL(raw, c.allow)
	if err != nil {
		return nil, err
	}
	ms, err := c.propfind(ctx, base.String(), cr, "0", propfindPrincipal)
	if err != nil {
		return nil, err
	}
	home := base
	var principal *url.URL
	for _, r := range ms.Responses {
		p := r.okProp()
		if u, ok := firstHref(base, p.CalendarHomeSet); ok {
			home = u
			principal = nil
			break
		}
		if u, ok := firstHref(base, p.CurrentUserPrincipal); ok {
			principal = u
		}
	}
	if principal != nil && principal.String() != base.String() {
		ms, err := c.propfind(ctx, principal.String(), cr, "0", propfindPrincipal)
		if err != nil {
			return nil, err
		}
		for _, r := range ms.Responses {
			if u, ok := firstHref(principal, r.okProp().CalendarHomeSet); ok {
				home = u
				break
			}
		}
	}
	ms, err = c.propfind(ctx, home.String(), cr, "1", propfindCalendars)
	if err != nil {
		return nil, err
	}
	return calendarsOf(home, ms), nil
}

// calendarsOf lists the event calendars of a Depth 1 PROPFIND of the home.
func calendarsOf(home *url.URL, ms *multistatus) []Calendar {
	var out []Calendar
	seen := map[string]bool{}
	for _, r := range ms.Responses {
		p := r.okProp()
		if p.ResourceType == nil || p.ResourceType.Calendar == nil {
			continue
		}
		if p.Components != nil && len(p.Components.Comps) > 0 {
			events := false
			for _, c := range p.Components.Comps {
				events = events || strings.EqualFold(c.Name, "VEVENT")
			}
			if !events {
				continue // tasks, journals
			}
		}
		u, ok := resolve(home, r.Href)
		if !ok {
			continue
		}
		if !strings.HasSuffix(u.Path, "/") {
			u.Path += "/"
		}
		href := u.String()
		if seen[href] {
			continue
		}
		seen[href] = true
		name := strings.TrimSpace(p.DisplayName)
		if name == "" {
			name = strings.Trim(u.Path, "/")
			if i := strings.LastIndexByte(name, '/'); i >= 0 {
				name = name[i+1:]
			}
		}
		out = append(out, Calendar{Href: href, Name: clip(name, 100), Color: color(p.CalendarColor)})
	}
	return out
}

// color normalizes an Apple calendar-color (#RRGGBB or #RRGGBBAA) to #RRGGBB; else "".
func color(s string) string {
	s = strings.TrimSpace(s)
	if len(s) != 7 && len(s) != 9 || s[0] != '#' {
		return ""
	}
	for _, r := range s[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return ""
		}
	}
	return strings.ToUpper(s[:7])
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// ---- import and push ----

const reportQuery = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="%s" end="%s"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`

// Object is a calendar object: its absolute URL, ETag (as the server wrote it, quotes included;
// may be empty) and iCalendar data.
type Object struct {
	Href, ETag, Data string
}

// Query returns the calendar objects of the calendar with an event in [from, to).
func (c *davClient) Query(ctx context.Context, calendar string, cr creds, from, to time.Time) ([]Object, error) {
	body := fmt.Sprintf(reportQuery, from.UTC().Format("20060102T150405Z"), to.UTC().Format("20060102T150405Z"))
	st, data, err := c.do(ctx, "REPORT", calendar, cr, "1", "application/xml; charset=utf-8", []byte(body))
	if err != nil {
		return nil, err
	}
	if st != http.StatusMultiStatus {
		return nil, &StatusError{Status: st}
	}
	ms, err := parseMultistatus(data)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(calendar)
	if err != nil {
		return nil, err
	}
	var out []Object
	for _, r := range ms.Responses {
		p := r.okProp()
		if p.CalendarData == "" {
			continue
		}
		o := Object{Data: p.CalendarData, ETag: strings.TrimSpace(p.ETag)}
		if u, ok := resolve(base, r.Href); ok && strings.TrimSpace(r.Href) != "" {
			o.Href = u.String()
		}
		out = append(out, o)
	}
	return out, nil
}

// Errors of the conditional writes of an object (ADR-0045 amendment 1).
var (
	ErrChanged  = errors.New("caldav: the event changed in the calendar")
	ErrReadOnly = errors.New("caldav: the calendar is read-only")
)

// sameETag compares ETags, weak or strong.
func sameETag(a, b string) bool {
	norm := func(s string) string { return strings.TrimPrefix(strings.TrimSpace(s), "W/") }
	return norm(a) == norm(b)
}

// writeStatus maps the status of a conditional DELETE / PUT.
func writeStatus(st int) error {
	switch {
	case st >= 200 && st < 300:
		return nil
	case st == http.StatusPreconditionFailed:
		return ErrChanged
	case st == http.StatusForbidden || st == http.StatusMethodNotAllowed:
		return ErrReadOnly
	}
	return &StatusError{Status: st}
}

// Get reads one calendar object with its ETag; a missing one is ErrChanged.
func (c *davClient) Get(ctx context.Context, target string, cr creds) (Object, error) {
	st, h, data, err := c.send(ctx, http.MethodGet, target, cr, http.Header{"Accept": {"text/calendar"}}, nil)
	switch {
	case err != nil:
		return Object{}, err
	case st == http.StatusNotFound || st == http.StatusGone:
		return Object{}, ErrChanged
	case st == http.StatusForbidden:
		return Object{}, ErrReadOnly
	case st != http.StatusOK:
		return Object{}, &StatusError{Status: st}
	}
	return Object{Href: target, ETag: strings.TrimSpace(h.Get("ETag")), Data: string(data)}, nil
}

// errNoETag: a conditional write without an ETag is refused (it would overwrite blindly).
var errNoETag = errors.New("caldav: no ETag for a conditional write")

// DeleteIf removes an object if it still has etag (required); one that is gone already is fine.
func (c *davClient) DeleteIf(ctx context.Context, target string, cr creds, etag string) error {
	if etag == "" {
		return errNoETag
	}
	h := http.Header{"If-Match": {etag}}
	st, _, _, err := c.send(ctx, http.MethodDelete, target, cr, h, nil)
	if err != nil {
		return err
	}
	if st == http.StatusNotFound || st == http.StatusGone {
		return nil
	}
	return writeStatus(st)
}

// PutIf replaces an object if it still has etag (required).
func (c *davClient) PutIf(ctx context.Context, target string, cr creds, ics, etag string) error {
	if etag == "" {
		return errNoETag
	}
	h := http.Header{"Content-Type": {"text/calendar; charset=utf-8"}, "If-Match": {etag}}
	st, _, _, err := c.send(ctx, http.MethodPut, target, cr, h, []byte(ics))
	if err != nil {
		return err
	}
	if st == http.StatusNotFound || st == http.StatusGone {
		return ErrChanged
	}
	return writeStatus(st)
}

// Put stores an event object. A server that already has the UID in the calendar (the
// invitation accepted from the mail) answers no-uid-conflict: that is success too.
func (c *davClient) Put(ctx context.Context, target string, cr creds, ics string) error {
	st, data, err := c.do(ctx, http.MethodPut, target, cr, "", "text/calendar; charset=utf-8", []byte(ics))
	if err != nil {
		return err
	}
	if st >= 200 && st < 300 {
		return nil
	}
	if (st == http.StatusConflict || st == http.StatusForbidden || st == http.StatusPreconditionFailed) &&
		bytes.Contains(data, []byte("no-uid-conflict")) {
		return nil
	}
	return &StatusError{Status: st}
}

// Delete removes an event object; a missing one is fine.
func (c *davClient) Delete(ctx context.Context, target string, cr creds) error {
	st, _, err := c.do(ctx, http.MethodDelete, target, cr, "", "", nil)
	if err != nil {
		return err
	}
	if (st >= 200 && st < 300) || st == http.StatusNotFound || st == http.StatusGone {
		return nil
	}
	return &StatusError{Status: st}
}
