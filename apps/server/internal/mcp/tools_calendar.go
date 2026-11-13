package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The calendar tools of CBF-188: `calendar` reads (meetings of a period, one meeting with its
// comments, free / busy, common free slots), `event` writes (create, reschedule, cancel,
// comment). Times are taken as ISO 8601 (an offset, or the caller's zone without one) and
// answered in the caller's zone (its profile timezone; UTC without one), named once as "tz".

// whoAmI is the caller as the tools see it: the person (OAuth, a bot on behalf) or the bot.
type whoAmI struct {
	id  string
	tz  string // IANA zone of the profile; "" = none (UTC is used)
	loc *time.Location
}

func caller(ctx context.Context, c *api) (whoAmI, error) {
	var r v1.GetMeResponse
	if err := c.call(ctx, http.MethodGet, "/api/me", nil, nil, &r); err != nil {
		return whoAmI{}, err
	}
	u := r.GetMe().GetUser()
	w := whoAmI{id: u.GetId(), tz: u.GetTimezone(), loc: time.UTC}
	if w.tz != "" {
		if loc, err := time.LoadLocation(w.tz); err == nil {
			w.loc = loc
		} else {
			w.tz = ""
		}
	}
	return w, nil
}

func (w whoAmI) zone() string {
	if w.tz == "" {
		return "UTC"
	}
	return w.tz
}

// parseWhen reads ISO 8601: with an offset (2026-11-14T10:00+03:00, …Z), or a local date-time /
// date in loc (2026-11-14T10:00, 2026-11-14 10:00, 2026-11-14).
func parseWhen(s string, loc *time.Location) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, l := range []string{time.RFC3339, "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		}
	}
	for _, l := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(l, s, loc); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("time " + strconv.Quote(s) + ": use ISO 8601, e.g. 2026-11-14T10:00+03:00 (without an offset: your zone)")
}

// span is a compact interval in loc: "2026-11-14 10:00–11:00", across days with both dates;
// an all-day one by its dates.
func span(from, to time.Time, allDay bool, loc *time.Location) string {
	from, to = from.In(loc), to.In(loc)
	if allDay {
		last := to.Add(-time.Nanosecond)
		if last.Format(time.DateOnly) == from.Format(time.DateOnly) {
			return from.Format(time.DateOnly) + " all day"
		}
		return from.Format(time.DateOnly) + "–" + last.Format(time.DateOnly) + " all day"
	}
	if from.Format(time.DateOnly) == to.Format(time.DateOnly) {
		return from.Format("2006-01-02 15:04") + "–" + to.Format("15:04")
	}
	return from.Format("2006-01-02 15:04") + " – " + to.Format("2006-01-02 15:04")
}

// oneWorkspace is ws, or the caller's only workspace; several: an error naming them.
func oneWorkspace(ctx context.Context, c *api, ws string) (string, error) {
	if ws = strings.TrimSpace(ws); ws != "" {
		return ws, nil
	}
	var r v1.ListWorkspacesResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces", nil, nil, &r); err != nil {
		return "", err
	}
	switch len(r.GetWorkspaces()) {
	case 0:
		return "", errors.New("no workspaces")
	case 1:
		return r.GetWorkspaces()[0].GetId(), nil
	}
	names := make([]string, 0, len(r.GetWorkspaces()))
	for _, w := range r.GetWorkspaces() {
		names = append(names, w.GetName()+" ("+w.GetId()+")")
	}
	return "", errors.New("give workspace: " + strings.Join(names, ", "))
}

// window is [from, to) of the arguments; def is the default length from the start of today.
func window(a args, loc *time.Location, def time.Duration) (time.Time, time.Time, error) {
	now := time.Now().In(loc)
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	var err error
	if a.From != "" {
		if from, err = parseWhen(a.From, loc); err != nil {
			return from, from, err
		}
	}
	to := from.Add(def)
	if a.To != "" {
		if to, err = parseWhen(a.To, loc); err != nil {
			return from, to, err
		}
		if len(strings.TrimSpace(a.To)) == len(time.DateOnly) { // a date: the whole day
			to = to.AddDate(0, 0, 1)
		}
	}
	if !to.After(from) {
		return from, to, errors.New("to must be after from")
	}
	return from, to, nil
}

