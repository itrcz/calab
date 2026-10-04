package plans

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/superadmin"
)

const (
	h720  = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720
	h1080 = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080
	orig  = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL
	none  = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED
)

func TestParseLimitsEnv(t *testing.T) {
	// Empty = built-in defaults (ADR-0024: 5 in a room, 720p / 15 fps, 1 stream, 5 GiB; team 1 TiB).
	free, team, biz, err := Defaults("", "", "")
	if err != nil || free != DefaultFree || team != DefaultTeam || biz != DefaultBusiness {
		t.Fatalf("defaults: %+v %+v %+v %v", free, team, biz, err)
	}
	if team != (Limits{BoardFormsPerBoard: 5, RoomMembers: 15, Members: 100, Bots: 5, Boards: 30, StorageMB: 300 * 1024,
		StreamsPerRoom: 2, CamerasPerRoom: 10, BoardWebhooksDisabled: true, TelephonyDisabled: true}) ||
		biz != (Limits{BoardFormsPerBoard: 20, RoomMembers: 50, Members: 500, Bots: 20, Boards: 50, StorageMB: 1 << 20, StreamsPerRoom: 5, CamerasPerRoom: 25}) {
		t.Fatalf("team / business defaults: %+v %+v", team, biz)
	}

	if free.RoomMembers != 5 || free.StreamMaxPreset != h720 || free.StreamMaxFPS != 15 || free.CameraMaxFPS != 15 ||
		free.StreamsPerRoom != 1 || free.StorageMB != 5120 || team.StorageMB != 300<<10 || free.Members != 50 || free.AudioMaxKbps != 16 ||
		free.Bots != 1 || free.StickerPacks != 1 || !free.ChecklistsDisabled || !free.BoardWebhooksDisabled ||
		!free.TelephonyDisabled || biz.TelephonyDisabled {
		t.Fatalf("free defaults: %+v", free)
	}
	// Keys override one by one; 0 / "" = no limit; presets are case-insensitive.
	l, err := ParseLimits(`{"room_members":8,"stream_max_preset":"H1080","camera_max_fps":0,"storage_mb":0}`, DefaultFree)
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultFree
	want.RoomMembers, want.StreamMaxPreset, want.CameraMaxFPS, want.StorageMB = 8, h1080, 0, 0
	if l != want {
		t.Fatalf("overlay: %+v, want %+v", l, want)
	}
	if l, _ := ParseLimits(`{"camera_max_preset":""}`, DefaultFree); l.CameraMaxPreset != none {
		t.Fatalf("empty preset = no limit, got %v", l.CameraMaxPreset)
	}
	for _, bad := range []string{
		`{"room_members":-1}`, `{"stream_max_preset":"4k"}`, `{"unknown":1}`, `[1]`, `{"room_members":5} {}`,
		`{"room_members":100000}`, `{"stream_max_fps":1000}`, `not json`, `{"audio_tier_max_kbps":24}`, `{"audio_tier_max_kbps":128}`,
	} {
		if _, err := ParseLimits(bad, DefaultFree); err == nil {
			t.Errorf("%s: accepted", bad)
		}
	}
	if _, _, _, err := Defaults("", `{"room_members":"x"}`, ""); err == nil {
		t.Error("bad PLAN_TEAM_LIMITS accepted")
	}
	if _, _, _, err := Defaults("", "", `{"members":-1}`); err == nil {
		t.Error("bad PLAN_BUSINESS_LIMITS accepted")
	}
	if _, _, b, err := Defaults("", "", `{"members":7,"room_members":0}`); err != nil || b.Members != 7 || b.RoomMembers != 0 || b.Bots != 20 {
		t.Errorf("business env override: %+v %v", b, err)
	}
}

