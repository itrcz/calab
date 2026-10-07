// Package pbconv converts DB rows (sqlc) to wire messages (calaba.v1) and maps enums
// between their DB text form and proto. Keep all such mapping here.
package pbconv

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/superadmin"
)

func ts(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

func tsp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func idp(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// ---- enums ----

var presetToDB = map[v1.ScreenSharePreset]string{
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY:  "economy",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720:     "h720",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080:    "h1080",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL: "original",
}

// PresetToDB maps a concrete preset to its DB text; ok=false for UNSPECIFIED/unknown.
func PresetToDB(p v1.ScreenSharePreset) (string, bool) {
	s, ok := presetToDB[p]
	return s, ok
}

// PresetFromDB maps DB text to the enum.
func PresetFromDB(s string) v1.ScreenSharePreset {
	for k, v := range presetToDB {
		if v == s {
			return k
		}
	}
	return v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED
}

// VisibilityToDB maps the enum; UNSPECIFIED means private.
func VisibilityToDB(v v1.WorkspaceVisibility) (string, bool) {
	switch v {
	case v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_UNSPECIFIED, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE:
		return "private", true
	case v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN:
		return "open", true
	}
	return "", false
}

// TimeFormatToDB maps the clock format (docs/09 #73); ok=false for UNSPECIFIED/unknown.
func TimeFormatToDB(f v1.TimeFormat) (string, bool) {
	switch f {
	case v1.TimeFormat_TIME_FORMAT_AUTO:
		return "auto", true
	case v1.TimeFormat_TIME_FORMAT_H24:
		return "h24", true
	case v1.TimeFormat_TIME_FORMAT_H12:
		return "h12", true
	}
	return "", false
}

func timeFormatFromDB(s string) v1.TimeFormat {
	switch s {
	case "h24":
		return v1.TimeFormat_TIME_FORMAT_H24
	case "h12":
		return v1.TimeFormat_TIME_FORMAT_H12
	}
	return v1.TimeFormat_TIME_FORMAT_AUTO
}

func visibilityFromDB(s string) v1.WorkspaceVisibility {
	if s == "open" {
		return v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN
	}
	return v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE
}

// RoomTypeToDB maps the enum; ok=false for UNSPECIFIED/unknown.
func RoomTypeToDB(t v1.RoomType) (string, bool) {
	switch t {
	case v1.RoomType_ROOM_TYPE_VOICE:
		return "voice", true
	case v1.RoomType_ROOM_TYPE_TEXT:
		return "text", true
	}
	return "", false
}

func roomTypeFromDB(s string) v1.RoomType {
	switch s {
	case "voice":
		return v1.RoomType_ROOM_TYPE_VOICE
	case "dm":
		return v1.RoomType_ROOM_TYPE_DM
	case "notes":
		return v1.RoomType_ROOM_TYPE_NOTES
	case "task":
		return v1.RoomType_ROOM_TYPE_TASK
	}
	return v1.RoomType_ROOM_TYPE_TEXT
}

// TargetTypeToDB maps the enum; ok=false for UNSPECIFIED/unknown.
func TargetTypeToDB(t v1.PermissionTargetType) (string, bool) {
	switch t {
	case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE:
		return "role", true
	case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER:
		return "user", true
	}
	return "", false
}

func targetTypeFromDB(s string) v1.PermissionTargetType {
	if s == "role" {
		return v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	}
	return v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
}

// ---- users / sessions ----

// User is the public profile. An expired custom status is returned empty.
func User(u sqlc.User) *v1.User {
	out := &v1.User{
		Id:           u.ID.String(),
		DisplayName:  u.DisplayName,
		AvatarFileId: idp(u.AvatarFileID),
		CreatedAt:    ts(u.CreatedAt),
		IsGuest:      u.IsGuest,
		Timezone:     deref(u.Timezone),
		IsBot:        u.IsBot,
		Username:     deref(u.Username), // public (ADR-0077); contacts: WithContacts
	}
	if !u.BirthdayHidden { // a hidden birthday goes to its owner only (Me)
		out.Birthday = Birthday(u.BirthdayDay, u.BirthdayMonth, u.BirthdayYear)
	}
	out.StatusText, out.StatusEmoji, out.StatusExpiresAt = Status(u)
	return out
}

// Birthday converts the users.birthday_* columns (nil = no birthday).
func Birthday(day, month, year *int16) *v1.Birthday {
	if day == nil || month == nil {
		return nil
	}
	b := &v1.Birthday{Day: uint32(*day), Month: uint32(*month)} //nolint:gosec // DB CHECK bounds them
	if year != nil {
		y := uint32(*year) //nolint:gosec // DB CHECK bounds it
		b.Year = &y
	}
	return b
}

// Status returns the user's current custom status (empty once expired).
func Status(u sqlc.User) (text, emoji string, expires *timestamppb.Timestamp) {
	if u.StatusExpiresAt != nil && !time.Now().Before(*u.StatusExpiresAt) {
		return "", "", nil
	}
	return u.StatusText, u.StatusEmoji, tsp(u.StatusExpiresAt)
}

// Settings decodes users.settings (protojson). Fields missing from the stored JSON (rows
// created before a field existed) get their defaults; corrupt data yields defaults.
func Settings(raw []byte) *v1.UserSettings {
	s := &v1.UserSettings{}
	var present map[string]json.RawMessage
	if len(raw) > 0 && json.Unmarshal(raw, &present) == nil {
		_ = protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(raw, s)
	}
	// noiseSuppression (RNNoise) defaults to off since migration 00025 (owner, 27.09: CPU on weak
	// machines); rows without the field are older than 00025, which wrote it explicitly.
	_ = present
	return NormalizeSettings(s)
}

// NormalizeSettings resolves mic_mode (UNSPECIFIED → from the legacy push_to_talk flag,
// else VAD) and keeps the deprecated push_to_talk flag in sync with it.
func NormalizeSettings(s *v1.UserSettings) *v1.UserSettings {
	if s.GetMicMode() == v1.MicMode_MIC_MODE_UNSPECIFIED {
		s.MicMode = v1.MicMode_MIC_MODE_VAD
		if s.GetPushToTalk() { //nolint:staticcheck // legacy field
			s.MicMode = v1.MicMode_MIC_MODE_PUSH_TO_TALK
		}
	}
	s.PushToTalk = s.GetMicMode() == v1.MicMode_MIC_MODE_PUSH_TO_TALK //nolint:staticcheck // legacy field
	return s
}

// EncodeSettings stores settings with every field explicit, so a stored false stays false.
func EncodeSettings(s *v1.UserSettings) ([]byte, error) {
	s = NormalizeSettings(proto.CloneOf(s))
	// Meeting reminders live in their own columns (users.event_reminders*, ADR-0038 §5).
	s.EventReminders, s.EventRemindersDnd = nil, false
	s.WorkHours = nil                        // users.work_* columns (ADR-0041)
	s.HideMessageTextInNotifications = false // dedicated privacy column (ADR-0072)
	return protojson.MarshalOptions{EmitDefaultValues: true}.Marshal(s)
}

// DefaultSettings are the settings of a new user.
func DefaultSettings() *v1.UserSettings {
	return &v1.UserSettings{NoiseSuppression: false, MicMode: v1.MicMode_MIC_MODE_VAD}
}

// Me is the authenticated user's own view.
func Me(u sqlc.User) *v1.Me {
	email := ""
	if u.Email != nil {
		email = *u.Email
	}
	settings := Settings(u.Settings)
	settings.HideMessageTextInNotifications = u.HideMessageTextInNotifications
	settings.EventReminders = make([]uint32, 0, len(u.EventReminders))
	for _, m := range u.EventReminders {
		settings.EventReminders = append(settings.EventReminders, uint32(max(m, 0))) //nolint:gosec // ≤ 1440
	}
	settings.EventRemindersDnd = u.EventRemindersDnd
	settings.WorkHours = &v1.WorkHours{StartMin: uint32(max(u.WorkStartMin, 0)), EndMin: uint32(max(u.WorkEndMin, 0)), //nolint:gosec // ≤ 1440
		Days: make([]uint32, 0, len(u.WorkDays))}
	for _, d := range u.WorkDays {
		settings.WorkHours.Days = append(settings.WorkHours.Days, uint32(max(d, 0))) //nolint:gosec // 1..7
	}
	me := &v1.Me{User: WithContacts(User(u), u), Email: email, Settings: settings,
		EmailVerified: u.IsGuest || u.EmailVerifiedAt != nil,                 // guests have no email to verify
		IsSuperadmin:  u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)} // an unverified address proves nothing
	if u.PendingEmail != nil {
		me.PendingEmail = *u.PendingEmail
	}
	if u.Locale != nil {
		me.Locale = *u.Locale
	}
	me.User.Birthday = Birthday(u.BirthdayDay, u.BirthdayMonth, u.BirthdayYear) // hidden or not
	me.BirthdayHidden = u.BirthdayHidden
	return me
}

// Session converts a session; current marks the caller's own session.
func Session(s sqlc.Session, current uuid.UUID) *v1.Session {
	return &v1.Session{
		Id:         s.ID.String(),
		DeviceName: s.DeviceName,
		Ip:         s.Ip,
		UserAgent:  s.UserAgent,
		CreatedAt:  ts(s.CreatedAt),
		LastSeenAt: ts(s.LastSeenAt),
		ExpiresAt:  ts(s.ExpiresAt),
		Current:    s.ID == current,
		Authority:  SessionAuthority(s),
	}
}

// ---- workspaces ----

// WorkspaceDefaults returns the workspace media defaults.
func WorkspaceDefaults(w sqlc.Workspace) *v1.RoomMediaSettings {
	return &v1.RoomMediaSettings{
		AudioBitrateKbps: uint32(w.DefaultAudioBitrateKbps), //nolint:gosec // DB CHECK bounds it
		MaxStreamPreset:  PresetFromDB(w.DefaultMaxStreamPreset),
		MaxStreams:       uint32(w.DefaultMaxStreams),  //nolint:gosec // DB CHECK bounds it
		CameraLimit:      uint32(w.DefaultCameraLimit), //nolint:gosec // DB CHECK bounds it
	}
}

// Workspace converts a workspace row. A suspension carries its reason: views for other than
// the owner / admins go through ForViewer.
func Workspace(w sqlc.Workspace) *v1.Workspace {
	var susp *v1.WorkspaceSuspension
	if w.SuspendedAt != nil {
		susp = &v1.WorkspaceSuspension{At: ts(*w.SuspendedAt), Reason: w.SuspendedReason}
	}
	return &v1.Workspace{
		Suspension:        susp,
		Id:                w.ID.String(),
		Slug:              w.Slug,
		Name:              w.Name,
		IconFileId:        idp(w.IconFileID),
		Visibility:        visibilityFromDB(w.Visibility),
		OwnerId:           w.OwnerID.String(),
		CreatedAt:         ts(w.CreatedAt),
		MediaDefaults:     WorkspaceDefaults(w),
		StorageQuotaBytes: uint64(max(w.StorageQuotaBytes, 0)),
		StorageUsedBytes:  uint64(max(w.StorageUsedBytes, 0)),
		AllowSelfNickname: w.AllowSelfNickname,
		TimeFormat:        timeFormatFromDB(w.TimeFormat),
		SipEnabled:        w.SipEnabled,
	}
}

// SeesSuspensionReason reports whether a role sees why the workspace is suspended (owner, admins).
func SeesSuspensionReason(role perm.Role) bool {
	return role == perm.RoleOwner || role == perm.RoleAdmin
}

// ForViewer returns ws as a viewer with role sees it: without the suspension reason unless
// SeesSuspensionReason. ws is not modified (a copy is returned when something is hidden).
func ForViewer(ws *v1.Workspace, role perm.Role) *v1.Workspace {
	if ws.GetSuspension().GetReason() == "" || SeesSuspensionReason(role) {
		return ws
	}
	c := proto.Clone(ws).(*v1.Workspace)
	c.Suspension.Reason = ""
	return c
}

// Ban converts a ban row with the banned user.
func Ban(b sqlc.WorkspaceBan, u sqlc.User) *v1.WorkspaceBan {
	out := &v1.WorkspaceBan{
		WorkspaceId: b.WorkspaceID.String(), User: User(u), Reason: b.Reason, BannedBy: idp(b.BannedBy),
		CreatedAt: ts(b.CreatedAt),
	}
	if b.Email != nil {
		out.Email = *b.Email
	}
	return out
}

// Member converts a membership row with its user and role ids (ADR-0026, highest first).
func Member(m sqlc.WorkspaceMember, u sqlc.User, roleIDs []uuid.UUID) *v1.WorkspaceMember {
	return &v1.WorkspaceMember{
		WorkspaceId: m.WorkspaceID.String(),
		User:        User(u),
		Role:        perm.Role(m.Role).Proto(),
		Nickname:    m.Nickname,
		JoinedAt:    ts(m.JoinedAt),
		RoleIds:     perm.IDStrings(roleIDs),
		BadgeId:     idp(m.BadgeID),
		// ADR-0061: kept by the grant / revoke transaction, never negative.
		AchievementCount: uint32(max(m.AchievementCount, 0)), //nolint:gosec // a count
	}
}

// Badge converts a workspace badge row (docs/09 #82).
func Badge(b sqlc.WorkspaceBadge) *v1.Badge {
	return &v1.Badge{Id: b.ID.String(), WorkspaceId: b.WorkspaceID.String(), Name: b.Name, FileId: b.FileID.String()}
}

// Badges converts badge rows.
func Badges(rows []sqlc.WorkspaceBadge) []*v1.Badge {
	out := make([]*v1.Badge, len(rows))
	for i, b := range rows {
		out[i] = Badge(b)
	}
	return out
}

// Background converts a workspace camera background row (ADR-0035).
func Background(b sqlc.WorkspaceBackground) *v1.WorkspaceBackground {
	return &v1.WorkspaceBackground{Id: b.ID.String(), WorkspaceId: b.WorkspaceID.String(), Name: b.Name, FileId: b.FileID.String()}
}

// Sound converts a soundboard row (ADR-0036).
func Sound(s sqlc.WorkspaceSound) *v1.Sound {
	return &v1.Sound{Id: s.ID.String(), WorkspaceId: s.WorkspaceID.String(), Name: s.Name, Emoji: s.Emoji,
		FileId: s.FileID.String(), DurationMs: uint32(max(s.DurationMs, 0)), Position: uint32(max(s.Position, 0))} //nolint:gosec // non-negative
}

// WorkspaceApp converts a web app row (ADR-0050).
func WorkspaceApp(a sqlc.WorkspaceApp) *v1.WorkspaceApp {
	pb := &v1.WorkspaceApp{Id: a.ID.String(), WorkspaceId: a.WorkspaceID.String(), Name: a.Name, Url: a.Url,
		Position: a.Position, CreatedAt: ts(a.CreatedAt), UpdatedAt: ts(a.UpdatedAt)}
	if a.IconFileID != nil {
		pb.IconFileId = a.IconFileID.String()
		pb.IconUrl = "/api/files/" + pb.IconFileId
	}
	if a.CreatedBy != nil {
		pb.CreatedBy = a.CreatedBy.String()
	}
	return pb
}

// WorkspaceApps converts web app rows.
func WorkspaceApps(rows []sqlc.WorkspaceApp) []*v1.WorkspaceApp {
	out := make([]*v1.WorkspaceApp, len(rows))
	for i, a := range rows {
		out[i] = WorkspaceApp(a)
	}
	return out
}

// Sounds converts soundboard rows.
func Sounds(rows []sqlc.WorkspaceSound) []*v1.Sound {
	out := make([]*v1.Sound, len(rows))
	for i, s := range rows {
		out[i] = Sound(s)
	}
	return out
}

// Backgrounds converts camera background rows.
func Backgrounds(rows []sqlc.WorkspaceBackground) []*v1.WorkspaceBackground {
	out := make([]*v1.WorkspaceBackground, len(rows))
	for i, b := range rows {
		out[i] = Background(b)
	}
	return out
}

// Role converts a workspace role row.
func Role(r sqlc.WorkspaceRole) *v1.Role {
	out := &v1.Role{
		Id:          r.ID.String(),
		WorkspaceId: r.WorkspaceID.String(),
		Name:        r.Name,
		Color:       uint32(max(r.Color, 0)), //nolint:gosec // 0..0xFFFFFF
		Position:    r.Position,
		Permissions: uint64(r.Permissions), //nolint:gosec // bit mask round-trip
		Mentionable: r.Mentionable,
		CreatedAt:   ts(r.CreatedAt),
	}
	if r.Builtin != nil {
		out.Builtin = perm.Role(*r.Builtin).Proto()
	}
	return out
}

// Roles converts role rows (order kept).
func Roles(rows []sqlc.WorkspaceRole) []*v1.Role {
	out := make([]*v1.Role, len(rows))
	for i, r := range rows {
		out[i] = Role(r)
	}
	return out
}

// Invite converts an invite row.
func Invite(i sqlc.WorkspaceInvite) *v1.Invite {
	return &v1.Invite{
		Id:          i.ID.String(),
		WorkspaceId: i.WorkspaceID.String(),
		Code:        i.Code,
		CreatedBy:   i.CreatedBy.String(),
		MaxUses:     uint32(max(i.MaxUses, 0)),
		Uses:        uint32(max(i.Uses, 0)),
		ExpiresAt:   tsp(i.ExpiresAt),
		CreatedAt:   ts(i.CreatedAt),
	}
}

// ---- rooms ----

// MediaOverride returns the raw per-room override.
func MediaOverride(r sqlc.Room) *v1.RoomMediaOverride {
	o := &v1.RoomMediaOverride{}
	if r.AudioBitrateKbps != nil {
		v := uint32(*r.AudioBitrateKbps) //nolint:gosec // DB CHECK bounds it
		o.AudioBitrateKbps = &v
	}
	if r.MaxStreamPreset != nil {
		v := PresetFromDB(*r.MaxStreamPreset)
		o.MaxStreamPreset = &v
	}
	if r.MaxStreams != nil {
		v := uint32(*r.MaxStreams) //nolint:gosec // DB CHECK bounds it
		o.MaxStreams = &v
	}
	if r.CameraLimit != nil {
		v := uint32(*r.CameraLimit) //nolint:gosec // DB CHECK bounds it
		o.CameraLimit = &v
	}
	return o
}

// EffectiveMedia merges the room override over the workspace defaults.
func EffectiveMedia(r sqlc.Room, defaults *v1.RoomMediaSettings) *v1.RoomMediaSettings {
	m := &v1.RoomMediaSettings{
		AudioBitrateKbps: defaults.GetAudioBitrateKbps(),
		MaxStreamPreset:  defaults.GetMaxStreamPreset(),
		MaxStreams:       defaults.GetMaxStreams(),
		CameraLimit:      defaults.GetCameraLimit(),
	}
	o := MediaOverride(r)
	if o.AudioBitrateKbps != nil {
		m.AudioBitrateKbps = *o.AudioBitrateKbps
	}
	if o.MaxStreamPreset != nil {
		m.MaxStreamPreset = *o.MaxStreamPreset
	}
	if o.MaxStreams != nil {
		m.MaxStreams = *o.MaxStreams
	}
	if o.CameraLimit != nil {
		m.CameraLimit = *o.CameraLimit
	}
	return m
}

// Override converts a room_permissions row.
func Override(p sqlc.RoomPermission) *v1.RoomPermissionOverride {
	return &v1.RoomPermissionOverride{
		TargetType: targetTypeFromDB(p.TargetType),
		TargetId:   p.TargetID,
		Allow:      uint64(p.Allow), //nolint:gosec // bit mask round-trip
		Deny:       uint64(p.Deny),  //nolint:gosec // bit mask round-trip
	}
}

// OverrideTargets converts rows for perm.ComputeIn.
func OverrideTargets(rows []sqlc.RoomPermission) []perm.OverrideTarget {
	out := make([]perm.OverrideTarget, len(rows))
	for i, p := range rows {
		out[i] = perm.OverrideTarget{
			TargetType: p.TargetType,
			TargetID:   p.TargetID,
			Override:   perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}, //nolint:gosec // bit mask
		}
	}
	return out
}