// users resolves people (me, ids, names, nicknames) in ws.
func users(ctx context.Context, c *api, ws string, refs []string) ([]string, error) {
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		id, err := resolveUser(ctx, c, ws, ref)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

// resolveRoom finds a room of ws by id or name (exact, else a unique part; voice rooms first
// when voice is set: a meeting's room is a voice room).
func resolveRoom(ctx context.Context, c *api, ws, ref string, voice bool) (string, error) {
	ref = strings.TrimSpace(ref)
	if _, err := uuid.Parse(ref); err == nil {
		return ref, nil
	}
	var r v1.ListRoomsResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/rooms", nil, nil, &r); err != nil {
		return "", err
	}
	low := strings.ToLower(strings.TrimPrefix(ref, "#"))
	var exact, partial []*v1.Room
	for _, x := range r.GetRooms() {
		if voice && x.GetType() != v1.RoomType_ROOM_TYPE_VOICE {
			continue
		}
		name := strings.ToLower(x.GetName())
		switch {
		case name == low:
			exact = append(exact, x)
		case strings.Contains(name, low):
			partial = append(partial, x)
		}
	}
	found := exact
	if len(found) == 0 {
		found = partial
	}
	switch len(found) {
	case 1:
		return found[0].GetId(), nil
	case 0:
		if voice {
			return "", errors.New("no voice room " + strconv.Quote(ref))
		}
		return "", errors.New("no room " + strconv.Quote(ref))
	}
	names := make([]string, 0, len(found))
	for _, x := range found {
		names = append(names, x.GetName()+" ("+x.GetId()+")")
	}
	return "", errors.New("several rooms match " + strconv.Quote(ref) + ": " + strings.Join(names, ", "))
}

var repeats = map[string]v1.EventRepeat{
	"none": v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED, "daily": v1.EventRepeat_EVENT_REPEAT_DAILY,
	"weekly": v1.EventRepeat_EVENT_REPEAT_WEEKLY, "biweekly": v1.EventRepeat_EVENT_REPEAT_BIWEEKLY,
	"monthly": v1.EventRepeat_EVENT_REPEAT_MONTHLY, "workdays": v1.EventRepeat_EVENT_REPEAT_WORKDAYS,
}

func repeatOf(s string) (v1.EventRepeat, error) {
	r, ok := repeats[strings.ToLower(strings.TrimSpace(s))]
	if !ok {
		return 0, errors.New("repeat must be none, daily, weekly, biweekly, monthly or workdays")
	}
	return r, nil
}

// eventBrief is a meeting in a list (one occurrence).
func eventBrief(e *v1.CalendarEvent, me whoAmI) map[string]any {
	out := map[string]any{"id": e.GetId(), "title": e.GetTitle(), "when": span(e.GetStartsAt().AsTime(), e.GetEndsAt().AsTime(), e.GetAllDay(), me.loc),
		"room": e.GetRoomId(), "organizer": e.GetOrganizerId(), "me": enum(e.GetMyStatus().String(), "ATTENDEE_STATUS_"),
		"repeat": enum(e.GetRepeat().String(), "EVENT_REPEAT_")}
	if e.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED && e.GetOccurrenceAt() != nil {
		// the occurrence a change or a cancellation of one meeting of the series names
		out["occurrence"] = e.GetOccurrenceAt().AsTime().UTC().Format(time.RFC3339)
	}
	if n := e.GetCounts(); n != nil {
		out["people"] = n.GetAccepted() + n.GetMaybe() + n.GetPending() + n.GetDeclined()
		out["comments"] = n.GetComments()
	}
	return compact(out)
}