func TestLimitsJSONRoundTrip(t *testing.T) {
	l := Limits{BoardFormsDisabled: true, BoardFormsPerBoard: 17, RoomMembers: 7, StreamMaxPreset: orig, StreamMaxFPS: 30, CameraMaxPreset: h1080, CameraMaxFPS: 24,
		StreamsPerRoom: 2, StorageMB: 5000, Members: 40, StickerPacks: 3, Stickers: 90, Bots: 3, AudioMaxKbps: 32, Boards: 2,
		ChecklistsDisabled: true, BoardWebhooksDisabled: true, TelephonyDisabled: true}
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseLimits(string(b), Limits{})
	if err != nil || back != l {
		t.Fatalf("round trip %s: %+v %v", b, back, err)
	}
	if FromProto(l.Proto()) != l {
		t.Fatal("proto round trip")
	}
	// Unlimited limits serialize every key (a stored custom plan is complete).
	b, _ = json.Marshal(Limits{})
	if string(b) != `{"board_forms_disabled":false,"board_forms_per_board":0,"room_members":0,"stream_max_preset":"","stream_max_fps":0,"camera_max_preset":"","camera_max_fps":0,"streams_per_room":0,"cameras_per_room":0,"storage_mb":0,"members":0,"sticker_packs":0,"stickers":0,"bots":0,"audio_tier_max_kbps":0,"boards":0,"caldav_disabled":false,"musician_disabled":false,"checklists_disabled":false,"board_webhooks_disabled":false,"telephony_disabled":false,"automations_disabled":false}` {
		t.Fatalf("zero limits: %s", b)
	}
}

func TestMediaCaps(t *testing.T) {
	free := DefaultFree
	// 1080p wanted → 720p / 15 on the free plan; lower requests stay as asked.
	if p := CapPreset(h1080, free.StreamMaxPreset); p != h720 {
		t.Fatalf("stream preset %v", p)
	}
	if f := free.StreamFPS(h720, 0); f != 15 {
		t.Fatalf("stream fps %d", f)
	}
	if f := free.StreamFPS(v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY, 30); f != 5 {
		t.Fatalf("economy fps %d", f)
	}
	if f := (Limits{}).StreamFPS(orig, 0); f != 30 {
		t.Fatalf("unlimited original fps %d", f)
	}
	if f := (Limits{}).StreamFPS(orig, 10); f != 10 {
		t.Fatalf("wanted fps %d", f)
	}
	if p, f := free.Camera(h1080, 30); p != h720 || f != 15 {
		t.Fatalf("camera 1080/30 on free: %v/%d", p, f)
	}
	if p, f := free.Camera(none, 0); p != h720 || f != 15 {
		t.Fatalf("camera best on free: %v/%d", p, f)
	}
	if p, f := (Limits{}).Camera(none, 0); p != none || f != 0 {
		t.Fatalf("camera without caps: %v/%d", p, f)
	}
	m := free.CapMedia(&v1.RoomMediaSettings{AudioBitrateKbps: 64, MaxStreamPreset: orig, MaxStreams: 3, CameraLimit: 6})
	if m.GetMaxStreamPreset() != h720 || m.GetMaxStreams() != 1 || m.GetAudioBitrateKbps() != 16 || m.GetCameraLimit() != 3 {
		t.Fatalf("capped media: %v", m)
	}
	if m := DefaultTeam.CapMedia(&v1.RoomMediaSettings{MaxStreams: 8, CameraLimit: 25}); m.GetMaxStreams() != 2 || m.GetCameraLimit() != 10 {
		t.Fatalf("team caps: %v", m)
	}
	if m := DefaultBusiness.CapMedia(&v1.RoomMediaSettings{MaxStreams: 9, CameraLimit: 25}); m.GetMaxStreams() != 5 || m.GetCameraLimit() != 25 {
		t.Fatalf("business caps: %v", m)
	}
	if m := (Limits{}).CapMedia(&v1.RoomMediaSettings{AudioBitrateKbps: 64, MaxStreamPreset: orig, MaxStreams: 3}); m.GetMaxStreamPreset() != orig || m.GetMaxStreams() != 3 || m.GetAudioBitrateKbps() != 64 {
		t.Fatalf("uncapped media: %v", m)
	}
}

