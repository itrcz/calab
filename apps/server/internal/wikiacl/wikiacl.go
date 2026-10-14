// Package wikiacl loads the access chains of wiki pages (ADR-0096 §2) and turns them into
// perm.TreeNode chains for perm.ComputeWikiPageIn: the REST handlers and the sync socket
// (internal/wiki), the file download rule (files.CanRead), the search section and the gateway's
// per-recipient routing of WIKI_PAGE_* events (from the chains the events carry) share it. It is
// the Wiki's twin of internal/diskacl.
package wikiacl

import (
	"context"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Chains are pages with their ancestors and the overrides of every level.
type Chains struct {
	pages map[uuid.UUID]sqlc.WikiPageHead
	paths map[uuid.UUID][]uuid.UUID // leaf → ids, the top-level page first
	ovs   map[uuid.UUID][]perm.OverrideTarget
}

func empty() *Chains {
	return &Chains{pages: map[uuid.UUID]sqlc.WikiPageHead{}, paths: map[uuid.UUID][]uuid.UUID{}, ovs: map[uuid.UUID][]perm.OverrideTarget{}}
}

// Load reads the chains of ids (missing pages are absent: Has reports false).
func Load(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) (*Chains, error) {
	c := empty()
	if len(ids) == 0 {
		return c, nil
	}
	rows, err := q.WikiPagePaths(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		c.pages[r.WikiPageHead.ID] = r.WikiPageHead
		c.paths[r.Leaf] = append(c.paths[r.Leaf], r.WikiPageHead.ID)
	}
	all := make([]uuid.UUID, 0, len(c.pages))
	for id := range c.pages {
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
	rows, err := q.ListWikiPermissionsForPages(ctx, ids)
	if err != nil {
		return err
	}
	for _, p := range rows {
		c.ovs[p.PageID] = append(c.ovs[p.PageID], Target(p))
	}
	return nil
}

// AddChildren adds pages of one parent (an id of c, or nil = the top level) with their
// overrides, so that Nodes works for them without one query per page.
func (c *Chains) AddChildren(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID, children []sqlc.WikiPageHead) error {
	base := []uuid.UUID(nil)
	if parent != nil {
		base = c.paths[*parent]
	}
	ids := make([]uuid.UUID, 0, len(children))
	for _, ch := range children {
		if _, ok := c.pages[ch.ID]; ok {
			continue
		}
		c.pages[ch.ID] = ch
		p := make([]uuid.UUID, len(base)+1)
		copy(p, base)
		p[len(base)] = ch.ID
		c.paths[ch.ID] = p
		ids = append(ids, ch.ID)
	}
	return c.loadOverrides(ctx, q, ids)
}

// Has reports whether the page was loaded.
func (c *Chains) Has(id uuid.UUID) bool { _, ok := c.paths[id]; return ok }

// Page returns a loaded page.
func (c *Chains) Page(id uuid.UUID) sqlc.WikiPageHead { return c.pages[id] }

// Path returns the page and its ancestors, the top-level page first.
func (c *Chains) Path(id uuid.UUID) []sqlc.WikiPageHead {
	ids := c.paths[id]
	out := make([]sqlc.WikiPageHead, len(ids))
	for i, x := range ids {
		out[i] = c.pages[x]
	}
	return out
}

// Overrides returns the overrides of one loaded page.
func (c *Chains) Overrides(id uuid.UUID) []perm.OverrideTarget { return c.ovs[id] }

// Nodes is the chain of id as perm.ComputeWikiPageIn reads it (nil for the top level or an
// unknown page).
func (c *Chains) Nodes(id uuid.UUID) []perm.TreeNode {
	ids := c.paths[id]
	out := make([]perm.TreeNode, len(ids))
	for i, x := range ids {
		out[i] = Node(c.pages[x], c.ovs[x])
	}
	return out
}

// Bits is a member's wiki bits on id. A nil id is the top level: the
// workspace-level bits.
func (c *Chains) Bits(m perm.Member, id *uuid.UUID) perm.Bits {
	if id == nil {
		return perm.ComputeWikiPageIn(m, nil)
	}
	return perm.ComputeWikiPageIn(m, c.Nodes(*id))
}

// Node is one level of a chain.
func Node(p sqlc.WikiPageHead, ovs []perm.OverrideTarget) perm.TreeNode {
	n := perm.TreeNode{Restricted: p.Restricted, Overrides: ovs}
	if p.OwnerID != nil {
		n.OwnerID = p.OwnerID.String()
	}
	return n
}

// Target converts a wiki_permissions row.
func Target(p sqlc.WikiPermission) perm.OverrideTarget {
	return perm.OverrideTarget{TargetType: p.TargetType, TargetID: p.TargetID,
		Override: perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}} //nolint:gosec // bit mask round-trip
}

// Entry converts an override to its API form.
func Entry(o perm.OverrideTarget) *v1.WikiPermissionEntry {
	tt := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	if o.TargetType == "role" {
		tt = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	}
	return &v1.WikiPermissionEntry{TargetType: tt, TargetId: o.TargetID, Allow: uint64(o.Allow), Deny: uint64(o.Deny)}
}

// Levels is a chain as the WIKI_PAGE_* events carry it (server-internal routing).
func Levels(nodes []perm.TreeNode) []*v1.WikiAccessLevel {
	out := make([]*v1.WikiAccessLevel, len(nodes))
	for i, n := range nodes {
		l := &v1.WikiAccessLevel{Restricted: n.Restricted, OwnerId: n.OwnerID}
		for _, o := range n.Overrides {
			l.Overrides = append(l.Overrides, Entry(o))
		}
		out[i] = l
	}
	return out
}

// FromLevels is the inverse of Levels.
func FromLevels(levels []*v1.WikiAccessLevel) []perm.TreeNode {
	out := make([]perm.TreeNode, len(levels))
	for i, l := range levels {
		n := perm.TreeNode{Restricted: l.GetRestricted(), OwnerID: l.GetOwnerId()}
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

// SameChain reports whether two chains give everyone the same bits (same levels).
func SameChain(a, b []perm.TreeNode) bool {
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
