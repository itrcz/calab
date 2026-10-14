package disk

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// MaxOverrides bounds the overrides of one item.
const MaxOverrides = 100

var errNotSharer = httpx.Forbidden("only the owner or DISK_MANAGE may share the item")

// getPermissions: GET /api/disk/items/{id}/permissions (the owner or DISK_MANAGE).
func (s *Service) getPermissions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	if !a.mayChange() {
		return errNotSharer
	}
	out := &v1.DiskPermissionsResponse{Restricted: a.item.Restricted}
	for _, o := range a.chain.Overrides(a.item.ID) {
		out.Entries = append(out.Entries, diskacl.Entry(o))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setPermissions: PUT /api/disk/items/{id}/permissions — replaces the item's overrides (VIEW /
// WRITE only; roles of the workspace except the guest role, members as users — guests only
// this way) and optionally the restricted switch. The owner or DISK_MANAGE.
func (s *Service) setPermissions(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.UpdateDiskPermissionsRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if len(req.GetEntries()) > MaxOverrides {
		return httpx.Validation("entries", "at most 100")
	}
	type entry struct {
		tt, id      string
		allow, deny perm.Bits
	}
	entries := make([]entry, 0, len(req.GetEntries()))
	seen := map[string]bool{}
	for _, e := range req.GetEntries() {
		tt, ok := pbconv.TargetTypeToDB(e.GetTargetType())
		if !ok {
			return httpx.Validation("entries.target_type", "must be ROLE or USER")
		}
		tid, err := uuid.Parse(e.GetTargetId())
		if err != nil {
			return httpx.Validation("entries.target_id", "must be an id")
		}
		allow, deny := perm.Bits(e.GetAllow()), perm.Bits(e.GetDeny())
		if !perm.ValidDiskOverride(allow, deny) {
			return httpx.Validation("entries.allow", "only DISK_VIEW and DISK_WRITE, not both allowed and denied")
		}
		k := tt + ":" + tid.String()
		if seen[k] {
			return httpx.Validation("entries", "one entry per target")
		}
		seen[k] = true
		if allow == 0 && deny == 0 {
			continue
		}
		entries = append(entries, entry{tt, tid.String(), allow, deny})
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var before, after []perm.DiskNode
	var a access
	var out *v1.DiskPermissionsResponse
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if !a.mayChange() {
			return errNotSharer
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		if _, err := q.GetDiskItemForUpdate(ctx, id); err != nil {
			return err
		}
		var roles map[string]sqlc.WorkspaceRole
		for _, e := range entries {
			switch e.tt {
			case "role":
				if roles == nil {
					rs, err := q.ListWorkspaceRoles(ctx, ws)
					if err != nil {
						return err
					}
					roles = map[string]sqlc.WorkspaceRole{}
					for _, r := range rs {
						roles[r.ID.String()] = r
					}
				}
				role, ok := roles[e.id]
				if !ok {
					return httpx.Validation("entries.target_id", "not a role of the workspace")
				}
				if role.Builtin != nil && *role.Builtin == string(perm.RoleGuest) {
					return httpx.Validation("entries.target_id", "guests get access only as people")
				}
			case "user":
				if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: uuid.MustParse(e.id)}); err != nil {
					if db.IsNotFound(err) {
						return httpx.Validation("entries.target_id", "not a member of the workspace")
					}
					return err
				}
			}
		}
		before = a.nodes()
		oldOvs := a.chain.Overrides(id)
		if err := q.DeleteDiskPermissions(ctx, id); err != nil {
			return err
		}
		for _, e := range entries {
			if err := q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: id, TargetType: e.tt, TargetID: e.id,
				Allow: int64(e.allow), Deny: int64(e.deny)}); err != nil { //nolint:gosec // bit masks ≤ 1 << 36
				return err
			}
		}
		it = a.item
		if req.Restricted != nil && req.GetRestricted() != it.Restricted {
			if it, err = q.UpdateDiskItem(ctx, sqlc.UpdateDiskItemParams{ID: id, Restricted: req.Restricted}); err != nil {
				return err
			}
		} else if err := q.TouchDiskItem(ctx, id); err != nil {
			return err
		}
		ch, err := diskacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		it, after = ch.Item(id), ch.Nodes(id)
		b, err := sharing(ctx, q, ws, a.item.Restricted, oldOvs)
		if err != nil {
			return err
		}
		af, err := sharing(ctx, q, ws, it.Restricted, ch.Overrides(id))
		if err != nil {
			return err
		}
		if err := s.journal(ctx, q, it, &a.c.uid, "share", b, af); err != nil {
			return err
		}
		out = &v1.DiskPermissionsResponse{Restricted: it.Restricted}
		for _, o := range ch.Overrides(id) {
			out.Entries = append(out.Entries, diskacl.Entry(o))
		}
		return nil
	})
	if err != nil {
		return err
	}
	var was []perm.DiskNode
	if !sameChain(before, after) {
		was = before
	}
	s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, after, was)})
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// newCode is a public link code: 32 random bytes, base64url without padding (43 characters).
func newCode() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// createLink: POST /api/disk/items/{id}/link — turns the public link of a file on (the owner or
// DISK_MANAGE); a live link is answered as is (200), a new one with 201.
func (s *Service) createLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.CreateDiskLinkRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var expires *time.Time
	if req.ExpiresAt != nil {
		t := req.GetExpiresAt().AsTime()
		if !t.After(s.Now()) {
			return httpx.Validation("expires_at", "must be in the future")
		}
		expires = &t
	}
	code, err := newCode()
	if err != nil {
		return err
	}
	ctx := r.Context()
	var link sqlc.DiskLink
	var a access
	fresh := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if a.item.Kind != "file" {
			return httpx.Conflict("only files can have a public link")
		}
		if !a.mayChange() {
			return errNotSharer
		}
		if _, err := q.GetDiskItemForUpdate(ctx, id); err != nil {
			return err
		}
		link, err = q.GetDiskLinkByItem(ctx, id)
		if err == nil {
			return nil
		}
		if !db.IsNotFound(err) {
			return err
		}
		if link, err = q.UpsertDiskLink(ctx, sqlc.UpsertDiskLinkParams{ItemID: id, Code: code, CreatedBy: &a.c.uid, ExpiresAt: expires}); err != nil {
			return err
		}
		fresh = true
		after := snap{}
		if expires != nil {
			after["expires_at"] = expires.UTC().Format(time.RFC3339)
		}
		return s.journal(ctx, q, a.item, &a.c.uid, "link_on", nil, after)
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if fresh {
		status = http.StatusCreated
		s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{upsertEvent(a.item, a.nodes(), nil)})
	}
	httpx.Write(w, status, &v1.DiskLinkResponse{Link: linkProto(link), Url: s.publicURL(link.Code)})
	return nil
}

// deleteLink: DELETE /api/disk/items/{id}/link — revokes the public link (the owner or
// DISK_MANAGE); 404 without a live one.
func (s *Service) deleteLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.mayChange() {
			return errNotSharer
		}
		n, err := q.RevokeDiskLink(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("link")
		}
		return s.journal(ctx, q, a.item, &a.c.uid, "link_off", nil, nil)
	})
	if err != nil {
		return err
	}
	s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{upsertEvent(a.item, a.nodes(), nil)})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
