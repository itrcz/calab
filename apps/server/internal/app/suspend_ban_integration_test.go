//go:build integration

package app_test

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Workspace suspension and bans (backlog item 32).

const errSuspended = v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED

// liveKitReachable is liveKitUp without skipping: the voice part of a test is optional.
func liveKitReachable() bool {
	d := net.Dialer{Timeout: time.Second}
	c, err := d.DialContext(context.Background(), "tcp", strings.TrimPrefix(testCfg.LiveKitInternalURL, "http://"))
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func suspend(t *testing.T, wsID string, on bool, reason string) *v1.AdminWorkspace {
	t.Helper()
	var r v1.AdminSetSuspensionResponse
	superadminUser(t).must(200, "PUT", "/api/admin/workspaces/"+wsID+"/suspension", &v1.AdminSetSuspensionRequest{Suspended: on, Reason: reason}, &r)
	return r.GetWorkspace()
}

// workspaceStateOrResync waits on g for a WORKSPACE_UPDATE of ws matching pred and returns
// that workspace. A suspension change also bumps the workspace identity policy; its notice
// reaches the gateway through the outbox up to a second later. An event admitted under the
// old lease and written after the notice lands is re-checked at emit/write time and the
// gateway fails closed with 4000 "identity resync required" (by design: it cannot re-check
// durable access without a DB round trip there). The client then IDENTIFYs again and takes
// the state from READY, and so does the test: it returns the new connection and the READY
// snapshot of ws, which must match pred as well.
func workspaceStateOrResync(t *testing.T, g *gw, token, ws, what string, pred func(*v1.Workspace) bool) (*gw, *v1.Workspace) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := g.read(time.Until(deadline))
		var ce websocket.CloseError
		if errors.As(err, &ce) && ce.Code == 4000 && strings.HasSuffix(ce.Reason, "resync required") {
			fresh := dialGW(t)
			for _, s := range fresh.identify(token).GetWorkspaces() {
				if s.GetWorkspace().GetId() == ws {
					if !pred(s.GetWorkspace()) {
						t.Fatalf("%s: READY after %q: %v", what, ce.Reason, s.GetWorkspace())
					}
					return fresh, s.GetWorkspace()
				}
			}
			t.Fatalf("%s: workspace missing from READY after %q", what, ce.Reason)
		}
		if err != nil {
			t.Fatalf("waiting for %s: %v", what, err)
		}
		if w := f.GetDispatch().GetWorkspaceUpdate().GetWorkspace(); w.GetId() == ws && pred(w) {
			return g, w
		}
	}
	t.Fatalf("timeout waiting for %s", what)
	return nil, nil
}

