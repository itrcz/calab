package boards

import (
	"context"
	"net/http"

	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// boardFor renders one board as viewer sees it (acc: theirs; zero = a broadcast, shared views
// only; acc.TaskScoped = the task-scoped form of ADR-0064).
func (s *Service) boardFor(ctx context.Context, q *sqlc.Queries, id, viewer uuid.UUID, acc perm.BoardAccess) (*v1.Board, error) {
	b, err := q.GetBoard(ctx, id)
	if err != nil {
		return nil, err
	}
	p, err := loadParts(ctx, q, []uuid.UUID{id}, viewer, acc.Bits != 0 || acc.TaskScoped)
	if err != nil {
		return nil, err
	}
	return boardProto(b, p, acc.Bits, acc.TaskScoped), nil
}

// publishBoard sends BOARD_UPDATE (or create) of a board to its viewers (the gateway fills in
// each recipient's bits).
func (s *Service) publishBoard(ctx context.Context, wsID, id uuid.UUID, created bool) {
	b, err := s.boardFor(ctx, s.db.Q, id, uuid.Nil, perm.BoardAccess{})
	if err != nil {
		return
	}
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardUpdate{BoardUpdate: &v1.BoardUpdate{Board: b}}}
	if created {
		ev = &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCreate{BoardCreate: &v1.BoardCreate{Board: b}}}
	}
	s.ev.Workspace(ctx, wsID, ev)
}

// respondBoard answers with the board as the caller sees it now and broadcasts BOARD_UPDATE.
func (s *Service) respondBoard(w http.ResponseWriter, r *http.Request, id uuid.UUID, acc perm.BoardAccess, status int) error {
	perm.FromContext(r.Context()).Invalidate()
	if fresh, err := perm.FromContext(r.Context()).Board(r.Context(), id, uid(r)); err == nil {
		acc = fresh
	}
	b, err := s.boardFor(r.Context(), s.db.Q, id, uid(r), acc)
	if err != nil {
		return err
	}
	s.publishBoard(r.Context(), acc.WorkspaceID, id, status == http.StatusCreated)
	httpx.Write(w, status, &v1.BoardResponse{Board: b})
	return nil
}

func validText(field, s string, lo, hi int) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < lo || n > hi {
		return "", httpx.Validation(field, field+" must be "+strconv.Itoa(lo)+".."+strconv.Itoa(hi)+" characters")
	}
	return s, nil
}

func validEmoji(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s != "" && !messages.ValidEmoji(s) {
		return "", httpx.Validation("emoji", "emoji must be one emoji")
	}
	return s, nil
}

func validColor(c uint32) (int32, error) {
	if c > 0xFFFFFF {
		return 0, httpx.Validation("color", "color must be 0xRRGGBB")
	}
	return int32(c), nil //nolint:gosec // ≤ 0xFFFFFF
}

// iconFile checks an icon upload: an image of the workspace uploaded by the caller (or the
// board's current icon, cur). A board icon is readable by every member of the workspace
// (files.CanRead: IsWorkspaceIcon), so someone else's file — e.g. an attachment of a room or a
// private board the members do not see — must not become one (security review 1.1.0).
func (s *Service) iconFile(ctx context.Context, wsID, me uuid.UUID, cur *uuid.UUID, raw string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, httpx.Validation("iconFileId", "invalid file id")
	}
	f, err := s.db.Q.GetFile(ctx, id)
	if db.IsNotFound(err) || (err == nil && (f.WorkspaceID == nil || *f.WorkspaceID != wsID || !strings.HasPrefix(f.Mime, "image/") ||
		(f.UploaderID != me && (cur == nil || *cur != id)))) {
		return nil, httpx.Validation("iconFileId", "an image you uploaded to this workspace is required")
	}
	return &id, err
}

// ---- boards ----

func (s *Service) listBoards(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	archived := r.URL.Query().Get("archived") == "1"
	if !archived {
		out, _, err := Snapshot(r.Context(), s.db.Q, wsID, m)
		if err != nil {
			return err
		}
		// Personal views too (Snapshot carries shared ones).
		ids := make([]uuid.UUID, len(out))
		for i, b := range out {
			ids[i] = uuid.MustParse(b.GetId())
		}
		if err := s.withPersonalViews(r.Context(), out, ids, uid(r)); err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, &v1.ListBoardsResponse{Boards: out})
		return nil
	}
	rows, err := s.db.Q.ListBoards(r.Context(), sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: true})
	if err != nil {
		return err
	}
	var out []*v1.Board
	for _, b := range rows {
		acc, err := perm.FromContext(r.Context()).Board(r.Context(), b.ID, uid(r))
		if err != nil || !acc.Bits.Has(perm.ViewBoard|perm.ManageBoard) {
			continue
		}
		pb, err := s.boardFor(r.Context(), s.db.Q, b.ID, uid(r), acc)
		if err != nil {
			return err
		}
		out = append(out, pb)
	}
	httpx.Write(w, http.StatusOK, &v1.ListBoardsResponse{Boards: out})
	return nil
}

