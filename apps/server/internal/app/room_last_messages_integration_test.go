//go:build integration

package app_test

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestRoomLastMessagesSnapshot: READY carries the newest live message of every room the
// recipient sees (ADR-0073 §5) in the DmLastMessage shape; a deleted newest message falls
// back to the previous one; rooms hidden from the recipient (private, VIEW_ROOM denied) give
// no preview, and rooms without messages have no entry.
func TestRoomLastMessagesSnapshot(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wsID := ws.GetId()
	general := textRoom(t, o, wsID, "general", false)
	empty := textRoom(t, o, wsID, "empty", false)
	private := textRoom(t, o, wsID, "private", true)
	denied := textRoom(t, o, wsID, "denied", false)
	o.must(200, "PUT", "/api/rooms/"+denied+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(bob.id, 0, perm.ViewRoom),
	}}, nil)

	// general: a long Cyrillic text with an attachment, then a newer message that is deleted.
	long := strings.Repeat("я", 250)
	status, file, _ := upload(t, o, "/api/workspaces/"+wsID+"/files", "notes.txt", []byte("notes"))
	if status != 201 {
		t.Fatalf("upload: %d", status)
	}
	var cm v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+general+"/messages", &v1.CreateMessageRequest{Content: long, AttachmentIds: []string{file.GetId()}}, &cm)
	kept := cm.GetMessage()
	gone := sendRetry(t, o, general, "to be deleted")
	o.must(204, "DELETE", "/api/messages/"+gone.GetId(), nil, nil)
	inVoice := sendRetry(t, bob, voice.GetId(), "voice chat")
	sendRetry(t, o, private, "secret")
	sendRetry(t, o, denied, "not for bob")

	g := dialGW(t)
	defer func() { _ = g.ws.CloseNow() }()
	var snap *v1.WorkspaceSnapshot
	for _, s := range g.identify(bob.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wsID {
			snap = s
		}
	}
	if snap == nil {
		t.Fatal("workspace missing from READY")
	}
	lm := snap.GetRoomLastMessages()
	if len(lm) != 2 {
		t.Fatalf("previews: %d rooms (%v), want general and voice", len(lm), lm)
	}
	got := lm[general]
	if got.GetId() != kept.GetId() || got.GetAuthorId() != o.id || got.GetContent() != strings.Repeat("я", 200) ||
		got.GetAttachmentCount() != 1 || got.GetCreatedAt() == nil || got.GetStickerEmoji() != "" {
		t.Fatalf("general preview: %v", got)
	}
	if v := lm[voice.GetId()]; v.GetId() != inVoice.GetId() || v.GetAuthorId() != bob.id || v.GetContent() != "voice chat" {
		t.Fatalf("voice preview: %v", v)
	}
	for name, id := range map[string]string{"empty": empty, "private": private, "denied": denied} {
		if _, ok := lm[id]; ok {
			t.Fatalf("%s room has a preview for bob", name)
		}
	}
	// The room's own last_message_id agrees with the preview.
	for _, r := range snap.GetRooms() {
		if r.GetId() == general && r.GetLastMessageId() != kept.GetId() {
			t.Fatalf("general last_message_id %s, want %s", r.GetLastMessageId(), kept.GetId())
		}
	}
}
