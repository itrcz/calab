package search

import (
	"context"
	"errors"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// space is what the caller sees in one workspace — only through the existing visibility
// functions (ADR-0062 §2).
type space struct {
	id     uuid.UUID
	rooms  []uuid.UUID             // rooms.VisibleBits: VIEW_ROOM (no task rooms, no archived rooms)
	boards boards.Visible          // boards.VisibleBoards: full and task-scoped (TaskBits != 0)
	events *calendar.SearchViewer  // the calendar's viewer; nil for guests
	bits   map[uuid.UUID]perm.Bits // effective bits per visible room
}

// dmRoom is one of the caller's DMs; since = their «Удалить чат» mark (only later messages).
type dmRoom struct {
	id    uuid.UUID
	since *uuid.UUID
}

// scope is everything a search may look into.
type scope struct {
	user  uuid.UUID
	bot   bool
	wss   []space
	dms   []dmRoom    // scope=all only
	notes []uuid.UUID // the caller's shelves, when notes are allowed
}

func (sc *scope) workspaceIDs() []uuid.UUID {
	out := make([]uuid.UUID, len(sc.wss))
	for i, s := range sc.wss {
		out[i] = s.id
	}
	return out
}

// buildScope resolves the caller's view. scope=<ws>: the caller must be a member (else 404).
// scope=all: every workspace where the access policy lets the caller read (others are skipped,
// as in /api/me/tasks), plus DMs and notes when the global policy allows.
func (s *Service) buildScope(ctx context.Context, req *request, user uuid.UUID, bot bool) (*scope, error) {
	sc := &scope{user: user, bot: bot}
	res := perm.FromContext(ctx)
	var wss []uuid.UUID
	if req.all {
		ids, err := s.db.Q.ListUserWorkspaceIDs(ctx, user)
		if err != nil {
			return nil, err
		}
		wss = ids
	} else {
		wss = []uuid.UUID{req.ws}
	}
	needBoards := req.has(v1.SearchType_SEARCH_TYPE_TASKS) || req.has(v1.SearchType_SEARCH_TYPE_TASK_COMMENTS) || req.has(v1.SearchType_SEARCH_TYPE_FILES)
	for _, id := range wss {
		m, err := res.Member(ctx, id, user)
		if err != nil {
			if !req.all {
				if errors.Is(err, perm.ErrNotMember) {
					return nil, httpx.NotFound("workspace")
				}
				return nil, err
			}
			if errors.Is(err, perm.ErrNotMember) || httpx.AsError(err) != nil {
				continue // left meanwhile, or blocked by the workspace's access policy
			}
			return nil, err
		}
		ws, err := s.db.Q.GetWorkspace(ctx, id)
		if err != nil {
			return nil, err
		}
		bits, err := rooms.VisibleBits(ctx, s.db.Q, ws, m)
		if err != nil {
			return nil, err
		}
		sp := space{id: id, bits: bits, rooms: make([]uuid.UUID, 0, len(bits))}
		for rid, b := range bits {
			if b.Has(perm.ViewRoom) {
				sp.rooms = append(sp.rooms, rid)
			}
		}
		if needBoards {
			if sp.boards, err = boards.VisibleBoards(ctx, s.db.Q, id, m); err != nil {
				return nil, err
			}
		}
		if req.has(v1.SearchType_SEARCH_TYPE_EVENTS) {
			sp.events = calendar.NewSearchViewer(m, user, bot, bits)
		}
		sc.wss = append(sc.wss, sp)
	}
	notes := req.notesAllowed(bot)
	if !req.all && !notes {
		return sc, nil
	}
	if err := perm.CheckAccess(ctx, uuid.Nil, user); err != nil {
		if httpx.AsError(err) != nil {
			return sc, nil // personal rooms are closed to this session by the global policy
		}
		return nil, err
	}
	rows, err := s.db.Q.ListSearchPersonalRooms(ctx, user)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		switch {
		case r.Type == "notes" && notes:
			sc.notes = append(sc.notes, r.ID)
		case r.Type == "dm" && req.all:
			sc.dms = append(sc.dms, dmRoom{id: r.ID, since: r.ClearedBefore})
		}
	}
	return sc, nil
}
