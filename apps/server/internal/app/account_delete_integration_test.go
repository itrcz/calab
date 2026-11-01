//go:build integration

package app_test

import (
	"context"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// ADR-0153: POST /api/me/delete — re-authentication, the sole-owner block, revocation of every
// session and socket, the anonymous tombstone other members see, re-registration.
func TestAccountDeletion(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	code := invite(t, o, ws.GetId())
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "chat"}, &tr)
	room := tr.GetRoom().GetId()
	msg := send(t, bob, room, "hello from bob", uniq("n"))
	// An avatar may be any image bob uploaded, here one attached to his message: deleting the
	// account must not take the attachment away from the room.
	st, pic, _ := upload(t, bob, "/api/workspaces/"+ws.GetId()+"/files", "pic.png", pngBytes(64, 64))
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	var withPic v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "pic", AttachmentIds: []string{pic.GetId()}, Nonce: uniq("n")}, &withPic)
	avatar := pic.GetId()
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{AvatarFileId: &avatar}, nil)
	var note v1.CreateNotesResponse
	bob.must(201, "POST", "/api/notes", &v1.CreateNotesRequest{Name: "Мои"}, &note)

	// A second device of bob and his socket: both die with the deletion.
	second := &client{t: t, ip: "10.153.0.1"}
	var l v1.LoginResponse
	second.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: bob.email, Password: "password123"}, &l)
	second.token = l.GetTokens().GetAccessToken()
	bg := dialGW(t)
	bg.identify(bob.token)
	og := dialGW(t)
	og.identify(o.token)

	// No token: 401. Re-authentication: the password is required and must be right.
	(&client{t: t, ip: "10.153.0.2"}).must(401, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "password123"}, nil)
	bob.must(422, "POST", "/api/me/delete", &v1.DeleteAccountRequest{}, nil)
	bob.must(403, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "wrong-pass"}, nil)
	bob.must(200, "GET", "/api/me", nil, nil) // a wrong password signs nobody out

	// Another user's password does not delete anyone: carol (other password) cannot use bob's.
	carol := register(t, code)
	carol.must(204, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "password123", NewPassword: "carol-pass-1"}, nil)
	carol.must(403, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "password123"}, nil)
	carol.must(200, "GET", "/api/me", nil, nil)
	bob.must(200, "GET", "/api/me", nil, nil)

	// The owner of a workspace is refused until the workspace is gone.
	own := createWorkspace(t, bob, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(409, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "password123"}, nil)
	var apiErr v1.ApiError
	if err := protojson.Unmarshal(bob.lastBody, &apiErr); err != nil || apiErr.GetReason() != "OWNS_WORKSPACES" {
		t.Fatalf("owner refusal: %s", bob.lastBody)
	}
	bob.must(204, "DELETE", "/api/workspaces/"+own.GetId(), nil, nil)

	bob.must(204, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "password123"}, nil)

	// Every session ends at once: this one, the other device, the socket (4010).
	bob.must(401, "GET", "/api/me", nil, nil)
	second.must(401, "GET", "/api/me", nil, nil)
	// 4010; or 4000 (resync) when a membership's identity invalidation wins the race — the
	// socket's next IDENTIFY is refused with 4010 either way.
	if st := bg.closeStatus(); st != 4010 && st != 4000 {
		t.Fatalf("socket of the deleted account: close %d, want 4010", st)
	}
	bg = dialGW(t)
	bg.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: bob.token}}})
	if st := bg.closeStatus(); st != 4010 {
		t.Fatalf("IDENTIFY of the deleted account: close %d, want 4010", st)
	}
	(&client{t: t, ip: "10.153.0.3"}).must(401, "POST", "/api/auth/login", &v1.LoginRequest{Email: bob.email, Password: "password123"}, nil)

	// Other members keep the message, by an anonymous author, and see the change live.
	og.wait("USER_UPDATE tombstone", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == bob.id && u.GetDisplayName() == "Удалённый пользователь" && u.GetAvatarFileId() == ""
	})
	og.wait("WORKSPACE_MEMBER_REMOVE account_deleted", func(e *v1.DispatchEvent) bool {
		rm := e.GetWorkspaceMemberRemove()
		return rm.GetUserId() == bob.id && rm.GetFormer().GetReason() == v1.FormerMemberReason_FORMER_MEMBER_REASON_ACCOUNT_DELETED
	})
	var hist v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+room+"/messages", nil, &hist)
	found, attached := false, false
	for _, m := range hist.GetMessages() {
		if m.GetId() == msg.GetId() {
			found = m.GetAuthorId() == bob.id && m.GetContent() == "hello from bob"
		}
		if m.GetId() == withPic.GetMessage().GetId() {
			attached = len(m.GetAttachments()) == 1 && m.GetAttachments()[0].GetId() == pic.GetId()
		}
	}
	if !found || !attached {
		t.Fatalf("bob's history in the room: message %v, attachment that was his avatar %v", found, attached)
	}
	var refs v1.ListWorkspaceUsersResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/users?ids="+bob.id, nil, &refs)
	if len(refs.GetUsers()) != 1 || refs.GetUsers()[0].GetDisplayName() != "Удалённый пользователь" || !refs.GetUsers()[0].GetFormer() ||
		refs.GetUsers()[0].GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_ACCOUNT_DELETED || refs.GetUsers()[0].GetUsername() != "" {
		t.Fatalf("tombstone ref: %v", refs.GetUsers())
	}

	// Nothing personal is left in the row; the personal shelf is gone; sessions hold no device data.
	var email, pass *string
	var deleted bool
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT email, password_hash, deleted_at IS NOT NULL AND disabled_at IS NOT NULL FROM users WHERE id = $1`, bob.id).Scan(&email, &pass, &deleted); err != nil {
		t.Fatal(err)
	}
	if email != nil || pass != nil || !deleted {
		t.Fatalf("tombstone row: email %v password %v deleted %v", email, pass, deleted)
	}
	var shelves, ua int
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM rooms WHERE id = $1), (SELECT count(*) FROM sessions WHERE user_id = $2 AND (ip <> '' OR user_agent <> ''))`, note.GetShelf().GetRoom().GetId(), bob.id).Scan(&shelves, &ua); err != nil {
		t.Fatal(err)
	}
	if shelves != 0 || ua != 0 {
		t.Fatalf("left over: shelves %d, sessions with device data %d", shelves, ua)
	}

	// The address is free again: a new, unrelated account.
	again := &client{t: t, ip: "10.153.0.4"}
	var rr v1.RegisterResponse
	again.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{Email: bob.email, Password: "password456", DisplayName: "Bob again", InviteCode: code, DeviceName: "test"}, &rr)
	if rr.GetMe().GetUser().GetId() == bob.id {
		t.Fatal("re-registration revived the deleted account")
	}

	// Guests have no password and are not deleted this way (they expire, ADR-0098).
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.153.0.5"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.153.0.6"}
	guest.must(403, "POST", "/api/me/delete", &v1.DeleteAccountRequest{CurrentPassword: "x"}, nil)
}
