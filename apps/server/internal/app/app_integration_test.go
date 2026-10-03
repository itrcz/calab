//go:build integration

// Integration tests against real Postgres 18 + Redis (infra/docker/compose.dev.yml).
//
//	TEST_DATABASE_URL  admin URL of an existing database (default postgres://calaba:calaba@localhost:55432/calaba)
//	TEST_REDIS_URL     default redis://localhost:56379/15 (the DB is flushed)
//	TEST_REDIS_KEY_PREFIX  key namespace of the run (REDIS_KEY_PREFIX), default calab:, empty = none;
//	                   after the run every key of the DB must be inside it (redistest.Foreign)
//	TEST_LIVEKIT_URL / TEST_LIVEKIT_INTERNAL_URL  dev LiveKit (devkey/secret), default localhost:7880;
//	                   rtc tests that need LiveKit are skipped when it is unreachable
//
// Every run creates a throwaway database calaba_it_<random>, migrates it and drops it.
package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/redisx/redistest"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/redis/rueidis"
)

var (
	srv       *httptest.Server
	testApp   *app.App
	testDB    *db.DB
	testRedis rueidis.Client
	testCfg   *config.Config
	lkRec     *recordingLiveKit
	testStore *blob.FS
	// testRedisURL is TEST_REDIS_URL with the logical DB leased for this run (leaseRedisDB).
	testRedisURL string
	// testMail records the mail the server sends (ADR-0023).
	testMail = mail.NewFake()
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestMain(m *testing.M) {
	flag.Parse()
	// `go test -list` only prints names: no database, Redis or LiveKit (the CI shard coverage check
	// runs it in the go job, which has no services).
	if f := flag.Lookup("test.list"); f != nil && f.Value.String() != "" {
		os.Exit(m.Run())
	}
	os.Exit(run(m))
}

func run(m *testing.M) int {
	ctx := context.Background()
	if !testing.Verbose() {
		slog.SetDefault(slog.New(slog.DiscardHandler))
	}
	// Admin connection only: every run creates and drops its own database calaba_it_<random>.
	adminURL := env("TEST_PG_URL", env("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "integration: postgres unavailable:", err)
		return 1
	}
	defer func() { _ = admin.Close(ctx) }()
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := "calaba_it_" + hex.EncodeToString(b[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		fmt.Fprintln(os.Stderr, "create db:", err)
		return 1
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()

	storageDir, err := os.MkdirTemp("", "calaba-it-files-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() { _ = os.RemoveAll(storageDir) }()
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	d, err := db.Connect(ctx, u.String())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer d.Close()
	if err := d.Migrate(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	redisURL, releaseDB, err := leaseRedisDB(ctx, env("TEST_REDIS_URL", "redis://localhost:56379/15"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "integration: redis unavailable:", err)
		return 1
	}
	defer releaseDB()
	testRedisURL = redisURL
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "integration: redis unavailable:", err)
		return 1
	}
	defer rc.Close()
	_ = rc.Do(ctx, rc.B().Flushdb().Build()).Error()

	egressURL, stopFakes, err := startRecordingFakes()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer stopFakes()

	cfg := &config.Config{
		DatabaseURL:      u.String(),
		RedisKeyPrefix:   redistest.Prefix(),
		JWTSecret:        "integration-secret-integration-secret",
		AccessTokenTTL:   24 * time.Hour, // the defaults (config.go): revocation must not lean on expiry
		RefreshTokenTTL:  8760 * time.Hour,
		RegistrationMode: config.RegistrationInvite,
		PublicAppURL:     "https://app.example.com",
		// Abuse limits are exercised separately (TestAbuseLimits) with small values.
		LoginAccountBurst:          1000,
		MaxWorkspacesPerUser:       1000,
		WorkspaceCreatesPerHour:    1000,
		StorageMaxTotalBytes:       1 << 40,
		DefaultWorkspaceQuotaBytes: 10 << 30,
		DefaultPersonalQuotaBytes:  1 << 30,
		PublicAppURLAlt:            "https://app.example.ru",
		PublicAppURLs:              []string{"https://app.example.com", "https://alias.example.org"},
		AuthRateBurst:              5,
		AuthRatePerMinute:          1,
		MaxFileSizeMB:              1,        // small, so the size limit is testable
		FFmpegPath:                 "ffmpeg", // HEIC conversion: tested when ffmpeg ≥ 7.1 is on PATH
		FFprobePath:                "ffprobe",
		StorageDriver:              "fs",
		StoragePath:                storageDir,
		HeartbeatInterval:          41 * time.Second,
		MaxDevicesPerUser:          5,
		LiveKitURL:                 env("TEST_LIVEKIT_URL", "ws://localhost:7880"),
		LiveKitInternalURL:         env("TEST_LIVEKIT_INTERNAL_URL", "http://localhost:7880"),
		LiveKitAPIKey:              "devkey",
		LiveKitAPISecret:           "secret",
		LiveKitMaxParticipants:     50,
		// Plans (ADR-0024): no plan limits by default, so other tests see room settings only;
		// plans_integration_test sets the free limits it needs.
		PlanFreeLimits:        unlimitedPlan,
		PlanContactEmail:      "it@gptunnel.ai",
		SuperadminEmails:      []string{superadminEmail, superadminEmail2},
		MailPerAddressPerHour: 3,
		MailPerHour:           1 << 20, // every test user gets a verification code
		// Recording (ADR-0025): fakes of GPTunneL and the egress, see recording_integration_test.
		GPTunnelAPIURL:         gptFake.URL,
		GPTunnelWebURL:         "https://gptunnel.ru",
		RecordingKeepDays:      30,
		TempRoomRetentionDays:  90,
		RecordingMaxConcurrent: 2,
		RecordingsPath:         recordDir,
		RecordingEgressDir:     "/out",
	}
	cfg.TrustedProxies = mustPrefixes("127.0.0.1/32", "::1/128")
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	store, err := blob.NewFS(storageDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	lkRec = &recordingLiveKit{LiveKit: rtc.NewLiveKit(cfg.LiveKitInternalURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret)}
	a := app.New(app.Deps{Config: cfg, DB: d, Redis: rc, Events: events.Redis{C: rc}, Blob: store, LiveKit: lkRec,
		UnfurlAllowAddr: func(netip.Addr) bool { return true }, // test pages are served on loopback
		Mail:            testMail,
		Egress:          rtc.NewEgress(egressURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret),
		BotWebhooks:     botWebhookOptions,
		CalDAV:          calDAVOptions,
		SIP:             sipFake})
	a.Recording.Tick, a.Recording.PollMin = 100*time.Millisecond, 50*time.Millisecond
	a.Recording.ResultBackoff = []time.Duration{50 * time.Millisecond, 50 * time.Millisecond}
	a.Mail.Poll = 200 * time.Millisecond
	testApp, testDB, testRedis, testCfg, testStore = a, d, rc, cfg, store
	bg, stop := context.WithCancel(ctx)
	defer stop()
	holdReconcileLock(bg, rc)
	a.Run(bg)
	srv = httptest.NewServer(a.Handler)
	defer srv.Close()
	time.Sleep(200 * time.Millisecond) // pub/sub subscription established
	code := m.Run()
	// Every key the run left in its DB must be inside the namespace: a name built without
	// redisx.Key escapes it (docs/06 «Общий Valkey»). The harness's leases live in DB 0.
	if foreign, err := redistest.Foreign(ctx, rc, cfg.RedisKeyPrefix, leaseKeyPrefix); err != nil || len(foreign) > 0 {
		fmt.Fprintf(os.Stderr, "integration: %d keys outside the namespace %q (err %v), e.g. %q\n",
			len(foreign), cfg.RedisKeyPrefix, err, foreign[:min(len(foreign), 20)])
		code = max(code, 1)
	}
	return code
}

// ---- tiny client ----

type client struct {
	t     *testing.T
	token string
	ip    string // sent as X-Forwarded-For (the test server trusts loopback)
	lang  string // Accept-Language, if set
	// lastBody is the raw body of the last response (error bodies: see apiErr).
	lastBody []byte
}

func (c *client) do(method, path string, in, out proto.Message) int {
	c.t.Helper()
	var body io.Reader
	if in != nil {
		b, err := protojson.Marshal(in)
		if err != nil {
			c.t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, body)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.ip != "" {
		req.Header.Set("X-Forwarded-For", c.ip)
	}
	if c.lang != "" {
		req.Header.Set("Accept-Language", c.lang)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	c.lastBody = raw
	if out != nil && resp.StatusCode < 300 && len(raw) > 0 {
		if err := protojson.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: decode %s: %v", method, path, raw, err)
		}
	}
	if resp.StatusCode >= 400 && testing.Verbose() {
		c.t.Logf("%s %s -> %d %s", method, path, resp.StatusCode, raw)
	}
	return resp.StatusCode
}

// rawErr performs a request and decodes the ApiError body.
func (c *client) rawErr(method, path string) *v1.ApiError {
	c.t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	_ = protojson.Unmarshal(raw, &e)
	return &e
}

func (c *client) must(want int, method, path string, in, out proto.Message) {
	c.t.Helper()
	if got := c.do(method, path, in, out); got != want {
		c.t.Fatalf("%s %s: status %d, want %d", method, path, got, want)
	}
}

var seq int

func uniq(prefix string) string {
	seq++
	return fmt.Sprintf("%s%d-%d", prefix, time.Now().UnixNano()%1e6, seq)
}

type user struct {
	*client
	id      string
	refresh string
	session string
	email   string
}

// register creates a user. The first call of the test binary bootstraps the server
// (REGISTRATION_MODE=invite allows only the very first user without an invite).
func register(t *testing.T, invite string) *user {
	t.Helper()
	seq++
	c := &client{t: t, ip: fmt.Sprintf("10.1.%d.%d", seq/250, seq%250+1)} // own rate-limit bucket
	var resp v1.RegisterResponse
	email := uniq("u") + "@example.com"
	c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: email, Password: "password123", DisplayName: email[:8], InviteCode: invite, DeviceName: "test",
	}, &resp)
	c.token = resp.GetTokens().GetAccessToken()
	// Most tests are not about email verification (ADR-0023): their users are verified.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET email_verified_at = now() WHERE id = $1", resp.GetMe().GetUser().GetId()); err != nil {
		t.Fatal(err)
	}
	return &user{client: c, id: resp.GetMe().GetUser().GetId(), refresh: resp.GetTokens().GetRefreshToken(), session: resp.GetTokens().GetSessionId(), email: email}
}

var bootstrapUser *user

func owner(t *testing.T) *user {
	t.Helper()
	if bootstrapUser == nil {
		bootstrapUser = register(t, "")
	}
	bootstrapUser.t = t
	// The shared owner uploads in many tests (badges, backgrounds, thumbnails, voice, …): reset
	// its upload bucket (30 at once, 120/h) so the order and number of tests never turn a valid
	// upload into a 429 (2026-09-29: TestVoiceMessages after the guest-admission tests).
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:upload:"+bootstrapUser.id)).Build()).Error()
	// Same for its meeting writes (30 at once, 120/h): calendar and identity tests share it.
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:event-write:"+bootstrapUser.id)).Build()).Error()
	// And its task creation (60 at once): the boards feature and checklist tests create many.
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:task-create:"+bootstrapUser.id)).Build()).Error()
	return bootstrapUser
}

func createWorkspace(t *testing.T, u *user, vis v1.WorkspaceVisibility) *v1.Workspace {
	t.Helper()
	var resp v1.CreateWorkspaceResponse
	u.must(201, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: uniq("ws-"), Name: "Team", Visibility: vis}, &resp)
	return resp.GetWorkspace()
}

func invite(t *testing.T, u *user, wsID string) string {
	t.Helper()
	var resp v1.CreateInviteResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{MaxUses: 10}, &resp)
	return resp.GetInvite().GetCode()
}

func roomPerms(t *testing.T, u *user, roomID string) (uint64, int) {
	t.Helper()
	var resp v1.GetRoomResponse
	st := u.do("GET", "/api/rooms/"+roomID, nil, &resp)
	return resp.GetPermissions(), st
}

func visibleRooms(t *testing.T, u *user, wsID string) map[string]*v1.Room {
	t.Helper()
	var resp v1.ListRoomsResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/rooms", nil, &resp)
	out := map[string]*v1.Room{}
	for _, r := range resp.GetRooms() {
		out[r.GetId()] = r
	}
	return out
}

func mustPrefixes(ss ...string) []netipPrefix { return parsePrefixes(ss) }

// ---- tests ----

func TestBootstrapAndInviteOnlyRegistration(t *testing.T) {
	o := owner(t)
	c := &client{t: t, ip: "10.0.0.2"}
	var e v1.ApiError
	if st := c.do("POST", "/api/auth/register", &v1.RegisterRequest{Email: "late@example.com", Password: "password123", DisplayName: "Late"}, &e); st != 403 {
		t.Fatalf("registration without invite after bootstrap: %d, want 403", st)
	}
	var me v1.GetMeResponse
	o.must(200, "GET", "/api/me", nil, &me)
	if me.GetMe().GetUser().GetId() != o.id {
		t.Fatal("GET /api/me returned another user")
	}
	name := "Owner Renamed"
	o.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{DisplayName: &name, Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_PUSH_TO_TALK, PushToTalkKey: "F13"}}, &me)
	if me.GetMe().GetUser().GetDisplayName() != name || me.GetMe().GetSettings().GetMicMode() != v1.MicMode_MIC_MODE_PUSH_TO_TALK {
		t.Fatalf("PATCH /api/me not applied: %v", me.GetMe())
	}
	// Invalid invite.
	if st := c.do("POST", "/api/auth/register", &v1.RegisterRequest{Email: "x@example.com", Password: "password123", DisplayName: "X", InviteCode: "nope"}, nil); st != 404 {
		t.Fatalf("bad invite: %d, want 404", st)
	}
}

