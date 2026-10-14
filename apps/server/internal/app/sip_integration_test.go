//go:build integration

package app_test

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
)

// fakeSIP stands in for the LiveKit SIP API (the dev LiveKit runs without livekit/sip). A dial
// blocks until the test answers or fails it (answer / fail), unless auto decides at once.
type fakeSIP struct {
	mu      sync.Mutex
	trunks  map[string]rtc.SIPTrunk
	seq     int
	creates int
	updates int
	deletes []string
	calls   []rtc.SIPCall
	results map[string]chan sipResult
	// failTrunk, if set, is returned by trunk create / update.
	failTrunk error
	// auto, if set, decides a dial at once (the connection test runs inside the request).
	auto func(rtc.SIPCall) (rtc.SIPParticipant, error)
}

type sipResult struct {
	p   rtc.SIPParticipant
	err error
}

var sipFake = &fakeSIP{}

func (f *fakeSIP) CreateSIPOutboundTrunk(_ context.Context, t rtc.SIPTrunk) (rtc.SIPTrunk, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failTrunk != nil {
		return rtc.SIPTrunk{}, f.failTrunk
	}
	f.seq++
	f.creates++
	t.ID = "ST_" + strings.Repeat("x", f.seq)
	if f.trunks == nil {
		f.trunks = map[string]rtc.SIPTrunk{}
	}
	f.trunks[t.ID] = t
	return t, nil
}

func (f *fakeSIP) UpdateSIPOutboundTrunk(_ context.Context, id string, t rtc.SIPTrunk) (rtc.SIPTrunk, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failTrunk != nil {
		return rtc.SIPTrunk{}, f.failTrunk
	}
	if _, ok := f.trunks[id]; !ok {
		return rtc.SIPTrunk{}, &rtc.Error{Status: 404, Code: "not_found", Msg: "trunk not found"}
	}
	f.updates++
	t.ID = id
	f.trunks[id] = t
	return t, nil
}

func (f *fakeSIP) DeleteSIPTrunk(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, id)
	delete(f.trunks, id)
	return nil
}

func (f *fakeSIP) result(identity string) chan sipResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.results == nil {
		f.results = map[string]chan sipResult{}
	}
	ch, ok := f.results[identity]
	if !ok {
		ch = make(chan sipResult, 1)
		f.results[identity] = ch
	}
	return ch
}

func (f *fakeSIP) CreateSIPParticipant(ctx context.Context, c rtc.SIPCall) (rtc.SIPParticipant, error) {
	f.mu.Lock()
	f.calls = append(f.calls, c)
	auto := f.auto
	f.mu.Unlock()
	if auto != nil {
		return auto(c)
	}
	select {
	case r := <-f.result(c.Identity):
		return r.p, r.err
	case <-ctx.Done():
		return rtc.SIPParticipant{}, ctx.Err()
	}
}

func (f *fakeSIP) answer(identity string) {
	f.result(identity) <- sipResult{p: rtc.SIPParticipant{Identity: identity, SIPCallID: "SCL_" + identity[4:12]}}
}

func (f *fakeSIP) fail(identity string, code int, text string) {
	f.result(identity) <- sipResult{err: &rtc.Error{Status: 503, Code: "unavailable", Msg: "sip status", Meta: map[string]string{
		"sip_status_code": strconv.Itoa(code), "sip_status": text}}}
}

// dialed waits for the dial of identity and returns it.
func (f *fakeSIP) dialed(t *testing.T, identity string) rtc.SIPCall {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, c := range f.calls {
			if c.Identity == identity {
				f.mu.Unlock()
				return c
			}
		}
		f.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no dial of %s", identity)
	return rtc.SIPCall{}
}

func (f *fakeSIP) trunk(id string) (rtc.SIPTrunk, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.trunks[id], f.creates, f.updates
}

