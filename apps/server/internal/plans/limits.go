// Package plans resolves the plan and effective limits of a workspace (ADR-0024) and serves
// the superadmin API. Limits are enforced by the callers (rtc: room members, stream / camera
// quality, streams per room, voice tier; files: storage; Check: members, bots, sticker packs)
// for everyone in the workspace, independent of roles.
package plans

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Limits are effective workspace limits; 0 / UNSPECIFIED = no limit.
type Limits struct {
	RoomMembers     uint32
	StreamMaxPreset v1.ScreenSharePreset
	StreamMaxFPS    uint32
	CameraMaxPreset v1.ScreenSharePreset
	CameraMaxFPS    uint32
	StreamsPerRoom  uint32
	CamerasPerRoom  uint32 // webcams at once in one voice room; caps the room / workspace camera_limit
	StorageMB       uint64
	Members         uint32 // members without guests; bots count (they take a seat)
	StickerPacks    uint32 // live sticker packs of the workspace (ADR-0030)
	Stickers        uint32 // live stickers over all its packs
	Bots            uint32 // bots that are members of the workspace (ADR-0031)
	AudioMaxKbps    uint32 // highest voice tier, kbps (docs/02 «Битрейт»)
	Boards          uint32 // task boards of the workspace, live and archived (ADR-0042)
	// CalDAVDisabled: CalDAV sync is not part of the plan (Free). A flag, not a count: zero =
	// allowed, like "0 = no limit" elsewhere. CalDAV is per user, so it works if any of the
	// user's workspaces allows it (Service.AllowsCalDAV).
	CalDAVDisabled bool
	// MusicianDisabled: musician mode (ADR-0052) is not part of the plan (Free); the same kind of
	// flag. Decided by the plan of the voice room's workspace (Service.AllowsMusician).
	MusicianDisabled bool
	// ChecklistsDisabled: task checklists (ADR-0058 §5) are Team and above; without them existing
	// checklists are read-only. BoardWebhooksDisabled: board webhooks are Business only; without
	// them a configured webhook stays but delivery pauses. The same kind of flag.
	ChecklistsDisabled    bool
	BoardWebhooksDisabled bool
	// TelephonyDisabled: telephony SIP (ADR-0046) is Business only (owner, 02.10); without it a
	// saved trunk stays readable but cannot be enabled, tested or called through.
	TelephonyDisabled bool
	// AutomationsDisabled: board automations (ADR-0060) are Team and above; without them new rules
	// are refused, existing rules and Git events do not run (the setup stays).
	AutomationsDisabled bool
}

// Built-in defaults; PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS / PLAN_BUSINESS_LIMITS override them key by key.
var (
	// DefaultFree (owner, 28.09): 5 in a room, 50 members, voice up to «Нормальное» (16 kbps),
	// video up to 720p / 15 fps, one stream per room, 5 GiB of files, one sticker pack with 200
	// stickers, one bot, no CalDAV (owner, 30.09), no musician mode (owner, 01.10, ADR-0052), no
	// checklists and no board webhooks (owner, 02.10, ADR-0058 §5), no telephony (owner, 02.10, ADR-0046),
	// no board automations (owner, 03.10, ADR-0060).
	DefaultFree = Limits{
		RoomMembers: 5, Members: 50, AudioMaxKbps: 16,
		StreamMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720, StreamMaxFPS: 15,
		CameraMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720, CameraMaxFPS: 15,
		StreamsPerRoom: 1, CamerasPerRoom: 3, StorageMB: 5 << 10, StickerPacks: 1, Stickers: 200, Bots: 1, Boards: 3, CalDAVDisabled: true,
		MusicianDisabled: true, ChecklistsDisabled: true, BoardWebhooksDisabled: true, TelephonyDisabled: true,
		AutomationsDisabled: true,
	}
	// DefaultTeam (owner, 30.09): 15 in a room, 100 workspace members, 300 GiB of files, 5 bots, 30 boards;
	// voice and video not limited by the plan; no board webhooks (ADR-0058 §5), no telephony (ADR-0046).
	DefaultTeam = Limits{RoomMembers: 15, Members: 100, Bots: 5, Boards: 30, StorageMB: 300 << 10, StreamsPerRoom: 2, CamerasPerRoom: 10,
		BoardWebhooksDisabled: true, TelephonyDisabled: true}
	// DefaultBusiness (owner, 30.09) is the cloud tier stored as PLAN_ENTERPRISE: 50 in a room,
	// 500 members, 20 bots, 50 boards (the hard cap), 5 streams and 25 cameras per room, 1 TiB of files; voice and video quality unlimited.
	DefaultBusiness = Limits{RoomMembers: 50, Members: 500, Bots: 20, Boards: 50, StorageMB: 1 << 20, StreamsPerRoom: 5, CamerasPerRoom: 25}
)