// eventFull is one meeting with its attendees.
func eventFull(e *v1.CalendarEvent, me whoAmI) map[string]any {
	out := eventBrief(e, me)
	delete(out, "people")
	out["description"], out["workspace"], out["can_edit"] = e.GetDescription(), e.GetWorkspaceId(), e.GetCanEdit()
	if e.GetRepeatUntil() != nil {
		out["repeat_until"] = e.GetRepeatUntil().AsTime().In(me.loc).Format(time.DateOnly)
	}
	var people []map[string]any
	for _, at := range e.GetAttendees() {
		p := compact(map[string]any{"user": at.GetUserId(), "email": at.GetEmail(), "status": enum(at.GetStatus().String(), "ATTENDEE_STATUS_")})
		if !at.GetRequired() {
			p["optional"] = true
		}
		people = append(people, p)
	}
	out["attendees"] = people
	return compact(out)
}

// ---- calendar ----

func calendarTool(ctx context.Context, c *api, a args) (any, error) {
	me, err := caller(ctx, c)
	if err != nil {
		return nil, err
	}
	switch a.Action {
	case "", "list":
		return listEvents(ctx, c, a, me)
	case "event":
		return readEvent(ctx, c, a, me)
	case "freebusy":
		return freeBusy(ctx, c, a, me)
	case "suggest":
		return suggestSlots(ctx, c, a, me)
	}
	return nil, errors.New("action must be list, event, freebusy or suggest")
}

func listEvents(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	from, to, err := window(a, me.loc, 7*24*time.Hour)
	if err != nil {
		return nil, err
	}
	wss, err := workspaceIDs(ctx, c, a.Workspace)
	if err != nil {
		return nil, err
	}
	qs := url.Values{"from": {from.UTC().Format(time.RFC3339)}, "to": {to.UTC().Format(time.RFC3339)}}
	limit := clamp(a.Limit, 50, 100)
	var list []map[string]any
	more := false
	for _, ws := range wss {
		var r v1.ListCalendarEventsResponse
		if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/events", qs, nil, &r); err != nil {
			// a workspace where the caller is a guest (403) has no calendar: skipped when not asked for
			var ae *apiError
			if a.Workspace == "" && errors.As(err, &ae) && (ae.status == http.StatusForbidden || ae.status == http.StatusNotFound) {
				continue
			}
			return nil, err
		}
		for _, e := range r.GetEvents() {
			if !a.All && !mine(e, me.id) {
				continue
			}
			if len(list) >= limit {
				more = true
				break
			}
			b := eventBrief(e, me)
			if len(wss) > 1 {
				b["workspace"] = ws
			}
			list = append(list, b)
		}
	}
	out := map[string]any{"tz": me.zone(), "from": from.In(me.loc).Format("2006-01-02 15:04"), "to": to.In(me.loc).Format("2006-01-02 15:04"), "events": list, "more": more}
	if len(list) == 0 {
		out["events"] = []map[string]any{}
	}
	return compact(out), nil
}

// mine: the caller organizes or attends the meeting.
func mine(e *v1.CalendarEvent, me string) bool {
	if e.GetOrganizerId() == me {
		return true
	}
	for _, at := range e.GetAttendees() {
		if at.GetUserId() == me {
			return true
		}
	}
	return false
}

