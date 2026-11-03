//go:build integration

package app_test

import (
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// One occurrence or the following ones of a series (ADR-0157, board #147): «Только эту» makes an
// override mailed alone (RECURRENCE-ID), «Всю серию» splits the series; cancellations and
// overrides follow their occurrences.
func TestEventSeriesOccurrenceScopes(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	partner := uniq("series") + "@outside.org"
	msk, _ := time.LoadLocation("Europe/Moscow")
	d := time.Now().In(msk).AddDate(0, 0, 3)
	start := time.Date(d.Year(), d.Month(), d.Day(), 10, 0, 0, 0, msk)
	o := func(i int) time.Time { return start.AddDate(0, 0, 7*i) }
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Weekly", StartsAt: ts(start), EndsAt: ts(start.Add(30 * time.Minute)),
		Tz: "Europe/Moscow", Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, RepeatUntil: ts(o(5).Add(6 * time.Hour)), RoomId: c.voice.GetId(),
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), ext(partner)}})
	waitMail(t, c.bob.email, mail.TemplateEventInvite, 1)
	from, to := start.Add(-time.Hour), o(6)
	type row struct{ id, series, title string }
	listed := func() map[string]row { // local start "01-02 15:04" → occurrence
		t.Helper()
		out := map[string]row{}
		for _, e := range listEvents(t, c.bob, wsID, from, to) {
			k := e.GetStartsAt().AsTime().In(msk).Format("01-02 15:04")
			if _, dup := out[k]; dup {
				t.Fatalf("two occurrences at %s", k)
			}
			out[k] = row{e.GetId(), e.GetSeriesId(), e.GetTitle()}
		}
		return out
	}
	at := func(t time.Time) string { return t.In(msk).Format("01-02 15:04") }
	patch := func(u *user, id string, req *v1.UpdateCalendarEventRequest) *v1.CalendarEvent {
		t.Helper()
		var resp v1.CalendarEventResponse
		u.must(200, "PATCH", "/api/events/"+id, req, &resp)
		return resp.GetEvent()
	}
	updates := func(to string) int {
		return testMail.Count(func(m mail.Message) bool { return m.To == to && m.Template == mail.TemplateEventUpdate })
	}

	// Rights and validation: a scope needs a live occurrence; only editors.
	this := v1.EventScope_EVENT_SCOPE_THIS
	c.bob.must(403, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: this, OccurrenceAt: ts(o(1))}, nil)
	c.o.must(422, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: this, OccurrenceAt: ts(o(1).Add(time.Minute))}, nil)

	// «Только эту»: o1 moves to 15:00 — an override; the series and its other occurrences stay.
	moved := o(1).Add(5 * time.Hour)
	ov := patch(c.o, ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: this, OccurrenceAt: ts(o(1)), StartsAt: ts(moved), EndsAt: ts(moved.Add(30 * time.Minute))})
	if ov.GetSeriesId() != ev.GetId() || !ov.GetRecurrenceAt().AsTime().Equal(o(1)) || ov.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED ||
		!ov.GetStartsAt().AsTime().Equal(moved) || attendeeOf(ov, c.bob.id, "") == nil || attendeeOf(ov, "", partner) == nil {
		t.Fatalf("override: %v", ov)
	}
	got := listed()
	if len(got) != 6 || got[at(moved)].id != ov.GetId() || got[at(o(1))].id != "" || got[at(o(2))].id != ev.GetId() {
		t.Fatalf("after «only this»: %v", got)
	}
	var sr v1.CalendarEventResponse
	c.o.must(200, "GET", "/api/events/"+ev.GetId(), nil, &sr)
	if sr.GetEvent().GetSequence() != 0 || len(sr.GetEvent().GetCancelledOccurrences()) != 0 {
		t.Fatalf("the series changed: %v", sr.GetEvent())
	}
	// The attendees hear about that occurrence alone: the series' UID with RECURRENCE-ID, no RRULE.
	for _, to := range []string{c.bob.email, partner} {
		m := waitMail(t, to, mail.TemplateEventUpdate, 1)
		ics := unfoldICS(m.Calendar)
		for _, want := range []string{"UID:" + ev.GetId() + "@calab", "RECURRENCE-ID:" + o(1).UTC().Format("20060102T150405Z"),
			"DTSTART:" + moved.UTC().Format("20060102T150405Z"), "METHOD:REQUEST"} {
			if !strings.Contains(ics, want) {
				t.Errorf("%s: no %q in\n%s", to, want, ics)
			}
		}
		if strings.Contains(ics, "RRULE") {
			t.Errorf("%s: the occurrence's mail carries the series:\n%s", to, ics)
		}
	}
	time.Sleep(300 * time.Millisecond) // a stray series mail would land by now
	if n := updates(c.bob.email); n != 1 {
		t.Errorf("bob got %d update mails for one occurrence, want 1", n)
	}
	// The organizer's export holds the series with the override under one UID (CalDAV-compatible).
	_, _, exp := calendarHTTP(t, c.o.token, "GET", "/api/events/"+ev.GetId()+"/calendar.ics")
	if ics := unfoldICS(exp); strings.Count(ics, "UID:"+ev.GetId()+"@calab") != 2 || !strings.Contains(ics, "RECURRENCE-ID:") ||
		strings.Contains(ics, "EXDATE") {
		t.Errorf("export:\n%s", ics)
	}

	// Cancel o4 alone (CANCEL of that occurrence) and change o3 alone.
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(o(4).UTC().Format(time.RFC3339)), nil, nil)
	if ics := unfoldICS(waitMail(t, c.bob.email, mail.TemplateEventCancel, 1).Calendar); !strings.Contains(ics, "METHOD:CANCEL") ||
		!strings.Contains(ics, "RECURRENCE-ID:"+o(4).UTC().Format("20060102T150405Z")) || strings.Contains(ics, "RRULE") {
		t.Errorf("occurrence cancel:\n%s", ics)
	}
	// Cancelling it again changes nothing (idempotent, as before ADR-0157); an overridden
	// occurrence is cancelled by the override's own id.
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(o(4).UTC().Format(time.RFC3339)), nil, nil)
	c.o.must(422, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(o(1).UTC().Format(time.RFC3339)), nil, nil)
	special := "Special"
	ov3 := patch(c.o, ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: this, OccurrenceAt: ts(o(3)), Title: &special,
		SetAttendees: true, Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), att(c.carol.id, false), ext(partner)}})
	if attendeeOf(ov3, c.carol.id, "") == nil || attendeeOf(sr.GetEvent(), c.carol.id, "") != nil {
		t.Fatalf("carol is on the occurrence only: %v", ov3)
	}
	waitMail(t, c.carol.email, mail.TemplateEventInvite, 1)
	c.o.must(422, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: this, OccurrenceAt: ts(o(3))}, nil) // overridden already

	// The whole series one hour later: the cancellation and the overrides follow their occurrences.
	h := time.Hour
	patch(c.o, ev.GetId(), &v1.UpdateCalendarEventRequest{StartsAt: ts(start.Add(h)), EndsAt: ts(start.Add(h + 30*time.Minute))})
	got = listed()
	if len(got) != 5 || got[at(moved)].id != ov.GetId() || got[at(o(3))].id != ov3.GetId() || got[at(o(2).Add(h))].id != ev.GetId() ||
		got[at(o(4).Add(h))].id != "" || got[at(o(1).Add(h))].id != "" {
		t.Fatalf("after moving the series: %v", got)
	}

	// «Всю серию» from o2: the series is split; o3's override and o4's cancellation go with it.
	newTitle := "Weekly 2"
	following := v1.EventScope_EVENT_SCOPE_FOLLOWING
	next := patch(c.o, ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: following, OccurrenceAt: ts(o(2).Add(h)), Title: &newTitle})
	if next.GetId() == ev.GetId() || next.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_WEEKLY || !next.GetStartsAt().AsTime().Equal(o(2).Add(h)) ||
		len(next.GetCancelledOccurrences()) != 1 || !next.GetCancelledOccurrences()[0].AsTime().Equal(o(4).Add(h)) || attendeeOf(next, c.bob.id, "") == nil {
		t.Fatalf("new series: %v", next)
	}
	c.o.must(200, "GET", "/api/events/"+ev.GetId(), nil, &sr)
	if u := sr.GetEvent().GetRepeatUntil(); u == nil || !u.AsTime().Before(o(2).Add(h)) || len(sr.GetEvent().GetCancelledOccurrences()) != 0 {
		t.Fatalf("old series: %v", sr.GetEvent())
	}
	got = listed()
	if len(got) != 5 || got[at(start.Add(h))].title != "Weekly" || got[at(moved)].series != ev.GetId() || got[at(o(2).Add(h))].id != next.GetId() ||
		got[at(o(3))].series != next.GetId() || got[at(o(3))].title != special || got[at(o(5).Add(h))].title != newTitle {
		t.Fatalf("after the split: %v", got)
	}

	// Cancel the following from o5 (the new series ends before it), then the moved o1 alone.
	before := updates(c.bob.email)
	c.o.must(204, "DELETE", "/api/events/"+next.GetId()+"?scope=following&occurrence="+url.QueryEscape(o(5).Add(h).UTC().Format(time.RFC3339)), nil, nil)
	waitMail(t, c.bob.email, mail.TemplateEventUpdate, before+1)
	c.o.must(204, "DELETE", "/api/events/"+ov.GetId(), nil, nil)
	if ics := unfoldICS(waitMail(t, c.bob.email, mail.TemplateEventCancel, 2).Calendar); !strings.Contains(ics, "UID:"+ev.GetId()+"@calab") ||
		!strings.Contains(ics, "RECURRENCE-ID:"+o(1).Add(h).UTC().Format("20060102T150405Z")) {
		t.Errorf("override cancel:\n%s", ics)
	}
	got = listed()
	if len(got) != 3 || got[at(moved)].id != "" || got[at(o(1).Add(h))].id != "" || got[at(o(5).Add(h))].id != "" {
		t.Fatalf("after the cancellations: %v", got)
	}
	c.o.must(200, "GET", "/api/events/"+ev.GetId(), nil, &sr)
	if cs := sr.GetEvent().GetCancelledOccurrences(); len(cs) != 1 || !cs[0].AsTime().Equal(o(1).Add(h)) {
		t.Fatalf("the cancelled override is a cancelled occurrence: %v", cs)
	}

	// «Всю серию» from the first occurrence is the whole series (no new one).
	first := "Weekly all"
	whole := patch(c.o, ev.GetId(), &v1.UpdateCalendarEventRequest{Scope: following, OccurrenceAt: ts(start.Add(h)), Title: &first})
	if whole.GetId() != ev.GetId() || whole.GetTitle() != first {
		t.Fatalf("from the first occurrence: %v", whole)
	}

	// Cancelling a series cancels its overrides: whoever is on an override only (carol, o3) gets a
	// CANCEL of that occurrence (RECURRENCE-ID); the series' attendees one CANCEL of the series.
	// (Bob's hourly budget of meeting mail is spent by now, so only carol's mail is asserted.)
	c.o.must(204, "DELETE", "/api/events/"+next.GetId(), nil, nil)
	if ics := unfoldICS(waitMail(t, c.carol.email, mail.TemplateEventCancel, 1).Calendar); !strings.Contains(ics, "UID:"+next.GetId()+"@calab") ||
		!strings.Contains(ics, "RECURRENCE-ID:"+o(3).Add(h).UTC().Format("20060102T150405Z")) || strings.Contains(ics, "RRULE") {
		t.Errorf("override-only attendee's cancel:\n%s", ics)
	}
	if got = listed(); len(got) != 1 || got[at(start.Add(h))].title != first {
		t.Fatalf("after cancelling the new series: %v", got)
	}
}
