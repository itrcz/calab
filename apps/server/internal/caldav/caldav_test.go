package caldav

import (
	"context"
	"crypto/x509"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	l, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func ics(events ...string) string {
	return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n" + strings.Join(events, "") + "END:VCALENDAR\r\n"
}

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestBusySingleAndSkipped(t *testing.T) {
	data := ics(
		"BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Secret title\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\n"+
			"BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nDURATION:PT5M\r\nEND:VALARM\r\nEND:VEVENT\r\n",
		"BEGIN:VEVENT\r\nUID:free\r\nDTSTART:20261001T110000Z\r\nDTEND:20261001T120000Z\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\n",
		"BEGIN:VEVENT\r\nUID:gone\r\nDTSTART:20261001T110000Z\r\nDTEND:20261001T120000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n",
		"BEGIN:VEVENT\r\nUID:0192-abc@calab\r\nDTSTART:20261001T130000Z\r\nDTEND:20261001T140000Z\r\nEND:VEVENT\r\n",
		// folded DTSTART line, a TZID and DURATION
		"BEGIN:VEVENT\r\nUID:b\r\nDTSTART;TZID=Europe/Moscow:2026100\r\n 1T150000\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\n",
		// Windows zone name
		"BEGIN:VEVENT\r\nUID:c\r\nDTSTART;TZID=\"Russian Standard Time\":20261002T100000\r\nDTEND;TZID=\"Russian Standard Time\":20261002T110000\r\nEND:VEVENT\r\n",
	)
	got := BusyFromICS(data, utc("2026-09-30T00:00:00Z"), utc("2026-10-10T00:00:00Z"), time.UTC)
	want := [][2]string{
		{"2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"},
		{"2026-10-01T12:00:00Z", "2026-10-01T13:30:00Z"},
		{"2026-10-02T07:00:00Z", "2026-10-02T08:00:00Z"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i, w := range want {
		if !got[i].Start.Equal(utc(w[0])) || !got[i].End.Equal(utc(w[1])) || got[i].AllDay {
			t.Errorf("%d: %v, want %v", i, got[i], w)
		}
		if len(got[i].UID) != 16 {
			t.Errorf("uid not hashed: %q", got[i].UID)
		}
	}
}

func TestBusyAllDayInUserZone(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	data := ics("BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261007\r\nEND:VEVENT\r\n")
	got := BusyFromICS(data, utc("2026-10-01T00:00:00Z"), utc("2026-10-10T00:00:00Z"), ny)
	if len(got) != 1 || !got[0].AllDay {
		t.Fatalf("got %v", got)
	}
	if want := time.Date(2026, 10, 5, 0, 0, 0, 0, ny); !got[0].Start.Equal(want) {
		t.Errorf("start %v, want %v", got[0].Start, want)
	}
	if want := time.Date(2026, 10, 7, 0, 0, 0, 0, ny); !got[0].End.Equal(want) {
		t.Errorf("end %v, want %v", got[0].End, want)
	}
}

func TestBusyWeeklyByDayAcrossDST(t *testing.T) {
	berlin := mustLoc(t, "Europe/Berlin")
	// Mon/Wed 10:00 Berlin from Mon 19 Oct 2026; DST ends Sun 25 Oct. One occurrence moved,
	// one excluded, COUNT 6.
	data := ics(
		"BEGIN:VEVENT\r\nUID:s\r\nDTSTART;TZID=Europe/Berlin:20261019T100000\r\nDTEND;TZID=Europe/Berlin:20261019T103000\r\n"+
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE;TZID=Europe/Berlin:20261021T100000\r\nEND:VEVENT\r\n",
		"BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261026T100000\r\nDTSTART;TZID=Europe/Berlin:20261026T150000\r\n"+
			"DTEND;TZID=Europe/Berlin:20261026T153000\r\nEND:VEVENT\r\n",
	)
	got := BusyFromICS(data, utc("2026-10-01T00:00:00Z"), utc("2026-12-01T00:00:00Z"), time.UTC)
	want := []time.Time{
		time.Date(2026, 10, 19, 10, 0, 0, 0, berlin), // 08:00Z (CEST)
		// 21st excluded; 26th moved to 15:00 (override listed after the master's)
		time.Date(2026, 10, 28, 10, 0, 0, 0, berlin), // 09:00Z (CET)
		time.Date(2026, 11, 2, 10, 0, 0, 0, berlin),
		time.Date(2026, 11, 4, 10, 0, 0, 0, berlin),
		time.Date(2026, 10, 26, 15, 0, 0, 0, berlin),
	}
	if len(got) != len(want) {
		t.Fatalf("got %d: %v", len(got), got)
	}
	for i, w := range want {
		if !got[i].Start.Equal(w) || got[i].End.Sub(got[i].Start) != 30*time.Minute {
			t.Errorf("%d: %v, want %v", i, got[i].Start, w.UTC())
		}
	}
	if got[0].Start.UTC().Hour() != 8 || got[1].Start.UTC().Hour() != 9 {
		t.Errorf("wall clock not kept across DST: %v %v", got[0].Start.UTC(), got[1].Start.UTC())
	}
}

func TestBusyRecurrenceVariants(t *testing.T) {
	from, to := utc("2026-10-01T00:00:00Z"), utc("2026-10-31T00:00:00Z")
	cases := []struct {
		name, rrule, dtstart string
		want                 int
	}{
		{"daily old series skipped ahead", "FREQ=DAILY", "20150101T090000Z", 30},
		{"daily until", "FREQ=DAILY;UNTIL=20261005T235959Z", "20261001T090000Z", 5},
		{"every 3 days", "FREQ=DAILY;INTERVAL=3", "20261001T090000Z", 10},
		{"weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "20261001T090000Z", 22},
		{"biweekly", "FREQ=WEEKLY;INTERVAL=2", "20261001T090000Z", 3},
		{"monthly 2nd tuesday", "FREQ=MONTHLY;BYDAY=2TU", "20260908T090000Z", 1},
		{"monthly last friday", "FREQ=MONTHLY;BYDAY=-1FR", "20260925T090000Z", 1},
		{"monthly 31st skips", "FREQ=MONTHLY", "20260831T090000Z", 0},
		{"yearly", "FREQ=YEARLY", "20201015T090000Z", 1},
		{"count from the start", "FREQ=DAILY;COUNT=3", "20260929T090000Z", 1},
		{"bad rule is the first only", "FREQ=SECONDLY", "20261002T090000Z", 1},
	}
	for _, c := range cases {
		data := ics("BEGIN:VEVENT\r\nUID:x\r\nDTSTART:" + c.dtstart + "\r\nDURATION:PT1H\r\nRRULE:" + c.rrule + "\r\nEND:VEVENT\r\n")
		if got := BusyFromICS(data, from, to, time.UTC); len(got) != c.want {
			t.Errorf("%s: %d occurrences, want %d", c.name, len(got), c.want)
		}
	}
}

func TestParseDuration(t *testing.T) {
	for in, want := range map[string]time.Duration{"PT1H": time.Hour, "P1D": 24 * time.Hour, "P1W": 7 * 24 * time.Hour,
		"P1DT2H30M": 26*time.Hour + 30*time.Minute, "-PT5M": 0, "PT45S": 45 * time.Second} {
		if got, err := parseDuration(in); err != nil || got != want {
			t.Errorf("%s: %v %v", in, got, err)
		}
	}
	if _, err := parseDuration("1H"); err == nil {
		t.Error("bad duration accepted")
	}
}

func TestColor(t *testing.T) {
	for in, want := range map[string]string{"#ff2968FF": "#FF2968", "#00AA00": "#00AA00", "red": "", "#12345": ""} {
		if got := color(in); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
}

func testClient(s *caldavtest.Server) *davClient {
	pool := x509.NewCertPool()
	pool.AddCert(s.Certificate())
	return newDAVClient(Options{AllowAddr: func(netip.Addr) bool { return true }, RootCAs: pool})
}

func TestDiscoverQueryPutDelete(t *testing.T) {
	s := caldavtest.New("anna", "app-pass")
	defer s.Close()
	c := testClient(s)
	ctx := context.Background()
	cr := creds{"anna", "app-pass"}
	cals, err := c.Discover(ctx, s.URL+"/", cr)
	if err != nil {
		t.Fatal(err)
	}
	if len(cals) != 2 || cals[0].Href != s.URL+s.Calendar() || cals[0].Name != "Работа" || cals[0].Color != "#FF2968" ||
		cals[1].Href != s.URL+s.Home()+"home/" || cals[1].Color != "" {
		t.Fatalf("calendars %+v", cals)
	}
	// Starting from the principal works too.
	if cals, err := c.Discover(ctx, s.URL+"/principals/anna/", cr); err != nil || len(cals) != 2 {
		t.Fatalf("from principal: %v %v", cals, err)
	}
	if _, err := c.Discover(ctx, s.URL+"/", creds{"anna", "wrong"}); !errors.Is(err, ErrAuth) {
		t.Fatalf("bad password: %v", err)
	}
	if _, err := c.Discover(ctx, strings.Replace(s.URL, "https", "http", 1)+"/", cr); !errors.Is(err, ErrURL) {
		t.Fatalf("http accepted: %v", err)
	}

	s.SetObject("a.ics", ics("BEGIN:VEVENT\r\nUID:q\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\nEND:VEVENT\r\n"))
	objs, err := c.Query(ctx, cals[0].Href, cr, utc("2026-09-30T00:00:00Z"), utc("2026-10-30T00:00:00Z"))
	if err != nil || len(objs) != 1 || !strings.Contains(objs[0].Data, "UID:q") || objs[0].Href != cals[0].Href+"a.ics" || objs[0].ETag != `"1"` {
		t.Fatalf("query %v %v", objs, err)
	}
	last := s.Requests()[len(s.Requests())-1]
	if last.Method != "REPORT" || !strings.Contains(last.Body, `start="20260930T000000Z"`) {
		t.Fatalf("report %+v", last)
	}

	target := cals[0].Href + "e1.ics"
	if err := c.Put(ctx, target, cr, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Object(s.Calendar() + "e1.ics"); !ok {
		t.Fatal("not stored")
	}
	if err := c.Delete(ctx, target, cr); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, target, cr); err != nil {
		t.Fatalf("delete of a missing object: %v", err)
	}
	s.FailPut = http.StatusInternalServerError
	var se *StatusError
	if err := c.Put(ctx, target, cr, "x"); !errors.As(err, &se) || se.Status != 500 {
		t.Fatalf("failing put: %v", err)
	}
}

func TestClientLimits(t *testing.T) {
	big := strings.Repeat("x", maxBody+10)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "https://example.com/", http.StatusFound)
		case "/uidconflict":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:no-uid-conflict/></d:error>`))
		default:
			_, _ = w.Write([]byte(big))
		}
	}))
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	c := newDAVClient(Options{AllowAddr: func(netip.Addr) bool { return true }, RootCAs: pool})
	ctx := context.Background()
	if _, _, err := c.do(ctx, "GET", srv.URL+"/big", creds{}, "", "", nil); !errors.Is(err, ErrTooLarge) {
		t.Errorf("large: %v", err)
	}
	if _, _, err := c.do(ctx, "GET", srv.URL+"/redirect", creds{}, "", "", nil); !errors.Is(err, ErrRedirect) {
		t.Errorf("redirect: %v", err)
	}
	if err := c.Put(ctx, srv.URL+"/uidconflict", creds{}, "x"); err != nil {
		t.Errorf("no-uid-conflict: %v", err)
	}
	// The production policy refuses loopback, literal or resolved.
	strict := newDAVClient(Options{AllowAddr: func(a netip.Addr) bool { return !a.IsLoopback() }, RootCAs: pool})
	if _, _, err := strict.do(ctx, "GET", srv.URL, creds{}, "", "", nil); !errors.Is(err, ErrURL) {
		t.Errorf("loopback: %v", err)
	}
	if _, err := CheckURL("https://localhost:1/", func(a netip.Addr) bool { return !a.IsLoopback() }); !errors.Is(err, ErrURL) {
		t.Errorf("localhost: %v", err)
	}
}

// Conditional writes (ADR-0045 amendment 1): the ETag of the import and of GET, If-Match, 412,
// a read-only calendar.
func TestConditionalWrites(t *testing.T) {
	s := caldavtest.New("anna", "app-pass")
	defer s.Close()
	c := testClient(s)
	ctx := context.Background()
	cr := creds{"anna", "app-pass"}
	target := s.URL + s.Calendar() + "a.ics"
	s.SetObject("a.ics", ics("BEGIN:VEVENT\r\nUID:q\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\nEND:VEVENT\r\n"))
	objs, err := c.Query(ctx, s.URL+s.Calendar(), cr, utc("2026-09-30T00:00:00Z"), utc("2026-10-30T00:00:00Z"))
	if err != nil || len(objs) != 1 || objs[0].Href != target || objs[0].ETag != s.ETag(s.Calendar()+"a.ics") {
		t.Fatalf("query %+v %v", objs, err)
	}
	etag := objs[0].ETag
	obj, err := c.Get(ctx, target, cr)
	if err != nil || obj.ETag != etag || !strings.Contains(obj.Data, "UID:q") {
		t.Fatalf("get %+v %v", obj, err)
	}
	if err := c.PutIf(ctx, target, cr, obj.Data, `"stale"`); !errors.Is(err, ErrChanged) {
		t.Fatalf("stale put: %v", err)
	}
	if err := c.PutIf(ctx, target, cr, obj.Data, etag); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteIf(ctx, target, cr, etag); !errors.Is(err, ErrChanged) {
		t.Fatalf("delete with the old etag after a write: %v", err)
	}
	s.ReadOnly = true
	if err := c.DeleteIf(ctx, target, cr, s.ETag(s.Calendar()+"a.ics")); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("read-only: %v", err)
	}
	s.ReadOnly = false
	if err := c.DeleteIf(ctx, target, cr, s.ETag(s.Calendar()+"a.ics")); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteIf(ctx, target, cr, etag); err != nil {
		t.Fatalf("delete of a missing object: %v", err)
	}
	if _, err := c.Get(ctx, target, cr); !errors.Is(err, ErrChanged) {
		t.Fatalf("get of a missing object: %v", err)
	}
	if !sameETag(`W/"1"`, `"1"`) || sameETag(`"1"`, `"2"`) {
		t.Error("sameETag")
	}
}