func (s *Service) withPersonalViews(ctx context.Context, bs []*v1.Board, ids []uuid.UUID, me uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	vs, err := s.db.Q.ListBoardViews(ctx, sqlc.ListBoardViewsParams{BoardIds: ids, UserID: &me})
	if err != nil {
		return err
	}
	by := map[string][]*v1.BoardView{}
	for _, v := range vs {
		by[v.BoardID.String()] = append(by[v.BoardID.String()], View(v))
	}
	for _, b := range bs {
		b.Views = by[b.GetId()]
	}
	return nil
}

// templates are the status sets of a new board (ADR-0042 §5).
var templates = map[v1.BoardTemplate][]sqlc.CreateBoardStatusParams{
	v1.BoardTemplate_BOARD_TEMPLATE_SIMPLE: {
		{Name: "Todo", Type: "unstarted", Color: 0x9CA3AF, IsDefault: true},
		{Name: "В работе", Type: "started", Color: 0xF59E0B},
		{Name: "Готово", Type: "completed", Color: 0x22C55E},
	},
	v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT: {
		{Name: "Backlog", Type: "backlog", Color: 0x6B7280},
		{Name: "Todo", Type: "unstarted", Color: 0x9CA3AF, IsDefault: true},
		{Name: "В работе", Type: "started", Color: 0xF59E0B},
		{Name: "Ревью", Type: "started", Color: 0x8B5CF6},
		{Name: "Готово", Type: "completed", Color: 0x22C55E},
		{Name: "Отменено", Type: "cancelled", Color: 0xEF4444},
	},
	v1.BoardTemplate_BOARD_TEMPLATE_EMPTY: {
		{Name: "Todo", Type: "unstarted", Color: 0x9CA3AF, IsDefault: true},
	},
}

// freeKey returns want when free, else want with a digit suffix (derived keys only).
func freeKey(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, want string, derived bool) (string, error) {
	for i := 0; i < 100; i++ {
		k := want
		if i > 0 {
			suffix := strconv.Itoa(i + 1)
			k = want[:min(len(want), 6-len(suffix))] + suffix
		}
		taken, err := q.BoardKeyTaken(ctx, sqlc.BoardKeyTakenParams{WorkspaceID: wsID, Key: k})
		if err != nil {
			return "", err
		}
		if !taken {
			return k, nil
		}
		if !derived {
			return "", httpx.Conflict("the key is taken by another board of the workspace")
		}
	}
	return "", httpx.Conflict("no free key")
}

func (s *Service) createBoard(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	if !m.Workspace().Has(perm.CreateBoards) { // ADR-0048 (guests are refused by member)
		return httpx.Forbidden("CREATE_BOARDS required")
	}
	if err := moderation.CheckSuspended(r.Context(), s.db.Q, wsID); err != nil {
		return err
	}
	var req v1.CreateBoardRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxBoardName)
	if err != nil {
		return err
	}
	desc := strings.TrimSpace(req.GetDescription())
	if utf8.RuneCountInString(desc) > MaxBoardDesc {
		return httpx.Validation("description", "description must be at most 2000 characters")
	}
	emoji, err := validEmoji(req.GetEmoji())
	if err != nil {
		return err
	}
	key, derived := strings.ToUpper(strings.TrimSpace(req.GetKey())), false
	if key == "" {
		key, derived = DeriveKey(name), true
	} else if !ValidKey(key) {
		return httpx.Validation("key", "key must be 2..6 letters A–Z or digits, starting with a letter")
	}
	icon, err := s.iconFile(r.Context(), wsID, uid(r), nil, req.GetIconFileId())
	if err != nil {
		return err
	}
	tmpl := templates[req.GetTemplate()]
	if tmpl == nil {
		tmpl = templates[v1.BoardTemplate_BOARD_TEMPLATE_SIMPLE]
	}
	me := uid(r)
	var b sqlc.Board
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockBoards(r.Context(), wsID.String()); err != nil {
			return err
		}
		n, err := q.CountAllBoards(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxBoards {
			return httpx.Conflict("at most 50 boards per workspace").WithDetails(ReasonBoardLimit, uint64(max(n, 0)), MaxBoards)
		}
		if err := s.plans.Check(r.Context(), q, wsID, plans.KindBoards, true); err != nil {
			return err
		}
		if key, err = freeKey(r.Context(), q, wsID, key, derived); err != nil {
			return err
		}
		b, err = q.CreateBoard(r.Context(), sqlc.CreateBoardParams{
			WorkspaceID: wsID, Name: name, Key: key, Emoji: emoji, IconFileID: icon, Description: desc,
			IsPrivate: req.GetIsPrivate(), CreatedBy: &me,
		})
		if err != nil {
			if db.UniqueViolation(err) != "" {
				return httpx.Conflict("the key is taken by another board of the workspace")
			}
			return err
		}
		for i, st := range tmpl {
			st.BoardID, st.Position = b.ID, int32(i) //nolint:gosec // ≤ 6
			if _, err := q.CreateBoardStatus(r.Context(), st); err != nil {
				return err
			}
		}
		// The creator manages the board (ADR-0042 §2), and sees it when it is private.
		return q.InsertBoardOverride(r.Context(), sqlc.InsertBoardOverrideParams{
			BoardID: b.ID, TargetType: "user", TargetID: me.String(), Allow: int64(perm.BoardOnly),
		})
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, b.ID, perm.BoardAccess{WorkspaceID: wsID}, http.StatusCreated)
}

