//go:build integration

package app_test

import (
	"net/url"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Report and block users (ADR-0154).

const errUnavailable = v1.ErrorCode_ERROR_CODE_USER_UNAVAILABLE

// TestBlockUsers: a block in either direction refuses a new DM, DM messages and forwards and a
// one-to-one call with the same 403 USER_UNAVAILABLE; an existing DM still opens; shared rooms
// are not filtered; the blocker's other sessions learn of it, the blocked person does not.
func TestBlockUsers(t *testing.T) {
	a, b, c, wsID := callTeam(t)
	general := textRoom(t, owner(t), wsID, uniq("general"), false)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	before := send(t, b.user, dm, "hello before", "")

	// Validation: not oneself, not a bot, not a stranger (404, as POST /api/dms).
	a.must(422, "POST", "/api/me/blocked-users/"+a.id, nil, nil)
	stranger := register(t, invite(t, owner(t), createWorkspace(t, owner(t), v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	a.must(404, "POST", "/api/me/blocked-users/"+stranger.id, nil, nil)
	bt := createBot(t, owner(t), wsID, "Blocky")
	a.must(422, "POST", "/api/me/blocked-users/"+bt.id, nil, nil)
	bt.must(403, "GET", "/api/me/blocked-users", nil, nil) // bots never block people

	// a blocks b; a's own gateway session hears it, b's never does.
	a.must(204, "POST", "/api/me/blocked-users/"+b.id, nil, nil)
	a.must(204, "POST", "/api/me/blocked-users/"+b.id, nil, nil) // idempotent
	a.g.wait("USER_BLOCKS_UPDATE", func(e *v1.DispatchEvent) bool {
		u := e.GetUserBlocksUpdate()
		return u != nil && u.GetUserId() == b.id && u.GetBlocked()
	})
	b.g.quiet("no block event to the blocked", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetUserBlocksUpdate() != nil })
	var l v1.ListBlockedUsersResponse
	a.must(200, "GET", "/api/me/blocked-users", nil, &l)
	if len(l.GetUserIds()) != 1 || l.GetUserIds()[0] != b.id {
		t.Fatalf("blocked list: %v", l.GetUserIds())
	}

	// Both directions refused with the same code; the existing DM still opens.
	for _, u := range []*user{a.user, b.user} {
		if st := u.do("POST", "/api/rooms/"+dm+"/messages", &v1.CreateMessageRequest{Content: "hi"}, nil); st != 403 || apiErr(u.client).GetCode() != errUnavailable {
			t.Fatalf("DM message with a block: %d %s", st, u.lastBody)
		}
		if code := errCode(t, u, "POST", "/api/dms/"+dm+"/call"); code != errUnavailable {
			t.Fatalf("call with a block: %v", code)
		}
	}
	openDM(t, b.user, a.id, 200)
	// Nor an edit of an old DM message or a reaction in the DM.
	if st := b.do("PATCH", "/api/messages/"+before.GetId(), &v1.UpdateMessageRequest{Content: "edited"}, nil); st != 403 || apiErr(b.client).GetCode() != errUnavailable {
		t.Fatalf("DM edit with a block: %d %s", st, b.lastBody)
	}
	if code := errCode(t, a.user, "PUT", "/api/messages/"+before.GetId()+"/reactions/"+url.PathEscape("👍")); code != errUnavailable {
		t.Fatalf("DM reaction with a block: %v", code)
	}
	// A forward into the DM is refused too.
	m := send(t, b.user, general, "shared room message", "")
	if st := b.do("POST", "/api/rooms/"+general+"/messages/"+m.GetId()+"/forward", &v1.ForwardMessageRequest{ToRoomId: dm}, nil); st != 403 {
		t.Fatalf("forward into a blocked DM: %d %s", st, b.lastBody)
	}
	// No ring reached a.
	a.g.quiet("no CALL_RING", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetCallRing() != nil })

	// A new DM is refused: c blocks a (no DM yet) — a cannot open one, nor can c.
	c.must(204, "POST", "/api/me/blocked-users/"+a.id, nil, nil)
	if st := a.do("POST", "/api/dms", &v1.CreateDmRequest{UserId: c.id}, nil); st != 403 || apiErr(a.client).GetCode() != errUnavailable {
		t.Fatalf("new DM to a blocker: %d %s", st, a.lastBody)
	}
	if st := c.do("POST", "/api/dms", &v1.CreateDmRequest{UserId: a.id}, nil); st != 403 {
		t.Fatalf("new DM from a blocker: %d", st)
	}

	// Shared rooms are not filtered: b still writes there and a still reads it.
	send(t, b.user, general, "still in the team room", "")

	// Unblock: the DM works again.
	a.must(204, "DELETE", "/api/me/blocked-users/"+b.id, nil, nil)
	a.g.wait("USER_BLOCKS_UPDATE unblock", func(e *v1.DispatchEvent) bool {
		u := e.GetUserBlocksUpdate()
		return u != nil && u.GetUserId() == b.id && !u.GetBlocked()
	})
	send(t, b.user, dm, "after unblock", "")
}

// TestReports: a member reports a person or a message; moderators (MANAGE_MEMBERS) see it live
// and in the list, ordinary members and non-members do not; the limit is 10 per hour.
func TestReports(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	general := textRoom(t, o, wid, uniq("general"), false)
	msg := send(t, carol, general, "something rude", "")

	og := dialGW(t)
	og.identify(o.token)
	bg := dialGW(t)
	bg.identify(bob.token)

	var cr v1.CreateReportResponse
	bob.must(201, "POST", "/api/reports", &v1.CreateReportRequest{
		UserId: carol.id, MessageId: msg.GetId(), Reason: v1.ReportReason_REPORT_REASON_HARASSMENT, Comment: "please look",
	}, &cr)
	og.wait("WORKSPACE_REPORT_CREATE", func(e *v1.DispatchEvent) bool {
		r := e.GetWorkspaceReportCreate().GetReport()
		return r.GetId() == cr.GetId() && r.GetMessageText() == "something rude" && r.GetTarget().GetId() == carol.id
	})
	bg.quiet("reports are not for ordinary members", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetWorkspaceReportCreate() != nil })

	// The owner lists it; a member without MANAGE_MEMBERS cannot.
	var lr v1.ListReportsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/reports", nil, &lr)
	if len(lr.GetReports()) != 1 || lr.GetReports()[0].GetReporter().GetId() != bob.id || lr.GetReports()[0].GetReason() != v1.ReportReason_REPORT_REASON_HARASSMENT {
		t.Fatalf("reports: %v", lr.GetReports())
	}
	bob.must(403, "GET", "/api/workspaces/"+wid+"/reports", nil, nil)
	bob.must(403, "POST", "/api/workspaces/"+wid+"/reports/"+cr.GetId()+"/resolve", nil, nil)

	// Resolve.
	o.must(204, "POST", "/api/workspaces/"+wid+"/reports/"+cr.GetId()+"/resolve", nil, nil)
	o.must(200, "GET", "/api/workspaces/"+wid+"/reports", nil, &lr)
	if lr.GetReports()[0].GetResolvedAt() == nil || lr.GetReports()[0].GetResolvedBy() != o.id {
		t.Fatalf("resolved: %v", lr.GetReports()[0])
	}

	// A non-member cannot report into the workspace, nor see the message.
	stranger := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	stranger.must(404, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id, Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
	stranger.must(404, "POST", "/api/reports", &v1.CreateReportRequest{UserId: carol.id, MessageId: msg.GetId(), Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
	// Nor about a person outside it; validation.
	bob.must(404, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: stranger.id, Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
	bob.must(422, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: bob.id, Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
	bob.must(422, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id}, nil)
	bob.must(422, "POST", "/api/reports", &v1.CreateReportRequest{UserId: o.id, MessageId: msg.GetId(), Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)

	// A DM message: reported into a workspace both share; its text reaches the moderators.
	dm := openDM(t, bob, carol.id, 201).GetRoom().GetId()
	dmMsg := send(t, carol, dm, "dm insult", "")
	bob.must(422, "POST", "/api/reports", &v1.CreateReportRequest{UserId: carol.id, MessageId: dmMsg.GetId(), Reason: v1.ReportReason_REPORT_REASON_OTHER}, nil)
	bob.must(201, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id, MessageId: dmMsg.GetId(), Reason: v1.ReportReason_REPORT_REASON_OTHER}, nil)
	o.must(404, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id, MessageId: dmMsg.GetId(), Reason: v1.ReportReason_REPORT_REASON_OTHER}, nil) // not their DM

	// The limit: 10 per hour per reporter (2 used above).
	for i := 0; i < 8; i++ {
		bob.must(201, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id, Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
	}
	bob.must(429, "POST", "/api/reports", &v1.CreateReportRequest{WorkspaceId: wid, UserId: carol.id, Reason: v1.ReportReason_REPORT_REASON_SPAM}, nil)
}
