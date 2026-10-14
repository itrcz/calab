// Package caldavtest is a small CalDAV server for tests (ADR-0041): basic auth, one principal
// /principals/<user>/, a home /calendars/<user>/ with an event calendar «work», a second one
// «home» and a task list, calendar-query REPORTs with ETags, GET and PUT / DELETE of objects
// (If-Match: 412 on a stale ETag; ReadOnly: 403).
package caldavtest

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
)

// Request is one request the server got.
type Request struct {
	Method, Path, Body string
}

// Server is the fake. Objects maps a path (/calendars/<user>/work/x.ics) to its iCalendar data.
type Server struct {
	*httptest.Server
	User, Password string

	mu       sync.Mutex
	objects  map[string]string
	etags    map[string]int
	gen      int
	requests []Request
	// FailPut makes PUT / DELETE answer this status (0 = normal).
	FailPut int
	// ReadOnly makes PUT / DELETE answer 403 (a calendar shared read-only).
	ReadOnly bool
}

// New starts a TLS server (use Server.Client() / Certificate() to trust it).
func New(user, password string) *Server {
	s := &Server{User: user, Password: password, objects: map[string]string{}, etags: map[string]int{}}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(s.serve))
	return s
}

// Home is the calendar home path.
func (s *Server) Home() string { return "/calendars/" + s.User + "/" }

// Calendar is the path of the calendar «work».
func (s *Server) Calendar() string { return s.Home() + "work/" }

// SetObject stores an object in the «work» calendar (a new ETag).
func (s *Server) SetObject(name, ics string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.store(s.Calendar()+name, ics)
}

func (s *Server) store(path, ics string) {
	s.gen++
	s.objects[path] = ics
	s.etags[path] = s.gen
}

// ETag is the current ETag of an object ("" = none).
func (s *Server) ETag(path string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.objects[path]; !ok {
		return ""
	}
	return fmt.Sprintf(`"%d"`, s.etags[path])
}

// stale: the request's If-Match does not match the object (a missing object never matches).
func (s *Server) stale(r *http.Request, path string) bool {
	m := r.Header.Get("If-Match")
	if m == "" {
		return false
	}
	_, ok := s.objects[path]
	return !ok || m != fmt.Sprintf(`"%d"`, s.etags[path])
}

// Object returns a stored object.
func (s *Server) Object(path string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.objects[path]
	return o, ok
}

// Requests returns the requests so far.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.requests = append(s.requests, Request{r.Method, r.URL.Path, string(body)})
	s.mu.Unlock()
	if u, p, ok := r.BasicAuth(); !ok || u != s.User || p != s.Password {
		w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	path := r.URL.Path
	switch r.Method {
	case "PROPFIND":
		s.propfind(w, path, r.Header.Get("Depth"))
	case "REPORT":
		s.report(w, path)
	case http.MethodGet:
		s.mu.Lock()
		o, ok := s.objects[path]
		etag := s.etags[path]
		s.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
		w.Header().Set("ETag", fmt.Sprintf(`"%d"`, etag))
		_, _ = io.WriteString(w, o)
	case http.MethodPut:
		if st := s.failStatus(); st != 0 {
			w.WriteHeader(st)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.stale(r, path) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		s.store(path, string(body))
		w.WriteHeader(http.StatusCreated)
	case http.MethodDelete:
		if st := s.failStatus(); st != 0 {
			w.WriteHeader(st)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		_, ok := s.objects[path]
		if ok && s.stale(r, path) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		delete(s.objects, path)
		delete(s.etags, path)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func multistatus(w http.ResponseWriter, inner string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusMultiStatus)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">%s</d:multistatus>`, inner)
}

func ok(href, props string) string {
	return `<d:response><d:href>` + href + `</d:href><d:propstat><d:prop>` + props +
		`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

func (s *Server) propfind(w http.ResponseWriter, path, depth string) {
	principal := "/principals/" + s.User + "/"
	switch {
	case path == "/" || path == "":
		multistatus(w, ok("/", `<d:current-user-principal><d:href>`+principal+`</d:href></d:current-user-principal><d:resourcetype><d:collection/></d:resourcetype>`)+
			`<d:response><d:href>/</d:href><d:propstat><d:prop><cal:calendar-home-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`)
	case path == principal:
		multistatus(w, ok(principal, `<cal:calendar-home-set><d:href>`+s.Home()+`</d:href></cal:calendar-home-set>`))
	case path == s.Home() && depth == "1":
		multistatus(w, ok(s.Home(), `<d:resourcetype><d:collection/></d:resourcetype><d:displayname>home set</d:displayname>`)+
			ok(s.Calendar(), `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Работа</d:displayname>`+
				`<ic:calendar-color>#FF2968FF</ic:calendar-color><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>`)+
			ok(s.Home()+"home", `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Дом</d:displayname>`)+
			ok(s.Home()+"tasks/", `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname>`+
				`<cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *Server) report(w http.ResponseWriter, path string) {
	s.mu.Lock()
	var names []string
	for k := range s.objects {
		if strings.HasPrefix(k, path) {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	var b strings.Builder
	for _, k := range names {
		data := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s.objects[k])
		b.WriteString(ok(k, fmt.Sprintf(`<d:getetag>"%d"</d:getetag>`, s.etags[k])+`<cal:calendar-data>`+data+`</cal:calendar-data>`))
	}
	s.mu.Unlock()
	multistatus(w, b.String())
}

func (s *Server) failStatus() int {
	switch {
	case s.FailPut != 0:
		return s.FailPut
	case s.ReadOnly:
		return http.StatusForbidden
	}
	return 0
}