// Room builds the wire room with effective media settings and its overrides.
func Room(r sqlc.Room, defaults *v1.RoomMediaSettings, overrides []sqlc.RoomPermission) *v1.Room {
	ovs := make([]*v1.RoomPermissionOverride, len(overrides))
	for i, p := range overrides {
		ovs[i] = Override(p)
	}
	return &v1.Room{
		Id:                  r.ID.String(),
		WorkspaceId:         idp(r.WorkspaceID),
		Type:                roomTypeFromDB(r.Type),
		Name:                r.Name,
		Topic:               r.Topic,
		Position:            r.Position,
		IsPrivate:           r.IsPrivate,
		Restricted:          r.Restricted,
		Media:               EffectiveMedia(r, defaults),
		MediaOverride:       MediaOverride(r),
		PermissionOverrides: ovs,
		CreatedAt:           ts(r.CreatedAt),
		CategoryId:          idp(r.CategoryID),
		UserLimit:           uint32(max(r.UserLimit, 0)),
		VoiceStatus:         deref(r.VoiceStatus),
		AllowRecording:      r.AllowRecording,
		GuestApproval:       r.GuestApproval,
		ExpiresAt:           tsp(r.ExpiresAt),
		CreatedBy:           idp(r.CreatedBy),
		ArchivedAt:          tsp(r.ArchivedAt),
	}
}

