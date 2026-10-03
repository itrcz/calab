package boards

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
)

// Board categories (ADR-0058 §1): a mirror of room categories for the boards list. A category is
// only a name, seen by every member but guests; creating, renaming, deleting and ordering them
// needs CREATE_BOARDS; putting a board into one needs MANAGE_BOARD on the board. Every write
// takes LockBoards (the count limit and positions of one workspace).

// boardCategory validates an optional category id of the workspace ("" = none).
func boardCategory(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, raw, field string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, httpx.Validation(field, "invalid category id")
	}
	c, err := q.GetBoardCategory(ctx, id)
	if db.IsNotFound(err) || (err == nil && c.WorkspaceID != wsID) {
		return nil, httpx.Validation(field, "a board category of this workspace is required")
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

// manageCategories resolves a member who may manage the board categories of a workspace:
// CREATE_BOARDS (ADR-0048; guests are refused by member), not suspended.
func (s *Service) manageCategories(r *http.Request, wsID uuid.UUID) (perm.Member, error) {
	m, err := member(r, wsID)
	if err != nil {
		return m, err
	}
	if !m.Workspace().Has(perm.CreateBoards) {
		return m, httpx.Forbidden("CREATE_BOARDS required")
	}
	return m, moderation.CheckSuspended(r.Context(), s.db.Q, wsID)
}

// loadCategory resolves the path category for a manager: 404 when it does not exist or the
// caller is not a member of its workspace.
func (s *Service) loadCategory(r *http.Request) (sqlc.BoardCategory, error) {
	id, err := httpx.PathUUID(r, "id", "category")
	if err != nil {
		return sqlc.BoardCategory{}, err
	}
	c, err := s.db.Q.GetBoardCategory(r.Context(), id)
	if db.IsNotFound(err) {
		return c, httpx.NotFound("category")
	}
	if err != nil {
		return c, err
	}
	if _, err := s.manageCategories(r, c.WorkspaceID); err != nil {
		if e := httpx.AsError(err); e.Status == http.StatusNotFound {
			return c, httpx.NotFound("category")
		}
		return c, err
	}
	return c, nil
}

// placeCategory moves category id to index pos among the workspace's categories (q in the
// transaction, LockBoards held) and returns the categories whose position changed, id included.
func placeCategory(ctx context.Context, q *sqlc.Queries, wsID, id uuid.UUID, pos int) ([]sqlc.BoardCategory, error) {
	cs, err := q.ListBoardCategories(ctx, wsID)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(cs))
	cur := make(map[uuid.UUID]int32, len(cs))
	for i, c := range cs {
		ids[i], cur[c.ID] = c.ID, c.Position
	}
	var changed []sqlc.BoardCategory
	for i, cid := range reorder(ids, id, pos) {
		p := int32(i) //nolint:gosec // ≤ 50
		if cur[cid] == p {
			continue
		}
		c, err := q.SetBoardCategoryPosition(ctx, sqlc.SetBoardCategoryPositionParams{ID: cid, WorkspaceID: wsID, Position: p})
		if err != nil {
			return nil, err
		}
		changed = append(changed, c)
	}
	return changed, nil
}

func categoryEvent(c sqlc.BoardCategory, created bool) *v1.DispatchEvent {
	if created {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCategoryCreate{BoardCategoryCreate: &v1.BoardCategoryCreate{Category: Category(c)}}}
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCategoryUpdate{BoardCategoryUpdate: &v1.BoardCategoryUpdate{Category: Category(c)}}}
}

// boardEvents renders BOARD_UPDATE (broadcast form) of the live boards among ids, loading their
// parts in one go.
func (s *Service) boardEvents(ctx context.Context, wsID uuid.UUID, ids []uuid.UUID) []*v1.DispatchEvent {
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Q.ListBoards(ctx, sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
	if err != nil {
		return nil
	}
	want := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	live := rows[:0]
	liveIDs := make([]uuid.UUID, 0, len(ids))
	for _, b := range rows {
		if want[b.ID] {
			live, liveIDs = append(live, b), append(liveIDs, b.ID)
		}
	}
	p, err := loadParts(ctx, s.db.Q, liveIDs, uuid.Nil, false)
	if err != nil {
		return nil
	}
	out := make([]*v1.DispatchEvent, len(live))
	for i, b := range live {
		out[i] = &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardUpdate{BoardUpdate: &v1.BoardUpdate{Board: boardProto(b, p, 0, false)}}}
	}
	return out
}

// publishBoards sends BOARD_UPDATE of the live boards among ids in one pipeline.
func (s *Service) publishBoards(ctx context.Context, wsID uuid.UUID, ids []uuid.UUID) {
	s.ev.WorkspaceEvents(ctx, wsID, s.boardEvents(ctx, wsID, ids))
}