func readEvent(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if err := need("event", a.Event); err != nil {
		return nil, err
	}
	var r v1.CalendarEventResponse
	if err := c.call(ctx, http.MethodGet, "/api/events/"+seg(a.Event), nil, nil, &r); err != nil {
		return nil, err
	}
	if a.Full {
		return raw(&r)
	}
	out := eventFull(r.GetEvent(), me)
	out["tz"] = me.zone()
	if r.GetEvent().GetCounts().GetComments() > 0 {
		var cs v1.ListCalendarEventCommentsResponse
		qs := url.Values{"limit": {strconv.Itoa(clamp(a.Comments, 20, 50))}}
		if err := c.call(ctx, http.MethodGet, "/api/events/"+seg(a.Event)+"/comments", qs, nil, &cs); err != nil {
			return nil, err
		}
		list := make([]map[string]any, 0, len(cs.GetComments()))
		for _, cm := range cs.GetComments() {
			list = append(list, compact(map[string]any{"id": cm.GetId(), "author": cm.GetAuthorId(), "text": cm.GetBody(),
				"at": cm.GetCreatedAt().AsTime().In(me.loc).Format("2006-01-02 15:04")}))
		}
		out["recent_comments"], out["more_comments"] = list, cs.GetHasMore()
	}
	return compact(out), nil
}

func freeBusy(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if len(a.Users) == 0 {
		return nil, errors.New("users is required")
	}
	ws, err := oneWorkspace(ctx, c, a.Workspace)
	if err != nil {
		return nil, err
	}
	ids, err := users(ctx, c, ws, a.Users)
	if err != nil {
		return nil, err
	}
	from, to, err := window(a, me.loc, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	var r v1.FreeBusyResponse
	qs := url.Values{"users": {strings.Join(ids, ",")}, "from": {from.UTC().Format(time.RFC3339)}, "to": {to.UTC().Format(time.RFC3339)}}
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/freebusy", qs, nil, &r); err != nil {
		return nil, err
	}
	list := make([]map[string]any, 0, len(r.GetUsers()))
	for _, u := range r.GetUsers() {
		busy := make([]map[string]any, 0, len(u.GetBusy()))
		for _, b := range u.GetBusy() {
			busy = append(busy, compact(map[string]any{"when": span(b.GetStartsAt().AsTime(), b.GetEndsAt().AsTime(), b.GetAllDay(), me.loc),
				"event": b.GetEventId(), "title": b.GetTitle(), "external": b.GetKind() == v1.BusyKind_BUSY_KIND_EXTERNAL}))
		}
		p := map[string]any{"user": u.GetUserId(), "tz": u.GetTimezone(), "busy": busy}
		if h := u.GetWorkHours(); h != nil && len(h.GetDays()) > 0 {
			p["work_hours"] = workHours(h)
		}
		if len(busy) == 0 {
			p["busy"] = []map[string]any{}
		}
		list = append(list, compact(p))
	}
	return map[string]any{"tz": me.zone(), "from": from.In(me.loc).Format("2006-01-02 15:04"), "to": to.In(me.loc).Format("2006-01-02 15:04"), "users": list}, nil
}