func TestPermissionsFlow(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())

	alice := register(t, code) // member, will be allowed into the private room
	bob := register(t, code)   // member
	gus := register(t, code)   // becomes guest

	// Login works for invited users too.
	var login v1.LoginResponse
	(&client{t: t, ip: "10.0.1.1"}).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: mustEmail(t, alice), Password: "password123"}, &login)

	// Owner demotes gus to guest; members cannot change roles.
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	bob.must(403, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)

	// Members cannot create rooms.
	bob.must(403, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "x"}, nil)

	var general, secret, voice v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "general"}, &general)
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "secret", IsPrivate: true}, &secret)
	bitrate := uint32(64)
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "voice", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &bitrate},
	}, &voice)

	// Effective media = override over workspace defaults (32 kbps, h1080, 3 streams).
	vm := voice.GetRoom().GetMedia()
	if vm.GetAudioBitrateKbps() != 64 || vm.GetMaxStreamPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080 || vm.GetMaxStreams() != 3 {
		t.Fatalf("effective media: %v", vm)
	}
	if general.GetRoom().GetPosition() != 0 || secret.GetRoom().GetPosition() != 1 || voice.GetRoom().GetPosition() != 2 {
		t.Fatal("rooms not appended in order")
	}
	// Text rooms reject media overrides.
	o.must(422, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &bitrate},
	}, nil)

	gID, sID, vID := general.GetRoom().GetId(), secret.GetRoom().GetId(), voice.GetRoom().GetId()

	// Overrides: alice may see the private room; guests may see general; members may not stream in voice.
	o.must(200, "PUT", "/api/rooms/"+sID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: alice.id, Allow: uint64(perm.ViewRoom)},
	}}, nil)
	o.must(200, "PUT", "/api/rooms/"+gID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "guest", Allow: uint64(perm.ViewRoom | perm.SendMessages)},
	}}, nil)
	var setResp v1.SetRoomPermissionsResponse
	o.must(200, "PUT", "/api/rooms/"+vID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.Stream)},
	}}, &setResp)
	if len(setResp.GetRoom().GetPermissionOverrides()) != 1 {
		t.Fatal("PUT permissions did not replace overrides")
	}

	// Invalid overrides.
	for name, ov := range map[string]*v1.RoomPermissionOverride{
		"admin bit":  {TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Allow: uint64(perm.Administrator)},
		"bad role":   {TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "root"},
		"non-member": {TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: "01890000-0000-7000-8000-000000000000"},
		"no target":  {TargetId: "member"},
		"allow&deny": {TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Allow: 1, Deny: 1},
	} {
		if st := o.do("PUT", "/api/rooms/"+gID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{ov}}, nil); st != 422 {
			t.Errorf("%s: status %d, want 422", name, st)
		}
	}

	member := perm.RoleDefaults[perm.RoleMember] // board bits (ADR-0042) pass through room rules like other role bits
	cases := []struct {
		who    string
		u      *user
		room   string
		bits   perm.Bits
		status int
	}{
		{"owner/secret", o, sID, perm.All, 200},
		{"alice/secret", alice, sID, member, 200},
		{"bob/secret", bob, sID, 0, 404},
		{"gus/secret", gus, sID, 0, 404},
		{"bob/general", bob, gID, member, 200},
		{"gus/general", gus, gID, perm.ViewRoom | perm.SendMessages | perm.Connect | perm.Speak, 200},
		{"gus/voice", gus, vID, 0, 404},
		{"bob/voice", bob, vID, member &^ perm.Stream, 200},
		{"alice/voice", alice, vID, member &^ perm.Stream, 200},
	}
	for _, c := range cases {
		bits, st := roomPerms(t, c.u, c.room)
		if st != c.status || perm.Bits(bits) != c.bits {
			t.Errorf("%s: status %d bits %d, want %d / %d", c.who, st, bits, c.status, c.bits)
		}
	}

	// Listing is filtered by VIEW_ROOM.
	for _, c := range []struct {
		u    *user
		want []string
	}{{o, []string{gID, sID, vID}}, {alice, []string{gID, sID, vID}}, {bob, []string{gID, vID}}, {gus, []string{gID}}} {
		got := visibleRooms(t, c.u, ws.GetId())
		if len(got) != len(c.want) {
			t.Errorf("user %s sees %d rooms, want %d", c.u.id, len(got), len(c.want))
		}
		for _, id := range c.want {
			if got[id] == nil {
				t.Errorf("user %s does not see room %s", c.u.id, id)
			}
		}
	}

	// Non-managers cannot edit rooms; the hidden room is 404 for them, not 403.
	newName := "renamed"
	bob.must(403, "PATCH", "/api/rooms/"+gID, &v1.UpdateRoomRequest{Name: &newName}, nil)
	bob.must(404, "PATCH", "/api/rooms/"+sID, &v1.UpdateRoomRequest{Name: &newName}, nil)

	// A member with MANAGE_ROOM via user override may manage the room, but not escalate.
	o.must(200, "PUT", "/api/rooms/"+gID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.ManageRoom)},
	}}, nil)
	bob.must(200, "PATCH", "/api/rooms/"+gID, &v1.UpdateRoomRequest{Name: &newName}, nil)
	bob.must(403, "PUT", "/api/rooms/"+gID+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.ManageRoom | perm.MuteMembers)},
	}}, nil)

	// Workspace media defaults flow into rooms without an override; overrides can be cleared.
	defStreams := uint32(5)
	preset := v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720
	bob.must(403, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultMaxStreams: &defStreams}, nil)
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultMaxStreams: &defStreams, DefaultMaxStreamPreset: &preset}, nil)
	var got v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+vID, nil, &got)
	if m := got.GetRoom().GetMedia(); m.GetMaxStreams() != 5 || m.GetMaxStreamPreset() != preset || m.GetAudioBitrateKbps() != 64 {
		t.Fatalf("effective media after defaults change: %v", m)
	}
	var upd v1.UpdateRoomResponse
	o.must(200, "PATCH", "/api/rooms/"+vID, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{}}, &upd)
	if upd.GetRoom().GetMedia().GetAudioBitrateKbps() != 32 || upd.GetRoom().GetMediaOverride().AudioBitrateKbps != nil {
		t.Fatalf("clearing override: %v", upd.GetRoom())
	}
	bad := uint32(33)
	o.must(422, "PATCH", "/api/rooms/"+vID, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &bad}}, nil)
	// The «telephone» tier (8 kbps, migration 00036) is valid for a room and a workspace default.
	tel := uint32(8)
	o.must(200, "PATCH", "/api/rooms/"+vID, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &tel}}, &upd)
	if upd.GetRoom().GetMedia().GetAudioBitrateKbps() != 8 {
		t.Fatalf("8 kbps room override: %v", upd.GetRoom().GetMedia())
	}
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultAudioBitrateKbps: &tel}, nil)
	o.must(200, "PATCH", "/api/rooms/"+vID, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{}}, &upd)
	if upd.GetRoom().GetMedia().GetAudioBitrateKbps() != 8 {
		t.Fatalf("8 kbps workspace default: %v", upd.GetRoom().GetMedia())
	}

	// Kicking a member drops their user overrides and access.
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/members/"+alice.id, nil, nil)
	if _, st := roomPerms(t, alice, gID); st != 404 {
		t.Fatalf("kicked member still sees room: %d", st)
	}
	var sr v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+sID, nil, &sr)
	for _, ov := range sr.GetRoom().GetPermissionOverrides() {
		if ov.GetTargetId() == alice.id {
			t.Fatal("user override survived the kick")
		}
	}

	// Archive a room.
	o.must(204, "DELETE", "/api/rooms/"+vID, nil, nil)
	o.must(404, "GET", "/api/rooms/"+vID, nil, nil)
}

