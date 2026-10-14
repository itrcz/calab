package wiki

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// MaxTrashDays bounds wiki_trash_days (the CHECK of migration 00090).
const MaxTrashDays = 3650

// settings: GET /api/workspaces/{id}/wiki/settings (members).
func (s *Service) settings(w http.ResponseWriter, r *http.Request) error {
	ws, _, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	days, err := s.db.Q.GetWikiTrashDays(r.Context(), ws)
	if err != nil {
		return err
	}
	out := &v1.WikiSettings{}
	if days != nil {
		out.TrashDays = uint32(max(*days, 0)) //nolint:gosec // ≤ MaxTrashDays
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setSettings: PUT /api/workspaces/{id}/wiki/settings (WIKI_MANAGE) — the trash retention.
func (s *Service) setSettings(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.WikiSettings
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if req.GetTrashDays() > MaxTrashDays {
		return httpx.Validation("trash_days", "must be 0..3650")
	}
	if !c.wsBits().Has(perm.WikiManage) {
		return httpx.Forbidden("WIKI_MANAGE required")
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	var days *int32
	if req.GetTrashDays() > 0 {
		d := int32(req.GetTrashDays()) //nolint:gosec // ≤ MaxTrashDays
		days = &d
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		return q.SetWikiTrashDays(ctx, sqlc.SetWikiTrashDaysParams{ID: ws, Days: days})
	}); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.WikiSettings{TrashDays: req.GetTrashDays()})
	return nil
}

// activityPage reads ?cursor= (the last entry id) and ?limit= (1..100, default 50).
func activityPage(r *http.Request) (*uuid.UUID, int, error) {
	cur, err := optUUID(r.URL.Query().Get("cursor"), "cursor")
	if err != nil {
		return nil, 0, err
	}
	limit, err := pageLimit(r, 50, 100)
	return cur, limit, err
}

func writeActivity(w http.ResponseWriter, rows []sqlc.WikiActivity, limit int) {
	out := &v1.WikiActivityPage{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextCursor = rows[limit-1].ID.String()
	}
	for _, a := range rows {
		out.Activities = append(out.Activities, activityProto(a))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
}

// pageActivity: GET /api/wiki/pages/{id}/activity?cursor=&limit= — the page's history, the
// newest first (WIKI_VIEW on the page).
func (s *Service) pageActivity(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWikiPageActivity(r.Context(), sqlc.ListWikiPageActivityParams{PageID: a.page.ID, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	if err := hidePlaces(r.Context(), s.db.Q, a.c, rows); err != nil {
		return err
	}
	writeActivity(w, rows, limit)
	return nil
}

// workspaceActivity: GET /api/workspaces/{id}/wiki/activity?actor=&cursor=&limit= — the history
// of the whole Wiki (WIKI_MANAGE).
func (s *Service) workspaceActivity(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	if !c.wsBits().Has(perm.WikiManage) {
		return httpx.Forbidden("WIKI_MANAGE required")
	}
	actor, err := optUUID(r.URL.Query().Get("actor"), "actor")
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWorkspaceWikiActivity(r.Context(), sqlc.ListWorkspaceWikiActivityParams{WorkspaceID: ws, ActorID: actor, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	writeActivity(w, rows, limit)
	return nil
}

// hidePlaces blanks the parent titles (parent_title) of a page's journal entries for pages the
// caller does not see (no titles without WIKI_VIEW), like the Disk's hidePlaces.
func hidePlaces(ctx context.Context, q *sqlc.Queries, c caller, rows []sqlc.WikiActivity) error {
	parentOf := func(raw []byte) (map[string]any, *uuid.UUID) {
		if len(raw) == 0 {
			return nil, nil
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			return nil, nil
		}
		if n, _ := m["parent_title"].(string); n == "" {
			return nil, nil
		}
		pid, _ := m["parent_id"].(string)
		id, err := uuid.Parse(pid)
		if err != nil {
			return m, nil
		}
		return m, &id
	}
	var ids []uuid.UUID
	for _, a := range rows {
		for _, side := range [][]byte{a.Before, a.After} {
			if _, id := parentOf(side); id != nil {
				ids = append(ids, *id)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ch, err := wikiacl.Load(ctx, q, ids)
	if err != nil {
		return err
	}
	hide := func(raw []byte) ([]byte, error) {
		m, id := parentOf(raw)
		if m == nil || (id != nil && ch.Has(*id) && ch.Bits(c.m, id).Has(perm.WikiView)) {
			return raw, nil
		}
		m["parent_title"] = ""
		return json.Marshal(m)
	}
	for i := range rows {
		if rows[i].Before, err = hide(rows[i].Before); err != nil {
			return err
		}
		if rows[i].After, err = hide(rows[i].After); err != nil {
			return err
		}
	}
	return nil
}

// versions: GET /api/wiki/pages/{id}/versions?cursor=&limit= (WIKI_VIEW), the newest first;
// limit 1..50, default 20.
func (s *Service) versions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	cur, err := optUUID(r.URL.Query().Get("cursor"), "cursor")
	if err != nil {
		return err
	}
	limit, err := pageLimit(r, 20, 50)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWikiVersions(r.Context(), sqlc.ListWikiVersionsParams{PageID: a.page.ID, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 51
	if err != nil {
		return err
	}
	out := &v1.WikiVersionsResponse{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextCursor = rows[limit-1].ID.String()
	}
	for _, v := range rows {
		out.Versions = append(out.Versions, versionProto(v))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// version: GET /api/wiki/pages/{id}/versions/{vid} — the Yjs state of a version
// (application/octet-stream; WIKI_VIEW). The client applies its content as a new transaction to
// restore it (ADR-0096 §5).
func (s *Service) version(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	vid, err := httpx.PathUUID(r, "vid", "version")
	if err != nil {
		return err
	}
	v, err := s.db.Q.GetWikiVersion(r.Context(), sqlc.GetWikiVersionParams{ID: vid, PageID: a.page.ID})
	if db.IsNotFound(err) {
		return httpx.NotFound("version")
	}
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(v.State)
	return nil
}

// upload: POST /api/wiki/pages/{id}/files — multipart "file": a picture or an attachment of
// the page (WIKI_WRITE on it, a live page) through files.UploadWith — the files row, the
// workspace quota and the wiki_page_files reference in one transaction (the mime type is
// sniffed by files). Answers UploadFileResponse; the document refers to the file by id.
func (s *Service) upload(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if !a.bits.Has(perm.WikiWrite) {
		return httpx.Forbidden("WIKI_WRITE required")
	}
	if a.page.TrashedAt != nil {
		return errTrashed
	}
	ws := a.page.WorkspaceID
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	f, err := s.files.UploadWith(w, r, ws, func(q *sqlc.Queries, f sqlc.File) error {
		cur, err := q.GetWikiPageForUpdate(ctx, a.page.ID)
		if db.IsNotFound(err) {
			return errNoPage
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt != nil {
			return errTrashed
		}
		return q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: cur.ID, FileID: f.ID})
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.UploadFileResponse{File: pbconv.File(f)})
	return nil
}
