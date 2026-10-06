package rooms

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// VoiceRooms returns who is in a call of the workspace and in which room (user -> room).
type VoiceRooms func(ctx context.Context, wsID uuid.UUID) (map[uuid.UUID]uuid.UUID, error)

// GuestVisibleUsers is what a guest may see of a workspace: perm.GuestVisible over Postgres
// (rooms, overrides, message authors of the guest's rooms) and voice, which may be nil.
func GuestVisibleUsers(ctx context.Context, q *sqlc.Queries, voice VoiceRooms, wsID, guest uuid.UUID) (map[uuid.UUID]bool, error) {
	members, err := perm.LoadMembers(ctx, q, wsID)
	if err != nil {
		return nil, err
	}
	me, ok := members[guest]
	if !ok {
		return map[uuid.UUID]bool{guest: true}, nil
	}
	ovRows, err := q.ListWorkspaceRoomOverrides(ctx, wsID)
	if err != nil {
		return nil, err
	}
	byRoom := map[uuid.UUID][]perm.OverrideTarget{}
	for _, o := range ovRows {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], pbconv.OverrideTargets([]sqlc.RoomPermission{o})...)
	}
	rs, err := q.ListRooms(ctx, wsID)
	if err != nil {
		return nil, err
	}
	rooms := make([]perm.GuestRoom, 0, len(rs))
	for _, r := range rs {
		rooms = append(rooms, perm.GuestRoom{ID: r.ID, Flags: perm.FlagsOf(r), Overrides: byRoom[r.ID]})
	}
	var authors map[uuid.UUID]map[uuid.UUID]bool
	if ids := perm.GuestRoomIDs(me, rooms); len(ids) > 0 {
		rows, err := q.ListRoomAuthors(ctx, ids)
		if err != nil {
			return nil, err
		}
		authors = map[uuid.UUID]map[uuid.UUID]bool{}
		for _, a := range rows {
			if authors[a.RoomID] == nil {
				authors[a.RoomID] = map[uuid.UUID]bool{}
			}
			authors[a.RoomID][a.AuthorID] = true
		}
	}
	var inVoice map[uuid.UUID]uuid.UUID
	if voice != nil {
		if inVoice, err = voice(ctx, wsID); err != nil {
			return nil, err
		}
	}
	return perm.GuestVisible(guest, members, rooms, inVoice, authors), nil
}
