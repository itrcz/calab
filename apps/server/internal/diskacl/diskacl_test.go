package diskacl

import (
	"reflect"
	"testing"

	"github.com/calaba/calaba/server/internal/perm"
)

// The chain the DISK_ITEM_* events carry is the chain the gateway computes with.
func TestLevelsRoundTrip(t *testing.T) {
	chain := []perm.DiskNode{
		{OwnerID: "u1"},
		{Restricted: true, OwnerID: "u2", Overrides: []perm.OverrideTarget{
			{TargetType: "role", TargetID: "r1", Override: perm.Override{Allow: perm.DiskView | perm.DiskWrite}},
			{TargetType: "user", TargetID: "u3", Override: perm.Override{Deny: perm.DiskWrite}},
		}},
	}
	if got := FromLevels(Levels(chain)); !reflect.DeepEqual(got, chain) {
		t.Fatalf("round trip %+v", got)
	}
	if len(FromLevels(nil)) != 0 {
		t.Fatal("empty chain")
	}
}
