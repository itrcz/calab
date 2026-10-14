package wiki

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

func idp(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

func strp(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// head is the listing form of a page row.
func head(p sqlc.WikiPage) sqlc.WikiPageHead {
	return sqlc.WikiPageHead{ID: p.ID, WorkspaceID: p.WorkspaceID, ParentID: p.ParentID, Title: p.Title, Icon: p.Icon,
		CoverFileID: p.CoverFileID, Position: p.Position, OwnerID: p.OwnerID, Restricted: p.Restricted, Preview: p.Preview,
		DocSize: p.DocSize, NextSeq: p.NextSeq, UpdatedBy: p.UpdatedBy, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		TrashedAt: p.TrashedAt, TrashedBy: p.TrashedBy, TrashedRoot: p.TrashedRoot}
}

// pageProto converts a page; cover is its cover's files row, link its live link (shown only to
// who may change the page), bits the caller's (0 in events).
func pageProto(p sqlc.WikiPageHead, cover *sqlc.File, shared, children bool, link *sqlc.WikiLink, bits perm.Bits) *v1.WikiPage {
	out := &v1.WikiPage{
		Id: p.ID.String(), WorkspaceId: p.WorkspaceID.String(), ParentId: idp(p.ParentID), Title: p.Title, Icon: strp(p.Icon),
		OwnerId: idp(p.OwnerID), Restricted: p.Restricted, Shared: shared, Preview: p.Preview,
		UpdatedAt: timestamppb.New(p.UpdatedAt), UpdatedBy: idp(p.UpdatedBy), MyBits: uint64(bits & perm.Wiki),
		HasChildren: children, CreatedAt: timestamppb.New(p.CreatedAt), Position: p.Position, TrashedBy: idp(p.TrashedBy),
		TrashedRoot: p.TrashedRoot, DocSize: uint32(max(p.DocSize, 0)), //nolint:gosec // ≤ 2 MiB
	}
	if p.TrashedAt != nil {
		out.TrashedAt = timestamppb.New(*p.TrashedAt)
	}
	if cover != nil {
		out.Cover = pbconv.File(*cover)
	}
	if link != nil {
		out.Link = linkProto(*link)
	}
	return out
}

func linkProto(l sqlc.WikiLink) *v1.WikiLink {
	out := &v1.WikiLink{Code: l.Code, IncludeChildren: l.IncludeChildren, CreatedBy: idp(l.CreatedBy), CreatedAt: timestamppb.New(l.CreatedAt),
		Views: uint32(max(l.Views, 0)), PageId: l.PageID.String()} //nolint:gosec // non-negative counter
	if l.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*l.ExpiresAt)
	}
	return out
}

// decorated converts pages for one caller: their covers, whether they are shared, whether they
// have live children and, for those whose structure the caller may change, their live links.
// bitsOf gives the caller's bits; children (nil = query) whether each has live children.
func decorated(ctx context.Context, q *sqlc.Queries, c caller, pages []sqlc.WikiPageHead, bitsOf func(sqlc.WikiPageHead) perm.Bits, children map[uuid.UUID]bool) ([]*v1.WikiPage, error) {
	if len(pages) == 0 {
		return nil, nil
	}
	ids := make([]uuid.UUID, len(pages))
	var covers []uuid.UUID
	for i, p := range pages {
		ids[i] = p.ID
		if p.CoverFileID != nil {
			covers = append(covers, *p.CoverFileID)
		}
	}
	fs := map[uuid.UUID]*sqlc.File{}
	if len(covers) > 0 {
		rows, err := q.ListDiskFiles(ctx, covers) // any files rows by id
		if err != nil {
			return nil, err
		}
		for i := range rows {
			fs[rows[i].ID] = &rows[i]
		}
	}
	sharedIDs, err := q.ListSharedWikiPages(ctx, ids)
	if err != nil {
		return nil, err
	}
	shared := make(map[uuid.UUID]bool, len(sharedIDs))
	for _, id := range sharedIDs {
		shared[id] = true
	}
	if children == nil {
		with, err := q.ListWikiPagesWithChildren(ctx, ids)
		if err != nil {
			return nil, err
		}
		children = make(map[uuid.UUID]bool, len(with))
		for _, id := range with {
			children[id] = true
		}
	}
	links := map[uuid.UUID]*sqlc.WikiLink{}
	ls, err := q.ListWikiLinksForPages(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range ls {
		links[ls[i].PageID] = &ls[i]
	}
	out := make([]*v1.WikiPage, len(pages))
	for i, p := range pages {
		bits := bitsOf(p)
		var cover *sqlc.File
		if p.CoverFileID != nil {
			cover = fs[*p.CoverFileID]
		}
		var l *sqlc.WikiLink
		if perm.WikiStructureAllowed(bits, c.owns(p)) {
			l = links[p.ID]
		}
		out[i] = pageProto(p, cover, shared[p.ID], children[p.ID], l, bits)
	}
	return out, nil
}

// one converts a single page for the caller.
func one(ctx context.Context, q *sqlc.Queries, a access) (*v1.WikiPage, error) {
	out, err := decorated(ctx, q, a.c, []sqlc.WikiPageHead{a.page}, func(sqlc.WikiPageHead) perm.Bits { return a.bits }, nil)
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

// jsonStruct converts a stored journal side.
func jsonStruct(b []byte) *structpb.Struct {
	if len(b) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil
	}
	return s
}

var activityKinds = map[string]v1.WikiActivityKind{
	"create": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_CREATE, "rename": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_RENAME,
	"move": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_MOVE, "share": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_SHARE,
	"link_on": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_LINK_ON, "link_off": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_LINK_OFF,
	"trash": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_TRASH, "restore": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_RESTORE,
	"delete": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_DELETE, "icon": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_ICON,
	"cover": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_COVER, "version": v1.WikiActivityKind_WIKI_ACTIVITY_KIND_VERSION,
}

func activityProto(a sqlc.WikiActivity) *v1.WikiActivity {
	return &v1.WikiActivity{Id: a.ID.String(), WorkspaceId: a.WorkspaceID.String(), PageId: idp(a.PageID), ActorId: idp(a.ActorID),
		Kind: activityKinds[a.Kind], Before: jsonStruct(a.Before), After: jsonStruct(a.After), CreatedAt: timestamppb.New(a.CreatedAt),
		PageTitle: a.PageTitle}
}

func versionProto(v sqlc.ListWikiVersionsRow) *v1.WikiVersion {
	out := &v1.WikiVersion{Id: v.ID.String(), PageId: v.PageID.String(), Title: v.Title, PlainText: v.PlainText,
		CreatedAt: timestamppb.New(v.CreatedAt), Size: uint32(max(v.Size, 0))} //nolint:gosec // ≤ 2 MiB
	for _, a := range v.Authors {
		out.AuthorIds = append(out.AuthorIds, a.String())
	}
	return out
}

// publicURL is the page of a public link.
func (s *Service) publicURL(code string) string {
	return strings.TrimRight(s.PublicURL, "/") + "/w/" + code
}
