package disk

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// MaxTrashDays bounds disk_trash_days (the CHECK of migration 00088).
const MaxTrashDays = 3650

// wsBits are the caller's workspace-level disk bits (perm.DiskOf).
func (c caller) wsBits() perm.Bits {
	return perm.DiskOf(c.m.Raw(), c.m.Role == perm.RoleGuest)
}

// usage: GET /api/workspaces/{id}/disk/usage (DISK_VIEW on the workspace) — DiskUsage.
func (s *Service) usage(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	if !c.wsBits().Has(perm.DiskView) {
		return httpx.Forbidden("DISK_VIEW required")
	}
	ctx := r.Context()
	row, err := s.db.Q.GetDiskUsage(ctx, ws)
	if err != nil {
		return err
	}
	out := &v1.DiskUsage{
		UsedBytes: uint64(max(row.StorageUsedBytes, 0)), DiskBytes: uint64(max(row.DiskBytes, 0)),
		TrashBytes: uint64(max(row.TrashBytes, 0)), OtherBytes: uint64(max(row.StorageUsedBytes-row.DiskBytes, 0)),
		AddonBytes: uint64(max(row.AddonMb, 0)) << 20,
	}
	quota := row.StorageQuotaBytes
	if s.plans != nil {
		l, err := s.plans.Effective(ctx, ws)
		if err != nil {
			return err
		}
		out.PlanBytes = l.StorageMB << 20
		b, ok, err := s.plans.EffectiveStorageBytes(ctx, s.db.Q, ws)
		if err != nil {
			return err
		}
		if ok {
			quota = min(quota, b)
		}
	}
	out.QuotaBytes = uint64(max(quota, 0))
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// settings: GET /api/workspaces/{id}/disk/settings (members).
func (s *Service) settings(w http.ResponseWriter, r *http.Request) error {
	ws, _, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	row, err := s.db.Q.GetWorkspace(r.Context(), ws)
	if err != nil {
		return err
	}
	out := &v1.DiskSettings{}
	if row.DiskTrashDays != nil {
		out.TrashDays = uint32(max(*row.DiskTrashDays, 0))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setSettings: PUT /api/workspaces/{id}/disk/settings (DISK_MANAGE) — the trash retention.
func (s *Service) setSettings(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.DiskSettings
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if req.GetTrashDays() > MaxTrashDays {
		return httpx.Validation("trash_days", "must be 0..3650")
	}
	if !c.wsBits().Has(perm.DiskManage) {
		return httpx.Forbidden("DISK_MANAGE required")
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
		return q.SetDiskTrashDays(ctx, sqlc.SetDiskTrashDaysParams{ID: ws, Days: days})
	}); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.DiskSettings{TrashDays: req.GetTrashDays()})
	return nil
}

// activityPage reads ?cursor= (the last entry id) and ?limit= (1..100, default 50).
func activityPage(r *http.Request) (*uuid.UUID, int, error) {
	cur, err := optUUID(r.URL.Query().Get("cursor"), "cursor")
	if err != nil {
		return nil, 0, err
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := pageLimit(r)
		if err != nil || n > 100 {
			return nil, 0, httpx.Validation("limit", "must be 1..100")
		}
		limit = n
	}
	return cur, limit, nil
}

func writeActivity(w http.ResponseWriter, rows []sqlc.DiskActivity, limit int) {
	out := &v1.DiskActivityPage{}
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

// itemActivity: GET /api/disk/items/{id}/activity?cursor=&limit= — the item's history, the
// newest first (DISK_VIEW on the item).
func (s *Service) itemActivity(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListDiskItemActivity(r.Context(), sqlc.ListDiskItemActivityParams{ItemID: a.item.ID, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	if err := hidePlaces(r.Context(), s.db.Q, a.c, rows); err != nil {
		return err
	}
	writeActivity(w, rows, limit)
	return nil
}

// workspaceActivity: GET /api/workspaces/{id}/disk/activity?actor=&cursor=&limit= — the history
// of the whole Disk (DISK_MANAGE).
func (s *Service) workspaceActivity(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	if !c.wsBits().Has(perm.DiskManage) {
		return httpx.Forbidden("DISK_MANAGE required")
	}
	actor, err := optUUID(r.URL.Query().Get("actor"), "actor")
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWorkspaceDiskActivity(r.Context(), sqlc.ListWorkspaceDiskActivityParams{WorkspaceID: ws, ActorID: actor, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	writeActivity(w, rows, limit)
	return nil
}

// hidePlaces blanks the folder names (parent_name) of an item's journal entries for folders the
// caller does not see (ADR-0094 §2: no names without DISK_VIEW): an item moved out of a
// restricted folder, or created in one, must not reveal that folder's name to whoever sees the
// item now. A folder that no longer exists is hidden too (its access cannot be checked).
func hidePlaces(ctx context.Context, q *sqlc.Queries, c caller, rows []sqlc.DiskActivity) error {
	parentOf := func(raw []byte) (map[string]any, *uuid.UUID) {
		if len(raw) == 0 {
			return nil, nil
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			return nil, nil
		}
		if n, _ := m["parent_name"].(string); n == "" {
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
	ch, err := diskacl.Load(ctx, q, ids)
	if err != nil {
		return err
	}
	hide := func(raw []byte) ([]byte, error) {
		m, id := parentOf(raw)
		if m == nil || (id != nil && ch.Has(*id) && ch.Bits(c.m, id).Has(perm.DiskView)) {
			return raw, nil
		}
		m["parent_name"] = ""
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
