package wiki

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// CodeLength is the length of a public link code.
const CodeLength = 43

var errNoLink = httpx.NotFound("link")

// linked resolves an anonymous visit of a public link (ADR-0096 §6): the live link (not revoked,
// not expired) of a page not in the trash, in a workspace that is not suspended and whose
// identity policy allows public capabilities (like the Disk's links and public forms). limit is
// spent first, per client IP.
func (s *Service) linked(w http.ResponseWriter, r *http.Request, limit Limiter) (sqlc.GetWikiLinkByCodeRow, error) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer")
	ctx := r.Context()
	if limit != nil {
		if err := limit.Take(ctx, httpx.ClientIP(ctx)); err != nil {
			return sqlc.GetWikiLinkByCodeRow{}, err
		}
	}
	code := r.PathValue("code")
	if len(code) != CodeLength {
		return sqlc.GetWikiLinkByCodeRow{}, errNoLink
	}
	row, err := s.db.Q.GetWikiLinkByCode(ctx, code)
	if db.IsNotFound(err) {
		return row, errNoLink
	}
	if err != nil {
		return row, err
	}
	if row.WikiPageHead.TrashedAt != nil {
		return row, errNoLink
	}
	ws, err := s.db.Q.GetWorkspace(ctx, row.WikiPageHead.WorkspaceID)
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

// branch is the visible outline below a linked page: with include_children, its live subpages
// that are not restricted and are not below a restricted one, in depth then position order.
func (s *Service) branch(ctx context.Context, l sqlc.WikiLink) ([]sqlc.WikiPageHead, error) {
	if !l.IncludeChildren {
		return nil, nil
	}
	rows, err := s.db.Q.ListWikiBranch(ctx, l.PageID)
	if err != nil {
		return nil, err
	}
	open := map[uuid.UUID]bool{l.PageID: true}
	var out []sqlc.WikiPageHead
	for _, row := range rows { // parents come before their children (depth order)
		p := row.WikiPageHead
		if p.ParentID == nil || !open[*p.ParentID] || p.Restricted {
			continue
		}
		open[p.ID] = true
		out = append(out, p)
	}
	return out, nil
}

// target is the page a visit reads: the linked page, or ?page= within its visible branch.
func (s *Service) target(r *http.Request, row sqlc.GetWikiLinkByCodeRow, br []sqlc.WikiPageHead) (sqlc.WikiPageHead, error) {
	raw := r.URL.Query().Get("page")
	if raw == "" || raw == row.WikiPageHead.ID.String() {
		return row.WikiPageHead, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.WikiPageHead{}, errNoPage
	}
	for _, p := range br {
		if p.ID == id {
			return p, nil
		}
	}
	return sqlc.WikiPageHead{}, errNoPage
}

// publicPage: GET /api/public/wiki/{code}[?page=] — PublicWikiPage, anonymous. A visit of the
// linked page itself counts as a view.
func (s *Service) publicPage(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	ctx := r.Context()
	br, err := s.branch(ctx, row.WikiLink)
	if err != nil {
		return err
	}
	p, err := s.target(r, row, br)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("page") == "" {
		if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error { return q.CountWikiLinkView(ctx, row.WikiLink.ID) }); err != nil {
			return err
		}
	}
	out := &v1.PublicWikiPage{Id: p.ID.String(), Title: p.Title, Icon: strp(p.Icon), CoverFileId: idp(p.CoverFileID),
		UpdatedAt: timestamppb.New(p.UpdatedAt), RootId: row.WikiPageHead.ID.String()}
	if row.WikiLink.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.WikiLink.ExpiresAt)
	}
	for _, c := range br {
		out.Children = append(out.Children, &v1.PublicWikiPageRef{Id: c.ID.String(), ParentId: idp(c.ParentID), Title: c.Title, Icon: strp(c.Icon)})
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// publicState: GET /api/public/wiki/{code}/state[?page=] — the document of the page as one
// application/octet-stream body: a sequence of records, each a uint32 big-endian length followed
// by one sync frame of that length (docs/05 «Вики: сокет синхронизации»): first a SNAPSHOT
// frame (0 | u64 through_seq | state), then an UPDATE frame (1 | u64 seq | update) for every
// update stored after it. The client applies them in order (Yjs merges). Read in one repeatable
// read transaction: a compaction in between cannot drop updates the snapshot read lacks.
func (s *Service) publicState(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	ctx := r.Context()
	br, err := s.branch(ctx, row.WikiLink)
	if err != nil {
		return err
	}
	p, err := s.target(r, row, br)
	if err != nil {
		return err
	}
	var body bytes.Buffer
	record := func(frame []byte) {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(frame))) //nolint:gosec // ≤ 2 MiB + 9
		body.Write(n[:])
		body.Write(frame)
	}
	err = s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); err != nil {
			return err
		}
		q := s.db.Q.WithTx(tx)
		through, state, err := loadSnapshot(ctx, q, p.ID)
		if err != nil {
			return err
		}
		record(snapshotFrame(through, state))
		return eachUpdate(ctx, q, p.ID, through, func(seq int64, data []byte) error {
			record(updateFrame(seq, data))
			return nil
		})
	})
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(body.Len()))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body.Bytes())
	return nil
}

// publicFile: GET /api/public/wiki/{code}/files/{fileId} — a picture or attachment of the
// linked page or (include_children) of a visible page of its branch, anonymous.
func (s *Service) publicFile(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkFileLimit)
	if err != nil {
		return err
	}
	ctx := r.Context()
	fid, err := uuid.Parse(r.PathValue("fileId"))
	if err != nil {
		return httpx.NotFound("file")
	}
	ok, err := s.db.Q.WikiBranchHasFile(ctx, sqlc.WikiBranchHasFileParams{FileID: fid, PageID: row.WikiPageHead.ID, IncludeChildren: row.WikiLink.IncludeChildren})
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("file")
	}
	f, err := s.db.Q.GetFile(ctx, fid)
	if db.IsNotFound(err) {
		return httpx.NotFound("file")
	}
	if err != nil {
		return err
	}
	return s.files.ServeLinked(w, r, f, r.URL.Query().Get("w") != "")
}
