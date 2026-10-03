package gateway

import (
	"context"
	"slices"
	"sync"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// wsState is this instance's view of one workspace: all live rooms (with overrides), the
// roles (ADR-0026) and every member's roles. It is loaded from Postgres once and then kept
// current by applying the workspace's events in order, so per-recipient VIEW_ROOM filtering
// needs no DB queries.
type wsState struct {
	mu       sync.RWMutex
	loading  bool
	backlog  []pendingEvent // events received while loading
	ws       *v1.Workspace
	rooms    map[uuid.UUID]*v1.Room
	targets  map[uuid.UUID][]perm.OverrideTarget // parsed overrides per room (M13: once per change, not per check)
	roleDefs perm.Roles                          // role id -> position / permissions
	roleIDs  map[uuid.UUID][]string              // member -> role ids
	members  map[uuid.UUID]perm.Member           // derived from roleIDs + roleDefs
	// Guest visibility (perm.GuestVisible, ADR-0016 amended 2026-10-02): who is in which
	// call (Redis at load, then VOICE_STATE_UPDATE), the message authors of rooms (Postgres
	// for the rooms guests can view — authorsLoaded —, plus every MESSAGE_CREATE since load),
	// and the visible set per guest, cached until any of its inputs changes (review B2: the
	// fan-out path computes it once per change, not per event).
	voiceRoom     map[uuid.UUID]uuid.UUID
	authors       map[uuid.UUID]map[uuid.UUID]bool
	authorsLoaded map[uuid.UUID]bool
	guestVis      map[uuid.UUID]map[uuid.UUID]bool
	// Task boards and task rooms (ADR-0042, boards.go).
	boardState
}

// setMember stores a member's built-in role and role ids (mu held).
func (s *wsState) setMember(uid uuid.UUID, role perm.Role, ids []string) {
	if s.roleIDs == nil {
		s.roleIDs = map[uuid.UUID][]string{}
	}
	if s.members == nil {
		s.members = map[uuid.UUID]perm.Member{}
	}
	s.roleIDs[uid] = ids
	s.members[uid] = s.roleDefs.Member(uid.String(), role, ids)
	s.guestVis = nil
}

func (s *wsState) delMember(uid uuid.UUID) {
	if _, ok := s.members[uid]; ok {
		delete(s.members, uid)
		delete(s.roleIDs, uid)
		s.guestVis = nil
	}
}

// role returns a member's highest built-in role ("" = not a member).
func (s *wsState) role(uid uuid.UUID) perm.Role { return s.members[uid].Role }

// setRoleDef stores a created / updated role and rebuilds its holders (mu held).
func (s *wsState) setRoleDef(r *v1.Role) {
	if s.roleDefs == nil {
		s.roleDefs = perm.Roles{}
	}
	s.roleDefs[r.GetId()] = perm.RoleBits{ID: r.GetId(), Position: r.GetPosition(), Permissions: perm.Bits(r.GetPermissions())}
	s.rebuild()
}

// delRoleDef forgets a deleted role, also in every member's role ids (mu held).
func (s *wsState) delRoleDef(id string) {
	delete(s.roleDefs, id)
	for u, ids := range s.roleIDs {
		if slices.Contains(ids, id) {
			s.roleIDs[u] = slices.DeleteFunc(slices.Clone(ids), func(x string) bool { return x == id })
		}
	}
	s.rebuild()
}

func (s *wsState) rebuild() {
	for u, m := range s.members {
		s.members[u] = s.roleDefs.Member(m.UserID, m.Role, s.roleIDs[u])
	}
	s.guestVis = nil
}

// setRoom stores a room and its parsed overrides (mu held).
func (s *wsState) setRoom(id uuid.UUID, r *v1.Room) {
	if s.targets == nil {
		s.targets = map[uuid.UUID][]perm.OverrideTarget{}
	}
	s.rooms[id] = r
	s.targets[id] = pbconv.ProtoOverrideTargets(r.GetPermissionOverrides())
	s.guestVis = nil
}

func (s *wsState) delRoom(id uuid.UUID) {
	delete(s.rooms, id)
	delete(s.targets, id)
	delete(s.authors, id)
	delete(s.authorsLoaded, id)
	s.guestVis = nil
}

// guestRooms returns the rooms in perm.GuestVisible form (mu held).
func (s *wsState) guestRooms() []perm.GuestRoom {
	out := make([]perm.GuestRoom, 0, len(s.rooms))
	for id, r := range s.rooms {
		gr := perm.GuestRoom{ID: id, Restricted: r.GetRestricted(), Overrides: s.targets[id]}
		if c, err := uuid.Parse(r.GetCreatedBy()); err == nil {
			gr.CreatedBy = c
		}
		out = append(out, gr)
	}
	return out
}

// guestVisible returns the members a guest may see (perm.GuestVisible; mu held for write).
// The result is cached: callers must not modify it.
func (s *wsState) guestVisible(guest uuid.UUID) map[uuid.UUID]bool {
	if v, ok := s.guestVis[guest]; ok {
		return v
	}
	v := perm.GuestVisible(guest, s.members, s.guestRooms(), s.voiceRoom, s.authors)
	if s.guestVis == nil {
		s.guestVis = map[uuid.UUID]map[uuid.UUID]bool{}
	}
	s.guestVis[guest] = v
	return v
}

// unloadedGuestRooms returns the rooms guest can view whose authors are not loaded (mu held).
func (s *wsState) unloadedGuestRooms(guest uuid.UUID) []uuid.UUID {
	m, ok := s.members[guest]
	if !ok {
		return nil
	}
	var out []uuid.UUID
	for _, id := range perm.GuestRoomIDs(m, s.guestRooms()) {
		if !s.authorsLoaded[id] {
			out = append(out, id)
		}
	}
	return out
}

// setVoice records the voice room of a user (uuid.Nil: not in voice) and reports whether it
// changed (mu held).
func (s *wsState) setVoice(user, room uuid.UUID) bool {
	if s.voiceRoom[user] == room {
		return false
	}
	if room == uuid.Nil {
		delete(s.voiceRoom, user)
	} else {
		if s.voiceRoom == nil {
			s.voiceRoom = map[uuid.UUID]uuid.UUID{}
		}
		s.voiceRoom[user] = room
	}
	s.guestVis = nil
	return true
}

// isAuthor reports whether user is a known author of room (mu held).
func (s *wsState) isAuthor(room, user uuid.UUID) bool { return s.authors[room][user] }

// addAuthor records a message author of a room (mu held).
func (s *wsState) addAuthor(room, user uuid.UUID) {
	if s.authors[room][user] {
		return
	}
	if s.authors == nil {
		s.authors = map[uuid.UUID]map[uuid.UUID]bool{}
	}
	if s.authors[room] == nil {
		s.authors[room] = map[uuid.UUID]bool{}
	}
	s.authors[room][user] = true
	s.guestVis = nil
}

// loadedAuthors merges the authors read from Postgres for rooms (mu held).
func (s *wsState) loadedAuthors(rooms []uuid.UUID, rows []sqlc.ListRoomAuthorsRow) {
	if s.authorsLoaded == nil {
		s.authorsLoaded = map[uuid.UUID]bool{}
	}
	for _, id := range rooms {
		if s.rooms[id] != nil {
			s.authorsLoaded[id] = true
		}
	}
	for _, a := range rows {
		if s.rooms[a.RoomID] != nil {
			s.addAuthor(a.RoomID, a.AuthorID)
		}
	}
	s.guestVis = nil
}

// sameVisibility reports whether replacing room id with r cannot change who sees what:
// the room exists and keeps its overrides, category and restricted flag (review B2, ADR-0029).
func (s *wsState) sameVisibility(id uuid.UUID, r *v1.Room) bool {
	old := s.rooms[id]
	if old == nil || old.GetCategoryId() != r.GetCategoryId() || old.GetRestricted() != r.GetRestricted() || len(old.GetPermissionOverrides()) != len(r.GetPermissionOverrides()) {
		return false
	}
	for i, o := range old.GetPermissionOverrides() {
		if !proto.Equal(o, r.GetPermissionOverrides()[i]) {
			return false
		}
	}
	return true
}

// hiddenFrom reports whether events about subject must not reach viewer: only guests are
// restricted, to the people of their rooms (guestVisible; mu held for write).
func (s *wsState) hiddenFrom(viewer, subject uuid.UUID) bool {
	if viewer == subject || s.role(viewer) != perm.RoleGuest {
		return false
	}
	return !s.guestVisible(viewer)[subject]
}

func loadState(ctx context.Context, q *sqlc.Queries, wid uuid.UUID) (*wsState, error) {
	ws, err := q.GetWorkspace(ctx, wid)
	if err != nil {
		return nil, err
	}
	rs, err := q.ListRooms(ctx, wid)
	if err != nil {
		return nil, err
	}
	ovs, err := q.ListWorkspaceRoomOverrides(ctx, wid)
	if err != nil {
		return nil, err
	}
	roles, err := q.ListWorkspaceRoles(ctx, wid)
	if err != nil {
		return nil, err
	}
	members, err := q.ListWorkspaceMemberRoles(ctx, wid)
	if err != nil {
		return nil, err
	}
	byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
	for _, o := range ovs {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	st := &wsState{ws: pbconv.Workspace(ws), rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.RolesOf(roles)}
	defaults := pbconv.WorkspaceDefaults(ws)
	for _, r := range rs {
		st.setRoom(r.ID, pbconv.Room(r, defaults, byRoom[r.ID]))
	}
	for _, m := range members {
		st.setMember(m.UserID, perm.Role(m.Role), perm.IDStrings(m.RoleIds))
		st.setBot(m.UserID, m.IsBot)
	}
	if err := loadBoards(ctx, q, wid, st); err != nil {
		return nil, err
	}
	// Message authors of the rooms guests can view (usually a few temporary rooms).
	guestRooms := map[uuid.UUID]bool{}
	for u, m := range st.members {
		if m.Role == perm.RoleGuest {
			for _, id := range st.unloadedGuestRooms(u) {
				guestRooms[id] = true
			}
		}
	}
	if len(guestRooms) > 0 {
		ids := make([]uuid.UUID, 0, len(guestRooms))
		for id := range guestRooms {
			ids = append(ids, id)
		}
		rows, err := q.ListRoomAuthors(ctx, ids)
		if err != nil {
			return nil, err
		}
		st.loadedAuthors(ids, rows)
	}
	return st, nil
}

// bits must be called with mu held (read).
func (s *wsState) bits(roomID, userID uuid.UUID) perm.Bits {
	m, ok := s.members[userID]
	if !ok {
		return 0
	}
	if s.rooms[roomID] == nil {
		return s.taskRoomBits(roomID, userID) // a task's comment room, or nothing
	}
	t, ok := s.targets[roomID]
	if !ok {
		t = pbconv.ProtoOverrideTargets(s.rooms[roomID].GetPermissionOverrides())
	}
	return perm.ComputeIn(m, s.rooms[roomID].GetRestricted(), t)
}

func (s *wsState) canView(roomID, userID uuid.UUID) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bits(roomID, userID).Has(perm.ViewRoom)
}

// transition turns a room change for one recipient into the events that recipient should
// see: both visible → changed (the original event), gained → ROOM_CREATE, lost → ROOM_DELETE.
func transition(before, after bool, changed *v1.DispatchEvent, room *v1.Room, wid, rid uuid.UUID) *v1.DispatchEvent {
	switch {
	case before && after:
		return changed
	case !before && after:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: room}}}
	case before && !after:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomDelete{RoomDelete: &v1.RoomDelete{WorkspaceId: wid.String(), RoomId: rid.String()}}}
	}
	return nil
}

// withPermissions returns a copy of room with new overrides.
func withPermissions(room *v1.Room, ovs []*v1.RoomPermissionOverride) *v1.Room {
	c := proto.Clone(room).(*v1.Room)
	c.PermissionOverrides = ovs
	return c
}

// sanitizeVoice hides the room of a voice state the recipient cannot see (the user then
// appears not to be in voice at all).
func sanitizeVoice(vs *v1.VoiceState, visible func(uuid.UUID) bool) *v1.VoiceState {
	rid, err := uuid.Parse(vs.GetRoomId())
	if err != nil || visible(rid) {
		return vs
	}
	return &v1.VoiceState{WorkspaceId: vs.GetWorkspaceId(), UserId: vs.GetUserId()}
}
