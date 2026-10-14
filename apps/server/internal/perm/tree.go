package perm

// The tree rule shared by the Disk (ADR-0094 §2) and the Wiki (ADR-0096 §2): a workspace-level
// triple of bits (VIEW / WRITE / MANAGE) on roles, then per-node overrides down a chain of
// ancestors. The two sections are two TreeBits over one algorithm (TS: treeItemPermissions).

// TreeBits names the three bits of one tree section.
type TreeBits struct {
	View, Write, Manage Bits
}

// All are the three bits.
func (b TreeBits) All() Bits { return b.View | b.Write | b.Manage }

// Override are the bits a per-node override may allow or deny: VIEW and WRITE.
func (b TreeBits) Override() Bits { return b.View | b.Write }

// TreeLevel is one node on the way from the top to the node being checked, as far as one
// member is concerned.
type TreeLevel struct {
	Restricted bool       // the node's «Только выбранные»
	Owner      bool       // the member owns this node
	RoleOvs    []Override // the node's overrides of the member's roles, lowest position first
	UserOv     *Override  // the node's override of the member; nil = none
}

// TreeInput is a member and a chain: Raw is the plain OR of the member's roles (ADMINISTRATOR
// not expanded); Chain runs from the topmost ancestor down to the node itself (empty = the root
// of the section). A bot is a member like a person (ADR-0031; ADR-0094 §2 and ADR-0096 §2,
// addendum 2026-10-14): no flag of its own.
type TreeInput struct {
	Raw   Bits
	Guest bool
	Chain []TreeLevel
}

// TreeOf is the workspace-level rule of a section (TS: treePermissions): guests nothing;
// ADMINISTRATOR or MANAGE all three; anyone else (bots included) the section's bits of their
// roles.
func TreeOf(b TreeBits, raw Bits, guest bool) Bits {
	switch {
	case guest:
		return 0
	case raw&(Administrator|b.Manage) != 0:
		return b.All()
	}
	return raw & b.All()
}

// ComputeTree is the one node rule. MANAGE or ADMINISTRATOR (TreeOf): everything, restricted
// nodes included. Otherwise the start is the member's VIEW | WRITE (none for guests) and at
// every level, top down: a restricted node drops what the roles and the ancestors gave; then
// each role's override (lowest position first: deny, then allow; ignored for guests — they get
// access only as a person), then the user's own; the owner of the level always
// has VIEW | WRITE. A child inherits its parent's result. Overrides touch b.Override() only.
// Without VIEW nothing (404).
func ComputeTree(b TreeBits, in TreeInput) Bits {
	ws := TreeOf(b, in.Raw, in.Guest)
	if ws&b.Manage != 0 {
		return b.All()
	}
	ov := b.Override()
	p := ws & ov
	for i := range in.Chain {
		l := &in.Chain[i]
		if l.Restricted {
			p = 0
		}
		if !in.Guest {
			for _, o := range l.RoleOvs {
				p &^= o.Deny & ov
				p |= o.Allow & ov
			}
		}
		if l.UserOv != nil {
			p &^= l.UserOv.Deny & ov
			p |= l.UserOv.Allow & ov
		}
		if l.Owner {
			p |= ov
		}
	}
	if p&b.View == 0 {
		return 0
	}
	return p
}

// TreeNode is one node of a chain as stored: its flag, owner and full override list.
type TreeNode struct {
	Restricted bool
	OwnerID    string // user uuid text; "" = none
	Overrides  []OverrideTarget
}

// ComputeTreeIn computes a member's bits on the last node of chain (the topmost first). Mirror
// of treeItemPermissions with override lists.
func ComputeTreeIn(b TreeBits, m Member, chain []TreeNode) Bits {
	var buf [16]TreeLevel
	levels := buf[:0]
	for _, n := range chain {
		l := TreeLevel{Restricted: n.Restricted, Owner: n.OwnerID != "" && n.OwnerID == m.UserID}
		for _, r := range m.Roles { // lowest position first
			for i := range n.Overrides {
				if o := &n.Overrides[i]; o.TargetType == "role" && o.TargetID == r.ID {
					l.RoleOvs = append(l.RoleOvs, o.Override)
					break
				}
			}
		}
		for i := range n.Overrides {
			if o := &n.Overrides[i]; o.TargetType == "user" && o.TargetID == m.UserID {
				l.UserOv = &o.Override
				break
			}
		}
		levels = append(levels, l)
	}
	return ComputeTree(b, TreeInput{Raw: m.Raw(), Guest: m.Role == RoleGuest, Chain: levels})
}

// ValidTreeOverride reports whether an allow / deny pair may be stored as a node override of
// the section: only its VIEW and WRITE (never MANAGE, other sections', billing or room bits),
// not both ways.
func ValidTreeOverride(b TreeBits, allow, deny Bits) bool {
	return (allow|deny)&^b.Override() == 0 && allow&deny == 0
}