// CustomBase is what a stored PLAN_CUSTOM row means for a key it lacks (rows written before the
// key existed): no limit, except flags that are off unless granted (ADR-0058 §5: board webhooks
// and ADR-0046: telephony are Business only, so an older Custom row does not gain them silently;
// checklists default on).
var CustomBase = Limits{BoardWebhooksDisabled: true, TelephonyDisabled: true}

// Upper bounds of every limit (validation of env and admin input).
const (
	maxRoomMembers    = 1000
	maxFPS            = 120
	maxStreamsPerRoom = 100
	maxCamerasPerRoom = 100
	maxStorageMB      = 100 << 20 // 100 TiB
	maxMembers        = 1_000_000
	maxStickerPacks   = 10_000
	maxStickers       = 1_000_000
	maxBots           = 1000
	maxAudioKbps      = 64
	maxBoards         = 50 // the hard cap of ADR-0042 §6
)

// audioTiers are the voice tiers a plan may cap at (docs/02 «Битрейт»); 0 = no cap.
var audioTiers = map[uint32]bool{0: true, 8: true, 16: true, 32: true, 64: true}

var presetNames = map[string]v1.ScreenSharePreset{
	"":         v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED,
	"economy":  v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY,
	"h720":     v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720,
	"h1080":    v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080,
	"original": v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL,
}

func presetName(p v1.ScreenSharePreset) string {
	for k, v := range presetNames {
		if v == p {
			return k
		}
	}
	return ""
}

// limitsJSON is the JSON form of Limits (env and workspace_plans.limits). Presets are
// "economy" | "h720" | "h1080" | "original" | "" (no limit); numbers 0 = no limit.
type limitsJSON struct {
	RoomMembers      *uint32 `json:"room_members,omitempty"`
	StreamMaxPreset  *string `json:"stream_max_preset,omitempty"`
	StreamMaxFPS     *uint32 `json:"stream_max_fps,omitempty"`
	CameraMaxPreset  *string `json:"camera_max_preset,omitempty"`
	CameraMaxFPS     *uint32 `json:"camera_max_fps,omitempty"`
	StreamsPerRoom   *uint32 `json:"streams_per_room,omitempty"`
	CamerasPerRoom   *uint32 `json:"cameras_per_room,omitempty"`
	StorageMB        *uint64 `json:"storage_mb,omitempty"`
	Members          *uint32 `json:"members,omitempty"`
	StickerPacks     *uint32 `json:"sticker_packs,omitempty"`
	Stickers         *uint32 `json:"stickers,omitempty"`
	Bots             *uint32 `json:"bots,omitempty"`
	AudioMaxKbps     *uint32 `json:"audio_tier_max_kbps,omitempty"`
	Boards           *uint32 `json:"boards,omitempty"`
	CalDAVDisabled   *bool   `json:"caldav_disabled,omitempty"`
	MusicianDisabled *bool   `json:"musician_disabled,omitempty"`
	Checklists       *bool   `json:"checklists_disabled,omitempty"`
	BoardWebhooks    *bool   `json:"board_webhooks_disabled,omitempty"`
	Telephony        *bool   `json:"telephony_disabled,omitempty"`
	Automations      *bool   `json:"automations_disabled,omitempty"`
}