// DMRoom is the wire form of a direct message room (ADR-0020): no workspace, name, topic,
// media or overrides — clients title it with the peer. A notes shelf (ADR-0039) carries its
// name and position.
func DMRoom(r sqlc.Room) *v1.Room {
	out := &v1.Room{Id: r.ID.String(), Type: roomTypeFromDB(r.Type), CreatedAt: ts(r.CreatedAt)}
	if r.Type == "notes" {
		out.Name, out.Position = r.Name, r.Position
	}
	return out
}

// Category converts a room category row.
func Category(c sqlc.RoomCategory) *v1.RoomCategory {
	return &v1.RoomCategory{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Name: c.Name, Position: c.Position}
}

// Categories converts category rows.
func Categories(cs []sqlc.RoomCategory) []*v1.RoomCategory {
	out := make([]*v1.RoomCategory, len(cs))
	for i, c := range cs {
		out[i] = Category(c)
	}
	return out
}

// ---- files / messages ----

// IsImage reports whether a stored mime type gets a thumbnail and inline display.
func IsImage(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

// File converts a file row; URLs are API paths.
func File(f sqlc.File) *v1.FileMeta {
	m := &v1.FileMeta{
		Id:          f.ID.String(),
		WorkspaceId: idp(f.WorkspaceID),
		UploaderId:  f.UploaderID.String(),
		Name:        f.Name,
		Mime:        f.Mime,
		Size:        uint64(max(f.Size, 0)),
		Sha256:      f.Sha256,
		Url:         "/api/files/" + f.ID.String(),
		CreatedAt:   ts(f.CreatedAt),
	}
	if f.Width != nil && f.Height != nil {
		m.Width, m.Height = uint32(max(*f.Width, 0)), uint32(max(*f.Height, 0))
	}
	if f.ThumbnailKey != nil {
		m.ThumbnailUrl = m.Url + "/thumbnail"
	}
	if f.VoiceDurationMs != nil {
		m.Voice = &v1.VoiceInfo{DurationMs: uint32(max(*f.VoiceDurationMs, 0)), Waveform: f.VoiceWaveform}
	}
	return m
}

// Message converts a message row with its attachments (in order).
func Message(m sqlc.Message, files []sqlc.File) *v1.Message {
	out := &v1.Message{
		Id:          m.ID.String(),
		RoomId:      m.RoomID.String(),
		AuthorId:    m.AuthorID.String(),
		Content:     m.Content,
		ReplyToId:   idp(m.ReplyToID),
		CreatedAt:   ts(m.CreatedAt),
		EditedAt:    tsp(m.EditedAt),
		Attachments: make([]*v1.FileMeta, len(files)),
	}
	if len(m.InlineKeyboard) > 0 && m.ForwardSentAt == nil {
		out.InlineKeyboard = &v1.InlineKeyboard{}
		_ = protojson.Unmarshal(m.InlineKeyboard, out.InlineKeyboard)
	}
	out.KeyboardRevision = uint64(m.KeyboardRevision) //nolint:gosec // nonnegative DB constraint
	if m.Nonce != nil {
		out.Nonce = *m.Nonce
	}
	out.PinnedAt, out.PinnedBy = tsp(m.PinnedAt), idp(m.PinnedBy)
	out.EmbedsHidden = m.EmbedsHidden
	if m.Kind == MessageKindSystem {
		out.Kind = v1.MessageKind_MESSAGE_KIND_SYSTEM
		out.System = &v1.SystemMessage{}
		if len(m.Payload) > 0 {
			_ = protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(m.Payload, out.System)
		}
	}
	if m.ForwardSentAt != nil { // a forwarded copy (ADR-0033); Forward.room_id is filled by the caller
		out.Forward = &v1.Forward{AuthorId: idp(m.ForwardAuthorID), MessageId: idp(m.ForwardedFrom), SentAt: tsp(m.ForwardSentAt)}
	}
	for i, f := range files {
		out.Attachments[i] = File(f)
	}
	return out
}

// MessageKindSystem is messages.kind of a system message (ADR-0025).
const MessageKindSystem = "system"

// RoomFlags returns the permission flags of a wire room for perm.ComputeIn (restricted,
// ADR-0029; private temporary and its creator, ADR-0078).
func RoomFlags(r *v1.Room) perm.RoomFlags {
	f := perm.RoomFlags{Restricted: r.GetRestricted(), PrivateTemp: r.GetIsPrivate() && r.GetExpiresAt() != nil}
	if id, err := uuid.Parse(r.GetCreatedBy()); err == nil {
		f.CreatedBy = id
	}
	return f
}

// ProtoOverrideTargets converts wire overrides for perm.ComputeIn.
func ProtoOverrideTargets(ovs []*v1.RoomPermissionOverride) []perm.OverrideTarget {
	out := make([]perm.OverrideTarget, 0, len(ovs))
	for _, o := range ovs {
		tt := "user"
		if o.GetTargetType() == v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE {
			tt = "role"
		}
		out = append(out, perm.OverrideTarget{TargetType: tt, TargetID: o.GetTargetId(),
			Override: perm.Override{Allow: perm.Bits(o.GetAllow()), Deny: perm.Bits(o.GetDeny())}})
	}
	return out
}

// RoomNotificationSettings converts a stored row.
func RoomNotificationSettings(s sqlc.RoomNotificationSetting) *v1.RoomNotificationSettings {
	return &v1.RoomNotificationSettings{
		RoomId: s.RoomID.String(), MutedUntil: tsp(s.MutedUntil),
		Level: notifications.LevelFromDB(s.Level, v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT),
	}
}

// WorkspaceNotificationSettings converts a stored row.
func WorkspaceNotificationSettings(s sqlc.WorkspaceNotificationSetting) *v1.WorkspaceNotificationSettings {
	return &v1.WorkspaceNotificationSettings{
		WorkspaceId: s.WorkspaceID.String(), MutedUntil: tsp(s.MutedUntil),
		Level:     notifications.LevelFromDB(s.Level, v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS),
		TaskLevel: notifications.LevelFromDB(s.TaskLevel, v1.NotificationLevel_NOTIFICATION_LEVEL_ALL),
	}
}

// SessionAuthority exposes persisted provenance without adding assurance.
func SessionAuthority(s sqlc.Session) *v1.SessionAuthority {
	kind := v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_UNSPECIFIED
	switch s.AuthorityKind {
	case "local_account":
		kind = v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_LOCAL_ACCOUNT
	case "workspace_sso":
		kind = v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_WORKSPACE_SSO
	case "recovery":
		kind = v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_RECOVERY
	}
	a := &v1.SessionAuthority{Kind: kind, Version: uint64(max(s.AuthorityVersion, 0))}
	if s.AuthorityWorkspaceID != nil {
		a.WorkspaceId = s.AuthorityWorkspaceID.String()
	}
	if s.AuthorityConnectionID != nil {
		a.ConnectionId = s.AuthorityConnectionID.String()
	}
	if s.LocalAuthenticatedAt != nil {
		a.LocalAuthenticatedAt = ts(*s.LocalAuthenticatedAt)
	}
	return a
}

// ScopedMe is the minimal profile available under workspace authority.
func ScopedMe(u sqlc.User) *v1.Me {
	return &v1.Me{User: &v1.User{Id: u.ID.String(), DisplayName: u.DisplayName}}
}

// LocalMe resolves the operator UUID grant for an independently local account profile.
// Corporate/recovery consumers must instead use ScopedMe and never call this conversion.
func LocalMe(ctx context.Context, q *sqlc.Queries, u sqlc.User) (*v1.Me, error) {
	out := Me(u)
	if u.IsGuest || u.IsBot || u.DisabledAt != nil {
		out.IsSuperadmin = false
		return out, nil
	}
	grant, err := q.GetProductAdminGrant(ctx, u.ID)
	if err != nil && !db.IsNotFound(err) {
		return nil, err
	}
	out.IsSuperadmin = out.IsSuperadmin || err == nil && grant.RevokedAt == nil
	return out, nil
}
