package search

import (
	"bytes"
	"context"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/searchq"
)

// CanvasVector must stay the expression of canvas_items_search_idx (00116) over canvas_items w;
// the sqlc query SearchCanvasItems (queries/canvas.sql) spells it out too.
const CanvasVector = "(to_tsvector('russian', w.name || ' ' || w.plain_text) || to_tsvector('simple', w.name || ' ' || w.plain_text))"

// canvas is the section of Canvas items (ADR-0126 §6): the candidates come from sqlc
// SearchCanvasItems (full text over name and text, trigram / substring over the name, ranked by
// relevance × freshness), the access filter is the item rule itself (perm.ComputeCanvasItemIn
// over the candidates' chains, canvasacl) and the snippets are ts_headline of the canvas's text.
// Newest first (sort=new) orders by id (uuidv7: creation). Bots do not search the Canvas in v1.
func (s *Service) canvas(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	if len(sc.wss) == 0 || sc.bot {
		return nil
	}
	members := make(map[uuid.UUID]perm.Member, len(sc.wss))
	for _, sp := range sc.wss {
		members[sp.id] = sp.m
	}
	q := s.db.Q.WithTx(tx)
	rows, err := q.SearchCanvasItems(ctx, sqlc.SearchCanvasItemsParams{Tsq: req.fq.TS, Words: req.fq.Text, Phrase: searchq.Like(req.fq.Text),
		Now: req.now, WorkspaceIds: sc.workspaceIDs(), Lim: candidateCap})
	if err != nil || len(rows) == 0 {
		return err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	ch, err := canvasacl.Load(ctx, q, ids)
	if err != nil {
		return err
	}
	rel := req.relevance(sec.Type)
	visible := rows[:0]
	for _, r := range rows {
		if ch.Has(r.ID) && ch.Bits(members[r.WorkspaceID], &r.ID).Has(perm.CanvasView) {
			visible = append(visible, r)
		}
	}
	total(req, sec, int64(len(visible)))
	if !rel {
		slices.SortFunc(visible, func(a, b sqlc.SearchCanvasItemsRow) int { return bytes.Compare(b.ID[:], a.ID[:]) })
	}
	if req.cur != nil {
		cid := req.cur.id()
		after := visible[:0]
		for _, r := range visible {
			if rel && (r.Score < req.cur.R || (r.Score == req.cur.R && bytes.Compare(r.ID[:], cid[:]) < 0)) ||
				!rel && bytes.Compare(r.ID[:], cid[:]) < 0 {
				after = append(after, r)
			}
		}
		visible = after
	}
	if len(visible) > req.limit+1 {
		visible = visible[:req.limit+1]
	}
	list := page(req, sec, visible, func(r sqlc.SearchCanvasItemsRow) (float64, uuid.UUID) { return r.Score, r.ID })
	if len(list) == 0 {
		return nil
	}
	pageIDs := make([]uuid.UUID, len(list))
	for i, r := range list {
		pageIDs[i] = r.ID
	}
	heads, err := q.CanvasSearchHeadlines(ctx, sqlc.CanvasSearchHeadlinesParams{Tsq: req.fq.TS, Options: searchq.HeadlineOptions, Ids: pageIDs})
	if err != nil {
		return err
	}
	snippets := make(map[uuid.UUID]string, len(heads))
	for _, h := range heads {
		snippets[h.ID] = h.Snippet
	}
	for _, r := range list {
		sec.Items = append(sec.Items, &v1.SearchHit{Snippet: snippets[r.ID], Title: r.Name, WorkspaceId: r.WorkspaceID.String(), At: ts(r.UpdatedAt),
			AuthorId: str(r.UpdatedBy), Ref: &v1.SearchHit_Canvas{Canvas: &v1.SearchCanvasRef{ItemId: r.ID.String(), ParentId: str(r.ParentID),
				Folder: r.Kind == "folder", Path: canvasPath(ch, members[r.WorkspaceID], r.ID)}}})
	}
	return nil
}

// canvasPath names the folders above id that m sees, the topmost first — the rule of the item's
// breadcrumbs: above a folder they do not see, nothing is named.
func canvasPath(ch *canvasacl.Chains, m perm.Member, id uuid.UUID) []string {
	chain := ch.Path(id)
	if len(chain) < 2 {
		return nil
	}
	chain = chain[:len(chain)-1]
	start := 0
	for i, p := range chain {
		if !ch.Bits(m, &p.ID).Has(perm.CanvasView) {
			start = i + 1
		}
	}
	out := make([]string, 0, len(chain)-start)
	for _, p := range chain[start:] {
		out = append(out, p.Name)
	}
	return out
}
