package perm

// Wiki bits (ADR-0096 §2): the same rules as the disk bits (disk.go) — listed in the comment of
// enum Permission and docs/04, TS WIKI_BITS; in ADMINISTRATOR (WikiOf) but outside All; per-page
// overrides (wiki_permissions) carry WikiView and WikiWrite only; guests get nothing from their
// roles, only from an explicit user override on a page (or by owning it); bots are members like
// people (addendum 2026-10-14). The page rule is the shared tree rule (tree.go) over WikiTree.
//
// One difference from the Disk is in what the bits allow, not in how they are computed:
// WIKI_WRITE on a page edits its content (the page is a shared document) and creates child
// pages under it; the structure of the page — rename, icon, cover, move, trash, restore, delete,
// access, public link — needs its owner or WIKI_MANAGE (WikiStructureAllowed).
const (
	// WikiView: see the Wiki and every page that is not restricted. Member default.
	WikiView Bits = 1 << 38
	// WikiWrite: create pages; edit the content of a page and add subpages wherever one has
	// it; the structure of one's own pages. Member default.
	WikiWrite Bits = 1 << 39
	// WikiManage: the structure of any page, the trash retention, empty the whole trash, remove
	// anyone's public link. Implies View and Write; sees restricted pages too.
	WikiManage Bits = 1 << 40

	// Wiki are the three wiki bits.
	Wiki = WikiView | WikiWrite | WikiManage
	// WikiOverride are the bits a wiki_permissions row may allow or deny.
	WikiOverride = WikiView | WikiWrite
)

// WikiTree are the Wiki's bits for the tree rule.
var WikiTree = TreeBits{View: WikiView, Write: WikiWrite, Manage: WikiManage}

// WikiOf is the workspace-level wiki rule (TS: wikiPermissions): guests nothing; ADMINISTRATOR
// or WIKI_MANAGE all three; anyone else (bots included) the wiki bits of their roles.
func WikiOf(raw Bits, guest bool) Bits { return TreeOf(WikiTree, raw, guest) }

// ComputeWikiPage is the one page rule (ADR-0096 §2; TS: wikiPagePermissions): ComputeTree over
// WikiTree. chain runs from the top-level ancestor down to the page itself (empty = the top
// level of the Wiki: creating a top-level page needs WIKI_WRITE there).
func ComputeWikiPage(raw Bits, guest bool, chain []TreeLevel) Bits {
	return ComputeTree(WikiTree, TreeInput{Raw: raw, Guest: guest, Chain: chain})
}

// ComputeWikiPageIn computes a member's bits on the last page of chain (the top-level page
// first).
func ComputeWikiPageIn(m Member, chain []TreeNode) Bits {
	return ComputeTreeIn(WikiTree, m, chain)
}

// WikiStructureAllowed is the structural rule of a page (ADR-0096 §2; TS:
// wikiStructureAllowed): renaming, the icon and the cover, moving, trashing, restoring,
// deleting forever, the access dialog and the public link need WIKI_VIEW on the page (bits =
// ComputeWikiPage) and either its ownership or WIKI_MANAGE. WIKI_WRITE alone edits the content
// and creates subpages, nothing else. Moving also needs WIKI_WRITE on the destination parent.
func WikiStructureAllowed(bits Bits, owner bool) bool {
	return bits&WikiView != 0 && (owner || bits&WikiManage != 0)
}

// ValidWikiOverride reports whether an allow / deny pair may be stored in wiki_permissions:
// only WIKI_VIEW and WIKI_WRITE, not both ways.
func ValidWikiOverride(allow, deny Bits) bool { return ValidTreeOverride(WikiTree, allow, deny) }
