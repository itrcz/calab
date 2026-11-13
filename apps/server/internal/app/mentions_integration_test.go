//go:build integration

package app_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestMentions(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	mentions := func(u *user, query string) *v1.ListMessagesResponse {
		var out v1.ListMessagesResponse
		u.must(200, "GET", "/api/me/mentions"+query, nil, &out)
		return &out
	}
	direct := send(t, o, rid, "hi @"+bob.id+", see this", "")
	everyone := send(t, o, rid, "@everyone lunch", "")
	send(t, bob, rid, "code: `@"+o.id+"` and mail@"+o.id, "") // not mentions
	send(t, bob, rid, "@"+bob.id+" note to self", "")         // own mention: not stored
	send(t, bob, rid, "@everyone from a member", "")          // no MENTION_EVERYONE: plain text

	// A private room bob cannot see: its mentions stay hidden from him.
	var pr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "private", IsPrivate: true}, &pr)
	send(t, o, pr.GetRoom().GetId(), "secret @"+bob.id, "")

	got := mentions(bob, "")
	if len(got.GetMessages()) != 2 || got.GetMessages()[0].GetId() != everyone.GetId() || got.GetMessages()[1].GetId() != direct.GetId() {
		t.Fatalf("bob mentions: %v", got.GetMessages())
	}
	// o is the shared test owner: other tests mention it too, so count only this workspace.
	if n := len(mentions(o, "?workspace_id="+ws.GetId()).GetMessages()); n != 0 {
		t.Fatalf("owner has %d mentions (own @everyone and code spans must not count)", n)
	}
	page := mentions(bob, "?limit=1")
	if len(page.GetMessages()) != 1 || !page.GetHasMore() {
		t.Fatal("pagination: first page")
	}
	page = mentions(bob, "?limit=1&before="+page.GetMessages()[0].GetId())
	if len(page.GetMessages()) != 1 || page.GetHasMore() || page.GetMessages()[0].GetId() != direct.GetId() {
		t.Fatal("pagination: second page")
	}
	if n := len(mentions(bob, "?workspace_id="+ws.GetId()).GetMessages()); n != 2 {
		t.Fatalf("workspace filter: %d", n)
	}
	// Editing the mention away and deleting the @everyone message remove them from history.
	o.must(200, "PATCH", "/api/messages/"+direct.GetId(), &v1.UpdateMessageRequest{Content: "hi all"}, nil)
	o.must(204, "DELETE", "/api/messages/"+everyone.GetId(), nil, nil)
	if n := len(mentions(bob, "").GetMessages()); n != 0 {
		t.Fatalf("after edit/delete: %d mentions", n)
	}
	o.must(200, "PATCH", "/api/messages/"+direct.GetId(), &v1.UpdateMessageRequest{Content: "again @" + bob.id}, nil)
	if n := len(mentions(bob, "").GetMessages()); n != 1 {
		t.Fatalf("mention added by edit: %d", n)
	}
	bob.must(400, "GET", "/api/me/mentions?after="+direct.GetId(), nil, nil)
}

func TestRoomNotificationSettings(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	g := dialGW(t)
	if n := len(g.identify(bob.token).GetNotificationSettings()); n != 0 {
		t.Fatalf("READY has %d settings by default", n)
	}
	until := time.Now().Add(time.Hour).Truncate(time.Second)
	var resp v1.UpdateRoomNotificationSettingsResponse
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{
		Level: v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS, MutedUntil: timestamppb.New(until),
	}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS || !resp.GetSettings().GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("response: %v", resp.GetSettings())
	}
	g.wait("ROOM_NOTIFICATION_UPDATE", func(e *v1.DispatchEvent) bool {
		s := e.GetRoomNotificationUpdate().GetSettings()
		return s.GetRoomId() == rid && s.GetLevel() == v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
	})
	ns := dialGW(t).identify(bob.token).GetNotificationSettings()
	if len(ns) != 1 || ns[0].GetRoomId() != rid || !ns[0].GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("READY settings: %v", ns)
	}
	if n := len(dialGW(t).identify(o.token).GetNotificationSettings()); n != 0 {
		t.Fatal("settings leaked to another user")
	}
	// Settings of a room the user can no longer view are not sent (they would reveal its id).
	hide := &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: 1},
	}}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", hide, nil)
	if n := len(dialGW(t).identify(bob.token).GetNotificationSettings()); n != 0 {
		t.Fatal("settings of a hidden room in READY")
	}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	// Validation and access.
	bob.must(422, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{
		MutedUntil: timestamppb.New(time.Now().Add(2 * 365 * 24 * time.Hour)),
	}, nil)
	bob.must(422, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: 42}, nil)
	var pr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "private", IsPrivate: true}, &pr)
	bob.must(404, "PUT", "/api/rooms/"+pr.GetRoom().GetId()+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{}, nil)
	// An explicit ALL is stored (the default is INHERIT now, docs/09 item 22).
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_ALL}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_ALL || resp.GetSettings().GetMutedUntil() != nil {
		t.Fatalf("ALL response: %v", resp.GetSettings())
	}
	if ns := dialGW(t).identify(bob.token).GetNotificationSettings(); len(ns) != 1 || ns[0].GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_ALL {
		t.Fatalf("explicit ALL not stored: %v", ns)
	}
	// Back to the default (UNSPECIFIED = INHERIT): the row is gone.
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT || resp.GetSettings().GetMutedUntil() != nil {
		t.Fatalf("reset response: %v", resp.GetSettings())
	}
	if n := len(dialGW(t).identify(bob.token).GetNotificationSettings()); n != 0 {
		t.Fatal("default settings still stored")
	}
}