func mustEmail(t *testing.T, u *user) string {
	t.Helper()
	var me v1.GetMeResponse
	u.must(200, "GET", "/api/me", nil, &me)
	return me.GetMe().GetEmail()
}

func TestRefreshRotationAndReuseDetection(t *testing.T) {
	o := owner(t)
	c := &client{t: t, ip: "10.0.2.1"}
	var l v1.LoginResponse
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: mustEmail(t, o), Password: "password123", DeviceName: "rot"}, &l)
	t0 := l.GetTokens().GetRefreshToken()

	refresh := func(tok string) (*v1.AuthTokens, int) {
		var r v1.RefreshResponse
		st := c.do("POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: tok}, &r)
		return r.GetTokens(), st
	}
	t1, st := refresh(t0)
	if st != 200 || t1.GetRefreshToken() == t0 || t1.GetSessionId() != l.GetTokens().GetSessionId() {
		t.Fatalf("first refresh: %d %v", st, t1)
	}
	t2, st := refresh(t1.GetRefreshToken())
	if st != 200 {
		t.Fatalf("second refresh: %d", st)
	}
	// Previous token while t2 is unused (the answer was lost):
	// the same t2 again, session kept (docs/09 #89).
	if again, st := refresh(t1.GetRefreshToken()); st != 200 || again.GetRefreshToken() != t2.GetRefreshToken() {
		t.Fatalf("previous token: %d, want 200 with the same new token", st)
	}
	t3, st := refresh(t2.GetRefreshToken())
	if st != 200 {
		t.Fatalf("session must survive a grace-window replay: %d", st)
	}
	sess := &client{t: t, token: t3.GetAccessToken()}
	sess.must(200, "GET", "/api/me", nil, nil)

	// Replay of an older token = reuse: the whole session is revoked.
	if _, st := refresh(t0); st != 401 {
		t.Fatalf("reused token: %d, want 401", st)
	}
	if _, st := refresh(t3.GetRefreshToken()); st != 401 {
		t.Fatalf("current token after reuse detection: %d, want 401", st)
	}
	sess.must(401, "GET", "/api/me", nil, nil)

	// Other sessions of the user are unaffected.
	o.must(200, "GET", "/api/me", nil, nil)

	// Garbage tokens.
	if _, st := refresh("not-a-token"); st != 401 {
		t.Fatalf("garbage: %d", st)
	}
}

