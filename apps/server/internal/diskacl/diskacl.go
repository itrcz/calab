// Package diskacl loads the access chains of Disk items (ADR-0094 §2) and turns them into
// perm.DiskNode chains for perm.ComputeDiskItemIn: the REST handlers (internal/disk), the file
// download rule (files.CanRead) and the gateway's per-recipient routing of DISK_ITEM_* events
// (from the chains the events carry) share it.
package diskacl

import (
	"context"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Chains are items with their ancestors and the overrides of every level.
type Chains struct {
	items map[uuid.UUID]sqlc.DiskItem
	paths map[uuid.UUID][]uuid.UUID // leaf → ids, the topmost first
	ovs   map[uuid.UUID][]perm.OverrideTarget
}

// Load reads the chains of ids (missing items are absent: Has reports false).
func Load(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) (*Chains, error) {
	c := &Chains{items: map[uuid.UUID]sqlc.DiskItem{}, paths: map[uuid.UUID][]uuid.UUID{}, ovs: map[uuid.UUID][]perm.OverrideTarget{}}
	if len(ids) == 0 {
		return c, nil
	}
	rows, err := q.DiskItemPaths(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		c.items[r.DiskItem.ID] = r.DiskItem
		c.paths[r.Leaf] = append(c.paths[r.Leaf], r.DiskItem.ID)
	}
	all := make([]uuid.UUID, 0, len(c.items))
	for id := range c.items {
		all = append(all, id)
	}
	if err := c.loadOverrides(ctx, q, all); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Chains) loadOverrides(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListDiskPermissionsForItems(ctx, ids)
	if err != nil {
		return err
	}
	for _, p := range rows {
		c.ovs[p.ItemID] = append(c.ovs[p.ItemID], Target(p))
	}
	return nil
}

// AddChildren adds items of one folder (parent: an item of c, or nil = the root) with their
// overrides, so that Nodes works for them without one query per item.
func (c *Chains) AddChildren(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID, children []sqlc.DiskItem) error {
	base := []uuid.UUID(nil)
	if parent != nil {
		base = c.paths[*parent]
	}
	ids := make([]uuid.UUID, 0, len(children))
	for _, ch := range children {
		if _, ok := c.items[ch.ID]; ok {
			continue
		}
		c.items[ch.ID] = ch
		p := make([]uuid.UUID, len(base)+1)
		copy(p, base)
		p[len(base)] = ch.ID
		c.paths[ch.ID] = p
		ids = append(ids, ch.ID)
	}
	return c.loadOverrides(ctx, q, ids)
}

// Has reports whether the item was loaded.
func (c *Chains) Has(id uuid.UUID) bool { _, ok := c.paths[id]; return ok }

// Item returns a loaded item.
func (c *Chains) Item(id uuid.UUID) sqlc.DiskItem { return c.items[id] }

// Path returns the item and its ancestors, the topmost first.
func (c *Chains) Path(id uuid.UUID) []sqlc.DiskItem {
	ids := c.paths[id]
	out := make([]sqlc.DiskItem, len(ids))
	for i, x := range ids {
		out[i] = c.items[x]
	}
	return out
}

// Overrides returns the overrides of one loaded item.
func (c *Chains) Overrides(id uuid.UUID) []perm.OverrideTarget { return c.ovs[id] }

// Nodes is the chain of id as perm.ComputeDiskItemIn reads it (nil for the root or an unknown
// item).
func (c *Chains) Nodes(id uuid.UUID) []perm.DiskNode {
	ids := c.paths[id]
	out := make([]perm.DiskNode, len(ids))
	for i, x := range ids {
		out[i] = Node(c.items[x], c.ovs[x])
	}
	return out
}

// Bits is a member's disk bits on id. A nil id is the root: the
// workspace-level bits.
func (c *Chains) Bits(m perm.Member, id *uuid.UUID) perm.Bits {
	if id == nil {
		return perm.ComputeDiskItemIn(m, nil)
	}
	return perm.ComputeDiskItemIn(m, c.Nodes(*id))
}

// Node is one level of a chain.
func Node(it sqlc.DiskItem, ovs []perm.OverrideTarget) perm.DiskNode {
	n := perm.DiskNode{Restricted: it.Restricted, Overrides: ovs}
	if it.OwnerID != nil {
		n.OwnerID = it.OwnerID.String()
	}
	return n
}

// Target converts a disk_permissions row.
func Target(p sqlc.DiskPermission) perm.OverrideTarget {
	return perm.OverrideTarget{TargetType: p.TargetType, TargetID: p.TargetID,
		Override: perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}} //nolint:gosec // bit mask round-trip
}

// Entry converts an override to its API form.
func Entry(o perm.OverrideTarget) *v1.DiskPermissionEntry {
	tt := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	if o.TargetType == "role" {
		tt = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	}
	return &v1.DiskPermissionEntry{TargetType: tt, TargetId: o.TargetID, Allow: uint64(o.Allow), Deny: uint64(o.Deny)}
}

// Levels is a chain as the DISK_ITEM_* events carry it (server-internal routing).
func Levels(nodes []perm.DiskNode) []*v1.DiskAccessLevel {
	out := make([]*v1.DiskAccessLevel, len(nodes))
	for i, n := range nodes {
		l := &v1.DiskAccessLevel{Restricted: n.Restricted, OwnerId: n.OwnerID}
		for _, o := range n.Overrides {
			l.Overrides = append(l.Overrides, Entry(o))
		}
		out[i] = l
	}
	return out
}

// FromLevels is the inverse of Levels.
func FromLevels(levels []*v1.DiskAccessLevel) []perm.DiskNode {
	out := make([]perm.DiskNode, len(levels))
	for i, l := range levels {
		n := perm.DiskNode{Restricted: l.GetRestricted(), OwnerID: l.GetOwnerId()}
		for _, o := range l.GetOverrides() {
			tt := "user"
			if o.GetTargetType() == v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE {
				tt = "role"
			}
			n.Overrides = append(n.Overrides, perm.OverrideTarget{TargetType: tt, TargetID: o.GetTargetId(),
				Override: perm.Override{Allow: perm.Bits(o.GetAllow()), Deny: perm.Bits(o.GetDeny())}})
		}
		out[i] = n
	}
	return out
}
