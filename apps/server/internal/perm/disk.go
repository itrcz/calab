package perm

// Disk bits (ADR-0094 §2). Bits from 1 << 32 on cannot be proto enum values (int32): they are
// listed in the comment of enum Permission (proto/calaba/v1/permissions.proto), docs/04 and the
// TS mirror (DISK_BITS). Workspace-level bits on roles, but unlike billing:
//   - ADMINISTRATOR includes them (DiskOf), although All stops at bit 31 (room and board rules
//     never see them);
//   - per-item overrides (disk_permissions) carry DiskView and DiskWrite (DiskOverride) and
//     nothing else, except a person's override, which may also carry DiskManage — the level
//     «Управление» (ADR-0161, DiskPersonal); room and board overrides never carry them
//     (RoomOnly / BoardOnly are within All);
//   - guests get nothing from their roles, only from an explicit user override on an item (or
//     by owning it); bots are members like people (addendum 2026-10-14).
//
// The item rule is the shared tree rule (tree.go) over DiskTree.
const (
	// DiskView: see the Disk and every item that is not restricted. Member default.
	DiskView Bits = 1 << 35
	// DiskWrite: create folders, upload; rename, move and trash one's own items. Member default.
	DiskWrite Bits = 1 << 36
	// DiskManage: any item, the trash retention, empty the whole trash, remove anyone's public
	// link. Implies View and Write; not inside restricted items
	// (addendum 2026-10-14): there only what their overrides give (ComputeTree).
	DiskManage Bits = 1 << 37

	// Disk are the three disk bits.
	Disk = DiskView | DiskWrite | DiskManage
	// DiskOverride are the bits a disk_permissions row of a role may allow or deny.
	DiskOverride = DiskView | DiskWrite
	// DiskPersonal are the bits a disk_permissions row of a person may allow or deny: also
	// DiskManage, allowed only with View and Write («Управление», ADR-0161; not for guests).
	DiskPersonal = Disk
)

// DiskTree are the Disk's bits for the tree rule; a person's override may carry DiskManage
// (ADR-0161).
var DiskTree = TreeBits{View: DiskView, Write: DiskWrite, Manage: DiskManage, PersonalManage: true}

// DiskLevel is one item on the way from the root to the item being checked.
type DiskLevel = TreeLevel

// DiskNode is one item of a chain as stored: its flag, owner and full override list.
type DiskNode = TreeNode

// DiskOf is the workspace-level disk rule (TS: diskPermissions): guests nothing;
// ADMINISTRATOR (raw: the plain OR of the roles, not expanded) or DISK_MANAGE all three;
// anyone else (bots included) the disk bits of their roles.
func DiskOf(raw Bits, guest bool) Bits { return TreeOf(DiskTree, raw, guest) }

// ComputeDiskItem is the one item rule (ADR-0094 §2; TS: diskItemPermissions): ComputeTree over
// DiskTree. chain runs from the topmost ancestor down to the item itself (empty = the root).
func ComputeDiskItem(raw Bits, guest bool, chain []DiskLevel) Bits {
	return ComputeTree(DiskTree, TreeInput{Raw: raw, Guest: guest, Chain: chain})
}

// ComputeDiskItemIn computes a member's bits on the last item of chain (root's child first).
func ComputeDiskItemIn(m Member, chain []DiskNode) Bits {
	return ComputeTreeIn(DiskTree, m, chain)
}

// ValidDiskOverride reports whether an allow / deny pair may be stored in disk_permissions for
// a role: only DISK_VIEW and DISK_WRITE (never DISK_MANAGE, billing or room bits), not both ways.
func ValidDiskOverride(allow, deny Bits) bool { return ValidTreeOverride(DiskTree, allow, deny) }

// ValidDiskPersonalOverride is ValidDiskOverride for a person (not a guest: the caller checks):
// DISK_MANAGE may be denied, and allowed only with DISK_VIEW | DISK_WRITE («Управление»,
// ADR-0161).
func ValidDiskPersonalOverride(allow, deny Bits) bool {
	return ValidTreePersonalOverride(DiskTree, allow, deny)
}
