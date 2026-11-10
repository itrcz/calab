//go:build integration

package app_test

import (
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
)

// memberRoleIDs returns the role ids of userID in wsID as u sees them.
func memberRoleIDs(t *testing.T, u *user, wsID, userID string) []string {
	t.Helper()
	var r v1.GetMemberResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/members/"+userID, nil, &r)
	return r.GetMember().GetRoleIds()
}

// CBF-174 (ADR-0026 addendum 2026-11-10): invitations carry custom roles. Made with the rules of
// assigning them; given on every way of joining (sign-up by a link, joining by a link, an email
// invitation accepted by its code or by confirming the address, adding an account); a role
// deleted meanwhile is skipped.
func TestInviteRoles(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid
	code := invite(t, o, wid)
	adm, mgr, inviter := register(t, code), register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", base+"/members/"+adm.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	// Created first = highest custom role: high > mgr > inviters > team > gone.
	high := newRole(t, o, wid, "high", 0)
	mgrRole := newRole(t, o, wid, "mgr", perm.ManageRoles|perm.InviteMembers)
	inviters := newRole(t, o, wid, "inviters", perm.InviteMembers)
	team, gone := newRole(t, o, wid, "team", 0), newRole(t, o, wid, "gone", 0)
	fin := newRole(t, o, wid, "fin", perm.BillingView)
	for u, r := range map[*user]string{mgr: mgrRole.GetId(), inviter: inviters.GetId()} {
		if st, _ := setMemberRoles(o, wid, u.id, r); st != 200 {
			t.Fatalf("assign: %d", st)
		}
	}
	link := func(u *user, ids ...string) (int, *v1.Invite) {
		var r v1.CreateInviteResponse
		st := u.do("POST", base+"/invites", &v1.CreateInviteRequest{MaxUses: 10, RoleIds: ids}, &r)
		return st, r.GetInvite()
	}
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER).GetId()
	for name, c := range map[string]struct {
		u   *user
		ids []string
		st  int
	}{
		"no right to assign":     {inviter, []string{team.GetId()}, 403},
		"above the inviter":      {mgr, []string{high.GetId()}, 403},
		"the inviter's own role": {mgr, []string{mgrRole.GetId()}, 403},
		"built-in":               {mgr, []string{member}, 422},
		"unknown":                {mgr, []string{"01890000-0000-7000-8000-00000000abcd"}, 422},
		"billing by an admin":    {adm, []string{fin.GetId()}, 403},
		"plain link, no right":   {inviter, nil, 201},
		"below the inviter":      {mgr, []string{team.GetId(), team.GetId()}, 201},
		"billing by the owner":   {o, []string{fin.GetId()}, 201},
		"admin, any custom role": {adm, []string{high.GetId()}, 201},
	} {
		if st, _ := link(c.u, c.ids...); st != c.st {
			t.Errorf("link %s: %d, want %d", name, st, c.st)
		}
	}

	// Sign-up by a link with roles: the roles come with the membership (and its event).
	st, inv := link(mgr, team.GetId())
	if st != 201 || !slices.Equal(inv.GetRoleIds(), []string{team.GetId()}) {
		t.Fatalf("link with team: %d %v", st, inv.GetRoleIds())
	}
	var listed v1.ListInvitesResponse
	mgr.must(200, "GET", base+"/invites", nil, &listed)
	if i := slices.IndexFunc(listed.GetInvites(), func(x *v1.Invite) bool { return x.GetId() == inv.GetId() }); i < 0 || len(listed.GetInvites()[i].GetRoleIds()) != 1 {
		t.Fatalf("listed link: %v", listed.GetInvites())
	}
	newbie := register(t, inv.GetCode())
	if ids := memberRoleIDs(t, o, wid, newbie.id); !slices.Contains(ids, team.GetId()) || !slices.Contains(ids, member) {
		t.Fatalf("signed up by the link: roles %v", ids)
	}

	// Joining by a link with an existing account; a role deleted meanwhile is skipped.
	st, inv = link(adm, team.GetId(), gone.GetId())
	if st != 201 {
		t.Fatalf("link: %d", st)
	}
	o.must(204, "DELETE", base+"/roles/"+gone.GetId(), nil, nil)
	elsewhere := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, elsewhere.GetId()))
	outsider.must(200, "POST", "/api/invites/"+inv.GetCode()+"/join", nil, nil)
	if ids := memberRoleIDs(t, o, wid, outsider.id); len(ids) != 2 || !slices.Contains(ids, team.GetId()) {
		t.Fatalf("joined by the link: roles %v", ids)
	}

	// An email invitation: listed with its roles; an account joins by the mailed code.
	invitee := register(t, invite(t, o, elsewhere.GetId()))
	var ei v1.CreateEmailInviteResponse
	if st := inviter.do("POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: invitee.email, RoleIds: []string{team.GetId()}}, nil); st != 403 {
		t.Fatalf("email invitation with roles, no right: %d", st)
	}
	mgr.must(201, "POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: invitee.email, RoleIds: []string{team.GetId()}}, &ei)
	if !slices.Equal(ei.GetInvite().GetRoleIds(), []string{team.GetId()}) {
		t.Fatalf("email invitation roles: %v", ei.GetInvite().GetRoleIds())
	}
	var el v1.ListEmailInvitesResponse
	mgr.must(200, "GET", base+"/invites/email", nil, &el)
	if len(el.GetInvites()) != 1 || !slices.Equal(el.GetInvites()[0].GetRoleIds(), []string{team.GetId()}) {
		t.Fatalf("listed email invitation: %v", el.GetInvites())
	}
	m := nthMail(t, 1, mail.TemplateWorkspaceInvite, invitee.email)
	mailed := m.Params["url"][strings.LastIndex(m.Params["url"], "/")+1:]
	invitee.must(200, "POST", "/api/invites/"+mailed+"/join", nil, nil)
	if ids := memberRoleIDs(t, o, wid, invitee.id); !slices.Contains(ids, team.GetId()) {
		t.Fatalf("joined by the emailed code: roles %v", ids)
	}

	// An email invitation accepted by confirming the address (sign-up with its code).
	addr := uniq("roles") + "@example.com"
	adm.must(201, "POST", base+"/invites/email", &v1.CreateEmailInviteRequest{Email: addr, RoleIds: []string{high.GetId()}}, nil)
	m = nthMail(t, 1, mail.TemplateWorkspaceInvite, addr)
	fresh, _ := registerRaw(t, addr, m.Params["url"][strings.LastIndex(m.Params["url"], "/")+1:], "")
	fresh.email = addr
	if ids := verifyAddr(t, fresh).GetJoinedWorkspaceIds(); len(ids) != 1 || ids[0] != wid {
		t.Fatalf("joined on confirming: %v", ids)
	}
	if ids := memberRoleIDs(t, o, wid, fresh.id); !slices.Contains(ids, high.GetId()) {
		t.Fatalf("joined on confirming: roles %v", ids)
	}

	// Adding an account at once.
	added := register(t, invite(t, o, elsewhere.GetId()))
	if st := mgr.do("POST", base+"/members", &v1.AddMemberRequest{UserId: added.id, RoleIds: []string{high.GetId()}}, nil); st != 403 {
		t.Fatalf("add with a role above the inviter: %d", st)
	}
	var am v1.AddMemberResponse
	mgr.must(201, "POST", base+"/members", &v1.AddMemberRequest{UserId: added.id, RoleIds: []string{team.GetId()}}, &am)
	if !slices.Contains(am.GetMember().GetRoleIds(), team.GetId()) {
		t.Fatalf("added: roles %v", am.GetMember().GetRoleIds())
	}

	// A standing link is a delegated grant, re-checked against its author's current roles on
	// every join: demoted (no right to assign any more) — nobody gets the role; departed — the
	// same; the author rejoining by their own link gets nothing either.
	st, byMgr := link(mgr, team.GetId())
	if st != 201 {
		t.Fatalf("link by mgr: %d", st)
	}
	if st, _ := setMemberRoles(o, wid, mgr.id); st != 200 {
		t.Fatalf("demote mgr: %d", st)
	}
	demoted := register(t, byMgr.GetCode())
	if ids := memberRoleIDs(t, o, wid, demoted.id); slices.Contains(ids, team.GetId()) {
		t.Fatalf("link of a demoted author gives its role: %v", ids)
	}
	st, byAdm := link(adm, team.GetId())
	if st != 201 {
		t.Fatalf("link by adm: %d", st)
	}
	adm.must(204, "DELETE", base+"/members/"+adm.id, nil, nil)
	departed := register(t, byAdm.GetCode())
	if ids := memberRoleIDs(t, o, wid, departed.id); slices.Contains(ids, team.GetId()) {
		t.Fatalf("link of a departed author gives its role: %v", ids)
	}
	adm.must(200, "POST", "/api/invites/"+byAdm.GetCode()+"/join", nil, nil)
	if ids := memberRoleIDs(t, o, wid, adm.id); slices.Contains(ids, team.GetId()) {
		t.Fatalf("author rejoining by their own link gets its role: %v", ids)
	}
}