// sipCall waits for the call's status in the journal (the dial goroutine and webhooks are async).
func sipCallStatus(t *testing.T, o *user, wsID, callID string, want v1.SipCallStatus) *v1.SipCall {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last *v1.SipCall
	for time.Now().Before(deadline) {
		var j v1.ListSipCallsResponse
		o.must(200, "GET", "/api/workspaces/"+wsID+"/calls", nil, &j)
		for _, c := range j.GetCalls() {
			if c.GetId() == callID {
				last = c
				if c.GetStatus() == want {
					return c
				}
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("call %s: %v, want %v", callID, last, want)
	return nil
}

func sipWebhook(t *testing.T, kind, wsID, roomID, identity string, attrs map[string]string) {
	t.Helper()
	ev := whEvent(kind, "ws_"+wsID+"_room_"+roomID, identity, nil)
	ev.Participant.Kind = livekit.ParticipantInfo_SIP
	ev.Participant.Attributes = attrs
	if st := webhook(t, ev, "secret"); st != 200 {
		t.Fatalf("webhook %s: %d", kind, st)
	}
}

// TestSIP: settings round trip without leaking the password, trunk create / update / delete,
// who may call (bit, guests, bots, being in the call), number rules, one call per room, the
// hourly limit, hangups, status flow from the dial and webhooks, the journal (ADR-0046).
func TestSIP(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}) // telephony is Business only
	base := "/api/workspaces/" + wid + "/sip"
	calls := "/api/rooms/" + rid + "/calls"
	start := time.Now()

	// Defaults; MANAGE_WORKSPACE only.
	var g v1.GetSipSettingsResponse
	o.must(200, "GET", base, nil, &g)
	if g.GetSettings().GetEnabled() || g.GetSettings().GetTransport() != v1.SipTransport_SIP_TRANSPORT_UDP || g.GetSettings().GetHasPassword() {
		t.Fatalf("defaults: %v", g.GetSettings())
	}
	bob.must(403, "GET", base, nil, nil)
	bob.must(403, "PUT", base, &v1.PutSipSettingsRequest{}, nil)

	// Validation.
	valid := func() *v1.PutSipSettingsRequest {
		pw := "s3cret-Пароль" //nolint:gosec // G101: a test fixture
		return &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10:5060",
			Transport: v1.SipTransport_SIP_TRANSPORT_TCP, Username: "u100", Password: &pw, CallerId: "8 (495) 123-45-67",
			AllowedPrefixes: []string{"+7", "+7"}}
	}
	for field, mut := range map[string]func(*v1.PutSipSettingsRequest){
		"host":            func(r *v1.PutSipSettingsRequest) { r.Host = "" },
		"host ":           func(r *v1.PutSipSettingsRequest) { r.Host = "sip:203.0.113.10" },
		"callerId":        func(r *v1.PutSipSettingsRequest) { r.CallerId = "12345" },
		"username":        func(r *v1.PutSipSettingsRequest) { r.Username = `a"b` },
		"authUsername":    func(r *v1.PutSipSettingsRequest) { r.AuthUsername = "a b" },
		"outboundPrefix":  func(r *v1.PutSipSettingsRequest) { r.OutboundPrefix = "8+" },
		"allowedPrefixes": func(r *v1.PutSipSettingsRequest) { r.AllowedPrefixes = []string{"7"} },
	} {
		req := valid()
		mut(req)
		st, e := o.apiErrBody("PUT", base, req)
		if st != 422 || e.GetField() != strings.TrimSpace(field) {
			t.Fatalf("%s: %d %v", field, st, e)
		}
	}

	// Save: the trunk is created in LiveKit with the password; the password never comes back.
	var put v1.PutSipSettingsResponse
	o.must(200, "PUT", base, valid(), &put)
	s := put.GetSettings()
	if !s.GetEnabled() || !s.GetHasPassword() || !s.GetTrunkSaved() || s.GetCallerId() != "+74951234567" ||
		s.GetHost() != "203.0.113.10" || s.GetPort() != 5060 || s.GetAuthUsername() != "" || len(s.GetAllowedPrefixes()) != 1 || s.GetUpdatedBy() != o.id {
		t.Fatalf("saved: %v", s)
	}
	if strings.Contains(string(o.lastBody), "s3cret") {
		t.Fatal("PUT echoes the password")
	}
	acct, err := testDB.Q.GetSipAccount(context.Background(), uuid.MustParse(wid))
	if err != nil || acct.TrunkID == "" || len(acct.PasswordEnc) == 0 || strings.Contains(string(acct.PasswordEnc), "s3cret") {
		t.Fatalf("stored account: %+v %v", acct, err)
	}
	tr, creates, _ := sipFake.trunk(acct.TrunkID)
	if creates == 0 || tr.AuthPassword != "s3cret-Пароль" || tr.Address != "203.0.113.10" || tr.Transport != rtc.SIPTransportTCP ||
		len(tr.Numbers) != 1 || tr.Numbers[0] != "+74951234567" || tr.AuthUsername != "u100" {
		t.Fatalf("trunk: %+v", tr)
	}
	o.must(200, "GET", base, nil, &g)
	if strings.Contains(string(o.lastBody), "s3cret") || !g.GetSettings().GetHasPassword() {
		t.Fatalf("GET: %s", o.lastBody)
	}
	var gw1 v1.GetWorkspaceResponse
	bob.must(200, "GET", "/api/workspaces/"+wid, nil, &gw1)
	if !gw1.GetWorkspace().GetSipEnabled() {
		t.Fatal("Workspace.sip_enabled not set")
	}

	// PUT without a password keeps it (the trunk is replaced, not recreated); a separate auth
	// user and a non-default port reach the trunk.
	keep := valid()
	keep.Password = nil
	keep.OutboundPrefix = "8"
	keep.Port = 5080
	keep.AuthUsername = "auth-100"
	st, e := o.apiErrBody("PUT", base, keep) // host:5060 contradicts port 5080
	if st != 422 || e.GetField() != "port" {
		t.Fatalf("port conflict: %d %v", st, e)
	}
	keep.Host = "203.0.113.10"
	o.must(200, "PUT", base, keep, &put)
	tr, creates2, updates := sipFake.trunk(acct.TrunkID)
	if creates2 != creates || updates == 0 || tr.AuthPassword != "s3cret-Пароль" || !put.GetSettings().GetHasPassword() {
		t.Fatalf("keep password: %+v creates %d→%d updates %d", tr, creates, creates2, updates)
	}
	if tr.Address != "203.0.113.10:5080" || tr.AuthUsername != "auth-100" || put.GetSettings().GetPort() != 5080 ||
		put.GetSettings().GetAuthUsername() != "auth-100" || put.GetSettings().GetUsername() != "u100" {
		t.Fatalf("auth user / port: %+v / %v", tr, put.GetSettings())
	}
	o.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "PUT", base, &v1.PutSipSettingsRequest{Host: "203.0.113.10", Port: 70000})

	// LiveKit refuses: 502 SIP_PROVIDER_ERROR, nothing saved but last_error.
	sipFake.mu.Lock()
	sipFake.failTrunk = &rtc.Error{Status: 400, Code: "invalid_argument", Msg: "invalid trunk address"}
	sipFake.mu.Unlock()
	bad := valid()
	bad.Host = "198.51.100.99"
	o.wantErr(502, v1.ErrorCode_ERROR_CODE_SIP_PROVIDER_ERROR, "PUT", base, bad)
	sipFake.mu.Lock()
	sipFake.failTrunk = nil
	sipFake.mu.Unlock()
	o.must(200, "GET", base, nil, &g)
	if g.GetSettings().GetLastError() != "invalid trunk address" || g.GetSettings().GetHost() != "203.0.113.10" || g.GetSettings().GetPort() != 5080 || g.GetSettings().GetOutboundPrefix() != "8" {
		t.Fatalf("after a refusal: %v", g.GetSettings())
	}
	o.must(200, "PUT", base, keep, &put) // a good save clears last_error
	if put.GetSettings().GetLastError() != "" {
		t.Fatal("last_error kept")
	}

	// Who may call: the bit (nobody by default), guests never, only from inside the call.
	num := &v1.PlaceSipCallRequest{Number: "+7 916 123-45-67"}
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", calls, num)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
	}}, nil)
	bob.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", calls, num) // not in the call
	joinVoice(t, bob, wid, rid)
	bob.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "POST", calls, &v1.PlaceSipCallRequest{Number: "916 123"})
	bob.wantErr(422, v1.ErrorCode_ERROR_CODE_SIP_NUMBER_NOT_ALLOWED, "POST", calls, &v1.PlaceSipCallRequest{Number: "+44 20 7946 0958"})

	g1 := dialGW(t)
	g1.identify(o.token)

	// Place → DIALING, the dial goes to LiveKit; a second call in the room is refused.
	var pc v1.SipCallResponse
	bob.must(201, "POST", calls, num, &pc)
	c1 := pc.GetCall()
	if c1.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_DIALING || c1.GetNumber() != "+79161234567" || c1.GetStartedBy() != bob.id ||
		c1.GetParticipantIdentity() != "sip:"+c1.GetId() || c1.GetRoomId() != rid {
		t.Fatalf("placed: %v", c1)
	}
	d := sipFake.dialed(t, c1.GetParticipantIdentity())
	if d.CallTo != "879161234567" || d.Room != "ws_"+wid+"_room_"+rid || d.TrunkID != acct.TrunkID || !d.WaitUntilAnswered || d.Name != "+79161234567" {
		t.Fatalf("dial: %+v", d)
	}
	g1.wait("SIP_CALL_UPDATE dialing", func(e *v1.DispatchEvent) bool {
		return e.GetSipCallUpdate().GetCall().GetId() == c1.GetId() && e.GetSipCallUpdate().GetCall().GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_DIALING
	})
	bob.wantErr(409, v1.ErrorCode_ERROR_CODE_SIP_CALL_ACTIVE, "POST", calls, num)

	// The line joins ringing, then the callee answers.
	sipWebhook(t, "participant_joined", wid, rid, c1.GetParticipantIdentity(), map[string]string{"sip.callStatus": "ringing"})
	g1.wait("SIP_CALL_UPDATE ringing", func(e *v1.DispatchEvent) bool {
		return e.GetSipCallUpdate().GetCall().GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_RINGING
	})
	sipFake.answer(c1.GetParticipantIdentity())
	ev := g1.wait("SIP_CALL_UPDATE active", func(e *v1.DispatchEvent) bool {
		return e.GetSipCallUpdate().GetCall().GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE
	})
	if ev.GetSipCallUpdate().GetCall().GetAnsweredAt() == nil {
		t.Fatal("answered_at")
	}
	// READY carries the live call.
	g2 := dialGW(t)
	ready := g2.identify(bob.token)
	found := false
	for _, w := range ready.GetWorkspaces() {
		if w.GetWorkspace().GetId() == wid {
			found = len(w.GetSipCalls()) == 1 && w.GetSipCalls()[0].GetId() == c1.GetId() && w.GetWorkspace().GetSipEnabled()
		}
	}
	if !found {
		t.Fatal("READY without the live call")
	}
	// The callee hangs up: the line leaves → ENDED remote.
	sipWebhook(t, "participant_left", wid, rid, c1.GetParticipantIdentity(), nil)
	if c := sipCallStatus(t, o, wid, c1.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "remote" || c.GetEndedAt() == nil {
		t.Fatalf("remote hangup: %v", c)
	}

	// Cancel while dialing: the caller hangs up; a late answer takes the line out again.
	bob.must(201, "POST", calls, num, &pc)
	c2 := pc.GetCall()
	sipFake.dialed(t, c2.GetParticipantIdentity())
	alice := register(t, invite(t, o, wid))
	alice.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "DELETE", calls+"/"+c2.GetId(), nil) // no MUTE_MEMBERS
	var hr v1.SipCallResponse
	bob.must(200, "DELETE", calls+"/"+c2.GetId(), nil, &hr)
	if hr.GetCall().GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ENDED || hr.GetCall().GetReason() != "cancelled" || hr.GetCall().GetEndedBy() != bob.id {
		t.Fatalf("cancel: %v", hr.GetCall())
	}
	bob.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "DELETE", calls+"/"+c2.GetId(), nil)
	sipFake.answer(c2.GetParticipantIdentity())
	waitUntil(t, "late line removed", func() bool { return countRemoved(c2.GetParticipantIdentity()) >= 2 })
	if c := sipCallStatus(t, o, wid, c2.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "cancelled" {
		t.Fatalf("late answer changed the call: %v", c)
	}

	// A moderator (MUTE_MEMBERS: the owner) ends someone's active call.
	bob.must(201, "POST", calls, num, &pc)
	c3 := pc.GetCall()
	sipFake.answer(c3.GetParticipantIdentity())
	sipCallStatus(t, o, wid, c3.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE)
	o.must(200, "DELETE", calls+"/"+c3.GetId(), nil, &hr)
	if hr.GetCall().GetReason() != "hangup_moderator" || !lkRec.wasRemoved(c3.GetParticipantIdentity()) {
		t.Fatalf("moderator hangup: %v", hr.GetCall())
	}

	// The provider answers busy → FAILED busy.
	bob.must(201, "POST", calls, num, &pc)
	c4 := pc.GetCall()
	sipFake.fail(c4.GetParticipantIdentity(), 486, "Busy Here")
	sipCallStatus(t, o, wid, c4.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_FAILED)
	if c := sipCallStatus(t, o, wid, c4.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_FAILED); c.GetReason() != "busy" || c.GetAnsweredAt() != nil {
		t.Fatalf("busy: %v", c)
	}

	// Everybody leaves the room's call: the phone call is hung up (ENDED empty).
	bob.must(201, "POST", calls, num, &pc)
	c5 := pc.GetCall()
	sipFake.answer(c5.GetParticipantIdentity())
	sipCallStatus(t, o, wid, c5.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE)
	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j) // the device's identity
	webhook(t, whEvent("participant_left", "ws_"+wid+"_room_"+rid, j.GetIdentity(), nil), "secret")
	if c := sipCallStatus(t, o, wid, c5.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "empty" || !lkRec.wasRemoved(c5.GetParticipantIdentity()) {
		t.Fatalf("empty room: %v", c)
	}
	joinVoice(t, bob, wid, rid)

	// The hourly limit per workspace (a limiter of 1 for the test).
	saved := testApp.SIP.CallLimit
	testApp.SIP.CallLimit = redisx.NewRateLimiter(testRedis, "rl:sip-call-it:", 1, 0.001)
	bob.must(201, "POST", calls, num, &pc)
	c6 := pc.GetCall()
	sipFake.fail(c6.GetParticipantIdentity(), 480, "Temporarily Unavailable")
	sipCallStatus(t, o, wid, c6.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_FAILED)
	bob.wantErr(429, v1.ErrorCode_ERROR_CODE_SIP_RATE_LIMITED, "POST", calls, num)
	testApp.SIP.CallLimit = saved

	// Guests never call, whatever the room says.
	off := false
	inv := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{RequireApproval: &off})
	guest, _ := anonGuest(t, inv.GetCode(), "Гость")
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: guest.id, Allow: uint64(perm.ViewRoom | perm.Connect | perm.PlaceCalls)},
	}}, nil)
	guest.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", calls, num)
	guest.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "GET", base, nil)

	// Bots: settings are people-only; calls follow the bit and being in the call.
	b := createBot(t, o, wid, "Dialer")
	b.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "GET", base, nil)
	if reason, _ := errReason(b.client); reason != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot settings: %q", reason)
	}
	b.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", calls, num) // no PLACE_CALLS
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: b.id, Allow: uint64(perm.PlaceCalls)},
	}}, nil)
	b.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", calls, num) // allowed, but not in the call
	var bj v1.JoinVoiceResponse
	b.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, bj.GetIdentity(), nil), "secret")
	b.must(201, "POST", calls, num, &pc)
	c7 := pc.GetCall()
	b.must(200, "DELETE", calls+"/"+c7.GetId(), nil, &hr)
	if hr.GetCall().GetReason() != "cancelled" {
		t.Fatalf("bot hangup: %v", hr.GetCall())
	}
	sipFake.fail(c7.GetParticipantIdentity(), 487, "Request Terminated")

	// The journal: newest first, MANAGE_WORKSPACE only, time filters.
	var jr v1.ListSipCallsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/calls", nil, &jr)
	if len(jr.GetCalls()) != 7 || jr.GetCalls()[0].GetId() != c7.GetId() || jr.GetCalls()[6].GetId() != c1.GetId() || jr.GetNextCursor() != "" {
		t.Fatalf("journal: %d calls", len(jr.GetCalls()))
	}
	o.must(200, "GET", "/api/workspaces/"+wid+"/calls?to="+start.UTC().Format(time.RFC3339), nil, &jr)
	if len(jr.GetCalls()) != 0 {
		t.Fatal("to filter")
	}
	o.must(200, "GET", "/api/workspaces/"+wid+"/calls?cursor="+c2.GetId(), nil, &jr)
	if len(jr.GetCalls()) != 1 || jr.GetCalls()[0].GetId() != c1.GetId() {
		t.Fatalf("cursor: %v", jr.GetCalls())
	}
	o.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "GET", "/api/workspaces/"+wid+"/calls?from=yesterday", nil)
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "GET", "/api/workspaces/"+wid+"/calls", nil)

	// The connection test calls the caller ID: busy proves the account works; 401 does not.
	sipFake.mu.Lock()
	sipFake.auto = func(c rtc.SIPCall) (rtc.SIPParticipant, error) {
		if c.CallTo != "874951234567" || !strings.HasPrefix(c.Room, "sip-test_") {
			t.Errorf("test dial: %+v", c)
		}
		// LiveKit's max_call_duration covers ringing too: it must outlast the ringing timeout.
		if c.MaxCallDuration <= c.RingingTimeout {
			t.Errorf("test dial cut before the ringing timeout: %+v", c)
		}
		return rtc.SIPParticipant{}, &rtc.Error{Status: 503, Code: "unavailable", Meta: map[string]string{"sip_status_code": "486", "sip_status": "Busy Here"}}
	}
	sipFake.mu.Unlock()
	var tr1 v1.TestSipResponse
	o.must(200, "POST", base+"/test", nil, &tr1)
	if !tr1.GetOk() || tr1.GetSipStatus() != 486 || tr1.GetMessage() != "486 Busy Here" {
		t.Fatalf("test busy: %v", &tr1)
	}
	sipFake.mu.Lock()
	sipFake.auto = func(rtc.SIPCall) (rtc.SIPParticipant, error) {
		return rtc.SIPParticipant{}, &rtc.Error{Status: 503, Code: "unavailable", Meta: map[string]string{"sip_status_code": "401", "sip_status": "Unauthorized"}}
	}
	sipFake.mu.Unlock()
	o.must(200, "POST", base+"/test", nil, &tr1)
	o.must(200, "GET", base, nil, &g)
	if tr1.GetOk() || g.GetSettings().GetLastError() != "401 Unauthorized" {
		t.Fatalf("test 401: %v / %v", &tr1, g.GetSettings())
	}
	// LiveKit's ringing timeout with no ringing seen: a failure that says what timed out.
	sipFake.mu.Lock()
	sipFake.auto = func(rtc.SIPCall) (rtc.SIPParticipant, error) {
		return rtc.SIPParticipant{}, &rtc.Error{Status: 499, Code: "canceled", Msg: "sip request timed out"}
	}
	sipFake.mu.Unlock()
	o.must(200, "POST", base+"/test", nil, &tr1)
	if tr1.GetOk() || !strings.Contains(tr1.GetMessage(), "did not answer the call within 15 s") {
		t.Fatalf("test timed out: %v", &tr1)
	}
	sipFake.mu.Lock()
	sipFake.auto = nil
	sipFake.mu.Unlock()
	bob.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", base+"/test", nil)

	// The sweeper ends an active call past the 2 h cap even if LiveKit did not (backstop).
	bob.must(201, "POST", calls, num, &pc)
	cLong := pc.GetCall()
	sipFake.answer(cLong.GetParticipantIdentity())
	sipCallStatus(t, o, wid, cLong.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE)
	if _, err := testDB.Pool.Exec(context.Background(),
		"UPDATE sip_calls SET started_at = now() - interval '3 hours', answered_at = now() - interval '3 hours' WHERE id = $1", cLong.GetId()); err != nil {
		t.Fatal(err)
	}
	if err := testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("sip:sweep")).Build()).Error(); err != nil {
		t.Fatal(err)
	}
	testApp.SIP.Sweep(context.Background())
	if c := sipCallStatus(t, o, wid, cLong.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "remote" || !lkRec.wasRemoved(cLong.GetParticipantIdentity()) {
		t.Fatalf("2 h cap: %v", c)
	}

	// Switching telephony off deletes the trunk, ends live calls and refuses new ones.
	bob.must(201, "POST", calls, num, &pc)
	c8 := pc.GetCall()
	sipFake.answer(c8.GetParticipantIdentity())
	sipCallStatus(t, o, wid, c8.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE)
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: false, Host: "203.0.113.10:5060", CallerId: "+74951234567"}, &put)
	if put.GetSettings().GetTrunkSaved() || !put.GetSettings().GetHasPassword() {
		t.Fatalf("off: %v", put.GetSettings())
	}
	sipFake.mu.Lock()
	deleted := len(sipFake.deletes) > 0 && sipFake.deletes[len(sipFake.deletes)-1] == acct.TrunkID
	sipFake.mu.Unlock()
	if !deleted {
		t.Fatal("trunk not deleted")
	}
	if c := sipCallStatus(t, o, wid, c8.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "disabled" {
		t.Fatalf("off ends calls: %v", c)
	}
	bob.wantErr(409, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, "POST", calls, num)
	o.wantErr(409, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, "POST", base+"/test", nil)
	bob.must(200, "GET", "/api/workspaces/"+wid, nil, &gw1)
	if gw1.GetWorkspace().GetSipEnabled() {
		t.Fatal("Workspace.sip_enabled still set")
	}
}