func (s *Service) getBoard(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := pathBoard(r, true)
	if err != nil {
		return err
	}
	b, err := s.boardFor(r.Context(), s.db.Q, id, uid(r), acc)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardResponse{Board: b})
	return nil
}

func (s *Service) updateBoard(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardParams{ID: id, IsPrivate: req.IsPrivate, Restricted: req.Restricted}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxBoardName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Description != nil {
		d := strings.TrimSpace(req.GetDescription())
		if utf8.RuneCountInString(d) > MaxBoardDesc {
			return httpx.Validation("description", "description must be at most 2000 characters")
		}
		p.Description = &d
	}
	if req.Emoji != nil {
		e, err := validEmoji(req.GetEmoji())
		if err != nil {
			return err
		}
		p.Emoji = &e
	}
	if req.IconFileId != nil {
		p.SetIcon = true
		cur, err := s.db.Q.GetBoard(r.Context(), id)
		if err != nil {
			return err
		}
		if p.IconFileID, err = s.iconFile(r.Context(), acc.WorkspaceID, uid(r), cur.IconFileID, req.GetIconFileId()); err != nil {
			return err
		}
	}
	if req.AutoArchiveDays != nil {
		if req.GetAutoArchiveDays() > MaxAutoArchive {
			return httpx.Validation("autoArchiveDays", "auto archive must be 0..3650 days")
		}
		d := int32(req.GetAutoArchiveDays()) //nolint:gosec // ≤ 3650
		p.AutoArchiveDays = &d
	}
	if req.DefaultViewId != nil {
		p.SetDefaultView = true
		if v := req.GetDefaultViewId(); v != "" {
			vid, err := uuid.Parse(v)
			if err != nil {
				return httpx.Validation("defaultViewId", "invalid view id")
			}
			view, err := s.db.Q.GetBoardView(r.Context(), sqlc.GetBoardViewParams{ID: vid, BoardID: id})
			if db.IsNotFound(err) || (err == nil && !view.Shared) {
				return httpx.Validation("defaultViewId", "a shared view of the board is required")
			}
			if err != nil {
				return err
			}
			p.DefaultViewID = &vid
		}
	}
	if req.ApprovalNotifyDelaySeconds != nil {
		d, ok := approvalNotifyDelays[req.GetApprovalNotifyDelaySeconds()]
		if !ok {
			return httpx.Validation("approvalNotifyDelaySeconds", "approval notify delay must be 0, 60, 300, 900, 1800 or 3600 seconds")
		}
		p.ApprovalNotifyDelaySeconds = &d
	}
	// Board features (ADR-0058 §3): the disabled set and the estimate scale.
	var features sqlc.SetBoardFeaturesParams
	if req.GetSetDisabledFeatures() {
		m, err := FeatureMask(req.GetDisabledFeatures())
		if err != nil {
			return err
		}
		features.DisabledFeatures = &m
	}
	if req.EstimateScale != nil {
		sc, ok := estimateScales[req.GetEstimateScale()]
		if !ok {
			return httpx.Validation("estimateScale", "estimate scale must be FIBONACCI, LINEAR or TSHIRT")
		}
		features.EstimateScale = &sc
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetBoardForUpdate(r.Context(), id)
		if err != nil {
			return err
		}
		if err := s.restrict(r, q, cur, req.IsPrivate, req.Restricted, acc); err != nil {
			return err
		}
		if features.DisabledFeatures != nil || features.EstimateScale != nil {
			features.ID = id
			if _, err := q.SetBoardFeatures(r.Context(), features); err != nil {
				return err
			}
		}
		if req.Key != nil {
			k := strings.ToUpper(strings.TrimSpace(req.GetKey()))
			if k != cur.Key {
				if !ValidKey(k) {
					return httpx.Validation("key", "key must be 2..6 letters A–Z or digits, starting with a letter")
				}
				if cur.NextNumber > 1 {
					return httpx.Conflict("the key cannot change after the first task")
				}
				if _, err := freeKey(r.Context(), q, acc.WorkspaceID, k, false); err != nil {
					return err
				}
				p.Key = &k
			}
		}
		_, err = q.UpdateBoard(r.Context(), p)
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("the key is taken by another board of the workspace")
		}
		return err
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

// restrict checks a change of is_private / restricted (ADR-0048: a closed board stays private)
// and, when the board gets closed, gives the caller a personal VIEW_BOARD | MANAGE_BOARD so they
// keep it (the owner sees it anyway; the creator has had every board bit since creation).
// MANAGE_BOARD on the board is checked by the caller (manageBoard): the owner always has it.
func (s *Service) restrict(r *http.Request, q *sqlc.Queries, cur sqlc.Board, private, restricted *bool, acc perm.BoardAccess) error {
	nextPrivate, nextRestricted := cur.IsPrivate, cur.Restricted
	if private != nil {
		nextPrivate = *private
	}
	if restricted != nil {
		nextRestricted = *restricted
	}
	switch {
	case restricted != nil && *restricted && !nextPrivate:
		return httpx.Validation("restricted", "only private boards can be closed")
	case nextRestricted && !nextPrivate:
		return httpx.Validation("isPrivate", "a closed board stays private")
	}
	if !nextRestricted || cur.Restricted || acc.Role == perm.RoleOwner {
		return nil
	}
	return q.GrantBoardUserOverride(r.Context(), sqlc.GrantBoardUserOverrideParams{
		BoardID: cur.ID, UserID: uid(r).String(), Allow: int64(perm.ViewBoard | perm.ManageBoard),
	})
}

// deleteBoard: DELETE /api/boards/{id} archives; ?purge=1 deletes the board with its tasks,
// comments and journal for good (people only).
func (s *Service) deleteBoard(w http.ResponseWriter, r *http.Request) error {
	purge := r.URL.Query().Get("purge") == "1"
	if purge && isBot(r) {
		return auth.ErrBotNotAllowed
	}
	id, acc, err := manageBoard(r, purge)
	if err != nil {
		return err
	}
	if !purge {
		if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.Board, error) {
			return guarded.SetBoardArchived(r.Context(), sqlc.SetBoardArchivedParams{ID: id, Archived: true})
		}); err != nil {
			return err
		}
	} else {
		err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
			rooms, err := q.BoardTaskRoomIDs(r.Context(), id)
			if err != nil {
				return err
			}
			if _, err := q.DeleteBoard(r.Context(), id); err != nil {
				return err
			}
			return q.DeleteBoardTaskRooms(r.Context(), rooms)
		})
		if err != nil {
			return err
		}
	}
	s.ev.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{BoardDelete: &v1.BoardDelete{
		WorkspaceId: acc.WorkspaceID.String(), BoardId: id.String(), Purged: purge}}})
	httpx.NoContent(w)
	return nil
}

