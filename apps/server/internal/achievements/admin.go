package achievements

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

const (
	maxField     = 1 << 10 // a text part of the form
	uploadWindow = 2 * time.Minute
)

// form is a parsed admin multipart body: the text fields present and the prepared picture.
type form struct {
	fields map[string]string
	image  []byte // the final WebP; nil = no "image" part
}

// readForm parses the multipart body and makes the picture (ADR-0061 §2).
func readForm(w http.ResponseWriter, r *http.Request) (*form, error) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadWindow))
	r.Body = http.MaxBytesReader(w, r.Body, MaxImageBytes+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest("expected multipart/form-data")
	}
	f := &form{fields: map[string]string{}}
	var raw []byte
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, partError(err)
		}
		name := part.FormName()
		switch name {
		case "image":
			raw, err = io.ReadAll(io.LimitReader(part, MaxImageBytes+1))
			if err != nil {
				_ = part.Close()
				return nil, partError(err)
			}
			if len(raw) > MaxImageBytes {
				_ = part.Close()
				return nil, httpx.Validation("image", "image must be at most 4 MB")
			}
		case "title", "description", "position", "archived":
			b, err := io.ReadAll(io.LimitReader(part, maxField+1))
			if err != nil {
				_ = part.Close()
				return nil, partError(err)
			}
			if len(b) > maxField {
				_ = part.Close()
				return nil, httpx.Validation(name, name+" is too long")
			}
			f.fields[name] = string(b)
		}
		_ = part.Close()
	}
	if raw != nil {
		img, err := PrepareAchievement(r.Context(), raw)
		if err != nil {
			return nil, imageError(err)
		}
		f.image = img
	}
	return f, nil
}

func partError(err error) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_PAYLOAD_TOO_LARGE, "upload too large")
	}
	return httpx.BadRequest("malformed multipart body")
}

// imageError maps a pipeline error to the API.
func imageError(err error) error {
	var ie *ImageError
	switch {
	case errors.Is(err, ErrNeedsAlpha):
		return httpx.Validation("image", err.Error()).WithDetails(ReasonNeedsAlpha, 0, 0)
	case errors.As(err, &ie):
		return httpx.Validation("image", ie.Msg)
	}
	return err
}

// storeImage puts a prepared picture under a new key.
func (s *Service) storeImage(ctx context.Context, img []byte) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	key := ImageKey(id)
	if err := s.store.Put(ctx, key, bytes.NewReader(img), int64(len(img)), "image/webp"); err != nil {
		return "", err
	}
	return key, nil
}

// adminList: GET /api/admin/achievements.
func (s *Service) adminList(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Q.ListAchievements(r.Context())
	if err != nil {
		return err
	}
	stats, err := s.db.Q.AdminAchievementStats(r.Context())
	if err != nil {
		return err
	}
	by := make(map[uuid.UUID]sqlc.AdminAchievementStatsRow, len(stats))
	for _, st := range stats {
		by[st.AchievementID] = st
	}
	out := &v1.AdminListAchievementsResponse{Achievements: make([]*v1.AdminAchievement, len(rows))}
	for i, a := range rows {
		st := by[a.ID]
		out.Achievements[i] = &v1.AdminAchievement{Achievement: Proto(a),
			GrantedCount: uint32(max(st.Granted, 0)), WorkspacesCount: uint32(max(st.Workspaces, 0))} //nolint:gosec // counts
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// adminCreate: POST /api/admin/achievements (multipart: image, title, description).
func (s *Service) adminCreate(w http.ResponseWriter, r *http.Request) error {
	f, err := readForm(w, r)
	if err != nil {
		return err
	}
	title, err := text("title", f.fields["title"], 1, maxTitle)
	if err != nil {
		return err
	}
	desc, err := text("description", f.fields["description"], 0, maxDescription)
	if err != nil {
		return err
	}
	if f.image == nil {
		return httpx.Validation("image", "image is required")
	}
	key, err := s.storeImage(r.Context(), f.image)
	if err != nil {
		return err
	}
	actor := auth.MustFromContext(r.Context()).UserID
	a, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.Achievement, error) {
		return guarded.InsertAchievement(r.Context(), sqlc.InsertAchievementParams{
			Title: title, Description: desc, ImageKey: key, ImageSize: int32(len(f.image)), //nolint:gosec // ≤ 4 MB
			Width: ImageSide, Height: ImageSide, CreatedBy: &actor,
		})
	})
	if err != nil {
		s.deleteBlob(r.Context(), key)
		return err
	}
	slog.InfoContext(r.Context(), "admin: achievement created", "id", a.ID, "by", actor, "title", a.Title)
	httpx.Write(w, http.StatusCreated, Proto(a))
	return nil
}