// ParseLimits applies a JSON object over base: keys present replace the base value, absent
// keys keep it. Empty input returns base. The result is validated.
func ParseLimits(raw string, base Limits) (Limits, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return base, nil
	}
	var j limitsJSON
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return Limits{}, fmt.Errorf("plan limits: %w", err)
	}
	if dec.More() {
		return Limits{}, errors.New("plan limits: trailing data after the JSON object")
	}
	l := base
	setU32 := func(dst *uint32, v *uint32) {
		if v != nil {
			*dst = *v
		}
	}
	setU32(&l.RoomMembers, j.RoomMembers)
	setU32(&l.StreamMaxFPS, j.StreamMaxFPS)
	setU32(&l.CameraMaxFPS, j.CameraMaxFPS)
	setU32(&l.StreamsPerRoom, j.StreamsPerRoom)
	setU32(&l.CamerasPerRoom, j.CamerasPerRoom)
	setU32(&l.Members, j.Members)
	setU32(&l.StickerPacks, j.StickerPacks)
	setU32(&l.Stickers, j.Stickers)
	setU32(&l.Bots, j.Bots)
	setU32(&l.AudioMaxKbps, j.AudioMaxKbps)
	setU32(&l.Boards, j.Boards)
	if j.StorageMB != nil {
		l.StorageMB = *j.StorageMB
	}
	if j.CalDAVDisabled != nil {
		l.CalDAVDisabled = *j.CalDAVDisabled
	}
	if j.MusicianDisabled != nil {
		l.MusicianDisabled = *j.MusicianDisabled
	}
	if j.Checklists != nil {
		l.ChecklistsDisabled = *j.Checklists
	}
	if j.BoardWebhooks != nil {
		l.BoardWebhooksDisabled = *j.BoardWebhooks
	}
	if j.Telephony != nil {
		l.TelephonyDisabled = *j.Telephony
	}
	if j.Automations != nil {
		l.AutomationsDisabled = *j.Automations
	}
	for _, p := range []struct {
		dst  *v1.ScreenSharePreset
		v    *string
		name string
	}{{&l.StreamMaxPreset, j.StreamMaxPreset, "stream_max_preset"}, {&l.CameraMaxPreset, j.CameraMaxPreset, "camera_max_preset"}} {
		if p.v == nil {
			continue
		}
		v, ok := presetNames[strings.ToLower(strings.TrimSpace(*p.v))]
		if !ok {
			return Limits{}, fmt.Errorf("plan limits: %s must be economy, h720, h1080, original or empty, got %q", p.name, *p.v)
		}
		*p.dst = v
	}
	if err := l.Validate(); err != nil {
		return Limits{}, err
	}
	return l, nil
}

// MarshalJSON returns the full JSON form (every key present), as stored in the database.
func (l Limits) MarshalJSON() ([]byte, error) {
	sp, cp := presetName(l.StreamMaxPreset), presetName(l.CameraMaxPreset)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	err := enc.Encode(limitsJSON{
		RoomMembers: &l.RoomMembers, StreamMaxPreset: &sp, StreamMaxFPS: &l.StreamMaxFPS,
		CameraMaxPreset: &cp, CameraMaxFPS: &l.CameraMaxFPS, StreamsPerRoom: &l.StreamsPerRoom, CamerasPerRoom: &l.CamerasPerRoom,
		StorageMB: &l.StorageMB, Members: &l.Members, StickerPacks: &l.StickerPacks, Stickers: &l.Stickers, Bots: &l.Bots,
		AudioMaxKbps: &l.AudioMaxKbps, Boards: &l.Boards, CalDAVDisabled: &l.CalDAVDisabled, MusicianDisabled: &l.MusicianDisabled,
		Checklists: &l.ChecklistsDisabled, BoardWebhooks: &l.BoardWebhooksDisabled, Telephony: &l.TelephonyDisabled,
		Automations: &l.AutomationsDisabled,
	})
	return bytes.TrimSpace(buf.Bytes()), err
}