func isNoBoard(err error) bool { return errors.Is(err, perm.ErrNoBoard) }

// ---- handlers ----

func (s *Service) listCategories(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err := member(r, wsID); err != nil {
		return err
	}
	cs, err := s.db.Q.ListBoardCategories(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListBoardCategoriesResponse{Categories: Categories(cs)})
	return nil
}

func (s *Service) createCategory(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err := s.manageCategories(r, wsID); err != nil {
		return err
	}
	var req v1.CreateBoardCategoryRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxCategoryName)
	if err != nil {
		return err
	}
	var c sqlc.BoardCategory
	var shifted []sqlc.BoardCategory
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockBoards(r.Context(), wsID.String()); err != nil {
			return err
		}
		n, err := q.CountBoardCategories(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxBoardCategories {
			return httpx.Conflict("at most 50 board categories per workspace").WithDetails(ReasonBoardCategoryLimit, uint64(max(n, 0)), MaxBoardCategories)
		}
		if c, err = q.CreateBoardCategory(r.Context(), sqlc.CreateBoardCategoryParams{WorkspaceID: wsID, Name: name}); err != nil || req.Position == nil {
			return err
		}
		changed, err := placeCategory(r.Context(), q, wsID, c.ID, int(req.GetPosition()))
		if err != nil {
			return err
		}
		for _, x := range changed {
			if x.ID == c.ID {
				c = x
			} else {
				shifted = append(shifted, x)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	evs := []*v1.DispatchEvent{categoryEvent(c, true)}
	for _, x := range shifted {
		evs = append(evs, categoryEvent(x, false))
	}
	s.ev.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.Write(w, http.StatusCreated, &v1.BoardCategoryResponse{Category: Category(c)})
	return nil
}

func (s *Service) updateCategory(w http.ResponseWriter, r *http.Request) error {
	c, err := s.loadCategory(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardCategoryRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardCategoryParams{ID: c.ID}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxCategoryName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	changed := map[uuid.UUID]sqlc.BoardCategory{}
	var order []uuid.UUID
	note := func(x sqlc.BoardCategory) {
		if _, ok := changed[x.ID]; !ok {
			order = append(order, x.ID)
		}
		changed[x.ID] = x
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockBoards(r.Context(), c.WorkspaceID.String()); err != nil {
			return err
		}
		x, err := q.UpdateBoardCategory(r.Context(), p)
		if db.IsNotFound(err) {
			return httpx.NotFound("category")
		}
		if err != nil {
			return err
		}
		c = x
		note(x)
		if req.Position == nil {
			return nil
		}
		moved, err := placeCategory(r.Context(), q, c.WorkspaceID, c.ID, int(req.GetPosition()))
		if err != nil {
			return err
		}
		for _, m := range moved {
			if m.ID == c.ID {
				c = m
			}
			note(m)
		}
		return nil
	})
	if err != nil {
		return err
	}
	evs := make([]*v1.DispatchEvent, 0, len(order))
	for _, id := range order {
		evs = append(evs, categoryEvent(changed[id], false))
	}
	s.ev.WorkspaceEvents(r.Context(), c.WorkspaceID, evs)
	httpx.Write(w, http.StatusOK, &v1.BoardCategoryResponse{Category: Category(c)})
	return nil
}

// deleteCategory: DELETE /api/board-categories/{id} — its boards (live and archived) move to
// «без категории» after the boards already there; BOARD_UPDATE for each live one.
func (s *Service) deleteCategory(w http.ResponseWriter, r *http.Request) error {
	c, err := s.loadCategory(r)
	if err != nil {
		return err
	}
	var moved []uuid.UUID
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockBoards(r.Context(), c.WorkspaceID.String()); err != nil {
			return err
		}
		moved, err = q.DeleteBoardCategory(r.Context(), c.ID)
		return err
	})
	if err != nil {
		return err
	}
	evs := []*v1.DispatchEvent{{Event: &v1.DispatchEvent_BoardCategoryDelete{BoardCategoryDelete: &v1.BoardCategoryDelete{
		WorkspaceId: c.WorkspaceID.String(), CategoryId: c.ID.String()}}}}
	s.ev.WorkspaceEvents(r.Context(), c.WorkspaceID, append(evs, s.boardEvents(r.Context(), c.WorkspaceID, moved)...))
	httpx.NoContent(w)
	return nil
}