func TestWorkspaceSuspension(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "text"}, &tr)
	text := tr.GetRoom().GetId()
	msg := send(t, bob, text, "before", "")
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+text+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	code := invite(t, o, wid)

	// Only superadmins; a reason is required.
	bob.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "PUT", "/api/admin/workspaces/"+wid+"/suspension", &v1.AdminSetSuspensionRequest{Suspended: true, Reason: "x"})
	superadminUser(t).wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "PUT", "/api/admin/workspaces/"+wid+"/suspension", &v1.AdminSetSuspensionRequest{Suspended: true})

	var bj v1.JoinVoiceResponse
	lk := liveKitReachable()
	if lk {
		bob.must(200, "POST", "/api/rooms/"+voice.GetId()+"/join", nil, &bj)
	}
	gb := dialGW(t)
	gb.identify(bob.token)
	gOwner := dialGW(t)
	gOwner.identify(o.token)

	aw := suspend(t, wid, true, "unpaid invoice")
	if aw.GetWorkspace().GetSuspension().GetReason() != "unpaid invoice" || aw.GetSuspendedByEmail() != superadminEmail || aw.GetWorkspace().GetSuspension().GetAt() == nil {
		t.Fatalf("admin view: %v", aw)
	}
	// WORKSPACE_UPDATE: the owner sees the reason, a member only the flag.
	suspended := func(w *v1.Workspace) bool { return w.GetSuspension() != nil }
	gOwner, w := workspaceStateOrResync(t, gOwner, o.token, wid, "owner WORKSPACE_UPDATE", suspended)
	if w.GetSuspension().GetReason() != "unpaid invoice" {
		t.Fatalf("owner update: %v", w)
	}
	_, w = workspaceStateOrResync(t, gb, bob.token, wid, "member WORKSPACE_UPDATE", suspended)
	if w.GetSuspension().GetReason() != "" {
		t.Fatalf("member sees the reason: %v", w)
	}
	var gr v1.GetWorkspaceResponse
	bob.must(200, "GET", "/api/workspaces/"+wid, nil, &gr)
	if gr.GetWorkspace().GetSuspension() == nil || gr.GetWorkspace().GetSuspension().GetReason() != "" {
		t.Fatalf("member GET: %v", gr.GetWorkspace().GetSuspension())
	}
	gr.Reset()
	o.must(200, "GET", "/api/workspaces/"+wid, nil, &gr)
	if gr.GetWorkspace().GetSuspension().GetReason() != "unpaid invoice" {
		t.Fatalf("owner GET: %v", gr.GetWorkspace().GetSuspension())
	}
	// READY carries the state (without the reason for members).
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid && (s.GetWorkspace().GetSuspension() == nil || s.GetWorkspace().GetSuspension().GetReason() != "") {
			t.Fatalf("READY: %v", s.GetWorkspace().GetSuspension())
		}
	}
	// The admin search shows the status.
	var sr v1.AdminSearchWorkspacesResponse
	superadminUser(t).must(200, "GET", "/api/admin/workspaces?q="+url.QueryEscape(ws.GetSlug()), nil, &sr)
	if len(sr.GetWorkspaces()) == 0 || sr.GetWorkspaces()[0].GetWorkspace().GetSuspension() == nil {
		t.Fatalf("admin search: %v", &sr)
	}

	// Voice: everyone is disconnected.
	if lk {
		deadline := time.Now().Add(3 * time.Second)
		for !lkRec.wasRemoved(bj.GetIdentity()) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if !lkRec.wasRemoved(bj.GetIdentity()) {
			t.Fatal("voice participant not disconnected on suspension")
		}
	}

	// Writes are refused, for the owner too.
	thumbs := url.PathEscape("👍")
	for _, u := range []*user{o, bob} {
		u.wantErr(403, errSuspended, "POST", "/api/rooms/"+text+"/messages", &v1.CreateMessageRequest{Content: "x"})
		u.wantErr(403, errSuspended, "POST", "/api/rooms/"+voice.GetId()+"/join", nil)
		u.wantErr(403, errSuspended, "POST", "/api/rooms/"+voice.GetId()+"/stream/request", &v1.RequestStreamRequest{})
		u.wantErr(403, errSuspended, "POST", "/api/rooms/"+voice.GetId()+"/camera/request", &v1.RequestCameraRequest{})
		u.wantErr(403, errSuspended, "POST", "/api/rooms/"+voice.GetId()+"/recording/start", nil)
		u.wantErr(403, errSuspended, "PUT", "/api/messages/"+msg.GetId()+"/reactions/"+thumbs, nil)
		if st, e := uploadRaw(t, u, wid, 10); st != 403 || e.GetCode() != errSuspended {
			t.Fatalf("upload: %d %v", st, e)
		}
	}
	bob.wantErr(403, errSuspended, "PATCH", "/api/messages/"+msg.GetId(), &v1.UpdateMessageRequest{Content: "edited"})
	o.wantErr(403, errSuspended, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{})
	o.wantErr(403, errSuspended, "POST", "/api/rooms/"+text+"/invites", &v1.CreateRoomInviteRequest{})
	o.wantErr(403, errSuspended, "POST", "/api/workspaces/"+wid+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("s") + "@example.com"})
	// Joining: invitation, room link (guest), registration with an invitation.
	stranger := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	stranger.wantErr(403, errSuspended, "POST", "/api/invites/"+code+"/join", nil)
	newClient(t).wantErr(403, errSuspended, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"})
	newClient(t).wantErr(403, errSuspended, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("r") + "@example.com", Password: "password123", DisplayName: "R", InviteCode: code, DeviceName: "test",
	})

	// Reading keeps working.
	var ml v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+text+"/messages", nil, &ml)
	if len(ml.GetMessages()) == 0 {
		t.Fatal("history not readable")
	}
	bob.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, nil)

	// Resume: everything works again.
	aw = suspend(t, wid, false, "ignored")
	if aw.GetWorkspace().GetSuspension() != nil || aw.GetSuspendedBy() != "" {
		t.Fatalf("resumed: %v", aw)
	}
	workspaceStateOrResync(t, gOwner, o.token, wid, "resume WORKSPACE_UPDATE", func(w *v1.Workspace) bool { return w.GetSuspension() == nil })
	send(t, bob, text, "after", "")
	stranger.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)
	var n int
	if err := testDB.Pool.QueryRow(t.Context(), "SELECT count(*) FROM workspace_admin_log WHERE workspace_id = $1", wid).Scan(&n); err != nil || n != 2 {
		t.Fatalf("admin log: %d %v", n, err)
	}
}