// Validate checks the bounds of every limit.
func (l Limits) Validate() error {
	var errs []error
	check := func(ok bool, field string, bound uint64) {
		if !ok {
			errs = append(errs, fmt.Errorf("plan limits: %s must be ≤ %d", field, bound))
		}
	}
	check(l.RoomMembers <= maxRoomMembers, "room_members", maxRoomMembers)
	check(l.StreamMaxFPS <= maxFPS, "stream_max_fps", maxFPS)
	check(l.CameraMaxFPS <= maxFPS, "camera_max_fps", maxFPS)
	check(l.StreamsPerRoom <= maxStreamsPerRoom, "streams_per_room", maxStreamsPerRoom)
	check(l.CamerasPerRoom <= maxCamerasPerRoom, "cameras_per_room", maxCamerasPerRoom)
	check(l.StorageMB <= maxStorageMB, "storage_mb", maxStorageMB)
	check(l.Members <= maxMembers, "members", maxMembers)
	check(l.StickerPacks <= maxStickerPacks, "sticker_packs", maxStickerPacks)
	check(l.Stickers <= maxStickers, "stickers", maxStickers)
	check(l.Bots <= maxBots, "bots", maxBots)
	check(l.Boards <= maxBoards, "boards", maxBoards)
	if !audioTiers[l.AudioMaxKbps] {
		errs = append(errs, fmt.Errorf("plan limits: audio_tier_max_kbps must be 0, 8, 16, 32 or %d", maxAudioKbps))
	}
	for name, p := range map[string]v1.ScreenSharePreset{"stream_max_preset": l.StreamMaxPreset, "camera_max_preset": l.CameraMaxPreset} {
		if p < v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || p > v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL {
			errs = append(errs, fmt.Errorf("plan limits: invalid %s", name))
		}
	}
	return errors.Join(errs...)
}

// Proto converts the limits to the wire message.
func (l Limits) Proto() *v1.PlanLimits {
	return &v1.PlanLimits{
		RoomMembers: l.RoomMembers, StreamMaxPreset: l.StreamMaxPreset, StreamMaxFps: l.StreamMaxFPS,
		CameraMaxPreset: l.CameraMaxPreset, CameraMaxFps: l.CameraMaxFPS, StreamsPerRoom: l.StreamsPerRoom, CamerasPerRoom: l.CamerasPerRoom,
		StorageMb: l.StorageMB, Members: l.Members, StickerPacks: l.StickerPacks, Stickers: l.Stickers, Bots: l.Bots,
		AudioTierMaxKbps: l.AudioMaxKbps, Boards: l.Boards, CaldavDisabled: l.CalDAVDisabled, MusicianDisabled: l.MusicianDisabled,
		ChecklistsDisabled: l.ChecklistsDisabled, BoardWebhooksDisabled: l.BoardWebhooksDisabled, TelephonyDisabled: l.TelephonyDisabled,
		AutomationsDisabled: l.AutomationsDisabled,
	}
}

// FromProto converts the wire message (nil = no limits).
func FromProto(p *v1.PlanLimits) Limits {
	return Limits{
		RoomMembers: p.GetRoomMembers(), StreamMaxPreset: p.GetStreamMaxPreset(), StreamMaxFPS: p.GetStreamMaxFps(),
		CameraMaxPreset: p.GetCameraMaxPreset(), CameraMaxFPS: p.GetCameraMaxFps(), StreamsPerRoom: p.GetStreamsPerRoom(), CamerasPerRoom: p.GetCamerasPerRoom(),
		StorageMB: p.GetStorageMb(), Members: p.GetMembers(), StickerPacks: p.GetStickerPacks(), Stickers: p.GetStickers(), Bots: p.GetBots(),
		AudioMaxKbps: p.GetAudioTierMaxKbps(), Boards: p.GetBoards(), CalDAVDisabled: p.GetCaldavDisabled(), MusicianDisabled: p.GetMusicianDisabled(),
		ChecklistsDisabled: p.GetChecklistsDisabled(), BoardWebhooksDisabled: p.GetBoardWebhooksDisabled(), TelephonyDisabled: p.GetTelephonyDisabled(),
		AutomationsDisabled: p.GetAutomationsDisabled(),
	}
}

