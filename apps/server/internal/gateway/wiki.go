package gateway

import (
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// Wiki events (ADR-0096 §8), routed like the Disk's (disk.go): each WIKI_PAGE_* event carries
// the page's access chain (server-internal, stripped here) and every recipient's bits come from
// it and their roles (perm.ComputeWikiPageIn). Without WIKI_VIEW on the page nothing is
// delivered; who saw the page before a change of its chain (move, restricted, overrides) and does
// not any more gets WIKI_PAGE_REMOVE instead of the upsert. The content of pages never travels
// here (the sync socket, internal/wiki).

// wikiBits is member uid's wiki bits on a page with this chain (mu held); 0 = not a member or no
// chain.
func (s *wsState) wikiBits(uid uuid.UUID, chain []perm.TreeNode) perm.Bits {
	m, ok := s.members[uid]
	if !ok || len(chain) == 0 {
		return 0
	}
	return perm.ComputeWikiPageIn(m, chain) & perm.Wiki
}

// wikiSees reports whether member uid sees a page with this chain (mu held).
func (s *wsState) wikiSees(uid uuid.UUID, chain []perm.TreeNode) bool {
	return s.wikiBits(uid, chain).Has(perm.WikiView)
}

// wikiRemove is WIKI_PAGE_REMOVE as clients get it.
func wikiRemove(ws, page, parent string) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageRemove{WikiPageRemove: &v1.WikiPageRemove{
		WorkspaceId: ws, PageId: page, ParentId: parent}}}
}

// routeWiki delivers WIKI_PAGE_UPSERT / WIKI_PAGE_REMOVE (st.mu held); false = not a wiki event.
func (h *Hub) routeWiki(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WikiPageUpsert:
		u := e.WikiPageUpsert
		after := wikiacl.FromLevels(u.GetAccess())
		before := wikiacl.FromLevels(u.GetAccessBefore())
		// my_bits is the recipient's own; one encoding per distinct value (few: viewer / editor / manager).
		byBits := map[perm.Bits]*encEvent{}
		var remove *encEvent
		for _, s := range sessions {
			bits := st.wikiBits(s.user, after)
			switch {
			case bits.Has(perm.WikiView):
				upsert := byBits[bits]
				if upsert == nil {
					pg := proto.Clone(u.GetPage()).(*v1.WikiPage)
					pg.MyBits = uint64(bits)
					upsert = newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_WikiPageUpsert{WikiPageUpsert: &v1.WikiPageUpsert{
						WorkspaceId: u.GetWorkspaceId(), Page: pg}}})
					byBits[bits] = upsert
				}
				s.dispatchEnc(id, upsert)
			case st.wikiSees(s.user, before):
				if remove == nil {
					remove = newScopedEnc(wid, wikiRemove(u.GetWorkspaceId(), u.GetPage().GetId(), u.GetPage().GetParentId()))
				}
				s.dispatchEnc(id, remove)
			}
		}
	case *v1.DispatchEvent_WikiPageRemove:
		x := e.WikiPageRemove
		chain := wikiacl.FromLevels(x.GetAccess())
		remove := newScopedEnc(wid, wikiRemove(x.GetWorkspaceId(), x.GetPageId(), x.GetParentId()))
		for _, s := range sessions {
			if st.wikiSees(s.user, chain) {
				s.dispatchEnc(id, remove)
			}
		}
	default:
		return false
	}
	return true
}