// Workspace level (docs/09 item 22): default MENTIONS as no row, stored levels and mutes,
// WORKSPACE_NOTIFICATION_UPDATE to the user's own devices only, READY, validation, access.
func TestWorkspaceNotificationSettings(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	g := dialGW(t)
	if n := len(g.identify(bob.token).GetWorkspaceNotificationSettings()); n != 0 {
		t.Fatalf("READY has %d workspace settings by default", n)
	}
	og := dialGW(t)
	og.identify(o.token)
	until := time.Now().Add(8 * time.Hour).Truncate(time.Second)
	var resp v1.UpdateWorkspaceNotificationSettingsResponse
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{
		Level: v1.NotificationLevel_NOTIFICATION_LEVEL_ALL, MutedUntil: timestamppb.New(until),
	}, &resp)
	s := resp.GetSettings()
	if s.GetWorkspaceId() != wid || s.GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_ALL || !s.GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("response: %v", s)
	}
	g.wait("WORKSPACE_NOTIFICATION_UPDATE", func(e *v1.DispatchEvent) bool {
		s := e.GetWorkspaceNotificationUpdate().GetSettings()
		return s.GetWorkspaceId() == wid && s.GetLevel() == v1.NotificationLevel_NOTIFICATION_LEVEL_ALL
	})
	// The owner's devices hear only about the owner's own change.
	o.must(200, "PUT", "/api/workspaces/"+wid+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_NONE}, nil)
	og.wait("WORKSPACE_NOTIFICATION_UPDATE (owner)", func(e *v1.DispatchEvent) bool {
		u := e.GetWorkspaceNotificationUpdate()
		if u != nil && u.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_NONE {
			t.Fatalf("bob's settings leaked to the owner: %v", u)
		}
		return u != nil
	})
	wns := dialGW(t).identify(bob.token).GetWorkspaceNotificationSettings()
	if len(wns) != 1 || wns[0].GetWorkspaceId() != wid || !wns[0].GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("READY workspace settings: %v", wns)
	}
	// Validation: INHERIT has nothing to inherit from; unknown levels; mutes over a year.
	put := func(status int, req *v1.UpdateWorkspaceNotificationSettingsRequest) {
		t.Helper()
		bob.must(status, "PUT", "/api/workspaces/"+wid+"/notifications", req, nil)
	}
	put(422, &v1.UpdateWorkspaceNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT})
	put(422, &v1.UpdateWorkspaceNotificationSettingsRequest{Level: 42})
	put(422, &v1.UpdateWorkspaceNotificationSettingsRequest{MutedUntil: timestamppb.New(time.Now().Add(2 * 365 * 24 * time.Hour))})
	// Not a member: 404.
	bob.must(404, "PUT", "/api/workspaces/"+uuid.NewString()+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{}, nil)
	// Back to the default (MENTIONS, not muted): the row is gone.
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS || resp.GetSettings().GetMutedUntil() != nil {
		t.Fatalf("reset response: %v", resp.GetSettings())
	}
	if n := len(dialGW(t).identify(bob.token).GetWorkspaceNotificationSettings()); n != 0 {
		t.Fatal("default workspace settings still stored")
	}
}

func TestReadStateCounts(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	counts := func(u *user) (unread, mentions uint32, ok bool) {
		for _, rs := range dialGW(t).identify(u.token).GetReadStates() {
			if rs.GetRoomId() == rid {
				return rs.GetUnreadCount(), rs.GetMentionCount(), true
			}
		}
		return 0, 0, false
	}
	send(t, bob, rid, "first", "") // bob's read marker
	send(t, o, rid, "hey @"+bob.id, "")
	everyone := send(t, o, rid, "@here standup", "")
	last := send(t, o, rid, "plain", "")
	if u, m, ok := counts(bob); !ok || u != 3 || m != 2 {
		t.Fatalf("bob: unread %d mentions %d (ok %v), want 3 / 2", u, m, ok)
	}
	if u, m, _ := counts(o); u != 0 || m != 0 {
		t.Fatalf("owner's own messages counted: %d / %d", u, m)
	}
	o.must(204, "DELETE", "/api/messages/"+everyone.GetId(), nil, nil)
	if u, m, _ := counts(bob); u != 2 || m != 1 {
		t.Fatalf("after delete: %d / %d, want 2 / 1", u, m)
	}
	bob.must(204, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: last.GetId()}, nil)
	if u, m, _ := counts(bob); u != 0 || m != 0 {
		t.Fatalf("after read: %d / %d", u, m)
	}

	// A room bob never opened (no read marker) is counted from his joining (review 4 M1).
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "news"}, &cr)
	news := cr.GetRoom().GetId()
	send(t, o, news, "hello", "")
	send(t, o, news, "ping @"+bob.id, "")
	found := false
	for _, rs := range dialGW(t).identify(bob.token).GetReadStates() {
		if rs.GetRoomId() == news {
			found = true
			if rs.GetLastReadMessageId() != "" || rs.GetUnreadCount() != 2 || rs.GetMentionCount() != 1 {
				t.Fatalf("never-opened room: %v", rs)
			}
		}
	}
	if !found {
		t.Fatal("never-opened room missing from READY read_states")
	}
}
