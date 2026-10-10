//go:build integration

package app_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0087: the billing bits live on roles, but only the workspace owner grants, revokes,
// assigns or removes them; ADMINISTRATOR and MANAGE_ROLES / MANAGE_MEMBERS do not reach them;
// bots never hold them; no bit above BILLING_MANAGE exists.
func TestBillingPermissionRoles(t *testing.T) {
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	adm := register(t, invite(t, o, wid))
	bob := register(t, invite(t, o, wid))
	base := "/api/workspaces/" + wid + "/roles"
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	admin := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN)
	if st, _ := setMemberRoles(o, wid, adm.id, admin.GetId(), member.GetId()); st != 200 {
		t.Fatalf("make admin: %d", st)
	}

	// Unknown bits above BILLING_MANAGE are refused; the admin cannot create a billing role.
	o.must(422, "POST", base, &v1.CreateRoleRequest{Name: "x", Permissions: uint64(perm.BillingManage << 1)}, nil)
	adm.must(403, "POST", base, &v1.CreateRoleRequest{Name: "Pay", Permissions: uint64(perm.BillingTopup)}, nil)
	fin := newRole(t, o, wid, "Finance", perm.BillingManage)
	if fin.GetPermissions() != uint64(perm.BillingManage) {
		t.Fatalf("finance role %v", fin)
	}
	// The admin edits the role's other bits (billing bits unchanged) but not its billing bits.
	keep := uint64(perm.BillingManage | perm.MuteMembers)
	adm.must(200, "PATCH", base+"/"+fin.GetId(), &v1.UpdateRoleRequest{Permissions: &keep}, nil)
	drop := uint64(perm.MuteMembers)
	adm.must(403, "PATCH", base+"/"+fin.GetId(), &v1.UpdateRoleRequest{Permissions: &drop}, nil)
	view := uint64(perm.BillingView | perm.ViewRoom | perm.Connect)
	adm.must(403, "PATCH", base+"/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &view}, nil)
	// Assigning / removing it: the owner only.
	if st, _ := setMemberRoles(adm, wid, bob.id, member.GetId(), fin.GetId()); st != 403 {
		t.Fatalf("admin assigns a billing role: %d", st)
	}
	if st, m := setMemberRoles(o, wid, bob.id, member.GetId(), fin.GetId()); st != 200 || len(m.GetRoleIds()) != 2 {
		t.Fatalf("owner assigns: %d %v", st, m)
	}
	if st, _ := setMemberRoles(adm, wid, bob.id, member.GetId()); st != 403 {
		t.Fatalf("admin removes a billing role: %d", st)
	}
	adm.must(403, "DELETE", base+"/"+fin.GetId(), nil, nil)
	// Bots never hold billing bits.
	b := createBot(t, o, wid, "billbot")
	if st, _ := setMemberRoles(o, wid, b.id, member.GetId(), fin.GetId()); st != 422 {
		t.Fatalf("bot with a billing role: %d", st)
	}
	// The owner deletes it (the per-route matrix of the bits is in internal/billing/http).
	o.must(204, "DELETE", base+"/"+fin.GetId(), nil, nil)
}

// ADR-0087: under a billing suspension a BILLING_TOPUP / MANAGE holder keeps the billing scope
// (to pay the debt) and nothing else; a BILLING_VIEW holder is closed like any member.
func TestBillingPermissionSuspension(t *testing.T) {
	ctx := context.Background()
	withBilling(t, newFakeSeats(), true)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	payer := register(t, invite(t, o, wid))
	viewer := register(t, invite(t, o, wid))
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	pay := newRole(t, o, wid, "Pay", perm.BillingTopup)
	look := newRole(t, o, wid, "Look", perm.BillingView)
	if st, _ := setMemberRoles(o, wid, payer.id, member.GetId(), pay.GetId()); st != 200 {
		t.Fatal(st)
	}
	if st, _ := setMemberRoles(o, wid, viewer.id, member.GetId(), look.GetId()); st != 200 {
		t.Fatal(st)
	}
	account := billingAccount(t, wid, "active", true)
	testApp.Plans.Invalidate(ctx, uuid.MustParse(wid))
	setBillingStatus(t, wid, account, "suspended")

	for _, p := range [][2]string{{"GET", "/billing"}, {"POST", "/billing/topups"}} {
		if st, e := payer.apiErrBody(p[0], "/api/workspaces/"+wid+p[1], nil); st != 501 || e.GetReason() != billing.ReasonDisabled {
			t.Fatalf("payer %s %s: %d %v", p[0], p[1], st, e)
		}
		wantBillingSuspended(t, viewer.client, p[0], "/api/workspaces/"+wid+p[1], nil)
	}
	wantBillingSuspended(t, payer.client, "GET", "/api/workspaces/"+wid+"/members", nil)
}
