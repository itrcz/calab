package workspaces

import (
	"testing"

	"github.com/calaba/calaba/server/internal/perm"
)

// TestCheckGrantDiskBits: roles carry the disk bits (ADR-0094, bits ≥ 32) like any
// workspace-level bit; billing bits stay the owner's; unknown bits are refused.
func TestCheckGrantDiskBits(t *testing.T) {
	member := perm.RoleDefaults[perm.RoleMember]
	admin := perm.NewMember("a", perm.RoleAdmin, []perm.RoleBits{{ID: "admin", Position: perm.PosAdmin, Permissions: perm.Administrator}})
	if err := checkGrant(admin, member, member|perm.DiskManage); err != nil {
		t.Fatalf("admin grants DISK_MANAGE: %v", err)
	}
	if err := checkGrant(admin, member, member&^perm.DiskWrite); err != nil {
		t.Fatalf("admin revokes DISK_WRITE: %v", err)
	}
	if err := checkGrant(admin, member, member|perm.BillingView); err == nil {
		t.Fatal("an admin must not grant billing bits")
	}
	if err := checkGrant(admin, member, member|1<<41); err == nil {
		t.Fatal("unknown bit 41 must be refused")
	}
	// A role manager without DISK_MANAGE cannot grant it; the disk bits it holds it can.
	mgr := perm.NewMember("m", perm.RoleMember, []perm.RoleBits{{ID: "member", Position: perm.PosMember, Permissions: member | perm.ManageRoles}})
	if err := checkGrant(mgr, 0, perm.DiskManage); err == nil {
		t.Fatal("cannot grant DISK_MANAGE without holding it")
	}
	if err := checkGrant(mgr, 0, perm.DiskView|perm.DiskWrite); err != nil {
		t.Fatalf("grants the disk bits it holds: %v", err)
	}
	// The same for the wiki bits (ADR-0096).
	if err := checkGrant(mgr, 0, perm.WikiManage); err == nil {
		t.Fatal("cannot grant WIKI_MANAGE without holding it")
	}
	if err := checkGrant(mgr, 0, perm.WikiView|perm.WikiWrite); err != nil {
		t.Fatalf("grants the wiki bits it holds: %v", err)
	}
	if err := checkGrant(admin, member, member|perm.WikiManage); err != nil {
		t.Fatalf("an admin grants WIKI_MANAGE: %v", err)
	}
}
