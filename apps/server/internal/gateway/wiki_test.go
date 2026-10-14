package gateway

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// ADR-0096 §8: WIKI_PAGE_* reach only members who see the page; the access chains are stripped;
// who lost the page with a change gets WIKI_PAGE_REMOVE.
func TestWikiEventsPerRecipient(t *testing.T) {
	wid := uuid.New()
	alice, bob, guest, admin, bot := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	const memberWiki = perm.WikiView | perm.WikiWrite
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember] | memberWiki},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
		"admin":  {ID: "admin", Position: perm.PosAdmin, Permissions: perm.Administrator},
	}}
	st.setMember(alice, perm.RoleMember, []string{"member"})
	st.setMember(bob, perm.RoleMember, []string{"member"})
	st.setMember(guest, perm.RoleGuest, []string{"guest"})
	st.setMember(admin, perm.RoleAdmin, []string{"admin"})
	st.setMember(bot, perm.RoleMember, []string{"member"})
	st.setBot(bot, true)
	h := &Hub{}
	page := &v1.WikiPage{Id: uuid.NewString(), WorkspaceId: wid.String(), Title: "Onboarding"}
	open := []perm.TreeNode{{OwnerID: alice.String()}}
	closed := []perm.TreeNode{{Restricted: true, OwnerID: alice.String(), Overrides: []perm.OverrideTarget{
		{TargetType: "user", TargetID: guest.String(), Override: perm.Override{Allow: perm.WikiView}}}}}

	myBits := map[uuid.UUID]perm.Bits{}
	deliver := func(ev *v1.DispatchEvent) map[uuid.UUID]string {
		sessions := []*Session{{user: alice}, {user: bob}, {user: guest}, {user: admin}, {user: bot}}
		if !h.routeWiki(st, wid, uuid.New(), sessions, ev) {
			t.Fatal("a wiki event not taken")
		}
		out := map[uuid.UUID]string{}
		for _, s := range sessions {
			for _, p := range s.pending {
				switch x := p.enc.ev.GetEvent().(type) {
				case *v1.DispatchEvent_WikiPageUpsert:
					if len(x.WikiPageUpsert.GetAccess()) > 0 || len(x.WikiPageUpsert.GetAccessBefore()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "U"
					myBits[s.user] = perm.Bits(x.WikiPageUpsert.GetPage().GetMyBits())
				case *v1.DispatchEvent_WikiPageRemove:
					if len(x.WikiPageRemove.GetAccess()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "R"
				}
			}
		}
		return out
	}
	upsert := func(after, before []perm.TreeNode) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageUpsert{WikiPageUpsert: &v1.WikiPageUpsert{
			WorkspaceId: wid.String(), Page: page, Access: wikiacl.Levels(after), AccessBefore: wikiacl.Levels(before)}}}
	}
	names := map[uuid.UUID]string{alice: "alice", bob: "bob", guest: "guest", admin: "admin", bot: "bot"}
	check := func(name string, got, want map[uuid.UUID]string) {
		t.Helper()
		for u, n := range names {
			if got[u] != want[u] {
				t.Errorf("%s: %s got %q, want %q", name, n, got[u], want[u])
			}
		}
	}
	check("open page", deliver(upsert(open, nil)), map[uuid.UUID]string{alice: "U", bob: "U", admin: "U", bot: "U"}) // a bot is a member like bob (addendum 2026-10-14)
	// my_bits is the recipient's own: an administrator manages, a member with WIKI_WRITE does not.
	if myBits[admin]&perm.WikiManage == 0 || myBits[bob]&perm.WikiManage != 0 || myBits[bob]&perm.WikiWrite == 0 || myBits[bob]&perm.WikiView == 0 {
		t.Errorf("my_bits per recipient: admin %b, bob %b", myBits[admin], myBits[bob])
	}
	check("restricted: bob loses it, the guest gains it", deliver(upsert(closed, open)),
		map[uuid.UUID]string{alice: "U", bob: "R", guest: "U", admin: "U", bot: "R"})
	check("deleted forever", deliver(&v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageRemove{WikiPageRemove: &v1.WikiPageRemove{
		WorkspaceId: wid.String(), PageId: page.GetId(), Access: wikiacl.Levels(closed)}}}),
		map[uuid.UUID]string{alice: "R", guest: "R", admin: "R"})
	if h.routeWiki(st, wid, uuid.New(), nil, &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{}}) {
		t.Fatal("a board event taken as a wiki event")
	}
}
