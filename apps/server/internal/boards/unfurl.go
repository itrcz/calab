package boards

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Unfurl returns the unfurl hook for own links (ADR-0042 §5): https://<app host>/t/<KEY-N> and
// /b/<board id> become a task / board card by the caller's rights, without HTTP. origins are
// the web client's origins (PUBLIC_APP_URL…).
func (s *Service) Unfurl(origins []string) func(r *http.Request, u *url.URL) (*v1.UnfurlResponse, bool, error) {
	hosts := map[string]bool{}
	for _, o := range origins {
		if p, err := url.Parse(o); err == nil && p.Host != "" {
			hosts[strings.ToLower(p.Host)] = true
		}
	}
	return func(r *http.Request, u *url.URL) (*v1.UnfurlResponse, bool, error) {
		if !hosts[strings.ToLower(u.Host)] {
			return nil, false, nil
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) != 2 {
			return nil, false, nil
		}
		switch parts[0] {
		case "t":
			resp, err := s.unfurlTask(r, parts[1])
			if resp != nil {
				resp.Url = u.String()
			}
			return resp, true, err
		case "b":
			resp, err := s.unfurlBoard(r, parts[1])
			if resp != nil {
				resp.Url = u.String()
			}
			return resp, true, err
		}
		return nil, false, nil
	}
}

func (s *Service) unfurlTask(r *http.Request, raw string) (*v1.UnfurlResponse, error) {
	key, n, ok := ParseKey(raw)
	if !ok {
		return nil, httpx.NotFound("task")
	}
	wss, err := s.db.Q.ListUserWorkspaceIDs(r.Context(), uid(r))
	if err != nil {
		return nil, err
	}
	for _, ws := range wss {
		t, err := s.db.Q.GetTaskByNumber(r.Context(), sqlc.GetTaskByNumberParams{WorkspaceID: ws, Key: key, Number: n})
		if err != nil {
			continue
		}
		row, ok, err := taskByID(r.Context(), s.db.Pool, t.ID, false)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if _, err := taskOf(r, s.db.Q, row); err != nil { // ADR-0059: the task itself must be visible
			continue
		}
		acc, err := board(r, t.BoardID, false)
		if err != nil {
			continue
		}
		out, err := s.taskResponse(r, t.ID, false)
		if err != nil {
			return nil, err
		}
		b, err := s.boardFor(r.Context(), s.db.Q, t.BoardID, uuid.Nil, acc)
		if err != nil {
			return nil, err
		}
		b.Views = nil
		status := ""
		for _, st := range b.GetStatuses() {
			if st.GetId() == out.GetTask().GetStatusId() {
				status = st.GetName()
			}
		}
		return &v1.UnfurlResponse{Title: out.GetTask().GetKey() + " · " + out.GetTask().GetTitle(), Description: status,
			SiteName: b.GetName(), Task: out.GetTask(), Board: b}, nil
	}
	return nil, httpx.NotFound("task")
}

func (s *Service) unfurlBoard(r *http.Request, raw string) (*v1.UnfurlResponse, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, httpx.NotFound("board")
	}
	acc, err := board(r, id, false)
	if err != nil {
		return nil, err
	}
	b, err := s.boardFor(r.Context(), s.db.Q, id, uuid.Nil, acc)
	if err != nil {
		return nil, err
	}
	b.Views = nil
	return &v1.UnfurlResponse{Title: b.GetName(), Description: b.GetDescription(), SiteName: b.GetKey(), Board: b}, nil
}