func TestWorkspaceBans(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN)
	wid := ws.GetId()
	path := "/api/workspaces/" + wid
	code := invite(t, o, wid)
	bob := register(t, code)
	admin := register(t, code)
	admin2 := register(t, code)
	for _, a := range []*user{admin, admin2} {
		o.must(200, "PATCH", path+"/members/"+a.id, &v1.UpdateMemberRequest{Role: v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN.Enum()}, nil)
	}
	carol := register(t, code)

	// Rights: members cannot ban; nobody bans the owner, themself, or (as an admin) an admin.
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/bans", &v1.CreateBanRequest{UserId: carol.id})
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "GET", path+"/bans", nil)
	admin.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/bans", &v1.CreateBanRequest{UserId: o.id})
	admin.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/bans", &v1.CreateBanRequest{UserId: admin2.id})
	admin.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/bans", &v1.CreateBanRequest{UserId: admin.id})
	admin.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "POST", path+"/bans", &v1.CreateBanRequest{UserId: "nope"})

	gAdmin := dialGW(t)
	gAdmin.identify(admin.token)
	gBob := dialGW(t)
	gBob.identify(bob.token)
	gCarol := dialGW(t)
	gCarol.identify(carol.token)

	var cb v1.CreateBanResponse
	admin.must(201, "POST", path+"/bans", &v1.CreateBanRequest{UserId: carol.id, Reason: "spam"}, &cb)
	if cb.GetBan().GetUser().GetId() != carol.id || cb.GetBan().GetReason() != "spam" || cb.GetBan().GetEmail() != carol.email || cb.GetBan().GetBannedBy() != admin.id {
		t.Fatalf("ban: %v", &cb)
	}
	// Removed: MEMBER_REMOVE to the workspace, WORKSPACE_DELETE to carol; BAN_ADD to admins only.
	gAdmin.wait("BAN_ADD", func(e *v1.DispatchEvent) bool { return e.GetWorkspaceBanAdd().GetBan().GetUser().GetId() == carol.id })
	gBob.wait("MEMBER_REMOVE", func(e *v1.DispatchEvent) bool { return e.GetWorkspaceMemberRemove().GetUserId() == carol.id })
	gBob.quiet("BAN_ADD to a member", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetWorkspaceBanAdd() != nil })
	gCarol.wait("WORKSPACE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetWorkspaceDelete().GetWorkspaceId() == wid })
	carol.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "GET", path, nil)

	// No way back: invitation, open join, direct add, email invitation.
	carol.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", "/api/invites/"+code+"/join", nil)
	carol.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", path+"/join", nil)
	o.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", path+"/members", &v1.AddMemberRequest{UserId: carol.id})
	o.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: carol.email})
	// The invitation was not used up by the refused join.
	var li v1.ListInvitesResponse
	o.must(200, "GET", path+"/invites", nil, &li)
	for _, i := range li.GetInvites() {
		if i.GetCode() == code && i.GetUses() != 4 {
			t.Fatalf("invite uses: %d", i.GetUses())
		}
	}

	var lb v1.ListBansResponse
	admin.must(200, "GET", path+"/bans", nil, &lb)
	if len(lb.GetBans()) != 1 || lb.GetBans()[0].GetUser().GetId() != carol.id {
		t.Fatalf("bans: %v", &lb)
	}

	// Unban: carol may come back (not automatically).
	admin.must(204, "DELETE", path+"/bans/"+carol.id, nil, nil)
	gAdmin.wait("BAN_REMOVE", func(e *v1.DispatchEvent) bool { return e.GetWorkspaceBanRemove().GetUserId() == carol.id })
	admin.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "DELETE", path+"/bans/"+carol.id, nil)
	carol.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "GET", path, nil)
	carol.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)

	// The owner bans an admin; banning a non-member (who left) works too.
	o.must(201, "POST", path+"/bans", &v1.CreateBanRequest{UserId: admin2.id}, nil)
	bob.must(204, "DELETE", path+"/members/@me", nil, nil)
	admin.must(201, "POST", path+"/bans", &v1.CreateBanRequest{UserId: bob.id}, nil)
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", path+"/join", nil)

	// A guest (room link) is banned by their guest account.
	var tr v1.CreateRoomResponse
	o.must(201, "POST", path+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "guests"}, &tr)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+tr.GetRoom().GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	gc := newClient(t)
	var gj v1.JoinRoomInviteResponse
	gc.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	gc.token = gj.GetTokens().GetAccessToken()
	o.must(201, "POST", path+"/bans", &v1.CreateBanRequest{UserId: gj.GetMe().GetUser().GetId()}, nil)
	gc.wantErr(403, v1.ErrorCode_ERROR_CODE_BANNED, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{})
}
