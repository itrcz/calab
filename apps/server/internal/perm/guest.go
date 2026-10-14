package perm

import "github.com/google/uuid"

// GuestRoom is a room as GuestVisible needs it.
type GuestRoom struct {
	ID        uuid.UUID
	Flags     RoomFlags // Flags.CreatedBy: uuid.Nil when not recorded
	Overrides []OverrideTarget
}

// GuestVisible returns the members a guest may see (ADR-0016, amended 2026-10-02): itself and,
// in every room the guest can view, that room's people — members invited by name (a user
// override, e.g. through a room link) or its creator, while they can view it; whoever is in its
// call now (voice: user -> room); and the authors of its messages (authors: room -> users).
// Being able to view a room is not enough: a public room (and a public temporary room) is open
// to every member, and the guest must not get the whole directory through it. Only ids present
// in members are returned (besides the guest itself).
func GuestVisible(guest uuid.UUID, members map[uuid.UUID]Member, rooms []GuestRoom,
	voice map[uuid.UUID]uuid.UUID, authors map[uuid.UUID]map[uuid.UUID]bool) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{guest: true}
	me, ok := members[guest]
	if !ok {
		return out
	}
	mine := map[uuid.UUID]bool{}
	for i := range rooms {
		r := &rooms[i]
		if !ComputeIn(me, r.Flags, r.Overrides).Has(ViewRoom) {
			continue
		}
		mine[r.ID] = true
		viewer := func(u uuid.UUID) {
			if m, ok := members[u]; ok && !out[u] && ComputeIn(m, r.Flags, r.Overrides).Has(ViewRoom) {
				out[u] = true
			}
		}
		for _, t := range r.Overrides {
			if t.TargetType == "user" {
				if u, err := uuid.Parse(t.TargetID); err == nil {
					viewer(u)
				}
			}
		}
		if r.Flags.CreatedBy != uuid.Nil {
			viewer(r.Flags.CreatedBy)
		}
		for u := range authors[r.ID] {
			if _, ok := members[u]; ok {
				out[u] = true
			}
		}
	}
	for u, rid := range voice {
		if _, ok := members[u]; ok && mine[rid] {
			out[u] = true
		}
	}
	return out
}

// GuestRoomIDs returns the ids of the rooms the guest can view (the rooms whose authors
// GuestVisible needs).
func GuestRoomIDs(guest Member, rooms []GuestRoom) []uuid.UUID {
	var out []uuid.UUID
	for i := range rooms {
		if ComputeIn(guest, rooms[i].Flags, rooms[i].Overrides).Has(ViewRoom) {
			out = append(out, rooms[i].ID)
		}
	}
	return out
}
