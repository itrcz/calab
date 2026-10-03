// Package achievements serves ADR-0061 (amendment 1): the achievement catalog of every
// workspace kept by its owner and admins (MANAGE_WORKSPACE), grants of achievements to workspace
// members and the grant's card in the workspace's general chat (SystemMessage.achievement).
package achievements

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Field limits (characters) and the catalog size of a workspace.
const (
	maxTitle        = 60
	maxDescription  = 200
	maxNote         = 120
	MaxPerWorkspace = 100
)

// Reasons of the 4xx answers (ApiError.reason).
const (
	ReasonNeedsAlpha = "IMAGE_NEEDS_ALPHA"
	ReasonInUse      = "ACHIEVEMENT_IN_USE"
	ReasonSelfGrant  = "SELF_GRANT"
	ReasonArchived   = "ACHIEVEMENT_ARCHIVED"
	ReasonLimit      = "ACHIEVEMENT_LIMIT"
)

// Service serves the catalogs and the grants.
type Service struct {
	db     *db.DB
	store  blob.Store
	files  *files.Service
	events events.Publisher
	system *messages.System
	voice  rooms.VoiceRooms
}

// New creates the service. fs stores the pictures as workspace files; voice lets guests see the
// members of their call (the profile rule, ADR-0051); nil = fail closed for those.
func New(d *db.DB, store blob.Store, fs *files.Service, ev events.Publisher, voice rooms.VoiceRooms) *Service {
	return &Service{db: d, store: store, files: fs, events: ev, system: messages.NewSystem(d, ev), voice: voice}
}

// Routes registers the routes; wrap applies auth and the permission resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	handle := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(f)) }
	handle("GET /api/workspaces/{id}/achievements", s.catalog)
	handle("POST /api/workspaces/{id}/achievements", s.create)
	handle("PATCH /api/achievements/{id}", s.update)
	handle("DELETE /api/achievements/{id}", s.remove)
	handle("GET /api/workspaces/{id}/members/{userId}/achievements", s.list)
	handle("POST /api/workspaces/{id}/members/{userId}/achievements", s.grant)
	handle("DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}", s.revoke)
}

// Proto converts a catalog row; granted / inUse are its grant stats.
func Proto(a sqlc.Achievement, granted int64, inUse bool) *v1.Achievement {
	out := &v1.Achievement{
		Id: a.ID.String(), WorkspaceId: a.WorkspaceID.String(), Title: a.Title, Description: a.Description,
		ImageSize: uint32(max(a.ImageSize, 0)), Width: uint32(max(a.Width, 0)), Height: uint32(max(a.Height, 0)), //nolint:gosec // non-negative
		Position: a.Position, CreatedAt: timestamppb.New(a.CreatedAt), UpdatedAt: timestamppb.New(a.UpdatedAt),
		GrantedCount: uint32(max(granted, 0)), InUse: inUse, //nolint:gosec // a count
	}
	if a.FileID != nil {
		out.FileId = a.FileID.String()
	}
	if a.ArchivedAt != nil {
		out.ArchivedAt = timestamppb.New(*a.ArchivedAt)
	}
	return out
}

// GrantProto converts a grant; roomID is the room of its card (nil = none).
func GrantProto(g sqlc.MemberAchievement, roomID *uuid.UUID) *v1.MemberAchievement {
	out := &v1.MemberAchievement{
		Id: g.ID.String(), WorkspaceId: g.WorkspaceID.String(), UserId: g.UserID.String(),
		AchievementId: g.AchievementID.String(), Note: g.Note, GrantedAt: timestamppb.New(g.GrantedAt),
	}
	if g.GrantedBy != nil {
		out.GrantedBy = g.GrantedBy.String()
	}
	if g.MessageID != nil && roomID != nil {
		out.MessageId, out.RoomId = g.MessageID.String(), roomID.String()
	}
	return out
}

// access resolves the workspace of the path and the caller's bits and role there (404 for a
// non-member).
func access(r *http.Request) (uuid.UUID, perm.Bits, perm.Role, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, 0, "", err
	}
	bits, role, err := workspaceAccess(r, wsID, "workspace")
	return wsID, bits, role, err
}

// workspaceAccess: the caller's bits and role in wsID; a non-member gets 404 what.
func workspaceAccess(r *http.Request, wsID uuid.UUID, what string) (perm.Bits, perm.Role, error) {
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return 0, "", httpx.NotFound(what)
	}
	return bits, role, err
}

// canManageCatalog: MANAGE_WORKSPACE, never a guest.
func canManageCatalog(bits perm.Bits, role perm.Role) error {
	if !bits.Has(perm.ManageWorkspace) || role == perm.RoleGuest {
		return httpx.Forbidden("MANAGE_WORKSPACE required")
	}
	return nil
}

// catalog: GET /api/workspaces/{id}/achievements — the workspace's catalog by position (archived
// entries flagged), with an ETag of its content.
func (s *Service) catalog(w http.ResponseWriter, r *http.Request) error {
	wsID, _, _, err := access(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWorkspaceAchievements(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListAchievementsResponse{Achievements: make([]*v1.Achievement, len(rows))}
	for i, row := range rows {
		out.Achievements[i] = Proto(row.Achievement, row.Granted, row.InUse)
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(out)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	etag := `"` + hex.EncodeToString(sum[:12]) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache") // revalidate with If-None-Match
	if inm := r.Header.Get("If-None-Match"); inm != "" && etagMatch(inm, etag) {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func etagMatch(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		if t == "*" || strings.TrimPrefix(t, "W/") == etag {
			return true
		}
	}
	return false
}

// text validates a trimmed single-line text field of min..max characters.
func text(field, v string, minLen, maxLen int) (string, error) {
	v = strings.TrimSpace(v)
	if n := utf8.RuneCountInString(v); n < minLen || n > maxLen {
		if minLen > 0 {
			return "", httpx.Validation(field, field+" must be 1.."+strconv.Itoa(maxLen)+" characters")
		}
		return "", httpx.Validation(field, field+" must be at most "+strconv.Itoa(maxLen)+" characters")
	}
	if strings.IndexFunc(v, unicode.IsControl) >= 0 {
		return "", httpx.Validation(field, field+" must not contain control characters")
	}
	return v, nil
}

// catalogChanged tells every member of the workspace to refetch its catalog.
func (s *Service) catalogChanged(r *http.Request, wsID uuid.UUID) {
	s.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceAchievementsUpdate{
		WorkspaceAchievementsUpdate: &v1.WorkspaceAchievementsUpdate{WorkspaceId: wsID.String()},
	}})
}
