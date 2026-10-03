// Package achievements serves ADR-0061: the host catalog of achievements kept by the
// superadmins, grants of achievements to workspace members and the grant's card in the
// workspace's general chat (SystemMessage.achievement).
package achievements

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Field limits (characters).
const (
	maxTitle       = 60
	maxDescription = 200
	maxNote        = 120
)

// keyPrefix is the blob.Store key space of the pictures: "achievements/<uuid>.webp".
const keyPrefix = "achievements/"

// imageRoute is the URL prefix of the pictures (Achievement.image_url).
const imageRoute = "/api/achievements/images/"

// Reasons of the 4xx answers (ApiError.reason).
const (
	ReasonNeedsAlpha = "IMAGE_NEEDS_ALPHA"
	ReasonInUse      = "ACHIEVEMENT_IN_USE"
	ReasonSelfGrant  = "SELF_GRANT"
	ReasonArchived   = "ACHIEVEMENT_ARCHIVED"
)

// Service serves the catalog, the superadmin routes and the grants.
type Service struct {
	db     *db.DB
	store  blob.Store
	events events.Publisher
	system *messages.System
	voice  rooms.VoiceRooms
}

// New creates the service. voice lets guests see the members of their call (the profile rule,
// ADR-0051); nil = fail closed for those.
func New(d *db.DB, store blob.Store, ev events.Publisher, voice rooms.VoiceRooms) *Service {
	return &Service{db: d, store: store, events: ev, system: messages.NewSystem(d, ev), voice: voice}
}

// Routes registers the routes; wrap applies auth and the permission resolver, adminGuard the
// superadmin check of /api/admin/* (plans.Admin.Guard: 404 to everyone else, 60/min).
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler, adminGuard func(httpx.HandlerFunc) httpx.HandlerFunc) {
	admin := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(adminGuard(f))) }
	admin("GET /api/admin/achievements", s.adminList)
	admin("POST /api/admin/achievements", s.adminCreate)
	admin("PATCH /api/admin/achievements/{id}", s.adminUpdate)
	admin("DELETE /api/admin/achievements/{id}", s.adminDelete)
	mux.Handle("GET /api/achievements", wrap(httpx.HandlerFunc(s.catalog)))
	mux.Handle("GET /api/achievements/images/{name}", wrap(httpx.HandlerFunc(s.image)))
	mux.Handle("GET /api/workspaces/{id}/members/{userId}/achievements", wrap(httpx.HandlerFunc(s.list)))
	mux.Handle("POST /api/workspaces/{id}/members/{userId}/achievements", wrap(httpx.HandlerFunc(s.grant)))
	mux.Handle("DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}", wrap(httpx.HandlerFunc(s.revoke)))
}

// ImageKey is the blob key of a picture.
func ImageKey(id uuid.UUID) string { return keyPrefix + id.String() + ".webp" }

// Proto converts a catalog row.
func Proto(a sqlc.Achievement) *v1.Achievement {
	out := &v1.Achievement{
		Id: a.ID.String(), Title: a.Title, Description: a.Description,
		ImageUrl:  imageRoute + strings.TrimPrefix(a.ImageKey, keyPrefix),
		ImageSize: uint32(max(a.ImageSize, 0)), Width: uint32(max(a.Width, 0)), Height: uint32(max(a.Height, 0)), //nolint:gosec // non-negative
		Position: a.Position, CreatedAt: timestamppb.New(a.CreatedAt), UpdatedAt: timestamppb.New(a.UpdatedAt),
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

// catalog: GET /api/achievements — the whole catalog by position (archived entries flagged),
// with an ETag of its content.
func (s *Service) catalog(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Q.ListAchievements(r.Context())
	if err != nil {
		return err
	}
	out := &v1.ListAchievementsResponse{Achievements: make([]*v1.Achievement, len(rows))}
	for i, a := range rows {
		out.Achievements[i] = Proto(a)
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

// image: GET /api/achievements/images/{uuid}.webp — a catalog picture. The key changes with the
// bytes, so it is cached for good.
func (s *Service) image(w http.ResponseWriter, r *http.Request) error {
	name, ok := strings.CutSuffix(r.PathValue("name"), ".webp")
	if !ok {
		return httpx.NotFound("image")
	}
	id, err := uuid.Parse(name)
	if err != nil || id.String() != name {
		return httpx.NotFound("image")
	}
	rc, meta, err := s.store.Get(r.Context(), ImageKey(id))
	if errors.Is(err, blob.ErrNotFound) {
		return httpx.NotFound("image")
	}
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	h := w.Header()
	h.Set("Content-Type", "image/webp")
	h.Set("ETag", `"`+name+`"`)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(w, r, "", meta.ModTime, rc)
	return nil
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

// deleteBlob removes a picture after a commit (or of a failed write), best effort.
func (s *Service) deleteBlob(ctx context.Context, key string) {
	if key == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := s.store.Delete(ctx, key); err != nil {
		slog.WarnContext(ctx, "delete achievement image", "key", key, "err", err)
	}
}
