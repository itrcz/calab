package gateway

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0094 §7: DISK_ITEM_* reach only members who see the item; the access chains are stripped;
// who lost the item with a change gets DISK_ITEM_REMOVE.
func TestDiskEventsPerRecipient(t *testing.T) {
	wid := uuid.New()
	alice, bob, guest, admin, bot := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	const memberDisk = perm.DiskView | perm.DiskWrite
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember] | memberDisk},
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
	item := &v1.DiskItem{Id: uuid.NewString(), WorkspaceId: wid.String(), Name: "Plan.pdf"}
	open := []perm.DiskNode{{OwnerID: alice.String()}}
	// Restricted, shared with the guest by name.
	closed := []perm.DiskNode{{Restricted: true, OwnerID: alice.String(), Overrides: []perm.OverrideTarget{
		{TargetType: "user", TargetID: guest.String(), Override: perm.Override{Allow: perm.DiskView}}}}}

	deliver := func(ev *v1.DispatchEvent) map[uuid.UUID]string {
		sessions := []*Session{{user: alice}, {user: bob}, {user: guest}, {user: admin}, {user: bot}}
		h.routeDisk(st, wid, uuid.New(), sessions, ev)
		out := map[uuid.UUID]string{}
		for _, s := range sessions {
			for _, p := range s.pending {
				switch x := p.enc.ev.GetEvent().(type) {
				case *v1.DispatchEvent_DiskItemUpsert:
					if len(x.DiskItemUpsert.GetAccess()) > 0 || len(x.DiskItemUpsert.GetAccessBefore()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "U"
				case *v1.DispatchEvent_DiskItemRemove:
					if len(x.DiskItemRemove.GetAccess()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "R"
				}
			}
		}
		return out
	}
	upsert := func(after, before []perm.DiskNode) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemUpsert{DiskItemUpsert: &v1.DiskItemUpsert{
			WorkspaceId: wid.String(), Item: item, Access: diskacl.Levels(after), AccessBefore: diskacl.Levels(before)}}}
	}
	check := func(name string, got map[uuid.UUID]string, want map[uuid.UUID]string) {
		t.Helper()
		for _, u := range []uuid.UUID{alice, bob, guest, admin, bot} {
			if got[u] != want[u] {
				t.Errorf("%s: %s got %q, want %q", name, map[uuid.UUID]string{alice: "alice", bob: "bob", guest: "guest", admin: "admin", bot: "bot"}[u], got[u], want[u])
			}
		}
	}
	check("open item", deliver(upsert(open, nil)), map[uuid.UUID]string{alice: "U", bob: "U", admin: "U", bot: "U"}) // a bot is a member like bob (addendum 2026-10-14)
	check("restricted: bob loses it, the guest gains it", deliver(upsert(closed, open)),
		map[uuid.UUID]string{alice: "U", bob: "R", guest: "U", admin: "U", bot: "R"})
	check("deleted forever", deliver(&v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemRemove{DiskItemRemove: &v1.DiskItemRemove{
		WorkspaceId: wid.String(), ItemId: item.GetId(), Access: diskacl.Levels(closed)}}}),
		map[uuid.UUID]string{alice: "R", guest: "R", admin: "R"})
	if h.routeDisk(st, wid, uuid.New(), nil, &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{}}) {
		t.Fatal("a board event taken as a disk event")
	}
}
