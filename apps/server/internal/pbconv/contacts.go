package pbconv

import (
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Contacts (ADR-0077): User.email / email_verified / phone. User() never fills them; a path
// that may show them to a viewer calls WithContacts only after ContactsVisible (or, for
// workspace events, publishes them and lets the gateway strip them per recipient —
// gateway.contactsHidden). Bot API payloads and webhooks never carry them (StripEvent).

// HasContacts reports whether an account has contacts at all: people only — guest accounts
// have no email, bots have none.
func HasContacts(u sqlc.User) bool {
	return !u.IsGuest && !u.IsBot && u.Email != nil
}

// WithContacts fills out's contact fields from u (nothing for guests and bots) and returns out.
// The shown address is never trusted for authentication or invitations (ADR-0065).
func WithContacts(out *v1.User, u sqlc.User) *v1.User {
	if out == nil || !HasContacts(u) {
		return out
	}
	out.Email = *u.Email
	out.EmailVerified = u.EmailVerifiedAt != nil
	out.Phone = deref(u.Phone)
	return out
}

// ContactsVisible is the one rule of who sees a member's contacts within a workspace: both
// the viewer and the subject are members there and neither is a guest, the viewer is not a
// bot (bot API), the subject has contacts. viewerRole / subjectRole are the highest built-in
// roles in that workspace ("" = not a member).
func ContactsVisible(viewerRole perm.Role, viewerBot bool, subjectRole perm.Role, subject sqlc.User) bool {
	return !viewerBot && memberRole(viewerRole) && memberRole(subjectRole) && HasContacts(subject)
}

func memberRole(r perm.Role) bool { return r != "" && r != perm.RoleGuest }

// MemberFor converts a membership row as the viewer sees it: with contacts when
// ContactsVisible.
func MemberFor(m sqlc.WorkspaceMember, u sqlc.User, roleIDs []uuid.UUID, viewerRole perm.Role, viewerBot bool) *v1.WorkspaceMember {
	out := Member(m, u, roleIDs)
	if ContactsVisible(viewerRole, viewerBot, perm.Role(m.Role), u) {
		WithContacts(out.User, u)
	}
	return out
}

// MemberEvent converts a membership row for WORKSPACE_MEMBER_ADD / _UPDATE: with contacts when
// the member is not a guest there. Only for workspace events — the gateway strips them for
// the recipients that may not see them.
func MemberEvent(m sqlc.WorkspaceMember, u sqlc.User, roleIDs []uuid.UUID) *v1.WorkspaceMember {
	out := Member(m, u, roleIDs)
	if memberRole(perm.Role(m.Role)) {
		WithContacts(out.User, u)
	}
	return out
}

// UserEvent is the public User with contacts for USER_UPDATE to the user's workspaces (the
// gateway strips them per workspace and recipient).
func UserEvent(u sqlc.User) *v1.User { return WithContacts(User(u), u) }

// HasContactFields reports whether a wire User carries any contact field.
func HasContactFields(u *v1.User) bool {
	return u.GetEmail() != "" || u.GetPhone() != "" || u.GetEmailVerified()
}

// StripUser returns u without contact fields (a copy when it had any).
func StripUser(u *v1.User) *v1.User {
	if !HasContactFields(u) {
		return u
	}
	c := proto.CloneOf(u)
	c.Email, c.EmailVerified, c.Phone = "", false, ""
	return c
}

// StripEvent returns ev without the contacts of the users it carries (USER_UPDATE.user,
// WORKSPACE_MEMBER_ADD / _UPDATE.member.user) — a copy when there were any.
func StripEvent(ev *v1.DispatchEvent) *v1.DispatchEvent {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_UserUpdate:
		if u := e.UserUpdate.GetUser(); HasContactFields(u) {
			c := proto.CloneOf(e.UserUpdate)
			c.User = StripUser(u)
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: c}}
		}
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		if m := e.WorkspaceMemberAdd.GetMember(); HasContactFields(m.GetUser()) {
			c := proto.CloneOf(e.WorkspaceMemberAdd)
			c.Member.User = StripUser(m.GetUser())
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{WorkspaceMemberAdd: c}}
		}
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		if m := e.WorkspaceMemberUpdate.GetMember(); HasContactFields(m.GetUser()) {
			c := proto.CloneOf(e.WorkspaceMemberUpdate)
			c.Member.User = StripUser(m.GetUser())
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: c}}
		}
	}
	return ev
}
