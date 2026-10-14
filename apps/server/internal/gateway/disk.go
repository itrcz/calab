package gateway

import (
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// Disk events (ADR-0094 §7). The Disk tree is not kept in the workspace state: each
// DISK_ITEM_* event carries the item's access chain (server-internal, stripped here), and every
// recipient's bits come from it and their roles (perm.ComputeDiskItemIn), like board events from
// the board in the state. Without DISK_VIEW on the item nothing is delivered; who saw the item
// before a change of its chain (move, restricted, overrides) and does not any more gets
// DISK_ITEM_REMOVE instead of the upsert.

// diskSees reports whether member uid sees an item with this chain (mu held).
func (s *wsState) diskSees(uid uuid.UUID, chain []perm.DiskNode) bool {
	m, ok := s.members[uid]
	if !ok || len(chain) == 0 {
		return false
	}
	return perm.ComputeDiskItemIn(m, chain).Has(perm.DiskView)
}

// diskRemove is DISK_ITEM_REMOVE as clients get it.
func diskRemove(ws, item, parent string) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemRemove{DiskItemRemove: &v1.DiskItemRemove{
		WorkspaceId: ws, ItemId: item, ParentId: parent}}}
}

// routeDisk delivers DISK_ITEM_UPSERT / DISK_ITEM_REMOVE (st.mu held); false = not a disk event.
func (h *Hub) routeDisk(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_DiskItemUpsert:
		u := e.DiskItemUpsert
		after := diskacl.FromLevels(u.GetAccess())
		before := diskacl.FromLevels(u.GetAccessBefore())
		upsert := newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_DiskItemUpsert{DiskItemUpsert: &v1.DiskItemUpsert{
			WorkspaceId: u.GetWorkspaceId(), Item: u.GetItem()}}})
		var remove *encEvent
		for _, s := range sessions {
			switch {
			case st.diskSees(s.user, after):
				s.dispatchEnc(id, upsert)
			case st.diskSees(s.user, before):
				if remove == nil {
					remove = newScopedEnc(wid, diskRemove(u.GetWorkspaceId(), u.GetItem().GetId(), u.GetItem().GetParentId()))
				}
				s.dispatchEnc(id, remove)
			}
		}
	case *v1.DispatchEvent_DiskItemRemove:
		x := e.DiskItemRemove
		chain := diskacl.FromLevels(x.GetAccess())
		remove := newScopedEnc(wid, diskRemove(x.GetWorkspaceId(), x.GetItemId(), x.GetParentId()))
		for _, s := range sessions {
			if st.diskSees(s.user, chain) {
				s.dispatchEnc(id, remove)
			}
		}
	default:
		return false
	}
	return true
}
