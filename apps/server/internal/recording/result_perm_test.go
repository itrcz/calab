package recording

import (
	"testing"

	"github.com/calaba/calaba/server/internal/perm"
)

func TestMayDeleteOthers(t *testing.T) {
	member := perm.RoleDefaults[perm.RoleMember]
	admin := perm.NewMember("a", perm.RoleAdmin, []perm.RoleBits{{ID: "m", Position: perm.PosMember, Permissions: member}, {ID: "a", Position: perm.PosAdmin, Permissions: perm.Administrator}})
	owner := perm.NewMember("o", perm.RoleOwner, []perm.RoleBits{{ID: "m", Position: perm.PosMember, Permissions: member}, {ID: "o", Position: perm.PosOwner, Permissions: perm.Administrator}})
	rec := perm.NewMember("r", perm.RoleMember, []perm.RoleBits{{ID: "m", Position: perm.PosMember, Permissions: member}, {ID: "r", Position: perm.PosCustom, Permissions: perm.ManageRecordings}})
	plain := perm.NewMember("p", perm.RoleMember, []perm.RoleBits{{ID: "m", Position: perm.PosMember, Permissions: member}})
	guest := perm.NewMember("g", perm.RoleGuest, []perm.RoleBits{{ID: "g", Position: perm.PosGuest, Permissions: perm.ManageRecordings}})
	for _, c := range []struct {
		name string
		acc  perm.RoomAccess
		want bool
	}{
		{"owner, ordinary room", perm.RoomAccess{Role: perm.RoleOwner, Member: owner, Bits: perm.All}, true},
		{"MANAGE_RECORDINGS role, ordinary room", perm.RoomAccess{Role: perm.RoleMember, Member: rec, Bits: member}, true},
		{"plain member", perm.RoomAccess{Role: perm.RoleMember, Member: plain, Bits: member}, false},
		{"guest with the bit", perm.RoomAccess{Role: perm.RoleGuest, Member: guest, Bits: perm.ViewRoom}, false},
		{"MANAGE_MESSAGES in the room", perm.RoomAccess{Role: perm.RoleMember, Member: plain, Bits: member | perm.ManageMessages}, true},
		// ADR-0078: a chosen owner / admin counts as a member in a private temporary room.
		{"owner chosen into a private temp room", perm.RoomAccess{Role: perm.RoleOwner, Member: owner, Bits: member, PrivateTemp: true}, false},
		{"admin chosen into a private temp room", perm.RoomAccess{Role: perm.RoleAdmin, Member: admin, Bits: member, PrivateTemp: true}, false},
		{"MANAGE_RECORDINGS role in a private temp room", perm.RoomAccess{Role: perm.RoleMember, Member: rec, Bits: member, PrivateTemp: true}, false},
		{"MANAGE_MESSAGES in a private temp room", perm.RoomAccess{Role: perm.RoleMember, Member: plain, Bits: member | perm.ManageMessages, PrivateTemp: true}, true},
	} {
		if got := mayDeleteOthers(c.acc); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