// adminUpdate: PATCH /api/admin/achievements/{id} (multipart, every field optional).
func (s *Service) adminUpdate(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "achievement")
	if err != nil {
		return err
	}
	f, err := readForm(w, r)
	if err != nil {
		return err
	}
	var title, desc *string
	if v, ok := f.fields["title"]; ok {
		t, err := text("title", v, 1, maxTitle)
		if err != nil {
			return err
		}
		title = &t
	}
	if v, ok := f.fields["description"]; ok {
		d, err := text("description", v, 0, maxDescription)
		if err != nil {
			return err
		}
		desc = &d
	}
	var position *int32
	if v, ok := f.fields["position"]; ok {
		p, err := strconv.ParseInt(v, 10, 32)
		if err != nil || p < 0 || p > 1_000_000 {
			return httpx.Validation("position", "position must be 0..1000000")
		}
		p32 := int32(p)
		position = &p32
	}
	var archived *bool
	if v, ok := f.fields["archived"]; ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return httpx.Validation("archived", "archived must be true or false")
		}
		archived = &b
	}
	newKey := ""
	if f.image != nil {
		if newKey, err = s.storeImage(r.Context(), f.image); err != nil {
			return err
		}
	}
	var oldKey string
	var a sqlc.Achievement
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.LockAchievement(r.Context(), id)
		if db.IsNotFound(err) {
			return httpx.NotFound("achievement")
		}
		if err != nil {
			return err
		}
		p := sqlc.UpdateAchievementParams{ID: id, Title: cur.Title, Description: cur.Description, ImageKey: cur.ImageKey,
			ImageSize: cur.ImageSize, Width: cur.Width, Height: cur.Height, Position: cur.Position, ArchivedAt: cur.ArchivedAt}
		if title != nil {
			p.Title = *title
		}
		if desc != nil {
			p.Description = *desc
		}
		if position != nil {
			p.Position = *position
		}
		if archived != nil {
			switch {
			case !*archived:
				p.ArchivedAt = nil
			case cur.ArchivedAt == nil:
				now := time.Now()
				p.ArchivedAt = &now
			}
		}
		if newKey != "" {
			oldKey = cur.ImageKey
			p.ImageKey, p.ImageSize = newKey, int32(len(f.image)) //nolint:gosec // ≤ 4 MB
			p.Width, p.Height = ImageSide, ImageSide
		}
		a, err = q.UpdateAchievement(r.Context(), p)
		return err
	})
	if err != nil {
		s.deleteBlob(r.Context(), newKey)
		return err
	}
	s.deleteBlob(r.Context(), oldKey) // the replaced picture, after the commit
	slog.InfoContext(r.Context(), "admin: achievement updated", "id", id, "by", auth.MustFromContext(r.Context()).UserID,
		"image", newKey != "", "archived", a.ArchivedAt != nil)
	httpx.Write(w, http.StatusOK, Proto(a))
	return nil
}

// adminDelete: DELETE /api/admin/achievements/{id} — only one that was never granted.
func (s *Service) adminDelete(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "achievement")
	if err != nil {
		return err
	}
	var key string
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.LockAchievement(r.Context(), id)
		if db.IsNotFound(err) {
			return httpx.NotFound("achievement")
		}
		if err != nil {
			return err
		}
		n, err := q.DeleteAchievement(r.Context(), id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.Conflict("the achievement was granted: archive it instead").WithDetails(ReasonInUse, 0, 0)
		}
		key = cur.ImageKey
		return nil
	})
	if err != nil {
		return err
	}
	s.deleteBlob(r.Context(), key)
	slog.InfoContext(r.Context(), "admin: achievement deleted", "id", id, "by", auth.MustFromContext(r.Context()).UserID)
	httpx.NoContent(w)
	return nil
}
