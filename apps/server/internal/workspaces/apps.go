package workspaces

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/iconfile"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Web apps of a workspace (ADR-0050): sites pinned to the rail under the workspace icon. Every
// member except guests sees them; MANAGE_INTEGRATIONS (ADR-0048) manages them; bots have no
// access (the routes are botDeny). The server validates the address and never fetches it.
const (
	MaxApps        = 20
	maxAppNameLen  = 40
	appPositionEps = 1e-9 // below this gap between neighbours the apps are renumbered 1..n
)

func (h *Handlers) appRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/apps", h.listApps)
	handle("POST /api/workspaces/{id}/apps", h.createApp)
	handle("PATCH /api/workspace-apps/{appId}", h.updateApp)
	handle("DELETE /api/workspace-apps/{appId}", h.deleteApp)
	handle("PUT /api/workspace-apps/{appId}/position", h.setAppPosition)
}

// SeesApps reports whether a role sees web apps: guests do not web apps (ADR-0050 §1); bots are filtered by their callers.
func SeesApps(role perm.Role) bool { return role != perm.RoleGuest }

func appUpsert(a sqlc.WorkspaceApp) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceAppUpsert{WorkspaceAppUpsert: &v1.WorkspaceAppUpsert{App: pbconv.WorkspaceApp(a)}}}
}

func appName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > maxAppNameLen || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name", "name must be 1.."+strconv.Itoa(maxAppNameLen)+" characters without control characters")
	}
	return s, nil
}

func appURL(s string) (string, error) {
	u, err := ValidateAppURL(s)
	if err != nil {
		return "", httpx.Validation("url", err.Error())
	}
	return u, nil
}

// loadApp resolves /api/workspace-apps/{appId} for the caller: the app and the caller's bits in
// its workspace. Outsiders and guests get 404 (they do not see apps); manage requires
// MANAGE_INTEGRATIONS (403 otherwise).
func loadApp(r *http.Request, q *sqlc.Queries, manage bool) (sqlc.WorkspaceApp, error) {
	id, err := httpx.PathUUID(r, "appId", "app")
	if err != nil {
		return sqlc.WorkspaceApp{}, err
	}
	a, err := q.GetWorkspaceApp(r.Context(), id)
	if db.IsNotFound(err) {
		return a, httpx.NotFound("app")
	}
	if err != nil {
		return a, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), a.WorkspaceID, uid(r))
	if errors.Is(err, perm.ErrNotMember) || (err == nil && !SeesApps(role)) {
		return a, httpx.NotFound("app")
	}
	if err != nil {
		return a, err
	}
	if manage && !bits.Has(perm.ManageIntegrations) {
		return a, httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	return a, nil
}

// requireIntegrations: MANAGE_INTEGRATIONS in the workspace of the path (ADR-0048); guests never.
func requireIntegrations(r *http.Request) (uuid.UUID, error) {
	wsID, _, err := requireBit(r, perm.ManageIntegrations, "MANAGE_INTEGRATIONS")
	return wsID, err
}

// listApps: GET /api/workspaces/{id}/apps (members except guests).
func (h *Handlers) listApps(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	if !SeesApps(role) {
		return httpx.Forbidden("web apps are not available to guests")
	}
	rows, err := h.db.Q.ListWorkspaceApps(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListWorkspaceAppsResponse{Apps: pbconv.WorkspaceApps(rows)})
	return nil
}

// createApp: POST /api/workspaces/{id}/apps (MANAGE_INTEGRATIONS); the app goes last.
func (h *Handlers) createApp(w http.ResponseWriter, r *http.Request) error {
	wsID, err := requireIntegrations(r)
	if err != nil {
		return err
	}
	var req v1.CreateWorkspaceAppRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := appName(req.GetName())
	if err != nil {
		return err
	}
	u, err := appURL(req.GetUrl())
	if err != nil {
		return err
	}
	me := uid(r)
	var created sqlc.WorkspaceApp
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceApps(r.Context(), wsID); err != nil {
			return err
		}
		n, err := q.CountWorkspaceApps(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxApps {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxApps) + " apps")
		}
		icon, err := iconfile.Own(r.Context(), q, wsID, me, nil, req.GetIconFileId())
		if err != nil {
			return err
		}
		created, err = q.InsertWorkspaceApp(r.Context(), sqlc.InsertWorkspaceAppParams{
			WorkspaceID: wsID, Name: name, Url: u, IconFileID: icon, CreatedBy: &me,
		})
		return err
	})
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, appUpsert(created))
	httpx.Write(w, http.StatusCreated, &v1.CreateWorkspaceAppResponse{App: pbconv.WorkspaceApp(created)})
	return nil
}

// updateApp: PATCH /api/workspace-apps/{appId} (MANAGE_INTEGRATIONS).
func (h *Handlers) updateApp(w http.ResponseWriter, r *http.Request) error {
	var req v1.UpdateWorkspaceAppRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := loadApp(r, h.db.Q, true)
	if err != nil {
		return err
	}
	p := sqlc.UpdateWorkspaceAppParams{ID: cur.ID}
	if req.Name != nil {
		n, err := appName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Url != nil {
		u, err := appURL(req.GetUrl())
		if err != nil {
			return err
		}
		p.Url = &u
	}
	if req.IconFileId != nil {
		icon, err := iconfile.Own(r.Context(), h.db.Q, cur.WorkspaceID, uid(r), cur.IconFileID, req.GetIconFileId())
		if err != nil {
			return err
		}
		p.SetIcon, p.IconFileID = true, icon
	}
	updated, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceApp, error) {
		return guarded.UpdateWorkspaceApp(r.Context(), p)
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("app")
	}
	if db.IsForeignKeyViolation(err) { // the icon was deleted meanwhile
		return httpx.Validation("iconFileId", "file not found")
	}
	if err != nil {
		return err
	}
	// A replaced icon is now unreferenced and is removed by the orphan cleanup.
	h.events.Workspace(r.Context(), updated.WorkspaceID, appUpsert(updated))
	httpx.Write(w, http.StatusOK, &v1.UpdateWorkspaceAppResponse{App: pbconv.WorkspaceApp(updated)})
	return nil
}