// StorageBytes is the plan's storage limit in bytes; ok=false when unlimited.
func (l Limits) StorageBytes() (int64, bool) {
	if l.StorageMB == 0 {
		return 0, false
	}
	return int64(l.StorageMB) << 20, true //nolint:gosec // bounded by maxStorageMB
}

// ---- media caps (used by rtc) ----

// presetFPS is the native frame rate of a screen share preset (docs/02-media.md).
func presetFPS(p v1.ScreenSharePreset) uint32 {
	switch p {
	case v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY:
		return 5
	case v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL:
		return 30
	}
	return 15
}

// CapPreset lowers p to limit (UNSPECIFIED limit = none). p must be concrete.
func CapPreset(p, limit v1.ScreenSharePreset) v1.ScreenSharePreset {
	if limit != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED && p > limit {
		return limit
	}
	return p
}

func minNonZero(vals ...uint32) uint32 {
	out := uint32(0)
	for _, v := range vals {
		if v != 0 && (out == 0 || v < out) {
			out = v
		}
	}
	return out
}

// StreamFPS returns the frame rate granted to a screen share of the (already capped) preset:
// min(wanted, the preset's own, the plan cap); wanted 0 = the preset's own.
func (l Limits) StreamFPS(preset v1.ScreenSharePreset, wanted uint32) uint32 {
	return minNonZero(wanted, presetFPS(preset), l.StreamMaxFPS)
}

// Camera returns the webcam quality granted for the wanted one: min(wanted, plan cap), where
// UNSPECIFIED / 0 wanted means "the best allowed" (the plan cap, or none).
func (l Limits) Camera(wanted v1.ScreenSharePreset, wantedFPS uint32) (v1.ScreenSharePreset, uint32) {
	p := wanted
	if p == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || p > v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL {
		p = l.CameraMaxPreset
	} else {
		p = CapPreset(p, l.CameraMaxPreset)
	}
	return p, minNonZero(wantedFPS, l.CameraMaxFPS)
}

// AudioAllowed reports whether the plan lets a room / workspace be set to kbps.
func (l Limits) AudioAllowed(kbps uint32) bool { return l.AudioMaxKbps == 0 || kbps <= l.AudioMaxKbps }

// CapAudio lowers a voice bitrate to the plan's tier cap (0 kbps stays 0: "not set").
func (l Limits) CapAudio(kbps uint32) uint32 {
	if l.AudioMaxKbps > 0 && kbps > l.AudioMaxKbps {
		return l.AudioMaxKbps
	}
	return kbps
}

// CapMedia returns room media settings with the plan's caps applied (audio_bitrate_kbps,
// max_stream_preset, max_streams). m is not modified.
func (l Limits) CapMedia(m *v1.RoomMediaSettings) *v1.RoomMediaSettings {
	out := &v1.RoomMediaSettings{
		AudioBitrateKbps: l.CapAudio(m.GetAudioBitrateKbps()), MaxStreamPreset: m.GetMaxStreamPreset(),
		MaxStreams: m.GetMaxStreams(), CameraLimit: m.GetCameraLimit(),
	}
	if out.MaxStreamPreset == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		out.MaxStreamPreset = l.StreamMaxPreset
	} else {
		out.MaxStreamPreset = CapPreset(out.MaxStreamPreset, l.StreamMaxPreset)
	}
	if l.StreamsPerRoom > 0 && out.MaxStreams > l.StreamsPerRoom {
		out.MaxStreams = l.StreamsPerRoom
	}
	if l.CamerasPerRoom > 0 && out.CameraLimit > l.CamerasPerRoom {
		out.CameraLimit = l.CamerasPerRoom
	}
	return out
}