// workHours is "09:00–18:00 Mon-Fri" style: minutes of the day and ISO weekdays (1 = Monday) in
// the person's zone.
func workHours(h *v1.WorkHours) string {
	hm := func(m uint32) string { return fmt.Sprintf("%02d:%02d", m/60, m%60) }
	names := []string{"", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	days := make([]string, 0, len(h.GetDays()))
	for _, d := range h.GetDays() {
		if d >= 1 && d <= 7 {
			days = append(days, names[d])
		}
	}
	return hm(h.GetStartMin()) + "–" + hm(h.GetEndMin()) + " " + strings.Join(days, ",")
}

func suggestSlots(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if len(a.Users) == 0 {
		return nil, errors.New("users is required")
	}
	ws, err := oneWorkspace(ctx, c, a.Workspace)
	if err != nil {
		return nil, err
	}
	ids, err := users(ctx, c, ws, a.Users)
	if err != nil {
		return nil, err
	}
	from, to, err := window(a, me.loc, 7*24*time.Hour)
	if err != nil {
		return nil, err
	}
	if now := time.Now(); from.Before(now) { // the server looks from now on
		from = now.Truncate(time.Minute)
	}
	minutes := uint32(clamp(a.Duration, 30, 1440)) //nolint:gosec // 1..1440
	req := &v1.SuggestSlotsRequest{Users: ids, DurationMin: minutes, From: timestamppb.New(from), To: timestamppb.New(to),
		WithinWorkHours: a.WorkHours == nil || *a.WorkHours}
	if a.Room != "" {
		if req.RoomId, err = resolveRoom(ctx, c, ws, a.Room, true); err != nil {
			return nil, err
		}
	}
	var r v1.SuggestSlotsResponse
	if err := c.call(ctx, http.MethodPost, "/api/workspaces/"+seg(ws)+"/freebusy/suggest", nil, req, &r); err != nil {
		return nil, err
	}
	slots := make([]string, 0, len(r.GetSlots()))
	for _, s := range r.GetSlots() {
		slots = append(slots, span(s.GetStartsAt().AsTime(), s.GetEndsAt().AsTime(), false, me.loc))
	}
	out := map[string]any{"tz": me.zone(), "slots": slots}
	if len(slots) == 0 {
		out["slots"] = []string{}
	}
	return out, nil
}

// ---- event ----

func eventTool(ctx context.Context, c *api, a args) (any, error) {
	me, err := caller(ctx, c)
	if err != nil {
		return nil, err
	}
	switch a.Action {
	case "create":
		return createEvent(ctx, c, a, me)
	case "update":
		return updateEvent(ctx, c, a, me)
	case "cancel":
		return cancelEvent(ctx, c, a, me)
	case "comment":
		return commentEvent(ctx, c, a, me)
	}
	return nil, errors.New("action must be create, update, cancel or comment")
}

// attendees resolves people for a meeting: all required (optional ones are set in the app).
func attendees(ctx context.Context, c *api, ws string, refs []string) ([]*v1.CalendarEventAttendeeInput, error) {
	ids, err := users(ctx, c, ws, refs)
	if err != nil {
		return nil, err
	}
	out := make([]*v1.CalendarEventAttendeeInput, 0, len(ids))
	for _, id := range ids {
		out = append(out, &v1.CalendarEventAttendeeInput{UserId: id, Required: true})
	}
	return out, nil
}

// endOf is the end from end or duration (minutes; default 30 min, an all-day meeting one day).
func endOf(a args, start time.Time, allDay bool, loc *time.Location) (time.Time, error) {
	if a.End != nil && strings.TrimSpace(*a.End) != "" {
		end, err := parseWhen(*a.End, loc)
		if err == nil && allDay && len(strings.TrimSpace(*a.End)) == len(time.DateOnly) {
			end = end.AddDate(0, 0, 1) // the last day, inclusive
		}
		return end, err
	}
	if allDay && a.Duration <= 0 {
		return start.AddDate(0, 0, 1), nil
	}
	return start.Add(time.Duration(clamp(a.Duration, 30, 7*24*60)) * time.Minute), nil
}

func createEvent(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if err := errors.Join(need("title", a.Title), need("start", deref(a.Start))); err != nil {
		return nil, err
	}
	ws := strings.TrimSpace(a.Workspace)
	var roomID string
	if a.Room != "" {
		if _, err := uuid.Parse(strings.TrimSpace(a.Room)); err == nil && ws == "" { // the room names the workspace
			var rr v1.GetRoomResponse
			if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(a.Room), nil, nil, &rr); err != nil {
				return nil, err
			}
			ws = rr.GetRoom().GetWorkspaceId()
		}
	}
	ws, err := oneWorkspace(ctx, c, ws)
	if err != nil {
		return nil, err
	}
	if a.Room != "" {
		if roomID, err = resolveRoom(ctx, c, ws, a.Room, true); err != nil {
			return nil, err
		}
	}
	start, err := parseWhen(*a.Start, me.loc)
	if err != nil {
		return nil, err
	}
	end, err := endOf(a, start, a.AllDay, me.loc)
	if err != nil {
		return nil, err
	}
	req := &v1.CreateCalendarEventRequest{RoomId: roomID, Title: a.Title, Description: deref(a.Description), StartsAt: timestamppb.New(start),
		EndsAt: timestamppb.New(end), AllDay: a.AllDay, Tz: me.tz}
	if a.Repeat != "" {
		if req.Repeat, err = repeatOf(a.Repeat); err != nil {
			return nil, err
		}
	}
	if req.Attendees, err = attendees(ctx, c, ws, a.Users); err != nil {
		return nil, err
	}
	var r v1.CalendarEventResponse
	if err := c.call(ctx, http.MethodPost, "/api/workspaces/"+seg(ws)+"/events", nil, req, &r); err != nil {
		return nil, err
	}
	out := eventFull(r.GetEvent(), me)
	out["tz"] = me.zone()
	return out, nil
}

