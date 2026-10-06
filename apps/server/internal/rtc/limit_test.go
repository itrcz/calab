package rtc

import (
	"testing"

	"github.com/calaba/calaba/server/internal/perm"
)

func TestLimitExempt(t *testing.T) {
	for _, c := range []struct {
		name string
		acc  perm.RoomAccess
		want bool
	}{
		{"owner", perm.RoomAccess{Role: perm.RoleOwner}, true},
		{"admin", perm.RoomAccess{Role: perm.RoleAdmin}, false},
		{"member", perm.RoomAccess{Role: perm.RoleMember}, false},
		{"owner in a private temp room (ADR-0078)", perm.RoomAccess{Role: perm.RoleOwner, PrivateTemp: true}, false},
		{"owner in a restricted room", perm.RoomAccess{Role: perm.RoleOwner, Restricted: true}, true},
	} {
		if got := limitExempt(c.acc); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	room := wsRoom{}
	room.UserLimit = 2
	if a := admissionFor(room, limitExempt(perm.RoomAccess{Role: perm.RoleOwner, PrivateTemp: true})); a.room != 2 {
		t.Fatalf("owner in a private temp room skips user_limit: %+v", a)
	}
}
