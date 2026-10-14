package disk

import (
	"net/http"
	"strings"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// CodeLength is the length of a public link code.
const CodeLength = 43

var errNoLink = httpx.NotFound("link")

// linked resolves an anonymous visit of a public link (ADR-0094 §3): the live link (not revoked,
// not expired) with its item and file — in the trash or restricted too —, in a workspace that is
// not suspended and whose identity policy allows public capabilities (like public forms).
// limit is spent first, per client IP.
func (s *Service) linked(w http.ResponseWriter, r *http.Request, limit Limiter) (sqlc.GetDiskLinkByCodeRow, error) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer")
	ctx := r.Context()
	if limit != nil {
		if err := limit.Take(ctx, httpx.ClientIP(ctx)); err != nil {
			return sqlc.GetDiskLinkByCodeRow{}, err
		}
	}
	code := r.PathValue("code")
	if len(code) != CodeLength {
		return sqlc.GetDiskLinkByCodeRow{}, errNoLink
	}
	row, err := s.db.Q.GetDiskLinkByCode(ctx, code)
	if db.IsNotFound(err) {
		return row, errNoLink
	}
	if err != nil {
		return row, err
	}
	ws, err := s.db.Q.GetWorkspace(ctx, row.DiskItem.WorkspaceID)
	if err != nil {
		return row, err
	}
	if ws.SuspendedAt != nil {
		return row, errNoLink
	}
	if err := s.plans.CheckBillingOpen(ctx, s.db.Q, ws.ID); err != nil {
		return row, err
	}
	if err := auth.CheckPublicCapability(ctx, s.db.Q, ws.ID); err != nil {
		return row, err
	}
	return row, nil
}

// publicFile: GET /api/public/disk/{code} — PublicDiskFile, anonymous.
func (s *Service) publicFile(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	f := row.File
	out := &v1.PublicDiskFile{Name: row.DiskItem.Name, Size: uint64(max(f.Size, 0)), Mime: f.Mime, HasThumbnail: f.ThumbnailKey != nil}
	if f.Width != nil && f.Height != nil && pbconv.IsImage(f.Mime) {
		out.Width, out.Height = uint32(max(*f.Width, 0)), uint32(max(*f.Height, 0))
	}
	if row.DiskLink.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.DiskLink.ExpiresAt)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// publicContent: GET /api/public/disk/{code}/content — the bytes (Range), anonymous. A request
// from the start of the file counts as a download (no lock: one UPDATE of a counter).
func (s *Service) publicContent(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkDownloadLimit)
	if err != nil {
		return err
	}
	if rg := r.Header.Get("Range"); r.Method == http.MethodGet && (rg == "" || strings.HasPrefix(rg, "bytes=0-")) {
		if err := db.GuardExec(r.Context(), s.db, func(q *sqlc.Queries) error {
			return q.CountDiskLinkDownload(r.Context(), row.DiskLink.ID)
		}); err != nil {
			return err
		}
	}
	f := row.File
	f.Name = row.DiskItem.Name // the name on the Disk (a renamed file downloads as such)
	return s.files.ServeLinked(w, r, f, false)
}

// publicThumbnail: GET /api/public/disk/{code}/thumbnail?w=512|1024 — the preview, anonymous.
func (s *Service) publicThumbnail(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	return s.files.ServeLinked(w, r, row.File, true)
}