// deleteApp: DELETE /api/workspace-apps/{appId} (MANAGE_INTEGRATIONS) → WORKSPACE_APP_DELETE.
func (h *Handlers) deleteApp(w http.ResponseWriter, r *http.Request) error {
	cur, err := loadApp(r, h.db.Q, true)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) { return guarded.DeleteWorkspaceApp(r.Context(), cur.ID) })
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("app")
	}
	h.events.Workspace(r.Context(), cur.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceAppDelete{
		WorkspaceAppDelete: &v1.WorkspaceAppDelete{WorkspaceId: cur.WorkspaceID.String(), AppId: cur.ID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

// setAppPosition: PUT /api/workspace-apps/{appId}/position (MANAGE_INTEGRATIONS): between two
// neighbours of the same workspace. When the gap is exhausted, all apps are renumbered 1..n.
func (h *Handlers) setAppPosition(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetWorkspaceAppPositionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := loadApp(r, h.db.Q, true)
	if err != nil {
		return err
	}
	wsID := cur.WorkspaceID
	var all []sqlc.WorkspaceApp
	var changed []sqlc.WorkspaceApp
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceApps(r.Context(), wsID); err != nil {
			return err
		}
		rows, err := q.ListWorkspaceApps(r.Context(), wsID)
		if err != nil {
			return err
		}
		// The list without the moved app; the neighbours must be other apps of this workspace.
		others := make([]sqlc.WorkspaceApp, 0, len(rows))
		found := false
		for _, a := range rows {
			if a.ID == cur.ID {
				found = true
				continue
			}
			others = append(others, a)
		}
		if !found {
			return httpx.NotFound("app")
		}
		idx, err := appInsertIndex(others, req.GetAfterAppId(), req.GetBeforeAppId())
		if err != nil {
			return err
		}
		pos, ok := positionAt(others, idx)
		if ok {
			moved, err := q.SetWorkspaceAppPosition(r.Context(), sqlc.SetWorkspaceAppPositionParams{ID: cur.ID, Position: pos})
			if err != nil {
				return err
			}
			changed = append(changed, moved)
		} else {
			// Renumber: the new order gets positions 1..n.
			order := make([]sqlc.WorkspaceApp, 0, len(rows))
			order = append(order, others[:idx]...)
			order = append(order, cur)
			order = append(order, others[idx:]...)
			for i, a := range order {
				p := float64(i + 1)
				if a.ID != cur.ID && a.Position == p {
					continue
				}
				moved, err := q.SetWorkspaceAppPosition(r.Context(), sqlc.SetWorkspaceAppPositionParams{ID: a.ID, Position: p})
				if err != nil {
					return err
				}
				changed = append(changed, moved)
			}
		}
		all, err = q.ListWorkspaceApps(r.Context(), wsID)
		return err
	})
	if err != nil {
		return err
	}
	evs := make([]*v1.DispatchEvent, len(changed))
	for i, a := range changed {
		evs[i] = appUpsert(a)
	}
	h.events.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.Write(w, http.StatusOK, &v1.SetWorkspaceAppPositionResponse{Apps: pbconv.WorkspaceApps(all)})
	return nil
}

// appInsertIndex: where the moved app goes among the others (by position) given its neighbours:
// after after_app_id and/or before before_app_id; neither = last. Unknown ids or neighbours that
// are not adjacent are 422.
func appInsertIndex(others []sqlc.WorkspaceApp, after, before string) (int, error) {
	find := func(field, raw string) (int, error) {
		id, err := uuid.Parse(raw)
		if err != nil {
			return -1, httpx.Validation(field, "unknown app")
		}
		for i, a := range others {
			if a.ID == id {
				return i, nil
			}
		}
		return -1, httpx.Validation(field, "unknown app")
	}
	switch {
	case after == "" && before == "":
		return len(others), nil
	case after != "" && before != "":
		ai, err := find("afterAppId", after)
		if err != nil {
			return 0, err
		}
		bi, err := find("beforeAppId", before)
		if err != nil {
			return 0, err
		}
		if bi != ai+1 {
			return 0, httpx.Validation("beforeAppId", "the neighbours must be adjacent")
		}
		return bi, nil
	case after != "":
		ai, err := find("afterAppId", after)
		return ai + 1, err
	default:
		return find("beforeAppId", before)
	}
}

// positionAt: a position between others[idx-1] and others[idx]; false when the gap is too small
// (the caller renumbers).
func positionAt(others []sqlc.WorkspaceApp, idx int) (float64, bool) {
	switch {
	case len(others) == 0:
		return 1, true
	case idx == 0:
		return others[0].Position - 1, true
	case idx == len(others):
		return others[idx-1].Position + 1, true
	}
	lo, hi := others[idx-1].Position, others[idx].Position
	if hi-lo < appPositionEps {
		return 0, false
	}
	return lo + (hi-lo)/2, true
}