func countRemoved(identity string) int {
	lkRec.mu.Lock()
	defer lkRec.mu.Unlock()
	n := 0
	for _, id := range lkRec.removed {
		if id == identity {
			n++
		}
	}
	return n
}

// TestSIPDialingSeenByRoom: while the line dials, every viewer of the room — people in its call
// and members outside it — gets SIP_CALL_UPDATE DIALING (not only the caller, not only on the
// answer); a moderator may end it while it rings; busy / cancel reach everyone as a final status.
func TestSIPDialingSeenByRoom(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}) // telephony is Business only
	calls := "/api/rooms/" + rid + "/calls"
	alice := register(t, invite(t, o, wid)) // in the room's call, no PLACE_CALLS
	carol := register(t, invite(t, o, wid)) // a member outside the call
	pw := "pw"
	o.must(200, "PUT", "/api/workspaces/"+wid+"/sip", &v1.PutSipSettingsRequest{Enabled: true, Host: "203.0.113.10",
		Username: "u", Password: &pw, CallerId: "+74951234567", AllowedPrefixes: []string{"+7"}}, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
	}}, nil)
	joinVoice(t, bob, wid, rid)
	joinVoice(t, alice, wid, rid)
	ga, gc := dialGW(t), dialGW(t)
	ga.identify(alice.token)
	gc.identify(carol.token)
	status := func(g *gw, what, id string, want v1.SipCallStatus) *v1.SipCall {
		t.Helper()
		return g.wait(what, func(e *v1.DispatchEvent) bool {
			c := e.GetSipCallUpdate().GetCall()
			return c.GetId() == id && c.GetStatus() == want
		}).GetSipCallUpdate().GetCall()
	}
	num := &v1.PlaceSipCallRequest{Number: "+7 916 123-45-67"}

	// Dialing: the others see the line before any answer (the dial is still blocked in LiveKit).
	var pc v1.SipCallResponse
	bob.must(201, "POST", calls, num, &pc)
	c1 := pc.GetCall()
	sipFake.dialed(t, c1.GetParticipantIdentity())
	for _, g := range []*gw{ga, gc} {
		if c := status(g, "dialing", c1.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_DIALING); c.GetNumber() != "+79161234567" ||
			c.GetRoomId() != rid || c.GetStartedBy() != bob.id || c.GetParticipantIdentity() != "sip:"+c1.GetId() {
			t.Fatalf("dialing event: %v", c)
		}
	}
	// A reconnect while dialing (it replaces carol's session): READY carries the dialing line.
	gc = dialGW(t)
	ready := gc.identify(carol.token)
	seen := false
	for _, w := range ready.GetWorkspaces() {
		if w.GetWorkspace().GetId() == wid {
			seen = len(w.GetSipCalls()) == 1 && w.GetSipCalls()[0].GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_DIALING
		}
	}
	if !seen {
		t.Fatal("READY without the dialing line")
	}
	// Busy → FAILED busy for everyone.
	sipFake.fail(c1.GetParticipantIdentity(), 486, "Busy Here")
	for _, g := range []*gw{ga, gc} {
		if c := status(g, "failed", c1.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_FAILED); c.GetReason() != "busy" {
			t.Fatalf("busy: %v", c)
		}
	}

	// A moderator (MUTE_MEMBERS: the owner) ends a ringing line; alice (no MUTE_MEMBERS) may not.
	bob.must(201, "POST", calls, num, &pc)
	c2 := pc.GetCall()
	sipFake.dialed(t, c2.GetParticipantIdentity())
	status(ga, "dialing 2", c2.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_DIALING)
	alice.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "DELETE", calls+"/"+c2.GetId(), nil)
	o.must(200, "DELETE", calls+"/"+c2.GetId(), nil, nil)
	for _, g := range []*gw{ga, gc} {
		if c := status(g, "cancelled", c2.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ENDED); c.GetReason() != "cancelled" {
			t.Fatalf("cancel: %v", c)
		}
	}
	sipFake.fail(c2.GetParticipantIdentity(), 487, "Request Terminated")
}

