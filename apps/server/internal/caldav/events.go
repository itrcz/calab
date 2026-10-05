package caldav

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// The owner's view of the imported events and what colleagues see of them (ADR-0045).

// Share levels as stored in caldav_accounts.share_level.
const (
	ShareBusy    = "busy"
	ShareTitle   = "title"
	ShareDetails = "details"
)

func shareLevelProto(s string) v1.CalDavShareLevel {
	switch s {
	case ShareTitle:
		return v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE
	case ShareDetails:
		return v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS
	}
	return v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_BUSY
}

// setShare: PATCH /api/me/caldav {share_level} — only the account's own user (the route is /me).
func (s *Service) setShare(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	var req v1.SetCalDavShareRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var level string
	switch req.GetShareLevel() {
	case v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_BUSY:
		level = ShareBusy
	case v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_TITLE:
		level = ShareTitle
	case v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS:
		level = ShareDetails
	default:
		return httpx.Validation("shareLevel", "one of busy, title, details")
	}
	acc, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.CaldavAccount, error) {
		return guarded.SetCalDavShareLevel(ctx, sqlc.SetCalDavShareLevelParams{UserID: me, ShareLevel: level})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("CalDAV account")
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CalDavAccountResponse{Account: accountProto(acc)})
	return nil
}

// externalEvents: GET /api/me/external-events?from&to[&workspace] — the caller's own imported
// events with their details; with workspace, attendees who are members of it get their id.
func (s *Service) externalEvents(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me, err := s.paidPerson(r)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	from, err1 := time.Parse(time.RFC3339, qs.Get("from"))
	to, err2 := time.Parse(time.RFC3339, qs.Get("to"))
	if err1 != nil || err2 != nil {
		return httpx.Validation("from", "from and to are RFC 3339 times")
	}
	if !to.After(from) || to.Sub(from) > calendar.MaxBusyWindow {
		return httpx.Validation("to", "to must be after from, at most 14 days later")
	}
	var ws uuid.UUID
	if raw := qs.Get("workspace"); raw != "" {
		if ws, err = uuid.Parse(raw); err != nil {
			return httpx.Validation("workspace", "a workspace id")
		}
		m, err := s.db.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: me})
		if db.IsNotFound(err) || (err == nil && m.Role == "guest") {
			return httpx.Forbidden("not a member of this workspace")
		}
		if err != nil {
			return err
		}
	}
	rows, err := s.db.Q.ListMyExternalEvents(ctx, sqlc.ListMyExternalEventsParams{UserID: me, From: from, To: to})
	if err != nil {
		return err
	}
	lists := make([][]Attendee, len(rows))
	var emails []string
	seen := map[string]bool{}
	for i, row := range rows {
		_ = json.Unmarshal(row.Attendees, &lists[i]) // written by the import only
		for _, a := range lists[i] {
			if !seen[a.Email] {
				seen[a.Email] = true
				emails = append(emails, a.Email)
			}
		}
	}
	ids := map[string]string{}
	if ws != uuid.Nil && len(emails) > 0 {
		matched, err := s.db.Q.MatchMemberEmails(ctx, sqlc.MatchMemberEmailsParams{WorkspaceID: ws, Emails: emails})
		if err != nil {
			return err
		}
		for _, m := range matched {
			ids[m.Email] = m.ID.String()
		}
	}
	var mine map[string]bool // my addresses (my answer, ADR-0045 amendment 2)
	if len(rows) > 0 {
		login := ""
		if acc, err := s.db.Q.GetCalDavAccount(ctx, me); err == nil {
			login = acc.Username
		}
		mine = s.myAddresses(ctx, me, login)
	}
	out := &v1.ExternalEventsResponse{Events: make([]*v1.ExternalEvent, 0, len(rows))}
	for i, row := range rows {
		ev := &v1.ExternalEvent{Uid: row.Uid, StartsAt: timestamppb.New(row.StartsAt), EndsAt: timestamppb.New(row.EndsAt), AllDay: row.AllDay,
			Summary: row.Summary, Location: row.Location, Organizer: row.Organizer, Url: row.Url, Href: row.Href, Recurring: row.Recurring, WebUrl: row.WebUrl,
			Attendees: make([]*v1.ExternalAttendee, 0, len(lists[i])), MyStatus: myStatus(row.Organizer, lists[i], mine)}
		for _, a := range lists[i] {
			ev.Attendees = append(ev.Attendees, &v1.ExternalAttendee{Email: a.Email, Name: a.Name, UserId: ids[a.Email], Status: statusOfPartstat(a.Status)})
		}
		out.Events = append(out.Events, ev)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
