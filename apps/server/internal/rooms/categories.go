package rooms

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// CategoryRoutes registers category and ordering routes.
func (h *Handlers) CategoryRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/categories", wrap(httpx.HandlerFunc(h.listCategories)))
	mux.Handle("POST /api/workspaces/{id}/categories", wrap(httpx.HandlerFunc(h.createCategory)))
	mux.Handle("PATCH /api/categories/{id}", wrap(httpx.HandlerFunc(h.updateCategory)))
	mux.Handle("DELETE /api/categories/{id}", wrap(httpx.HandlerFunc(h.deleteCategory)))
	mux.Handle("PUT /api/workspaces/{id}/rooms/order", wrap(httpx.HandlerFunc(h.setOrder)))
}

// parseCategory validates an optional category id of the workspace ("" = none).
func parseCategory(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, s string) (*uuid.UUID, error) {
	if s == "" {
		return nil, nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil, httpx.Validation("categoryId", "invalid category id")
	}
	c, err := q.GetCategory(ctx, id)
	if db.IsNotFound(err) || (err == nil && c.WorkspaceID != wsID) {
		return nil, httpx.Validation("categoryId", "category not found in this workspace")
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

// manageWorkspaceRooms requires MANAGE_ROOM at workspace level (admin/owner).
func manageWorkspaceRooms(r *http.Request, wsID uuid.UUID) error {
	bits, _, err := workspaceAccess(r, wsID)
	if err != nil {
		return err
	}
	if !bits.Has(perm.ManageRoom) {
		return httpx.Forbidden("MANAGE_ROOM required")
	}
	return nil
}

func (h *Handlers) listCategories(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, _, err := workspaceAccess(r, wsID); err != nil {
		return err
	}
	cs, err := h.db.Q.ListCategories(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListCategoriesResponse{Categories: pbconv.Categories(cs)})
	return nil
}

func (h *Handlers) createCategory(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if err := manageWorkspaceRooms(r, wsID); err != nil {
		return err
	}
	var req v1.CreateCategoryRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validName(req.GetName())
	if err != nil {
		return err
	}
	c, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.RoomCategory, error) {
		return guarded.CreateCategory(r.Context(), sqlc.CreateCategoryParams{WorkspaceID: wsID, Name: name, Position: req.Position})
	})
	if err != nil {
		return err
	}
	pb := pbconv.Category(c)
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_CategoryCreate{CategoryCreate: &v1.CategoryCreate{Category: pb}}})
	httpx.Write(w, http.StatusCreated, &v1.CreateCategoryResponse{Category: pb})
	return nil
}

func (h *Handlers) loadCategory(r *http.Request) (sqlc.RoomCategory, error) {
	id, err := httpx.PathUUID(r, "id", "category")
	if err != nil {
		return sqlc.RoomCategory{}, err
	}
	c, err := h.db.Q.GetCategory(r.Context(), id)
	if db.IsNotFound(err) {
		return c, httpx.NotFound("category")
	}
	if err != nil {
		return c, err
	}
	if err := manageWorkspaceRooms(r, c.WorkspaceID); err != nil {
		if e := httpx.AsError(err); e.Status == http.StatusNotFound {
			return c, httpx.NotFound("category")
		}
		return c, err
	}
	return c, nil
}

func (h *Handlers) updateCategory(w http.ResponseWriter, r *http.Request) error {
	c, err := h.loadCategory(r)
	if err != nil {
		return err
	}
	var req v1.UpdateCategoryRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateCategoryParams{ID: c.ID, Position: req.Position}
	if req.Name != nil {
		n, err := validName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &n
	}
	c, err = db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.RoomCategory, error) { return guarded.UpdateCategory(r.Context(), p) })
	if err != nil {
		return err
	}
	pb := pbconv.Category(c)
	h.events.Workspace(r.Context(), c.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_CategoryUpdate{CategoryUpdate: &v1.CategoryUpdate{Category: pb}}})
	httpx.Write(w, http.StatusOK, &v1.UpdateCategoryResponse{Category: pb})
	return nil
}

