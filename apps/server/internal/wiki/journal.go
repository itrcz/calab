package wiki

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// CoalesceWindow is how recent a person's rename of a page must be for their next rename of it
// to merge into that entry (ADR-0081, like the Disk).
const CoalesceWindow = 5 * time.Minute

// snap is one side of a journal entry.
type snap map[string]any

func encode(m snap) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	return json.Marshal(m)
}

// journal writes one entry about page p (its title as now); actor nil = the sweeper. Kinds:
// ADR-0096 §5 (create, rename, move, share, link_on, link_off, trash, restore, delete, icon,
// cover, version).
func (s *Service) journal(ctx context.Context, q *sqlc.Queries, p sqlc.WikiPageHead, actor *uuid.UUID, kind string, before, after snap) error {
	b, err := encode(before)
	if err != nil {
		return err
	}
	a, err := encode(after)
	if err != nil {
		return err
	}
	if kind == "rename" && actor != nil {
		last, err := q.LastWikiActivity(ctx, &p.ID)
		switch {
		case err == nil && last.Kind == "rename" && last.ActorID != nil && *last.ActorID == *actor &&
			s.Now().Sub(last.CreatedAt) < CoalesceWindow:
			var was snap
			_ = json.Unmarshal(last.Before, &was)
			if was["title"] == after["title"] {
				return q.DeleteWikiActivity(ctx, last.ID) // renamed back: nothing happened
			}
			return q.UpdateWikiActivityAfter(ctx, sqlc.UpdateWikiActivityAfterParams{ID: last.ID, After: a, PageTitle: p.Title})
		case err != nil && !db.IsNotFound(err):
			return err
		}
	}
	var page *uuid.UUID
	if kind != "delete" {
		page = &p.ID
	}
	_, err = q.InsertWikiActivity(ctx, sqlc.InsertWikiActivityParams{WorkspaceID: p.WorkspaceID, PageID: page, PageTitle: p.Title,
		ActorID: actor, Kind: kind, Before: b, After: a})
	return err
}

// place is where a page is, for the journal: its parent's id and title ("" = the top level).
func place(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID) (snap, error) {
	if parent == nil {
		return snap{"parent_id": "", "parent_title": ""}, nil
	}
	p, err := q.GetWikiPage(ctx, *parent)
	if err != nil {
		if db.IsNotFound(err) {
			return snap{"parent_id": parent.String(), "parent_title": ""}, nil
		}
		return nil, err
	}
	return snap{"parent_id": p.ID.String(), "parent_title": p.Title}, nil
}

// sharing is the access settings of a page for the journal: restricted and the overrides with
// the names of their targets.
func sharing(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, restricted bool, ovs []perm.OverrideTarget) (snap, error) {
	var users []uuid.UUID
	for _, o := range ovs {
		if o.TargetType == "user" {
			if id, err := uuid.Parse(o.TargetID); err == nil {
				users = append(users, id)
			}
		}
	}
	names := map[string]string{}
	if len(users) > 0 {
		us, err := q.ListUsersByIDs(ctx, users)
		if err != nil {
			return nil, err
		}
		for _, u := range us {
			names[u.ID.String()] = u.DisplayName
		}
	}
	roles := map[string]string{}
	for _, o := range ovs {
		if o.TargetType == "role" {
			rs, err := q.ListWorkspaceRoles(ctx, ws)
			if err != nil {
				return nil, err
			}
			for _, r := range rs {
				roles[r.ID.String()] = r.Name
			}
			break
		}
	}
	entries := make([]any, 0, len(ovs))
	for _, o := range ovs {
		name := names[o.TargetID]
		if o.TargetType == "role" {
			name = roles[o.TargetID]
		}
		entries = append(entries, map[string]any{"target_type": o.TargetType, "target_id": o.TargetID, "name": name,
			"allow": float64(uint64(o.Allow)), "deny": float64(uint64(o.Deny))})
	}
	return snap{"restricted": restricted, "entries": entries}, nil
}

// ---- events ----

// eventPage is a page as the WIKI_PAGE_UPSERT event carries it: no per-recipient bits and no
// link (those come with a refetch), with its cover and has_children.
func (s *Service) eventPage(ctx context.Context, p sqlc.WikiPageHead) *v1.WikiPage {
	var cover *sqlc.File
	children := false
	if p.CoverFileID != nil {
		if fs, err := s.db.Q.ListDiskFiles(ctx, []uuid.UUID{*p.CoverFileID}); err == nil && len(fs) == 1 {
			cover = &fs[0]
		}
	}
	if with, err := s.db.Q.ListWikiPagesWithChildren(ctx, []uuid.UUID{p.ID}); err == nil {
		children = len(with) > 0
	}
	return pageProto(p, cover, false, children, nil, 0)
}

// upsertEvent is WIKI_PAGE_UPSERT of p: after is its access chain now, before the one it had
// when that changed (nil = unchanged, or nobody saw it: a new page).
func (s *Service) upsertEvent(ctx context.Context, p sqlc.WikiPageHead, after, before []perm.TreeNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageUpsert{WikiPageUpsert: &v1.WikiPageUpsert{
		WorkspaceId: p.WorkspaceID.String(), Page: s.eventPage(ctx, p),
		Access: wikiacl.Levels(after), AccessBefore: wikiacl.Levels(before),
	}}}
}

// removeEvent is WIKI_PAGE_REMOVE of p, to who saw it through chain.
func removeEvent(p sqlc.WikiPageHead, chain []perm.TreeNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageRemove{WikiPageRemove: &v1.WikiPageRemove{
		WorkspaceId: p.WorkspaceID.String(), PageId: p.ID.String(), ParentId: idp(p.ParentID), Access: wikiacl.Levels(chain),
	}}}
}

// publish sends the events of a committed change.
func (s *Service) publish(ctx context.Context, ws uuid.UUID, evs []*v1.DispatchEvent) {
	if len(evs) > 0 {
		s.ev.WorkspaceEvents(ctx, ws, evs)
	}
}

// upserted announces a committed change of page id: its chain is read again (after the change)
// and before, when it differs, goes along (who saw it then and does not now gets a removal).
func (s *Service) upserted(ctx context.Context, id uuid.UUID, before []perm.TreeNode) {
	ch, err := wikiacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil || !ch.Has(id) {
		if err != nil {
			slog.WarnContext(ctx, "wiki: event chain", "page_id", id, "err", err)
		}
		return
	}
	after := ch.Nodes(id)
	var was []perm.TreeNode
	if before != nil && !wikiacl.SameChain(before, after) {
		was = before
	}
	p := ch.Page(id)
	s.publish(ctx, p.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, p, after, was)})
}