// A refresh whose answer never reached the client (network cut, stuck connection, app quit
// for an update): the retry with the old token gets the same new pair for as long as the new
// one is unused — no time limit. Once the new token was used (a refresh with it, or a request
// with its access token), the old one is reuse: 401 SESSION_REVOKED/REUSE, session revoked
// (docs/09 #89, #123).
func TestRefreshLostAnswerReplay(t *testing.T) {
	o := owner(t)
	email := mustEmail(t, o)
	ctx := context.Background()
	logins := 0
	login := func() (*client, string) {
		logins++ // one IP per login: the per-IP login limit
		c := &client{t: t, ip: fmt.Sprintf("10.0.2.%d", logins)}
		var l v1.LoginResponse
		c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123", DeviceName: "lost"}, &l)
		return c, l.GetTokens().GetRefreshToken()
	}
	refresh := func(c *client, tok string) (*v1.AuthTokens, int) {
		var r v1.RefreshResponse
		st := c.do("POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: tok}, &r)
		return r.GetTokens(), st
	}
	// revokedAs: 401 SESSION_REVOKED with the reason.
	revokedAs := func(c *client, tok, reason, what string) {
		t.Helper()
		if _, st := refresh(c, tok); st != 401 {
			t.Fatalf("%s: %d, want 401", what, st)
		}
		var e v1.ApiError
		if err := protojson.Unmarshal(c.lastBody, &e); err != nil {
			t.Fatal(err)
		}
		if e.GetCode() != v1.ErrorCode_ERROR_CODE_SESSION_REVOKED || e.GetReason() != reason {
			t.Fatalf("%s: %v %q, want SESSION_REVOKED %q", what, e.GetCode(), e.GetReason(), reason)
		}
	}
	alive := func(tok *v1.AuthTokens, want int) {
		t.Helper()
		(&client{t: t, token: tok.GetAccessToken()}).must(want, "GET", "/api/me", nil, nil)
	}
	backdate := func(sid string, d string) {
		t.Helper()
		if _, err := testDB.Pool.Exec(ctx, "UPDATE sessions SET rotated_at = rotated_at - $2::interval, last_seen_at = last_seen_at - $2::interval WHERE id = $1",
			sid, d); err != nil {
			t.Fatal(err)
		}
	}

	// Lost answer, retried twice: the same refresh token every time, the session not extended.
	c, t0 := login()
	lost, st := refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	for i := range 2 {
		again, st := refresh(c, t0)
		if st != 200 || again.GetRefreshToken() != lost.GetRefreshToken() || again.GetSessionId() != lost.GetSessionId() {
			t.Fatalf("retry %d: %d %v", i, st, again)
		}
		if !again.GetRefreshExpiresAt().AsTime().Equal(lost.GetRefreshExpiresAt().AsTime()) {
			t.Fatalf("retry %d: the replay must not extend the session", i)
		}
	}
	next, st := refresh(c, lost.GetRefreshToken())
	if st != 200 {
		t.Fatalf("the replayed token must work: %d", st)
	}
	alive(next, 200)
	// Two generations old (t0 → lost → next): reuse, the whole session is revoked.
	revokedAs(c, t0, "REUSE", "two generations old")
	revokedAs(c, next.GetRefreshToken(), "REUSE", "current token after reuse")
	alive(next, 401)

	// The incident of 29.09: the answer was lost and the connection came back 2 hours later.
	// The new token was never used: 200 with the same pair, the session lives on.
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	backdate(lost.GetSessionId(), "2 hours")
	late, st := refresh(c, t0)
	if st != 200 || late.GetRefreshToken() != lost.GetRefreshToken() {
		t.Fatalf("lost answer replayed after 2 h: %d, want 200 with the same token", st)
	}
	alive(late, 200)
	if _, st := refresh(c, late.GetRefreshToken()); st != 200 {
		t.Fatalf("the session must survive a late replay: %d", st)
	}

	// The new pair arrived and its access token was used (no refresh with it yet): the old
	// token is reuse now — someone else holds a copy. Both copies die.
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	alive(lost, 200)
	revokedAs(c, t0, "REUSE", "old token after the new access token was used")
	revokedAs(c, lost.GetRefreshToken(), "REUSE", "new token after reuse")
	alive(lost, 401)

	// Security review #123: an access token of the previous generation keeps working until it
	// expires but does not mark the new generation used (the claim "rg" is signed and compared
	// with the session's current generation); the first gateway IDENTIFY with the new access
	// token does, and clears the seal.
	logins++
	c = &client{t: t, ip: fmt.Sprintf("10.0.2.%d", logins)}
	var l v1.LoginResponse
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123", DeviceName: "lost"}, &l)
	t0 = l.GetTokens().GetRefreshToken()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	alive(l.GetTokens(), 200) // gen 1 access token: still valid, marks nothing
	if again, st := refresh(c, t0); st != 200 || again.GetRefreshToken() != lost.GetRefreshToken() {
		t.Fatalf("old-generation access token must not mark the new one used: %d", st)
	}
	sealOf := func(sid string) (bool, bool) {
		t.Helper()
		var seal []byte
		var used *time.Time
		if err := testDB.Pool.QueryRow(ctx, "SELECT replay_seal, refresh_used_at FROM sessions WHERE id = $1", sid).Scan(&seal, &used); err != nil {
			t.Fatal(err)
		}
		return seal != nil, used != nil
	}
	if sealed, used := sealOf(lost.GetSessionId()); !sealed || used {
		t.Fatalf("before use: sealed=%v used=%v", sealed, used)
	}
	g := dialGW(t)
	g.identify(lost.GetAccessToken())
	if sealed, used := sealOf(lost.GetSessionId()); sealed || !used {
		t.Fatalf("after IDENTIFY: sealed=%v used=%v, want the seal cleared and used", sealed, used)
	}
	revokedAs(c, t0, "REUSE", "old token after IDENTIFY with the new access token")
	if st, reason := g.closeFrame(); st != 4010 || reason != "session revoked: REUSE" {
		t.Fatalf("reuse: close %d %q, want 4010 \"session revoked: REUSE\"", st, reason)
	}
	if sealed, _ := sealOf(lost.GetSessionId()); sealed {
		t.Fatal("revoked session keeps its seal")
	}

	// Legacy rotation (before migration 00040: no seal) with the new token unused: 409, the
	// session is kept and the new token still works.
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sessions SET replay_seal = NULL WHERE id = $1", lost.GetSessionId()); err != nil {
		t.Fatal(err)
	}
	if _, st := refresh(c, t0); st != 409 {
		t.Fatalf("no seal: %d, want 409", st)
	}
	if _, st := refresh(c, lost.GetRefreshToken()); st != 200 {
		t.Fatalf("session must survive a 409: %d", st)
	}

	// The session ends while the answer is lost (logout / revoke / disabled account): the old
	// token must not resurrect it, and the reason is told to its holder.
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	c.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{RefreshToken: lost.GetRefreshToken()}, nil)
	revokedAs(c, t0, "LOGOUT", "replay after logout")
	if sealed, _ := sealOf(lost.GetSessionId()); sealed {
		t.Fatal("logout must clear the seal")
	}
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	// From another device's session list (an access token of another session).
	o.must(204, "DELETE", "/api/me/sessions/"+lost.GetSessionId(), nil, nil)
	revokedAs(c, t0, "OTHER_DEVICE", "replay after session revoke")
	revokedAs(c, lost.GetRefreshToken(), "OTHER_DEVICE", "current after session revoke")
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET disabled_at = now() WHERE id = $1", o.id); err != nil {
		t.Fatal(err)
	}
	_, st = refresh(c, t0)
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET disabled_at = NULL WHERE id = $1", o.id); err != nil {
		t.Fatal(err)
	}
	if st != 401 {
		t.Fatalf("replay for a disabled account: %d, want 401", st)
	}
	revokedAs(c, lost.GetRefreshToken(), "ACCOUNT_DISABLED", "the disabled account's session")

	// An unknown secret for a live session is reuse too (a forgery or a very old copy); a
	// garbage token is just invalid.
	c, t0 = login()
	var junk [32]byte
	sid, _, _ := strings.Cut(t0, ".")
	revokedAs(c, sid+"."+base64.RawURLEncoding.EncodeToString(junk[:]), "REUSE", "forged secret")
	if _, st := refresh(c, "not-a-token"); st != 401 {
		t.Fatalf("garbage: %d", st)
	}

	// Logout with a stale token: the previous one ends only this session, never "everywhere".
	c, t0 = login()
	lost, st = refresh(c, t0)
	if st != 200 {
		t.Fatalf("refresh: %d", st)
	}
	c.must(401, "POST", "/api/auth/logout", &v1.LogoutRequest{RefreshToken: t0, AllSessions: true}, nil)
	o.must(200, "GET", "/api/me", nil, nil)
	c.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{RefreshToken: t0}, nil)
	revokedAs(c, lost.GetRefreshToken(), "LOGOUT", "after logout by the previous token")

	// The retry races the original (several API instances): one rotation, everyone gets the
	// same new token (the row lock serializes; the seal is written with the rotation).
	c, t0 = login()
	const n = 6
	got := make([]string, n)
	codes := make([]int, n)
	done := make(chan int, n)
	for i := range n {
		go func() {
			tok, st := refresh(&client{t: t, ip: c.ip}, t0)
			got[i], codes[i] = tok.GetRefreshToken(), st
			done <- i
		}()
	}
	for range n {
		<-done
	}
	for i := range n {
		if codes[i] != 200 || got[i] != got[0] {
			t.Fatalf("concurrent refresh %d: %d, token same=%v", i, codes[i], got[i] == got[0])
		}
	}
	var gen int64
	if err := testDB.Pool.QueryRow(ctx, "SELECT refresh_gen FROM sessions WHERE id = $1", sid0(got[0])).Scan(&gen); err != nil || gen != 2 {
		t.Fatalf("concurrent refreshes: generation %d (%v), want exactly one rotation (2)", gen, err)
	}
	if _, st := refresh(c, got[0]); st != 200 {
		t.Fatalf("the shared new token must work: %d", st)
	}
}

