package disk

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

func kindOf(k string) v1.DiskItemKind {
	if k == "folder" {
		return v1.DiskItemKind_DISK_ITEM_KIND_FOLDER
	}
	return v1.DiskItemKind_DISK_ITEM_KIND_FILE
}

// itemProto converts an item; f is its files row (files), link its live link (shown only to
// who may manage it), bits the caller's (0 in events).
func itemProto(it sqlc.DiskItem, f *sqlc.File, shared bool, link *sqlc.DiskLink, bits perm.Bits) *v1.DiskItem {
	out := &v1.DiskItem{
		Id: it.ID.String(), WorkspaceId: it.WorkspaceID.String(), ParentId: idp(it.ParentID), Kind: kindOf(it.Kind),
		Name: it.Name, OwnerId: idp(it.OwnerID), Restricted: it.Restricted, Shared: shared,
		CreatedAt: timestamppb.New(it.CreatedAt), UpdatedAt: timestamppb.New(it.UpdatedAt),
		MyBits: uint64(bits & perm.Disk), TrashedBy: idp(it.TrashedBy), TrashedRoot: it.TrashedRoot,
	}
	if it.TrashedAt != nil {
		out.TrashedAt = timestamppb.New(*it.TrashedAt)
	}
	if f != nil {
		out.File = pbconv.File(*f)
	}
	if link != nil {
		out.Link = linkProto(*link)
	}
	return out
}

func linkProto(l sqlc.DiskLink) *v1.DiskLink {
	out := &v1.DiskLink{Code: l.Code, CreatedBy: idp(l.CreatedBy), CreatedAt: timestamppb.New(l.CreatedAt),
		Downloads: uint32(max(l.Downloads, 0)), ItemId: l.ItemID.String()} //nolint:gosec // non-negative counter
	if l.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*l.ExpiresAt)
	}
	return out
}

// decorated converts a page of items for one caller: their files rows, whether they are shared
// and, for those the caller may manage, their live links. bitsOf gives the caller's bits.
func decorated(ctx context.Context, q *sqlc.Queries, c caller, items []sqlc.DiskItem, bitsOf func(sqlc.DiskItem) perm.Bits) ([]*v1.DiskItem, error) {
	if len(items) == 0 {
		return nil, nil
	}
	ids := make([]uuid.UUID, len(items))
	var fileIDs []uuid.UUID
	for i, it := range items {
		ids[i] = it.ID
		if it.FileID != nil {
			fileIDs = append(fileIDs, *it.FileID)
		}
	}
	fs := map[uuid.UUID]*sqlc.File{}
	if len(fileIDs) > 0 {
		rows, err := q.ListDiskFiles(ctx, fileIDs)
		if err != nil {
			return nil, err
		}
		for i := range rows {
			fs[rows[i].ID] = &rows[i]
		}
	}
	sharedIDs, err := q.ListSharedDiskItems(ctx, ids)
	if err != nil {
		return nil, err
	}
	shared := make(map[uuid.UUID]bool, len(sharedIDs))
	for _, id := range sharedIDs {
		shared[id] = true
	}
	links := map[uuid.UUID]*sqlc.DiskLink{}
	if fileIDs != nil {
		ls, err := q.ListDiskLinksForItems(ctx, ids)
		if err != nil {
			return nil, err
		}
		for i := range ls {
			links[ls[i].ItemID] = &ls[i]
		}
	}
	out := make([]*v1.DiskItem, len(items))
	for i, it := range items {
		bits := bitsOf(it)
		var f *sqlc.File
		if it.FileID != nil {
			f = fs[*it.FileID]
		}
		var l *sqlc.DiskLink
		if bits.Has(perm.DiskManage) || c.owns(it) {
			l = links[it.ID]
		}
		out[i] = itemProto(it, f, shared[it.ID], l, bits)
	}
	return out, nil
}

// one converts a single item for the caller.
func one(ctx context.Context, q *sqlc.Queries, a access) (*v1.DiskItem, error) {
	out, err := decorated(ctx, q, a.c, []sqlc.DiskItem{a.item}, func(sqlc.DiskItem) perm.Bits { return a.bits })
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

var activityKinds = map[string]v1.DiskActivityKind{
	"create": v1.DiskActivityKind_DISK_ACTIVITY_KIND_CREATE, "upload": v1.DiskActivityKind_DISK_ACTIVITY_KIND_UPLOAD,
	"rename": v1.DiskActivityKind_DISK_ACTIVITY_KIND_RENAME, "move": v1.DiskActivityKind_DISK_ACTIVITY_KIND_MOVE,
	"share": v1.DiskActivityKind_DISK_ACTIVITY_KIND_SHARE, "link_on": v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_ON,
	"link_off": v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_OFF, "trash": v1.DiskActivityKind_DISK_ACTIVITY_KIND_TRASH,
	"restore": v1.DiskActivityKind_DISK_ACTIVITY_KIND_RESTORE, "delete": v1.DiskActivityKind_DISK_ACTIVITY_KIND_DELETE,
}

func activityProto(a sqlc.DiskActivity) *v1.DiskActivity {
	return &v1.DiskActivity{Id: a.ID.String(), WorkspaceId: a.WorkspaceID.String(), ItemId: idp(a.ItemID), ActorId: idp(a.ActorID),
		Kind: activityKinds[a.Kind], Before: jsonStruct(a.Before), After: jsonStruct(a.After), CreatedAt: timestamppb.New(a.CreatedAt),
		ItemName: a.ItemName}
}

// publicURL is the page of a public link.
func (s *Service) publicURL(code string) string {
	return strings.TrimRight(s.PublicURL, "/") + "/d/" + code
}