// occurrenceScope reads occurrence and scope (this | following | all) of a change or a
// cancellation; without occurrence the whole series (a one-off meeting) is meant.
func occurrenceScope(a args, loc *time.Location) (*time.Time, string, error) {
	scope := strings.ToLower(strings.TrimSpace(a.Scope))
	if strings.TrimSpace(a.Occurrence) == "" {
		if scope != "" && scope != "all" {
			return nil, "", errors.New("scope " + scope + " needs occurrence (from calendar)")
		}
		return nil, "", nil
	}
	switch scope {
	case "":
		scope = "this"
	case "this", "following":
	case "all":
		return nil, "", nil
	default:
		return nil, "", errors.New("scope must be this, following or all")
	}
	t, err := parseWhen(a.Occurrence, loc)
	if err != nil {
		return nil, "", err
	}
	return &t, scope, nil
}

func updateEvent(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if err := need("event", a.Event); err != nil {
		return nil, err
	}
	var cur v1.CalendarEventResponse
	if err := c.call(ctx, http.MethodGet, "/api/events/"+seg(a.Event), nil, nil, &cur); err != nil {
		return nil, err
	}
	e := cur.GetEvent()
	occ, scope, err := occurrenceScope(a, me.loc)
	if err != nil {
		return nil, err
	}
	req := &v1.UpdateCalendarEventRequest{}
	if a.Title != "" {
		req.Title = &a.Title
	}
	req.Description = a.Description
	if a.AllDay {
		req.AllDay = &a.AllDay
	}
	// The current times: of the occurrence changed, else of the event.
	start, end := e.GetStartsAt().AsTime(), e.GetEndsAt().AsTime()
	if occ != nil {
		start, end = *occ, occ.Add(end.Sub(start))
		req.OccurrenceAt, req.Scope = timestamppb.New(*occ), v1.EventScope_EVENT_SCOPE_THIS
		if scope == "following" {
			req.Scope = v1.EventScope_EVENT_SCOPE_FOLLOWING
		}
	}
	moved := false
	if s := deref(a.Start); strings.TrimSpace(s) != "" {
		ns, err := parseWhen(s, me.loc)
		if err != nil {
			return nil, err
		}
		start, end, moved = ns, ns.Add(end.Sub(start)), true // the length is kept
	}
	if (a.End != nil && strings.TrimSpace(*a.End) != "") || a.Duration > 0 {
		if end, err = endOf(a, start, a.AllDay || e.GetAllDay(), me.loc); err != nil {
			return nil, err
		}
		moved = true
	}
	if moved || occ != nil {
		req.StartsAt, req.EndsAt = timestamppb.New(start), timestamppb.New(end)
	}
	if a.Room != "" {
		room := ""
		if !strings.EqualFold(strings.TrimSpace(a.Room), "none") {
			if room, err = resolveRoom(ctx, c, e.GetWorkspaceId(), a.Room, true); err != nil {
				return nil, err
			}
		}
		req.RoomId = &room
	}
	if a.Repeat != "" {
		rp, err := repeatOf(a.Repeat)
		if err != nil {
			return nil, err
		}
		req.Repeat = &rp
	}
	if len(a.Users) > 0 {
		if req.Attendees, err = changedAttendees(ctx, c, e, a); err != nil {
			return nil, err
		}
		req.SetAttendees = true
	}
	var r v1.CalendarEventResponse
	if err := c.call(ctx, http.MethodPatch, "/api/events/"+seg(a.Event), nil, req, &r); err != nil {
		return nil, err
	}
	out := eventFull(r.GetEvent(), me)
	out["tz"] = me.zone()
	return out, nil
}