// TestSIPPlanBusinessOnly (owner, 02.10, ADR-0046): telephony is Business only. Free and Team
// refuse saving an enabled trunk, the connection test and calls with 409 PLAN_LIMIT; after a
// downgrade the trunk stays readable, a live call is not cut and can be hung up, but new calls,
// tests and re-saving it enabled are refused; turning it off always works.
func TestSIPPlanBusinessOnly(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	base := "/api/workspaces/" + wid + "/sip"
	calls := "/api/rooms/" + rid + "/calls"
	pw := "pw"
	enable := &v1.PutSipSettingsRequest{Enabled: true, Host: "203.0.113.10", Username: "u", Password: &pw, CallerId: "+74951234567"}
	num := &v1.PlaceSipCallRequest{Number: "+7 916 123-45-67"}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
	}}, nil)
	joinVoice(t, bob, wid, rid)

	// Free (no plan row) and Team: settings readable, enabling / testing / calling refused.
	for _, p := range []v1.Plan{v1.Plan_PLAN_FREE, v1.Plan_PLAN_TEAM} {
		if p != v1.Plan_PLAN_FREE {
			setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: p})
		}
		o.must(200, "GET", base, nil, nil)
		st, e := o.apiErrBody("PUT", base, enable)
		wantPlanLimit(t, p.String()+" trunk save", st, e, 0, 0)
		st, e = o.apiErrBody("POST", base+"/test", nil)
		wantPlanLimit(t, p.String()+" connection test", st, e, 0, 0)
		st, e = bob.apiErrBody("POST", calls, num)
		wantPlanLimit(t, p.String()+" call", st, e, 0, 0)
	}
	if _, err := testDB.Q.GetSipAccount(context.Background(), uuid.MustParse(wid)); err == nil {
		t.Fatal("a refused save stored the account")
	}

	// Business: the trunk is saved and a call goes through.
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	var put v1.PutSipSettingsResponse
	o.must(200, "PUT", base, enable, &put)
	if !put.GetSettings().GetTrunkSaved() {
		t.Fatalf("business save: %v", put.GetSettings())
	}
	var pc v1.SipCallResponse
	bob.must(201, "POST", calls, num, &pc)
	c1 := pc.GetCall()
	sipFake.answer(c1.GetParticipantIdentity())
	sipCallStatus(t, o, wid, c1.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE)

	// Downgrade to Team: nothing is deleted, the live call goes on.
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, OverrideLimits: true}) // the trunk is on: over Team (ADR-0086)
	var g v1.GetSipSettingsResponse
	o.must(200, "GET", base, nil, &g)
	if !g.GetSettings().GetEnabled() || !g.GetSettings().GetTrunkSaved() || g.GetSettings().GetHost() != "203.0.113.10" {
		t.Fatalf("downgraded settings: %v", g.GetSettings())
	}
	o.must(200, "GET", "/api/workspaces/"+wid+"/calls", nil, nil)
	if c := sipCallStatus(t, o, wid, c1.GetId(), v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE); c.GetEndedAt() != nil {
		t.Fatalf("downgrade cut the call: %v", c)
	}
	st, e := o.apiErrBody("PUT", base, enable)
	wantPlanLimit(t, "downgraded trunk save", st, e, 0, 0)
	st, e = o.apiErrBody("POST", base+"/test", nil)
	wantPlanLimit(t, "downgraded connection test", st, e, 0, 0)
	var hr v1.SipCallResponse
	bob.must(200, "DELETE", calls+"/"+c1.GetId(), nil, &hr) // hanging up always works
	if hr.GetCall().GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ENDED {
		t.Fatalf("hangup: %v", hr.GetCall())
	}
	st, e = bob.apiErrBody("POST", calls, num)
	wantPlanLimit(t, "downgraded call", st, e, 0, 0)
	acct, err := testDB.Q.GetSipAccount(context.Background(), uuid.MustParse(wid))
	if err != nil || acct.TrunkID == "" || !acct.Enabled {
		t.Fatalf("the downgrade dropped the trunk: %+v %v", acct, err)
	}
	sipFake.mu.Lock()
	for _, id := range sipFake.deletes {
		if id == acct.TrunkID {
			t.Error("the downgrade deleted the trunk in LiveKit")
		}
	}
	sipFake.mu.Unlock()
	// Turning telephony off is always allowed.
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: false, Host: "203.0.113.10", CallerId: "+74951234567"}, &put)
	if put.GetSettings().GetEnabled() {
		t.Fatalf("off: %v", put.GetSettings())
	}
}
