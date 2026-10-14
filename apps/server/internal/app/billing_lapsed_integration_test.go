//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/events"
)

// setLapsed puts the stopped account in the restricted mode or takes it out (the core's job in
// production: the end of the paid days, Activate, Resume FREE) and reports it like the core.
func setLapsed(t *testing.T, ws string, id uuid.UUID, lapsed bool) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(),
		`UPDATE billing_accounts SET lapsed_at = CASE WHEN $2 THEN now() END WHERE id = $1`, id, lapsed); err != nil {
		t.Fatal(err)
	}
	if err := testApp.Plans.BillingChanged(context.Background(), testDB.Q, events.Redis{C: testRedis}, uuid.MustParse(ws)); err != nil {
		t.Fatal(err)
	}
}

func wantPlanInactive(t *testing.T, c *client, method, path string, in proto.Message) {
	t.Helper()
	st, e := c.apiErrBody(method, path, in)
	if st != 403 || e.GetReason() != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("%s %s: %d %v, want 403 %s", method, path, st, e, billing.ReasonWorkspacePlanInactive)
	}
}

// The restricted mode («тариф не активен», ADR-0086 amendment): everyone in the workspace — the
// owner, members and bots — reads but does not write, upload, invite or create; voice takes two
// people, audio only. Cleanup (deleting a message) and DMs stay open. Enforcement off (kill
// switch) and leaving the mode lift it.
func TestBillingLapsedRestrictedMode(t *testing.T) {
	ctx := context.Background()
	withBilling(t, newFakeSeats(), true)
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	m := register(t, invite(t, a, ws))
	third := register(t, invite(t, a, ws))
	room := textRoom(t, a, ws, "Lapsed", false)
	voice := voiceRoom(t, a, ws, "Voice", 0)
	board := createBoard(t, a, ws, &v1.CreateBoardRequest{Name: "Lapsed board", Key: "LAPS"}, 201)
	bot := createBot(t, a, ws, "lapsebot")
	mine := send(t, m, room, "before", uniq("lapse-"))
	messages := "/api/rooms/" + room + "/messages"

	account := billingAccount(t, ws, "stopped", false)
	setLapsed(t, ws, account, true)
	var gr v1.GetWorkspaceResponse
	m.must(200, "GET", "/api/workspaces/"+ws, nil, &gr)
	if b := gr.GetWorkspace().GetBilling(); b.GetState() != v1.BillingState_BILLING_STATE_LAPSED {
		t.Fatalf("Workspace.billing: %v, want LAPSED", b)
	}
	if n := gr.GetWorkspace().GetPlan().GetLimits().GetRoomMembers(); n != 2 {
		t.Fatalf("room_members in the restricted mode: %d, want 2", n)
	}

	for _, c := range []*client{m.client, a.client, bot.client} {
		c.must(200, "GET", messages, nil, nil)
		wantPlanInactive(t, c, "POST", messages, &v1.CreateMessageRequest{Content: "after", Nonce: uniq("n-")})
	}
	wantPlanInactive(t, m.client, "PATCH", "/api/messages/"+mine.GetId(), &v1.UpdateMessageRequest{Content: "edited"})
	wantPlanInactive(t, m.client, "PUT", "/api/messages/"+mine.GetId()+"/reactions/"+url.PathEscape("👍"), nil)
	if st, _, _ := upload(t, m, "/api/workspaces/"+ws+"/files", "lapsed.txt", []byte("bytes")); st != 403 {
		t.Fatalf("upload: %d, want 403", st)
	}
	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/invites", &v1.CreateInviteRequest{})
	wantPlanInactive(t, a.client, "POST", "/api/rooms/"+room+"/invites", &v1.CreateRoomInviteRequest{})
	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "new"})
	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/boards", &v1.CreateBoardRequest{Name: "New", Key: "NEWB"})
	wantPlanInactive(t, a.client, "POST", "/api/boards/"+board.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "t"})
	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/bots", &v1.CreateBotRequest{DisplayName: "b", Username: "lapsed_new_bot"})
	// Cleanup stays: deleting one's message, reading the board.
	m.must(204, "DELETE", "/api/messages/"+mine.GetId(), nil, nil)
	a.must(200, "GET", "/api/boards/"+board.GetId(), nil, nil)
	// DMs have no workspace: not restricted.
	dm := openDM(t, a, m.id, 201)
	send(t, a, dm.GetRoom().GetId(), "dm still works", uniq("dm-"))

	if testApp.RTC != nil {
		liveKitUp(t)
		var j v1.JoinVoiceResponse
		a.must(200, "POST", "/api/rooms/"+voice+"/join", nil, &j)
		if j.GetCanStream() || j.GetCanVideo() {
			t.Fatalf("restricted mode is audio only: stream=%v video=%v", j.GetCanStream(), j.GetCanVideo())
		}
		joinVoice(t, m, ws, voice)
		time.Sleep(50 * time.Millisecond)
		st, e := third.apiErrBody("POST", "/api/rooms/"+voice+"/join", nil)
		if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL || e.GetReason() != billing.ReasonWorkspacePlanInactive || e.GetLimit() != 2 {
			t.Fatalf("third join: %d %v, want 409 ROOM_FULL %s limit 2", st, e, billing.ReasonWorkspacePlanInactive)
		}
		wantPlanInactive(t, m.client, "POST", "/api/rooms/"+voice+"/stream/request", &v1.RequestStreamRequest{})
		wantPlanInactive(t, m.client, "POST", "/api/rooms/"+voice+"/camera/request", nil)
	}

	// Kill switch: enforcement off shows STOPPED and lifts the mode.
	testApp.SetBilling(newFakeSeats(), true, false)
	testApp.Plans.Invalidate(ctx, uuid.MustParse(ws))
	send(t, m, room, "enforcement off", uniq("off-"))
	testApp.SetBilling(newFakeSeats(), true, true)
	testApp.Plans.Invalidate(ctx, uuid.MustParse(ws))
	wantPlanInactive(t, m.client, "POST", messages, &v1.CreateMessageRequest{Content: "on again", Nonce: uniq("n-")})

	// Leaving the mode (paid or Free once it fits) opens everything at once.
	setLapsed(t, ws, account, false)
	send(t, m, room, "plan active again", uniq("back-"))
	bot.must(201, "POST", messages, &v1.CreateMessageRequest{Content: "bot writes again", Nonce: uniq("bot-")}, nil)
}

