package boards

import (
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Saved views (ADR-0042 §3): shared ones are seen by everyone who sees the board and edited
// with MANAGE_BOARD; personal ones by their author only.

func (s *Service) listViews(w http.ResponseWriter, r *http.Request) error {
	id, _, err := pathBoard(r, false)
	if err != nil {
		return err
	}
	me := uid(r)
	vs, err := s.db.Q.ListBoardViews(r.Context(), sqlc.ListBoardViewsParams{BoardIds: []uuid.UUID{id}, UserID: &me})
	if err != nil {
		return err
	}
	out := &v1.ListBoardViewsResponse{Views: make([]*v1.BoardView, len(vs))}
	for i, v := range vs {
		out.Views[i] = View(v)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func viewKind(k v1.BoardViewKind) (string, error) {
	if k == v1.BoardViewKind_BOARD_VIEW_KIND_UNSPECIFIED {
		return "kanban", nil
	}
	s, ok := viewKinds[k]
	if !ok {
		return "", httpx.Validation("kind", "kind must be KANBAN, LIST or TIMELINE")
	}
	return s, nil
}

// checkFilter validates a view's filter by translating it once.
func (s *Service) checkFilter(r *http.Request, f *v1.TaskFilter) error {
	var a Args
	_, err := Translate(f, s.env(r), &a)
	return err
}

func (s *Service) createView(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := fullBoard(r, false) // task-scoped members only read views (ADR-0059)
	if err != nil {
		return err
	}
	if err := writable(acc); err != nil {
		return err
	}
	var req v1.CreateBoardViewRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.GetShared() && !acc.Bits.Has(perm.ManageBoard) {
		return httpx.Forbidden("MANAGE_BOARD required for a shared view")
	}
	name, err := validText("name", req.GetName(), 1, MaxViewName)
	if err != nil {
		return err
	}
	kind, err := viewKind(req.GetKind())
	if err != nil {
		return err
	}
	if len(req.GetGroupBy()) > 32 || len(req.GetSort()) > 32 {
		return httpx.Validation("groupBy", "groupBy and sort must be at most 32 characters")
	}
	if err := s.checkFilter(r, req.GetFilter()); err != nil {
		return err
	}
	var v sqlc.BoardView
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		n, err := q.CountBoardViews(r.Context(), id)
		if err != nil {
			return err
		}
		if n >= MaxViews {
			return httpx.Conflict("at most 30 views per board")
		}
		v, err = q.CreateBoardView(r.Context(), sqlc.CreateBoardViewParams{
			BoardID: id, Name: name, Kind: kind, Filter: filterJSON(req.GetFilter()), GroupBy: req.GetGroupBy(),
			Sort: req.GetSort(), Shared: req.GetShared(), CreatedBy: uid(r), Position: req.Position,
		})
		return err
	})
	if err != nil {
		return err
	}
	if v.Shared {
		s.publishBoard(r.Context(), acc.WorkspaceID, id, false)
	}
	httpx.Write(w, http.StatusCreated, &v1.BoardViewResponse{View: View(v)})
	return nil
}

// view loads a view the caller may change: their own personal view, or a shared one with
// MANAGE_BOARD.
func (s *Service) view(r *http.Request) (uuid.UUID, perm.BoardAccess, sqlc.BoardView, error) {
	id, acc, err := fullBoard(r, false)
	if err != nil {
		return id, acc, sqlc.BoardView{}, err
	}
	if err := writable(acc); err != nil {
		return id, acc, sqlc.BoardView{}, err
	}
	vid, err := pathSub(r)
	if err != nil {
		return id, acc, sqlc.BoardView{}, err
	}
	v, err := s.db.Q.GetBoardView(r.Context(), sqlc.GetBoardViewParams{ID: vid, BoardID: id})
	if db.IsNotFound(err) || (err == nil && !v.Shared && v.CreatedBy != uid(r)) {
		return id, acc, v, httpx.NotFound("view")
	}
	if err != nil {
		return id, acc, v, err
	}
	if v.Shared && !acc.Bits.Has(perm.ManageBoard) {
		return id, acc, v, httpx.Forbidden("MANAGE_BOARD required for a shared view")
	}
	return id, acc, v, nil
}

func (s *Service) updateView(w http.ResponseWriter, r *http.Request) error {
	id, acc, v, err := s.view(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardViewRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardViewParams{ID: v.ID, GroupBy: req.GroupBy, Sort: req.Sort, Shared: req.Shared, Position: req.Position}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxViewName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Kind != nil {
		k, err := viewKind(req.GetKind())
		if err != nil {
			return err
		}
		p.Kind = &k
	}
	if len(req.GetGroupBy()) > 32 || len(req.GetSort()) > 32 {
		return httpx.Validation("groupBy", "groupBy and sort must be at most 32 characters")
	}
	if req.Filter != nil {
		if err := s.checkFilter(r, req.GetFilter()); err != nil {
			return err
		}
		p.Filter = filterJSON(req.GetFilter())
	}
	if req.GetShared() && !v.Shared && !acc.Bits.Has(perm.ManageBoard) {
		return httpx.Forbidden("MANAGE_BOARD required for a shared view")
	}
	out, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.BoardView, error) { return guarded.UpdateBoardView(r.Context(), p) })
	if err != nil {
		return err
	}
	if v.Shared || out.Shared {
		s.publishBoard(r.Context(), acc.WorkspaceID, id, false)
	}
	httpx.Write(w, http.StatusOK, &v1.BoardViewResponse{View: View(out)})
	return nil
}

func (s *Service) deleteView(w http.ResponseWriter, r *http.Request) error {
	id, acc, v, err := s.view(r)
	if err != nil {
		return err
	}
	if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteBoardView(r.Context(), sqlc.DeleteBoardViewParams{ID: v.ID, BoardID: id})
	}); err != nil {
		return err
	}
	if v.Shared {
		s.publishBoard(r.Context(), acc.WorkspaceID, id, false)
	}
	httpx.NoContent(w)
	return nil
}