// The voice tier cap (ADR-0024, owner 28.09: free = «Нормальное»): effective = min(room, plan).
func TestAudioTierCap(t *testing.T) {
	free := DefaultFree
	for _, c := range []struct{ in, want uint32 }{{8, 8}, {16, 16}, {24, 16}, {32, 16}, {64, 16}, {0, 0}} {
		if got := free.CapAudio(c.in); got != c.want {
			t.Errorf("free CapAudio(%d) = %d, want %d", c.in, got, c.want)
		}
	}
	if got := (Limits{}).CapAudio(64); got != 64 {
		t.Errorf("unlimited CapAudio(64) = %d", got)
	}
	if !free.AudioAllowed(16) || !free.AudioAllowed(8) || free.AudioAllowed(32) || free.AudioAllowed(64) || !(Limits{}).AudioAllowed(64) {
		t.Error("AudioAllowed")
	}
	s := &Service{}
	s.load = func(context.Context, uuid.UUID) (*sqlc.WorkspacePlan, error) { return nil, nil }
	s.free, s.now, s.cache = free, time.Now, map[uuid.UUID]cached{}
	ctx, ws := context.Background(), uuid.New()
	if err := s.CheckAudio(ctx, ws, 16, 32); err != nil {
		t.Errorf("16 on free: %v", err)
	}
	if err := s.CheckAudio(ctx, ws, 32, 32); err != nil {
		t.Errorf("unchanged stored 32 on free: %v", err)
	}
	err := s.CheckAudio(ctx, ws, 64, 32)
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 409 || he.Reason != httpx.ReasonPlanLimit || he.Used != 64 || he.Limit != 16 {
		t.Errorf("64 on free: %v", err)
	}
	if err := (*Service)(nil).CheckAudio(ctx, ws, 64, 0); err != nil {
		t.Errorf("nil service: %v", err)
	}
}

type fakeRows struct {
	rows  map[uuid.UUID]*sqlc.WorkspacePlan
	loads int
	err   error
}

func (f *fakeRows) load(_ context.Context, id uuid.UUID) (*sqlc.WorkspacePlan, error) {
	f.loads++
	return f.rows[id], f.err
}

func testService(f *fakeRows, now *time.Time) *Service {
	s := &Service{load: f.load, free: DefaultFree, team: DefaultTeam, biz: DefaultBusiness, now: func() time.Time { return *now }, cache: map[uuid.UUID]cached{}}
	return s
}

func TestEffectiveAndExpiry(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	freeWS, teamWS, customWS, entWS := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	until := now.Add(time.Hour)
	f.rows[entWS] = &sqlc.WorkspacePlan{WorkspaceID: entWS, Plan: "enterprise"}
	f.rows[teamWS] = &sqlc.WorkspacePlan{WorkspaceID: teamWS, Plan: "team", ValidUntil: &until}
	custom, _ := json.Marshal(Limits{RoomMembers: 12, StorageMB: 42})
	f.rows[customWS] = &sqlc.WorkspacePlan{WorkspaceID: customWS, Plan: "custom", Limits: custom}

	// No row = free.
	if i, err := s.Info(ctx, freeWS); err != nil || i.Plan != v1.Plan_PLAN_FREE || i.Limits != DefaultFree || i.Expired {
		t.Fatalf("no row: %+v %v", i, err)
	}
	if l, _ := s.Effective(ctx, teamWS); l != DefaultTeam {
		t.Fatalf("team: %+v", l)
	}
	if l, _ := s.Effective(ctx, customWS); l != (Limits{RoomMembers: 12, StorageMB: 42}) {
		t.Fatalf("custom as stored: %+v", l)
	}
	// PLAN_ENTERPRISE is the cloud Business tier: its own defaults.
	if i, _ := s.Info(ctx, entWS); i.Plan != v1.Plan_PLAN_ENTERPRISE || i.Limits != DefaultBusiness || s.PlanLimits(v1.Plan_PLAN_ENTERPRISE) != DefaultBusiness {
		t.Fatalf("enterprise: %+v", i)
	}

	// Cached for CacheTTL: a changed row is not read again...
	f.rows[customWS] = &sqlc.WorkspacePlan{WorkspaceID: customWS, Plan: "free"}
	loads := f.loads
	if l, _ := s.Effective(ctx, customWS); l.RoomMembers != 12 || f.loads != loads {
		t.Fatalf("cache not used: %+v loads %d→%d", l, loads, f.loads)
	}
	// ...until invalidated.
	s.Invalidate(ctx, customWS)
	if l, _ := s.Effective(ctx, customWS); l != DefaultFree {
		t.Fatalf("after invalidate: %+v", l)
	}

	// valid_until passed → free limits, the stored plan is still reported (expired). The
	// cache entry ends at valid_until, not at the TTL.
	now = until
	i, err := s.Info(ctx, teamWS)
	if err != nil || i.Plan != v1.Plan_PLAN_TEAM || !i.Expired || i.Limits != DefaultFree {
		t.Fatalf("expired team: %+v %v", i, err)
	}
	if p := i.Proto(); !p.GetExpired() || p.GetValidUntil().AsTime() != until || p.GetLimits().GetRoomMembers() != 5 {
		t.Fatalf("proto: %v", p)
	}
	// TTL expiry re-reads.
	loads = f.loads
	now = now.Add(CacheTTL + time.Second)
	_, _ = s.Info(ctx, freeWS)
	if f.loads != loads+1 {
		t.Fatal("entry not re-read after the TTL")
	}

	// A corrupt custom row fails safe to free; a load error is returned, not cached.
	f.rows[customWS] = &sqlc.WorkspacePlan{WorkspaceID: customWS, Plan: "custom", Limits: []byte(`{"room_members":"x"}`)}
	s.Invalidate(ctx, customWS)
	if l, _ := s.Effective(ctx, customWS); l != DefaultFree {
		t.Fatalf("corrupt custom: %+v", l)
	}
	f.err = errors.New("db down")
	s.Invalidate(ctx, customWS)
	if _, err := s.Effective(ctx, customWS); err == nil {
		t.Fatal("load error swallowed")
	}

	// SetDefaults applies new env limits at once.
	f.err = nil
	s.SetDefaults(Limits{RoomMembers: 3}, DefaultTeam, DefaultBusiness)
	if l, _ := s.Effective(ctx, freeWS); l.RoomMembers != 3 {
		t.Fatalf("after SetDefaults: %+v", l)
	}
}