// Links issued before the restricted mode let nobody new in: registration by a workspace invite
// code and an account-less room guest link (public routes outside the identity gate's route
// table) are refused with WORKSPACE_PLAN_INACTIVE; the same links work again once the mode is
// over.
func TestBillingLapsedOldLinksRefused(t *testing.T) {
	withBilling(t, newFakeSeats(), true)
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	code := invite(t, a, ws)
	room := textRoom(t, a, ws, "Guest link", false)
	link := roomLink(t, a, room, &v1.CreateRoomInviteRequest{AllowGuests: proto.Bool(true)})

	account := billingAccount(t, ws, "stopped", false)
	setLapsed(t, ws, account, true)

	seq++
	c := &client{t: t, ip: fmt.Sprintf("10.1.%d.%d", seq/250, seq%250+1)}
	email := uniq("u") + "@example.com"
	st, e := c.apiErrBody("POST", "/api/auth/register", &v1.RegisterRequest{
		Email: email, Password: "password123", DisplayName: email[:8], InviteCode: code, DeviceName: "test",
	})
	if st != 403 || e.GetReason() != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("registration by invite: %d %v, want 403 %s", st, e, billing.ReasonWorkspacePlanInactive)
	}
	admissionIP++
	g := &client{t: t, ip: fmt.Sprintf("10.140.%d.%d", admissionIP/250, admissionIP%250+1)}
	st, e = g.apiErrBody("POST", "/api/room-invites/"+link.GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "late guest"})
	if st != 403 || e.GetReason() != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("guest link: %d %v, want 403 %s", st, e, billing.ReasonWorkspacePlanInactive)
	}

	setLapsed(t, ws, account, false)
	register(t, code)
	anonGuest(t, link.GetCode(), "guest after")
}