// changedAttendees is the meeting's attendee list after mode (add, remove, set) with users;
// external addresses and the optional flag of those who stay are kept.
func changedAttendees(ctx context.Context, c *api, e *v1.CalendarEvent, a args) ([]*v1.CalendarEventAttendeeInput, error) {
	ids, err := users(ctx, c, e.GetWorkspaceId(), a.Users)
	if err != nil {
		return nil, err
	}
	var out []*v1.CalendarEventAttendeeInput
	keep := func(at *v1.CalendarEventAttendee) {
		out = append(out, &v1.CalendarEventAttendeeInput{UserId: at.GetUserId(), Email: at.GetEmail(), Required: at.GetRequired()})
	}
	switch a.Mode {
	case "", "add":
		for _, at := range e.GetAttendees() {
			keep(at)
			ids = slices.DeleteFunc(ids, func(id string) bool { return id == at.GetUserId() })
		}
	case "remove":
		for _, at := range e.GetAttendees() {
			if at.GetUserId() == "" || !slices.Contains(ids, at.GetUserId()) {
				keep(at)
			}
		}
		return out, nil
	case "set":
		for _, at := range e.GetAttendees() {
			if at.GetEmail() != "" && at.GetUserId() == "" {
				keep(at)
			}
		}
	default:
		return nil, errors.New("mode must be add, remove or set")
	}
	for _, id := range ids {
		out = append(out, &v1.CalendarEventAttendeeInput{UserId: id, Required: true})
	}
	return out, nil
}

func cancelEvent(ctx context.Context, c *api, a args, me whoAmI) (any, error) {
	if err := need("event", a.Event); err != nil {
		return nil, err
	}
	occ, scope, err := occurrenceScope(a, me.loc)
	if err != nil {
		return nil, err
	}
	qs := url.Values{}
	if occ != nil {
		qs.Set("occurrence", occ.UTC().Format(time.RFC3339))
		if scope == "following" {
			qs.Set("scope", "following")
		}
	}
	if err := c.call(ctx, http.MethodDelete, "/api/events/"+seg(a.Event), qs, nil, nil); err != nil {
		return nil, err
	}
	out := map[string]any{"id": a.Event, "cancelled": "the whole meeting"}
	if occ != nil {
		out["cancelled"] = scope + " " + occ.In(me.loc).Format("2006-01-02 15:04") + " (" + me.zone() + ")"
	}
	return out, nil
}

func commentEvent(ctx context.Context, c *api, a args, _ whoAmI) (any, error) {
	if err := errors.Join(need("event", a.Event), need("text", a.Text)); err != nil {
		return nil, err
	}
	var r v1.CalendarEventCommentResponse
	if err := c.call(ctx, http.MethodPost, "/api/events/"+seg(a.Event)+"/comments", nil, &v1.CalendarEventCommentRequest{Body: a.Text}, &r); err != nil {
		return nil, onBehalfHint(err, "commenting on a meeting is closed to a bot acting on behalf (ADR-0109); connect through OAuth to comment as yourself")
	}
	return map[string]any{"id": r.GetComment().GetId(), "event": r.GetComment().GetEventId()}, nil
}

// onBehalfHint adds why to a 403 ON_BEHALF_ROUTE refusal.
func onBehalfHint(err error, why string) error {
	var ae *apiError
	if errors.As(err, &ae) && ae.status == http.StatusForbidden && ae.e.GetReason() == "ON_BEHALF_ROUTE" {
		return errors.New(ae.Error() + ": " + why)
	}
	return err
}