func sid0(tok string) string {
	sid, _, _ := strings.Cut(tok, ".")
	return sid
}

func TestLogoutAndSessions(t *testing.T) {
	o := owner(t)
	email := mustEmail(t, o)
	login := func(dev string) *client {
		c := &client{t: t, ip: "10.0.3.1"}
		var l v1.LoginResponse
		c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123", DeviceName: dev}, &l)
		c.token = l.GetTokens().GetAccessToken()
		return c
	}
	a, b := login("a"), login("b")
	var ls v1.ListSessionsResponse
	a.must(200, "GET", "/api/me/sessions", nil, &ls)
	current := 0
	for _, s := range ls.GetSessions() {
		if s.GetCurrent() {
			current++
			if s.GetDeviceName() != "a" || s.GetIp() != "10.0.3.1" {
				t.Fatalf("current session: %v", s)
			}
		}
	}
	if current != 1 || len(ls.GetSessions()) < 2 {
		t.Fatalf("sessions: %v", ls.GetSessions())
	}
	a.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{}, nil)
	a.must(401, "GET", "/api/me", nil, nil)
	b.must(200, "GET", "/api/me", nil, nil)
	(&client{t: t}).must(401, "GET", "/api/me", nil, nil)
	(&client{t: t, token: "garbage"}).must(401, "GET", "/api/me", nil, nil)
}