func (h *Handlers) deleteCategory(w http.ResponseWriter, r *http.Request) error {
	c, err := h.loadCategory(r)
	if err != nil {
		return err
	}
	moved, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) ([]uuid.UUID, error) { return guarded.DeleteCategory(r.Context(), c.ID) })
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), c.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_CategoryDelete{
		CategoryDelete: &v1.CategoryDelete{WorkspaceId: c.WorkspaceID.String(), CategoryId: c.ID.String()},
	}})
	var evs []*v1.DispatchEvent
	for _, rid := range moved {
		room, err := h.db.Q.GetRoom(r.Context(), rid)
		if err != nil {
			continue
		}
		if pb, err := h.load(r.Context(), h.db.Q, room); err == nil {
			evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}})
		}
	}
	h.events.WorkspaceEvents(r.Context(), c.WorkspaceID, evs)
	httpx.NoContent(w)
	return nil
}

// setOrder applies a drag & drop result atomically and announces every changed item.
func (h *Handlers) setOrder(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if err := manageWorkspaceRooms(r, wsID); err != nil {
		return err
	}
	var req v1.SetRoomOrderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if len(req.GetRooms()) > 500 || len(req.GetCategories()) > 200 {
		return httpx.Validation("rooms", "too many items")
	}
	resp := &v1.SetRoomOrderResponse{}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		resp.Rooms, resp.Categories = nil, nil
		var updated []sqlc.Room
		for _, c := range req.GetCategories() {
			id, err := uuid.Parse(c.GetCategoryId())
			if err != nil {
				return httpx.Validation("categories", "invalid category id")
			}
			row, err := q.SetCategoryPosition(r.Context(), sqlc.SetCategoryPositionParams{ID: id, WorkspaceID: wsID, Position: c.GetPosition()})
			if db.IsNotFound(err) {
				return httpx.Validation("categories", "category "+id.String()+" not found in this workspace")
			}
			if err != nil {
				return err
			}
			resp.Categories = append(resp.Categories, pbconv.Category(row))
		}
		for _, rp := range req.GetRooms() {
			id, err := uuid.Parse(rp.GetRoomId())
			if err != nil {
				return httpx.Validation("rooms", "invalid room id")
			}
			cat, err := parseCategory(r.Context(), q, wsID, rp.GetCategoryId())
			if err != nil {
				return err
			}
			row, err := q.SetRoomPlacement(r.Context(), sqlc.SetRoomPlacementParams{ID: id, WorkspaceID: wsID, Position: rp.GetPosition(), CategoryID: cat})
			if db.IsNotFound(err) {
				return httpx.Validation("rooms", "room "+id.String()+" not found in this workspace")
			}
			if err != nil {
				return err
			}
			updated = append(updated, row)
		}
		if len(updated) == 0 {
			return nil
		}
		// One lookup for defaults and overrides instead of two queries per room.
		ws, err := q.GetWorkspace(r.Context(), wsID)
		if err != nil {
			return err
		}
		ovs, err := q.ListWorkspaceRoomOverrides(r.Context(), wsID)
		if err != nil {
			return err
		}
		byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
		for _, o := range ovs {
			byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
		}
		defaults := pbconv.WorkspaceDefaults(ws)
		me, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID)
		if err != nil {
			return err
		}
		for _, row := range updated {
			// A room the caller cannot see (a restricted room, ADR-0029) is not theirs to
			// place, and the answer must not reveal it.
			if !perm.ComputeIn(me, perm.FlagsOf(row), pbconv.OverrideTargets(byRoom[row.ID])).Has(perm.ViewRoom) {
				return httpx.Validation("rooms", "room "+row.ID.String()+" not found in this workspace")
			}
			resp.Rooms = append(resp.Rooms, pbconv.Room(row, defaults, byRoom[row.ID]))
		}
		return nil
	})
	if err != nil {
		return err
	}
	evs := make([]*v1.DispatchEvent, 0, len(resp.GetCategories())+len(resp.GetRooms()))
	for _, c := range resp.GetCategories() {
		evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_CategoryUpdate{CategoryUpdate: &v1.CategoryUpdate{Category: c}}})
	}
	for _, room := range resp.GetRooms() {
		evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: room}}})
	}
	h.events.WorkspaceEvents(r.Context(), wsID, evs) // one pipeline, not one PUBLISH per room
	httpx.Write(w, http.StatusOK, resp)
	return nil
}
