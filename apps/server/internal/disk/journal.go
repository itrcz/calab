package disk

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// CoalesceWindow is how recent a person's rename of an item must be for their next rename of it
// to merge into that entry (ADR-0081, ADR-0094 §5).
const CoalesceWindow = 5 * time.Minute

// snap is one side of a journal entry.
type snap map[string]any

func encode(m snap) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	return json.Marshal(m)
}

// journal writes one entry about item it (its name as now); actor nil = the sweeper.
func (s *Service) journal(ctx context.Context, q *sqlc.Queries, it sqlc.DiskItem, actor *uuid.UUID, kind string, before, after snap) error {
	b, err := encode(before)
	if err != nil {
		return err
	}
	a, err := encode(after)
	if err != nil {
		return err
	}
	if kind == "rename" && actor != nil {
		last, err := q.LastDiskActivity(ctx, &it.ID)
		switch {
		case err == nil && last.Kind == "rename" && last.ActorID != nil && *last.ActorID == *actor &&
			s.Now().Sub(last.CreatedAt) < CoalesceWindow:
			var was snap
			_ = json.Unmarshal(last.Before, &was)
			if was["name"] == after["name"] {
				return q.DeleteDiskActivity(ctx, last.ID) // renamed back: nothing happened
			}
			return q.UpdateDiskActivityAfter(ctx, sqlc.UpdateDiskActivityAfterParams{ID: last.ID, After: a, ItemName: it.Name})
		case err != nil && !db.IsNotFound(err):
			return err
		}
	}
	var item *uuid.UUID
	if kind != "delete" {
		item = &it.ID
	}
	_, err = q.InsertDiskActivity(ctx, sqlc.InsertDiskActivityParams{WorkspaceID: it.WorkspaceID, ItemID: item, ItemName: it.Name,
		ActorID: actor, Kind: kind, Before: b, After: a})
	return err
}

// place is where an item is, for the journal: its folder's id and name ("" = the root).
func place(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID) (snap, error) {
	if parent == nil {
		return snap{"parent_id": "", "parent_name": ""}, nil
	}
	p, err := q.GetDiskItem(ctx, *parent)
	if err != nil {
		if db.IsNotFound(err) {
			return snap{"parent_id": parent.String(), "parent_name": ""}, nil
		}
		return nil, err
	}
	return snap{"parent_id": p.ID.String(), "parent_name": p.Name}, nil
}

// sharing is the access settings of an item for the journal: restricted and the overrides with
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

// upsertEvent is DISK_ITEM_UPSERT of it: after is its access chain now, before the one it had
// when that changed (nil = unchanged, or nobody saw it: a new item).
func upsertEvent(it sqlc.DiskItem, after, before []perm.DiskNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemUpsert{DiskItemUpsert: &v1.DiskItemUpsert{
		WorkspaceId: it.WorkspaceID.String(), Item: itemProto(it, nil, false, nil, 0),
		Access: diskacl.Levels(after), AccessBefore: diskacl.Levels(before),
	}}}
}

// removeEvent is DISK_ITEM_REMOVE of it, to who saw it through chain.
func removeEvent(it sqlc.DiskItem, chain []perm.DiskNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemRemove{DiskItemRemove: &v1.DiskItemRemove{
		WorkspaceId: it.WorkspaceID.String(), ItemId: it.ID.String(), ParentId: idp(it.ParentID), Access: diskacl.Levels(chain),
	}}}
}

// publish sends the events of a committed change.
func (s *Service) publish(ctx context.Context, ws uuid.UUID, evs []*v1.DispatchEvent) {
	if len(evs) > 0 {
		s.ev.WorkspaceEvents(ctx, ws, evs)
	}
}

// sameChain reports whether two chains give everyone the same bits (same levels).
func sameChain(a, b []perm.DiskNode) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.Restricted != y.Restricted || x.OwnerID != y.OwnerID || len(x.Overrides) != len(y.Overrides) {
			return false
		}
		for j := range x.Overrides {
			if x.Overrides[j] != y.Overrides[j] {
				return false
			}
		}
	}
	return true
}
