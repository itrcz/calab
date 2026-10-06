package gateway

import (
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// knockAudience is who a guest's knock on room rid reaches (ADR-0040 §3, amendment
// 2026-10-06): the author of the link the guest came by, and a decider — INVITE_GUESTS in that
// room, not a guest — who is in the room's voice right now. Nobody else: a knock is a call to
// act for the people running the room, not a workspace-wide notification. The same rule
// narrows READY (loadInto) and ROOM_ADMISSION_REQUEST (route); the client mirrors it
// (features/guests/services/admissions.ts forMe). st.mu held.
func knockAudience(st *wsState, rid, author, user uuid.UUID) bool {
	if st.role(user) == perm.RoleGuest {
		return false
	}
	if author != uuid.Nil && user == author {
		return true
	}
	return rid != uuid.Nil && st.voiceRoom[user] == rid && st.bits(rid, user).Has(perm.InviteGuests)
}

// narrowKnocks applies knockAudience to READY: guests.FillAdmissions lists every pending knock
// the user may decide; only the ones they authored the link of and those of the room they are
// in the voice of (the snapshot's voice states, filled by fillLive) stay.
func narrowKnocks(user uuid.UUID, snaps []*v1.WorkspaceSnapshot) {
	for _, snap := range snaps {
		if len(snap.Admissions) == 0 {
			continue
		}
		mine := uuid.Nil
		for _, vs := range snap.GetVoiceStates() {
			if parseID(vs.GetUserId()) == user {
				mine = parseID(vs.GetRoomId())
			}
		}
		kept := snap.Admissions[:0]
		for _, a := range snap.Admissions {
			if parseID(a.GetInviteCreatedBy()) == user || (mine != uuid.Nil && parseID(a.GetRoomId()) == mine) {
				kept = append(kept, a)
			}
		}
		snap.Admissions = kept
	}
}