// restoreBoard: POST /api/boards/{id}/restore — out of the archive (MANAGE_BOARD).
func (s *Service) restoreBoard(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, true)
	if err != nil {
		return err
	}
	if !acc.Archived {
		return httpx.Conflict("the board is not archived")
	}
	if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.Board, error) {
		return guarded.SetBoardArchived(r.Context(), sqlc.SetBoardArchivedParams{ID: id, Archived: false})
	}); err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusCreated)
}

// reorder moves id to index pos in ids (clamped) and returns the new order.
func reorder(ids []uuid.UUID, id uuid.UUID, pos int) []uuid.UUID {
	out := slices.DeleteFunc(slices.Clone(ids), func(x uuid.UUID) bool { return x == id })
	pos = min(max(pos, 0), len(out))
	return slices.Insert(out, pos, id)
}

// setBoardPosition: PUT /api/boards/{id}/position — the index within the board's container
// (its category or «без категории»); category_id set moves it into that category first
// (ADR-0058 §1). Boards that shift get BOARD_UPDATE.
func (s *Service) setBoardPosition(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.SetBoardPositionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var moved []uuid.UUID
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockBoards(r.Context(), acc.WorkspaceID.String()); err != nil {
			return err
		}
		rows, err := q.ListBoards(r.Context(), sqlc.ListBoardsParams{WorkspaceID: acc.WorkspaceID, Archived: false})
		if err != nil {
			return err
		}
		var cat *uuid.UUID
		for _, b := range rows {
			if b.ID == id {
				cat = b.CategoryID
			}
		}
		catChanged := false
		if req.CategoryId != nil {
			next, err := boardCategory(r.Context(), q, acc.WorkspaceID, req.GetCategoryId(), "categoryId")
			if err != nil {
				return err
			}
			catChanged, cat = !eqID(cat, next), next
		}
		var ids []uuid.UUID
		pos := map[uuid.UUID]int32{}
		for _, b := range rows {
			if eqID(b.CategoryID, cat) || b.ID == id {
				ids, pos[b.ID] = append(ids, b.ID), b.Position
			}
		}
		for i, bid := range reorder(ids, id, int(req.GetPosition())) {
			p := int32(i) //nolint:gosec // ≤ 50
			if bid == id && catChanged {
				if _, err := q.SetBoardPlacement(r.Context(), sqlc.SetBoardPlacementParams{ID: id, WorkspaceID: acc.WorkspaceID, Position: p, CategoryID: cat}); err != nil {
					return err
				}
				continue
			}
			if pos[bid] == p {
				continue
			}
			if err := q.SetBoardPosition(r.Context(), sqlc.SetBoardPositionParams{ID: bid, Position: p}); err != nil {
				return err
			}
			if bid != id {
				moved = append(moved, bid)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.publishBoards(r.Context(), acc.WorkspaceID, moved)
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

// ---- permissions ----

func (s *Service) getPermissions(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := pathBoard(r, true)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ManageBoard) {
		return httpx.Forbidden("MANAGE_BOARD required")
	}
	b, err := s.boardFor(r.Context(), s.db.Q, id, uid(r), acc)
	if err != nil {
		return err
	}
	return writePermissions(w, r, s.db.Q, id, b)
}

// writePermissions answers GET / PUT permissions with the task-scoped count (ADR-0076).
func writePermissions(w http.ResponseWriter, r *http.Request, q *sqlc.Queries, id uuid.UUID, b *v1.Board) error {
	n, err := taskScopedCount(r.Context(), q, id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardPermissionsResponse{Overrides: b.GetPermissionOverrides(), Board: b, TaskScopedCount: n})
	return nil
}

func (s *Service) setPermissions(w http.ResponseWriter, r *http.Request) error {
	if isBot(r) {
		return auth.ErrBotNotAllowed
	}
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.SetBoardPermissionsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		existing, err := q.ListBoardOverrides(r.Context(), id)
		if err != nil {
			return err
		}
		params, err := validateOverrides(r.Context(), q, acc, existing, req.GetOverrides())
		if err != nil {
			return err
		}
		if err := q.DeleteBoardOverrides(r.Context(), id); err != nil {
			return err
		}
		for _, p := range params {
			p.BoardID = id
			if err := q.InsertBoardOverride(r.Context(), p); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	b, err := s.boardFor(r.Context(), s.db.Q, id, uid(r), perm.BoardAccess{})
	if err != nil {
		return err
	}
	s.publishBoard(r.Context(), acc.WorkspaceID, id, false)
	fresh, err := perm.FromContext(r.Context()).Board(r.Context(), id, uid(r))
	if err == nil {
		b.Permissions = uint64(fresh.Bits)
	}
	return writePermissions(w, r, s.db.Q, id, b)
}

// validateOverrides checks board override targets and bits like room overrides (rooms): role
// ids (or built-in names) and members of the workspace, only BoardOnly bits, and a
// non-administrator may only grant or remove bits they hold on the board.
func validateOverrides(ctx context.Context, q *sqlc.Queries, actor perm.BoardAccess, existing []sqlc.BoardPermission, in []*v1.RoomPermissionOverride) ([]sqlc.InsertBoardOverrideParams, error) {
	if len(in) > 100 {
		return nil, httpx.Validation("overrides", "too many overrides")
	}
	prev := map[string]perm.Bits{}
	for _, e := range existing {
		prev[e.TargetType+":"+e.TargetID] = perm.Bits(uint64(e.Allow)) //nolint:gosec // bit mask
	}
	admin := actor.Bits.Has(perm.Administrator) // not on a closed board (ADR-0048), except the owner
	roleRows, err := q.ListWorkspaceRoles(ctx, actor.WorkspaceID)
	if err != nil {
		return nil, err
	}
	roleIDs := make(map[string]string, len(roleRows)+4)
	for _, rr := range roleRows {
		roleIDs[rr.ID.String()] = rr.ID.String()
		if rr.Builtin != nil {
			roleIDs[*rr.Builtin] = rr.ID.String()
		}
	}
	seen := map[string]bool{}
	out := make([]sqlc.InsertBoardOverrideParams, 0, len(in))
	for i, o := range in {
		field := "overrides[" + strconv.Itoa(i) + "]"
		var tt string
		switch o.GetTargetType() {
		case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE:
			tt = "role"
		case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER:
			tt = "user"
		default:
			return nil, httpx.Validation(field+".targetType", "target type must be ROLE or USER")
		}
		target := o.GetTargetId()
		if tt == "role" {
			id, ok := roleIDs[strings.ToLower(target)]
			if !ok {
				return nil, httpx.Validation(field+".targetId", "unknown role")
			}
			target = id
		} else {
			u, err := uuid.Parse(target)
			if err != nil {
				return nil, httpx.Validation(field+".targetId", "invalid user id")
			}
			if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: actor.WorkspaceID, UserID: u}); err != nil {
				if db.IsNotFound(err) {
					return nil, httpx.Validation(field+".targetId", "user is not a member of the workspace")
				}
				return nil, err
			}
			target = u.String()
		}
		if seen[tt+":"+target] {
			return nil, httpx.Validation(field, "duplicate target")
		}
		seen[tt+":"+target] = true
		allow, deny := perm.Bits(o.GetAllow()), perm.Bits(o.GetDeny())
		if (allow|deny)&^perm.BoardOnly != 0 {
			return nil, httpx.Validation(field, "only VIEW_BOARD, CREATE_TASKS, EDIT_TASKS and MANAGE_BOARD can be set per board")
		}
		if allow&deny != 0 {
			return nil, httpx.Validation(field, "a bit cannot be both allowed and denied")
		}
		if !admin {
			old := prev[tt+":"+target]
			if (allow&^old)&^actor.Bits != 0 || (old&^allow)&^actor.Bits != 0 {
				return nil, httpx.Forbidden("cannot grant or remove permissions you do not have")
			}
			delete(prev, tt+":"+target)
		}
		out = append(out, sqlc.InsertBoardOverrideParams{TargetType: tt, TargetID: target, Allow: int64(allow), Deny: int64(deny)}) //nolint:gosec // bits < 2^21
	}
	if !admin {
		for _, old := range prev {
			if old&^actor.Bits != 0 {
				return nil, httpx.Forbidden("cannot remove permissions you do not have")
			}
		}
	}
	return out, nil
}

// ---- statuses, labels, milestones ----

func pathSub(r *http.Request) (uuid.UUID, error) { return httpx.PathUUID(r, "sid", "item") }

func (s *Service) createStatus(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.CreateBoardStatusRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxStatusName)
	if err != nil {
		return err
	}
	typ := StatusTypeToDB(req.GetType())
	if req.GetType() == v1.BoardStatusType_BOARD_STATUS_TYPE_UNSPECIFIED {
		typ = "unstarted"
	}
	if typ == "" {
		return httpx.Validation("type", "unknown status type")
	}
	c, err := validColor(req.GetColor())
	if err != nil {
		return err
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		ss, err := q.ListBoardStatuses(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		if len(ss) >= MaxStatuses {
			return httpx.Conflict("at most 20 statuses per board")
		}
		if req.GetIsDefault() {
			if err := q.ClearDefaultBoardStatus(r.Context(), id); err != nil {
				return err
			}
		}
		st, err := q.CreateBoardStatus(r.Context(), sqlc.CreateBoardStatusParams{BoardID: id, Name: name, Type: typ, Color: c,
			Position: int32(len(ss)), IsDefault: req.GetIsDefault() || len(ss) == 0}) //nolint:gosec // ≤ 20
		if err != nil || req.Position == nil {
			return err
		}
		ids := make([]uuid.UUID, len(ss))
		for i, x := range ss {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(append(ids, st.ID), st.ID, int(req.GetPosition())), statusPos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusCreated)
}

// setPositions writes position = index for every id.
func setPositions(ctx context.Context, ids []uuid.UUID, set func(context.Context, uuid.UUID, int32) error) error {
	for i, id := range ids {
		if err := set(ctx, id, int32(i)); err != nil { //nolint:gosec // ≤ 50
			return err
		}
	}
	return nil
}

func statusPos(q *sqlc.Queries) func(context.Context, uuid.UUID, int32) error {
	return func(ctx context.Context, id uuid.UUID, p int32) error {
		return q.SetBoardStatusPosition(ctx, sqlc.SetBoardStatusPositionParams{ID: id, Position: p})
	}
}

func labelPos(q *sqlc.Queries) func(context.Context, uuid.UUID, int32) error {
	return func(ctx context.Context, id uuid.UUID, p int32) error {
		return q.SetBoardLabelPosition(ctx, sqlc.SetBoardLabelPositionParams{ID: id, Position: p})
	}
}

func milestonePos(q *sqlc.Queries) func(context.Context, uuid.UUID, int32) error {
	return func(ctx context.Context, id uuid.UUID, p int32) error {
		return q.SetBoardMilestonePosition(ctx, sqlc.SetBoardMilestonePositionParams{ID: id, Position: p})
	}
}

func (s *Service) updateStatus(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	sid, err := pathSub(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardStatusRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardStatusParams{ID: sid, BoardID: id}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxStatusName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Type != nil {
		t := StatusTypeToDB(req.GetType())
		if t == "" {
			return httpx.Validation("type", "unknown status type")
		}
		p.Type = &t
	}
	if req.Color != nil {
		c, err := validColor(req.GetColor())
		if err != nil {
			return err
		}
		p.Color = &c
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		if _, err := q.UpdateBoardStatus(r.Context(), p); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("status")
			}
			return err
		}
		if req.GetIsDefault() {
			if err := q.ClearDefaultBoardStatus(r.Context(), id); err != nil {
				return err
			}
			if err := q.SetDefaultBoardStatus(r.Context(), sqlc.SetDefaultBoardStatusParams{ID: sid, BoardID: id}); err != nil {
				return err
			}
		}
		if req.Position == nil {
			return nil
		}
		ss, err := q.ListBoardStatuses(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(ss))
		for i, x := range ss {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(ids, sid, int(req.GetPosition())), statusPos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

// deleteStatus: DELETE …/statuses/{sid}?move_to=<sid> — its tasks move to move_to first.
func (s *Service) deleteStatus(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	sid, err := pathSub(r)
	if err != nil {
		return err
	}
	to, err := uuid.Parse(r.URL.Query().Get("move_to"))
	if err != nil || to == sid {
		return httpx.Validation("moveTo", "move_to must be another status of the board")
	}
	var moved []uuid.UUID
	var c change
	err = s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		ss, err := q.ListBoardStatuses(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		var from, dst *sqlc.BoardStatus
		for i := range ss {
			switch ss[i].ID {
			case sid:
				from = &ss[i]
			case to:
				dst = &ss[i]
			}
		}
		if from == nil {
			return httpx.NotFound("status")
		}
		if dst == nil {
			return httpx.Validation("moveTo", "move_to must be another status of the board")
		}
		if from.IsDefault {
			return httpx.Conflict("the default status cannot be deleted; make another one the default first")
		}
		// Moving the tasks forward is a status change like any other (ADR-0049 §2): refused
		// while one of them waits for approval — pick another move_to.
		if Forward(*from, *dst) && !Disabled(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS) {
			// Row locks: a vote / approvers change (which lock the task) cannot slip in
			// between this check and the move.
			rows, err := queryTasks(r.Context(), tx, "WHERE t.status_id = $1 ORDER BY t.id FOR UPDATE OF t", sid)
			if err != nil {
				return err
			}
			tls, err := tallies(r.Context(), q, rows)
			if err != nil {
				return err
			}
			for _, x := range rows {
				if err := checkApprovalGate(tls[x.ID], *from, *dst); err != nil {
					return err
				}
			}
		}
		if moved, err = q.MoveStatusTasks(r.Context(), sqlc.MoveStatusTasksParams{FromID: sid, ToID: to}); err != nil {
			return err
		}
		for _, t := range moved {
			if err := s.statusChanged(r.Context(), q, tx, t, *from, *dst, uid(r), &c); err != nil {
				return err
			}
		}
		_, err = q.DeleteBoardStatus(r.Context(), sqlc.DeleteBoardStatusParams{ID: sid, BoardID: id})
		return err
	})
	if err != nil {
		return err
	}
	for _, t := range moved {
		s.publish(r.Context(), t, &change{acts: actsOf(c.acts, t), journal: journalOf(c.journal, t)}, false)
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

func (s *Service) createLabel(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := pathBoard(r, false)
	if err != nil {
		return err
	}
	// CREATE_TASKS may create a label on the fly (the picker); the rest needs MANAGE_BOARD.
	if !acc.Bits.Has(perm.ManageBoard) && !acc.Bits.Has(perm.CreateTasks) {
		return httpx.Forbidden("MANAGE_BOARD or CREATE_TASKS required")
	}
	if err := writable(acc); err != nil {
		return err
	}
	var req v1.CreateBoardLabelRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxLabelName)
	if err != nil {
		return err
	}
	c, err := validColor(req.GetColor())
	if err != nil {
		return err
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		ls, err := q.ListBoardLabels(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		if len(ls) >= MaxLabels {
			return httpx.Conflict("at most 50 labels per board")
		}
		l, err := q.CreateBoardLabel(r.Context(), sqlc.CreateBoardLabelParams{BoardID: id, Name: name, Color: c, Position: int32(len(ls))}) //nolint:gosec // ≤ 50
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("a label with this name exists")
		}
		if err != nil || req.Position == nil {
			return err
		}
		ids := make([]uuid.UUID, len(ls))
		for i, x := range ls {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(append(ids, l.ID), l.ID, int(req.GetPosition())), labelPos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusCreated)
}

func (s *Service) updateLabel(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	lid, err := pathSub(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardLabelRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardLabelParams{ID: lid, BoardID: id}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxLabelName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Color != nil {
		c, err := validColor(req.GetColor())
		if err != nil {
			return err
		}
		p.Color = &c
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.UpdateBoardLabel(r.Context(), p); err != nil {
			switch {
			case db.IsNotFound(err):
				return httpx.NotFound("label")
			case db.UniqueViolation(err) != "":
				return httpx.Conflict("a label with this name exists")
			}
			return err
		}
		if req.Position == nil {
			return nil
		}
		ls, err := q.ListBoardLabels(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(ls))
		for i, x := range ls {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(ids, lid, int(req.GetPosition())), labelPos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

func (s *Service) deleteLabel(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	lid, err := pathSub(r)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteBoardLabel(r.Context(), sqlc.DeleteBoardLabelParams{ID: lid, BoardID: id})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("label")
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

func (s *Service) createMilestone(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.CreateBoardMilestoneRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxMilestoneName)
	if err != nil {
		return err
	}
	due, ok := ParseDate(req.GetDueOn())
	if !ok {
		return httpx.Validation("dueOn", "date must be YYYY-MM-DD")
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		ms, err := q.ListBoardMilestones(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		if len(ms) >= MaxMilestones {
			return httpx.Conflict("at most 50 milestones per board")
		}
		m, err := q.CreateBoardMilestone(r.Context(), sqlc.CreateBoardMilestoneParams{BoardID: id, Name: name, DueOn: due, Position: int32(len(ms))}) //nolint:gosec // ≤ 50
		if err != nil || req.Position == nil {
			return err
		}
		ids := make([]uuid.UUID, len(ms))
		for i, x := range ms {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(append(ids, m.ID), m.ID, int(req.GetPosition())), milestonePos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusCreated)
}

func (s *Service) updateMilestone(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	mid, err := pathSub(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardMilestoneRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardMilestoneParams{ID: mid, BoardID: id}
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxMilestoneName)
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.DueOn != nil {
		d, ok := ParseDate(req.GetDueOn())
		if !ok {
			return httpx.Validation("dueOn", "date must be YYYY-MM-DD")
		}
		p.SetDue, p.DueOn = true, d
	}
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.UpdateBoardMilestone(r.Context(), p); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("milestone")
			}
			return err
		}
		if req.Position == nil {
			return nil
		}
		ms, err := q.ListBoardMilestones(r.Context(), []uuid.UUID{id})
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(ms))
		for i, x := range ms {
			ids[i] = x.ID
		}
		return setPositions(r.Context(), reorder(ids, mid, int(req.GetPosition())), milestonePos(q))
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

func (s *Service) deleteMilestone(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	mid, err := pathSub(r)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteBoardMilestone(r.Context(), sqlc.DeleteBoardMilestoneParams{ID: mid, BoardID: id})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("milestone")
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

// upload: POST /api/boards/{id}/files — an attachment for a task description or a comment
// (VIEW_BOARD: whoever may comment), into the board's workspace quota.
func (s *Service) upload(w http.ResponseWriter, r *http.Request) error {
	_, acc, err := pathBoard(r, false)
	if err != nil {
		return err
	}
	if err := writable(acc); err != nil {
		return err
	}
	if s.files == nil {
		return httpx.NotFound("route")
	}
	return s.files.UploadInto(w, r, acc.WorkspaceID)
}