func TestFillNilSafe(t *testing.T) {
	var s *Service
	ws := &v1.Workspace{Id: uuid.NewString()}
	if err := s.Fill(context.Background(), ws); err != nil || ws.Plan != nil {
		t.Fatal("nil service must fill nothing")
	}
}

func TestPlanDBMapping(t *testing.T) {
	for _, p := range []v1.Plan{v1.Plan_PLAN_FREE, v1.Plan_PLAN_TEAM, v1.Plan_PLAN_CUSTOM, v1.Plan_PLAN_ENTERPRISE} {
		s, ok := PlanToDB(p)
		if !ok || PlanFromDB(s) != p {
			t.Errorf("%v: %q %v", p, s, ok)
		}
	}
	if _, ok := PlanToDB(v1.Plan_PLAN_UNSPECIFIED); ok {
		t.Error("UNSPECIFIED mapped")
	}
}

func TestLikePattern(t *testing.T) {
	if got := likePattern(`50%_a\b`); got != `50\%\_a\\b` {
		t.Fatalf("%s", got)
	}
}

func TestSuperadmin(t *testing.T) {
	superadmin.Configure([]string{" IT@unne.ai ", ""})
	defer superadmin.Configure(nil)
	em := "it@UNNE.ai"
	if !superadmin.Is("it@unne.ai") || !superadmin.IsPtr(&em) || superadmin.Is("") || superadmin.IsPtr(nil) || superadmin.Is("other@unne.ai") {
		t.Fatal("superadmin matching")
	}
}

func TestCalDAVFlag(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	freeWS, teamWS, user := uuid.New(), uuid.New(), uuid.New()
	f.rows[teamWS] = &sqlc.WorkspacePlan{WorkspaceID: teamWS, Plan: "team"}
	mine := []uuid.UUID{freeWS}
	s.userWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return mine, nil }
	if !DefaultFree.CalDAVDisabled || DefaultTeam.CalDAVDisabled || DefaultBusiness.CalDAVDisabled {
		t.Fatal("CalDAV is only off on Free by default")
	}
	if ok, err := s.AllowsCalDAV(ctx, user); err != nil || ok {
		t.Fatalf("free only: %v %v", ok, err)
	}
	mine = []uuid.UUID{freeWS, teamWS} // one workspace with CalDAV is enough
	if ok, err := s.AllowsCalDAV(ctx, user); err != nil || !ok {
		t.Fatalf("free + team: %v %v", ok, err)
	}
	if ok, _ := (*Service)(nil).AllowsCalDAV(ctx, user); !ok {
		t.Fatal("nil service allows")
	}
	// env / JSON round trip.
	l, err := ParseLimits(`{"caldav_disabled":false}`, DefaultFree)
	if err != nil || l.CalDAVDisabled {
		t.Fatalf("override: %+v %v", l, err)
	}
	if FromProto(DefaultFree.Proto()) != DefaultFree {
		t.Fatal("proto round trip")
	}
}

