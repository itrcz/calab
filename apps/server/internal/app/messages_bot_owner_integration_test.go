//go:build integration

package app_test

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestBotOwnerEditsBotMessages covers ADR-0162: the current owner of a bot edits the bot's
// messages (rooms, task comments, DMs) where they see them, in the bot's home workspace; the
// author stays the bot, the task journal names the owner. Nobody else gains the right.
func TestBotOwnerEditsBotMessages(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carl := register(t, invite(t, o, wid)) // owns the bot
	dave := register(t, invite(t, o, wid)) // MANAGE_BOTS, not the owner
	bots := newRole(t, o, wid, "bots164", perm.ManageBots).GetId()
	for _, u := range []*user{carl, dave} {
		if st, _ := setMemberRoles(o, wid, u.id, bots); st != 200 {
			t.Fatalf("assign MANAGE_BOTS: %d", st)
		}
	}
	mine := createBot(t, carl, wid, "own164")
	edit := func(u musty, mid string, want int) *v1.Message {
		t.Helper()
		var r v1.UpdateMessageResponse
		u.must(want, "PATCH", "/api/messages/"+mid, &v1.UpdateMessageRequest{Content: "правка " + mid[len(mid)-4:]}, &r)
		return r.GetMessage()
	}

	// A room: the owner edits, the author stays the bot, the keyboard stays; others get 403.
	room := textRoom(t, o, wid, "bot164", false)
	m := inlineMessage(t, mine, room, inlineKeyboard(carl.id))
	got := edit(carl, m.GetId(), 200)
	if got.GetAuthorId() != mine.id || got.GetEditedAt() == nil || got.GetInlineKeyboard() == nil || got.GetContent() == m.GetContent() {
		t.Fatalf("owner edit: %v", got)
	}
	edit(dave, m.GetId(), 403)
	edit(o, m.GetId(), 403)
	carl.must(403, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: "x", InlineKeyboard: inlineKeyboard()}, nil)
	edit(mine, m.GetId(), 200) // the bot itself, as before

	// A room the owner does not see: 404, as for any hidden message.
	secret := textRoom(t, o, wid, "secret164", true)
	o.must(200, "PUT", "/api/rooms/"+secret+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		userOv(mine.id, perm.ViewRoom|perm.SendMessages, 0),
	}}, nil)
	hidden := send(t, &user{client: mine.client}, secret, "секрет", "")
	edit(carl, hidden.GetId(), 404)

	// A task comment: the journal entry is the owner's.
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Скрепка", Key: "BME", IsPrivate: true}, 201)
	vc := perm.ViewBoard | perm.CreateTasks
	setBoardPerms(o, b.GetId(), 200, creatorOv(o), userOv(carl.id, vc, 0), userOv(dave.id, vc, 0), userOv(mine.id, vc, 0))
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "карточка"}, 201)
	c := send(t, &user{client: mine.client}, task.GetRoomId(), "срок 10.11", "")
	edit(carl, c.GetId(), 200)
	edit(dave, c.GetId(), 403)
	if es := journalOf(t, o, task.GetId(), "comment_edit"); len(es) != 1 || es[0].GetActorId() != carl.id {
		t.Fatalf("journal: %v", es)
	}

	// DMs: the owner's own DM with the bot — yes; the bot's DM with someone else — not seen.
	var dm, other v1.CreateDmResponse
	mine.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: carl.id}, &dm)
	mine.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: dave.id}, &other)
	d := send(t, &user{client: mine.client}, dm.GetDm().GetRoom().GetId(), "привет", "")
	edit(carl, d.GetId(), 200)
	edit(carl, send(t, &user{client: mine.client}, other.GetDm().GetRoom().GetId(), "привет", "").GetId(), 404)

	// Outside the bot's home workspace the owner is not its author.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	carl.must(200, "POST", "/api/invites/"+invite(t, o, ws2)+"/join", nil, nil)
	o.must(201, "POST", "/api/workspaces/"+ws2+"/bots/add", &v1.AddBotRequest{BotUserId: mine.id}, nil)
	away := send(t, &user{client: mine.client}, textRoom(t, o, ws2, "away164", false), "в чужом", "")
	edit(carl, away.GetId(), 403)

	// The owner changes: the right moves with it, the previous owner loses it (room and DM).
	if _, err := testDB.Pool.Exec(context.Background(), `UPDATE bots SET owner_user_id = $2 WHERE user_id = $1`, mine.id, dave.id); err != nil {
		t.Fatal(err)
	}
	edit(carl, m.GetId(), 403)
	edit(carl, d.GetId(), 403)
	edit(dave, m.GetId(), 200)
}
