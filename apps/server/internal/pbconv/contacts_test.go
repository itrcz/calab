package pbconv

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestContactsVisible(t *testing.T) {
	email, phone, now := "a@example.com", "+7 999", time.Now()
	person := sqlc.User{Email: &email, Phone: &phone, EmailVerifiedAt: &now}
	guest := sqlc.User{IsGuest: true}
	bot := sqlc.User{IsBot: true}
	for i, c := range []struct {
		viewer  perm.Role
		vBot    bool
		subject perm.Role
		u       sqlc.User
		want    bool
	}{
		{perm.RoleMember, false, perm.RoleMember, person, true},
		{perm.RoleOwner, false, perm.RoleAdmin, person, true},
		{perm.RoleGuest, false, perm.RoleMember, person, false}, // a guest sees no contacts
		{perm.RoleMember, false, perm.RoleGuest, person, false}, // a guest's are shown to nobody
		{perm.RoleMember, true, perm.RoleMember, person, false}, // bot API
		{"", false, perm.RoleMember, person, false},             // not a member
		{perm.RoleMember, false, "", person, false},
		{perm.RoleMember, false, perm.RoleMember, guest, false},
		{perm.RoleMember, false, perm.RoleMember, bot, false},
	} {
		if got := ContactsVisible(c.viewer, c.vBot, c.subject, c.u); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
	u := WithContacts(User(person), person)
	if u.GetEmail() != email || u.GetPhone() != phone || !u.GetEmailVerified() {
		t.Fatalf("WithContacts: %v", u)
	}
	if u := User(person); HasContactFields(u) {
		t.Fatalf("User() leaks contacts: %v", u)
	}
}

func TestStripEvent(t *testing.T) {
	full := &v1.User{Id: "u", DisplayName: "A", Email: "a@example.com", EmailVerified: true, Phone: "+1", Username: "a_nick"}
	for _, ev := range []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{User: full}}},
		{Event: &v1.DispatchEvent_WorkspaceMemberAdd{WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: &v1.WorkspaceMember{WorkspaceId: "w", User: full}}}},
		{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: &v1.WorkspaceMember{WorkspaceId: "w", User: full}}}},
	} {
		out := StripEvent(ev)
		if out == ev {
			t.Fatalf("not stripped: %v", ev)
		}
		u := out.GetUserUpdate().GetUser()
		if u == nil {
			u = out.GetWorkspaceMemberAdd().GetMember().GetUser()
		}
		if u == nil {
			u = out.GetWorkspaceMemberUpdate().GetMember().GetUser()
		}
		if HasContactFields(u) || u.GetUsername() != "a_nick" || u.GetDisplayName() != "A" {
			t.Fatalf("stripped: %v", u)
		}
	}
	if full.GetEmail() == "" {
		t.Fatal("StripEvent changed the original")
	}
	plain := &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{User: &v1.User{Id: "u"}}}}
	if StripEvent(plain) != plain {
		t.Fatal("an event without contacts is copied")
	}
}