// setOrder: PUT /api/workspaces/{id}/boards/order — one drag & drop in one transaction and one
// event pipeline. Categories need CREATE_BOARDS; each board MANAGE_BOARD on it, and a board the
// caller does not see (or of another workspace, or archived) is 422 like a missing one, so the
// answer reveals nothing. Only what actually changed is written and announced.
func (s *Service) setOrder(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	var req v1.SetBoardOrderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if len(req.GetBoards()) > MaxBoards || len(req.GetCategories()) > MaxBoardCategories {
		return httpx.Validation("boards", "too many items")
	}
	if len(req.GetCategories()) > 0 && !m.Workspace().Has(perm.CreateBoards) {
		return httpx.Forbidden("CREATE_BOARDS required to order board categories")
	}
	if err := moderation.CheckSuspended(r.Context(), s.db.Q, wsID); err != nil {
		return err
	}
	type placement struct {
		id  uuid.UUID
		raw string
		pos int32
	}
	boards := make([]placement, 0, len(req.GetBoards()))
	seen := map[uuid.UUID]bool{}
	for i, bp := range req.GetBoards() {
		field := "boards[" + strconv.Itoa(i) + "].boardId"
		id, err := uuid.Parse(bp.GetBoardId())
		if err != nil || seen[id] {
			return httpx.Validation(field, "invalid or duplicate board id")
		}
		seen[id] = true
		acc, err := perm.FromContext(r.Context()).Board(r.Context(), id, uid(r))
		if err != nil && !isNoBoard(err) {
			return err
		}
		if err != nil || acc.WorkspaceID != wsID || !acc.Bits.Has(perm.ViewBoard) || acc.Archived {
			return httpx.Validation(field, "board not found in this workspace")
		}
		if !acc.Bits.Has(perm.ManageBoard) {
			return httpx.Forbidden("MANAGE_BOARD required on every board placed")
		}
		boards = append(boards, placement{id, bp.GetCategoryId(), bp.GetPosition()})
	}
	var movedBoards []uuid.UUID
	var movedCats []sqlc.BoardCategory
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		movedBoards, movedCats = nil, nil
		if err := q.LockBoards(r.Context(), wsID.String()); err != nil {
			return err
		}
		if len(req.GetCategories()) > 0 {
			cs, err := q.ListBoardCategories(r.Context(), wsID)
			if err != nil {
				return err
			}
			cur := make(map[uuid.UUID]int32, len(cs))
			for _, c := range cs {
				cur[c.ID] = c.Position
			}
			done := map[uuid.UUID]bool{}
			for i, cp := range req.GetCategories() {
				field := "categories[" + strconv.Itoa(i) + "].categoryId"
				id, err := uuid.Parse(cp.GetCategoryId())
				old, ok := cur[id]
				if err != nil || !ok || done[id] {
					return httpx.Validation(field, "invalid, duplicate or unknown category id")
				}
				done[id] = true
				if old == cp.GetPosition() {
					continue
				}
				c, err := q.SetBoardCategoryPosition(r.Context(), sqlc.SetBoardCategoryPositionParams{ID: id, WorkspaceID: wsID, Position: cp.GetPosition()})
				if err != nil {
					return err
				}
				movedCats = append(movedCats, c)
			}
		}
		if len(boards) == 0 {
			return nil
		}
		rows, err := q.ListBoards(r.Context(), sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
		if err != nil {
			return err
		}
		cur := make(map[uuid.UUID]sqlc.Board, len(rows))
		for _, b := range rows {
			cur[b.ID] = b
		}
		for i, p := range boards {
			old, ok := cur[p.id]
			if !ok { // archived since the check
				return httpx.Validation("boards["+strconv.Itoa(i)+"].boardId", "board not found in this workspace")
			}
			cat, err := boardCategory(r.Context(), q, wsID, p.raw, "boards["+strconv.Itoa(i)+"].categoryId")
			if err != nil {
				return err
			}
			if eqID(old.CategoryID, cat) && old.Position == p.pos {
				continue
			}
			if _, err := q.SetBoardPlacement(r.Context(), sqlc.SetBoardPlacementParams{ID: p.id, WorkspaceID: wsID, Position: p.pos, CategoryID: cat}); err != nil {
				return err
			}
			movedBoards = append(movedBoards, p.id)
		}
		return nil
	})
	if err != nil {
		return err
	}
	evs := make([]*v1.DispatchEvent, 0, len(movedCats)+len(movedBoards))
	for _, c := range movedCats {
		evs = append(evs, categoryEvent(c, false))
	}
	s.ev.WorkspaceEvents(r.Context(), wsID, append(evs, s.boardEvents(r.Context(), wsID, movedBoards)...))

	out, _, err := Snapshot(r.Context(), s.db.Q, wsID, m)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(out))
	for i, b := range out {
		ids[i] = uuid.MustParse(b.GetId())
	}
	if err := s.withPersonalViews(r.Context(), out, ids, uid(r)); err != nil {
		return err
	}
	cs, err := s.db.Q.ListBoardCategories(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SetBoardOrderResponse{Boards: out, Categories: Categories(cs)})
	return nil
}
