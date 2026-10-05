//go:build integration

// ADR-0065: EMAIL_VERIFICATION=optional — an unconfirmed address blocks no action, but it is
// still never trusted (email invitations, add-by-email, OAuth claims, superadmin).
package app_test

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/mail"
)

// optionalServer runs a second app on the shared DB / Redis / mail fake with
// EMAIL_VERIFICATION=optional and points the test client at it for the rest of the test.
func optionalServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := *testCfg
	cfg.EmailVerification = config.EmailVerificationOptional
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore,
		LiveKit: lkRec, Mail: testMail})
	ctx, cancel := context.WithCancel(context.Background())
	a.Run(ctx)
	s := httptest.NewServer(a.Handler)
	old := srv.URL
	srv.URL = s.URL
	t.Cleanup(func() { srv.URL = old; s.Close(); cancel() })
	time.Sleep(150 * time.Millisecond) // pub/sub subscribed
	return s
}

func verifyCodes(addr string) int {
	return testMail.Count(func(m mail.Message) bool { return m.Template == mail.TemplateVerifyCode && m.To == addr })
}

// With optional: an unconfirmed account creates workspaces, invitations and DMs; nothing is
// mailed unasked; the address stays unconfirmed until the user confirms it from the settings.
func TestOptionalVerifyUnblocksActions(t *testing.T) {
	s := optionalServer(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	email := uniq("optv") + "@example.com"
	u, resp := registerRaw(t, email, invite(t, o, ws.GetId()), "")
	if resp.GetMe().GetEmailVerified() || !resp.GetEmailVerificationOptional() || resp.GetEmailInvitePending() {
		t.Fatalf("register: %v", resp)
	}

	var own v1.CreateWorkspaceResponse
	u.must(201, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: uniq("ws-"), Name: "Mine"}, &own)
	path := "/api/workspaces/" + own.GetWorkspace().GetId()
	u.must(201, "POST", path+"/invites", &v1.CreateInviteRequest{MaxUses: 1}, nil)
	u.must(201, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("someone") + "@example.com"}, nil)
	u.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: o.id}, nil)

	// Still unconfirmed everywhere.
	var me v1.GetMeResponse
	u.must(200, "GET", "/api/me", nil, &me)
	if me.GetMe().GetEmailVerified() {
		t.Fatal("GET /api/me: verified without a code")
	}
	var at *time.Time
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT email_verified_at FROM users WHERE id = $1", u.id).Scan(&at); err != nil || at != nil {
		t.Fatalf("email_verified_at = %v (%v)", at, err)
	}
	var login v1.LoginResponse
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &login)
	if !login.GetEmailVerificationOptional() || login.GetEmailInvitePending() || login.GetMe().GetEmailVerified() {
		t.Fatalf("login: %v", &login)
	}
	g := dialAt(t, s.URL)
	ready := g.identify(u.token)
	if !ready.GetEmailVerificationOptional() || ready.GetEmailInvitePending() || ready.GetMe().GetEmailVerified() {
		t.Fatalf("READY: optional=%v verified=%v", ready.GetEmailVerificationOptional(), ready.GetMe().GetEmailVerified())
	}
	_ = g.ws.CloseNow()
	// Neither the sign-up nor the sign-in mailed a code: nothing asks for it.
	time.Sleep(500 * time.Millisecond) // the outbox polls every 200 ms
	if n := verifyCodes(email); n != 0 {
		t.Fatalf("%d verification codes mailed unasked", n)
	}

	// Confirming stays available (Settings → «Подтвердить»).
	u.must(204, "POST", "/api/auth/verify/send", nil, nil)
	var vr v1.VerifyEmailResponse
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: nthMail(t, 1, mail.TemplateVerifyCode, email).Params["code"]}, &vr)
	if !vr.GetMe().GetEmailVerified() {
		t.Fatal("not verified after the code")
	}
}

// The required mode (the shared server) keeps answering false.
func TestOptionalVerifyRequiredModeFlag(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u, resp := registerRaw(t, uniq("reqv")+"@example.com", invite(t, o, ws.GetId()), "")
	if resp.GetEmailVerificationOptional() || resp.GetEmailInvitePending() {
		t.Fatal("register: optional in the required mode")
	}
	u.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: uniq("ws-"), Name: "X"})
	u.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/dms", &v1.CreateDmRequest{UserId: o.id})
	g := dialGW(t)
	if r := g.identify(u.token); r.GetEmailVerificationOptional() || r.GetEmailInvitePending() {
		t.Fatal("READY: optional in the required mode")
	}
	_ = g.ws.CloseNow()
}

// The squatting threat stays closed with optional: someone registers ivan@… before Ivan.
// An admin looking Ivan up / adding him by id does not get that account, an email
// invitation does not join it until the address is confirmed, and the invitee is asked to
// confirm (email_invite_pending).
func TestOptionalVerifySquatting(t *testing.T) {
	s := optionalServer(t)
	o := owner(t)
	ivan := uniq("ivan") + "@example.com"
	squatter, resp := registerRaw(t, ivan, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()), "")
	if !resp.GetEmailVerificationOptional() || resp.GetEmailInvitePending() {
		t.Fatalf("register: %v", resp)
	}

	admin, ws := wsOwner(t)
	path := "/api/workspaces/" + ws.GetId()
	var lr v1.InviteLookupResponse
	admin.must(200, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: ivan}, &lr)
	if lr.GetUser() != nil {
		t.Fatal("lookup found the unconfirmed account")
	}
	admin.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "POST", path+"/members", &v1.AddMemberRequest{UserId: squatter.id})

	// An email invitation for the address: no auto-join, the join by its code needs the
	// confirmation, and the account is asked to confirm from now on.
	code := emailInviteCode(t, admin, ws.GetId(), ivan)
	if st := squatter.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member without confirming: %d", st)
	}
	squatter.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/invites/"+code+"/join", nil)
	if st := squatter.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member after the join attempt: %d", st)
	}
	var login v1.LoginResponse
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: ivan, Password: "password123"}, &login)
	if !login.GetEmailVerificationOptional() || !login.GetEmailInvitePending() {
		t.Fatal("login: no prompt while an email invitation waits for the address")
	}
	g := dialAt(t, s.URL)
	if !g.identify(squatter.token).GetEmailInvitePending() {
		t.Fatal("READY: no prompt while an email invitation waits for the address")
	}
	_ = g.ws.CloseNow()
	// Superadmin and OAuth never see an unconfirmed address as proven (pbconv, oauthprovider
	// check email_verified_at themselves; auth.TestEmailTrustInventory pins that).
	var me v1.GetMeResponse
	squatter.must(200, "GET", "/api/me", nil, &me)
	if me.GetMe().GetEmailVerified() || me.GetMe().GetIsSuperadmin() {
		t.Fatalf("me: %v", me.GetMe())
	}

	// Signing up from an email invitation: not joined yet, asked to confirm, code mailed.
	invited := uniq("invited") + "@example.com"
	code2 := emailInviteCode(t, admin, ws.GetId(), invited)
	u2, resp2 := registerRaw(t, invited, code2, "")
	if !resp2.GetEmailInvitePending() || resp2.GetMe().GetEmailVerified() {
		t.Fatalf("register by email invitation: %v", resp2)
	}
	if st := u2.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member before confirming: %d", st)
	}
	if vr := verifyAddr(t, u2); len(vr.GetJoinedWorkspaceIds()) != 1 || vr.GetJoinedWorkspaceIds()[0] != ws.GetId() {
		t.Fatalf("verify: %v", vr)
	}
	u2.must(200, "GET", path, nil, nil)
}