func TestLoginRateLimitAndBadCredentials(t *testing.T) {
	o := owner(t)
	email := mustEmail(t, o)
	c := &client{t: t, ip: "10.9.9.9"}
	var e v1.ApiError
	for i := range 5 {
		if st := c.do("POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "wrong-password"}, &e); st != 401 {
			t.Fatalf("attempt %d: %d, want 401", i, st)
		}
	}
	if st := c.do("POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, nil); st != 429 {
		t.Fatalf("6th attempt: %d, want 429", st)
	}
	// Another IP has its own bucket.
	(&client{t: t, ip: "10.9.9.10"}).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, nil)
	// Unknown email looks the same as a wrong password.
	(&client{t: t, ip: "10.9.9.11"}).must(401, "POST", "/api/auth/login", &v1.LoginRequest{Email: "nobody@example.com", Password: "password123"}, nil)
}

func TestWorkspaceMembershipRules(t *testing.T) {
	o := owner(t)
	open := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN)
	priv := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, priv.GetId())
	adm := register(t, code)
	mem := register(t, code)

	// Slug rules.
	o.must(409, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: open.GetSlug(), Name: "dup"}, nil)
	o.must(422, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: "Bad Slug", Name: "x"}, nil)

	// Discover + join open workspace; private one is invisible to non-members.
	var disc v1.DiscoverWorkspacesResponse
	mem.must(200, "GET", "/api/workspaces/discover", nil, &disc)
	found := false
	for _, w := range disc.GetWorkspaces() {
		found = found || w.GetId() == open.GetId()
		if w.GetId() == priv.GetId() {
			t.Fatal("private workspace discoverable")
		}
	}
	if !found {
		t.Fatal("open workspace not discoverable")
	}
	var j v1.JoinWorkspaceResponse
	mem.must(200, "POST", "/api/workspaces/"+open.GetId()+"/join", nil, &j)
	if j.GetMember().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER {
		t.Fatalf("open join role: %v", j.GetMember().GetRole())
	}
	outsider := register(t, invite(t, o, open.GetId()))
	outsider.must(404, "GET", "/api/workspaces/"+priv.GetId(), nil, nil)
	outsider.must(404, "POST", "/api/workspaces/"+priv.GetId()+"/join", nil, nil)

	// Invite preview + joining twice does not burn uses.
	var prev v1.GetInviteResponse
	outsider.must(200, "GET", "/api/invites/"+code, nil, &prev)
	if prev.GetWorkspace().GetId() != priv.GetId() {
		t.Fatal("invite preview: wrong workspace")
	}
	outsider.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)
	outsider.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)
	var invs v1.ListInvitesResponse
	o.must(200, "GET", "/api/workspaces/"+priv.GetId()+"/invites", nil, &invs)
	if u := invs.GetInvites()[0].GetUses(); u != 3 { // adm, mem, outsider
		t.Fatalf("invite uses = %d, want 3", u)
	}
	mem.must(403, "GET", "/api/workspaces/"+priv.GetId()+"/invites", nil, nil)

	// Role rules.
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	ownerRole := v1.WorkspaceRole_WORKSPACE_ROLE_OWNER
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	base := "/api/workspaces/" + priv.GetId() + "/members/"
	o.must(200, "PATCH", base+adm.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	adm.must(403, "PATCH", base+mem.id, &v1.UpdateMemberRequest{Role: &admin}, nil)   // only owner grants admin
	adm.must(200, "PATCH", base+mem.id, &v1.UpdateMemberRequest{Role: &guest}, nil)   // admin can demote member
	adm.must(403, "PATCH", base+o.id, &v1.UpdateMemberRequest{Role: &guest}, nil)     // owner untouchable
	o.must(403, "PATCH", base+adm.id, &v1.UpdateMemberRequest{Role: &ownerRole}, nil) // no ownership transfer here
	nick := "Mimi"
	mem.must(200, "PATCH", base+"@me", &v1.UpdateMemberRequest{Nickname: &nick}, nil)

	// Admin can create invites and rooms now.
	adm.must(201, "POST", "/api/workspaces/"+priv.GetId()+"/invites", &v1.CreateInviteRequest{}, nil)

	// Kick / leave rules.
	adm.must(403, "DELETE", base+o.id, nil, nil)
	mem.must(403, "DELETE", base+adm.id, nil, nil)
	o.must(409, "DELETE", base+"@me", nil, nil)
	mem.must(204, "DELETE", base+"@me", nil, nil)
	mem.must(404, "GET", "/api/workspaces/"+priv.GetId(), nil, nil)
	adm.must(204, "DELETE", base+outsider.id, nil, nil)

	var ms v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+priv.GetId()+"/members", nil, &ms)
	if len(ms.GetMembers()) != 2 {
		t.Fatalf("members left: %d, want 2 (owner, admin)", len(ms.GetMembers()))
	}

	// Only the owner deletes.
	adm.must(403, "DELETE", "/api/workspaces/"+priv.GetId(), nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+priv.GetId(), nil, nil)
	o.must(404, "GET", "/api/workspaces/"+priv.GetId(), nil, nil)
	// Invite of a deleted workspace is gone.
	outsider.must(404, "GET", "/api/invites/"+code, nil, nil)
}