// Musician mode (ADR-0052): off on Free by default, on for Team / Business; a DM call (no
// workspace) takes any of the user's workspaces, like CalDAV.
func TestAllowsMusician(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	freeWS, teamWS, bizWS, dm, user := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	f.rows[teamWS] = &sqlc.WorkspacePlan{WorkspaceID: teamWS, Plan: "team"}
	f.rows[bizWS] = &sqlc.WorkspacePlan{WorkspaceID: bizWS, Plan: "enterprise"}
	if !DefaultFree.MusicianDisabled || DefaultTeam.MusicianDisabled || DefaultBusiness.MusicianDisabled {
		t.Fatal("musician mode is only off on Free by default")
	}
	for ws, want := range map[uuid.UUID]bool{freeWS: false, teamWS: true, bizWS: true} {
		if ok, err := s.AllowsMusician(ctx, ws, false, user); err != nil || ok != want {
			t.Fatalf("workspace %v: %v %v, want %v", ws, ok, err, want)
		}
	}
	mine := []uuid.UUID{freeWS}
	s.userWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return mine, nil }
	if ok, err := s.AllowsMusician(ctx, dm, true, user); err != nil || ok {
		t.Fatalf("DM, free only: %v %v", ok, err)
	}
	mine = []uuid.UUID{freeWS, teamWS}
	if ok, err := s.AllowsMusician(ctx, dm, true, user); err != nil || !ok {
		t.Fatalf("DM, free + team: %v %v", ok, err)
	}
	if ok, _ := (*Service)(nil).AllowsMusician(ctx, freeWS, false, user); !ok {
		t.Fatal("nil service allows")
	}
	// Self-hosted: the operator turns it on for Free through PLAN_FREE_LIMITS.
	l, err := ParseLimits(`{"musician_disabled":false}`, DefaultFree)
	if err != nil || l.MusicianDisabled {
		t.Fatalf("override: %+v %v", l, err)
	}
}

// ADR-0058 §5: a Custom row stored before the flags existed has webhooks off and checklists
// on; a row that stores the flags gets them as stored.
func TestCustomBoardFlagsDefault(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	legacy, on, off := uuid.New(), uuid.New(), uuid.New()
	f.rows[legacy] = &sqlc.WorkspacePlan{WorkspaceID: legacy, Plan: "custom", Limits: []byte(`{"room_members":12}`)}
	f.rows[on] = &sqlc.WorkspacePlan{WorkspaceID: on, Plan: "custom",
		Limits: []byte(`{"checklists_disabled":false,"board_webhooks_disabled":false}`)}
	f.rows[off] = &sqlc.WorkspacePlan{WorkspaceID: off, Plan: "custom",
		Limits: []byte(`{"checklists_disabled":true,"board_webhooks_disabled":true}`)}
	for ws, want := range map[uuid.UUID][2]bool{legacy: {false, true}, on: {false, false}, off: {true, true}} {
		l, err := s.Effective(ctx, ws)
		if err != nil || l.ChecklistsDisabled != want[0] || l.BoardWebhooksDisabled != want[1] {
			t.Fatalf("%v: checklists_disabled %v board_webhooks_disabled %v (%v), want %v", ws, l.ChecklistsDisabled, l.BoardWebhooksDisabled, err, want)
		}
	}
	if l, _ := s.Effective(ctx, legacy); l.RoomMembers != 12 || l.Members != 0 {
		t.Fatalf("legacy custom: %+v", l)
	}
}

// ADR-0046 (owner, 02.10): telephony is Business only; a Custom row without the key has it off,
// a row that stores the flag gets it as stored.
func TestCustomTelephonyDefault(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	legacy, on, off, biz, team := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	f.rows[legacy] = &sqlc.WorkspacePlan{WorkspaceID: legacy, Plan: "custom", Limits: []byte(`{"room_members":12}`)}
	f.rows[on] = &sqlc.WorkspacePlan{WorkspaceID: on, Plan: "custom", Limits: []byte(`{"telephony_disabled":false}`)}
	f.rows[off] = &sqlc.WorkspacePlan{WorkspaceID: off, Plan: "custom", Limits: []byte(`{"telephony_disabled":true}`)}
	f.rows[biz] = &sqlc.WorkspacePlan{WorkspaceID: biz, Plan: "enterprise"}
	f.rows[team] = &sqlc.WorkspacePlan{WorkspaceID: team, Plan: "team"}
	for ws, want := range map[uuid.UUID]bool{legacy: true, on: false, off: true, biz: false, team: true, uuid.New(): true} {
		if l, err := s.Effective(ctx, ws); err != nil || l.TelephonyDisabled != want {
			t.Fatalf("%v: telephony_disabled %v (%v), want %v", ws, l.TelephonyDisabled, err, want)
		}
	}
}
