package wiki

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// MaxOverrides bounds the overrides of one page.
const MaxOverrides = 100

// getPermissions: GET /api/wiki/pages/{id}/permissions (the owner or WIKI_MANAGE).
func (s *Service) getPermissions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	if !a.structure() {
		return errNotStructure
	}
	out := &v1.WikiPermissionsResponse{Restricted: a.page.Restricted}
	for _, o := range a.chain.Overrides(a.page.ID) {
		out.Entries = append(out.Entries, wikiacl.Entry(o))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setPermissions: PUT /api/wiki/pages/{id}/permissions — replaces the page's overrides
// (WIKI_VIEW / WIKI_WRITE only; roles of the workspace except the guest role, members as users —
// guests only this way) and optionally the restricted switch. The owner or WIKI_MANAGE.
func (s *Service) setPermissions(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	var req v1.UpdateWikiPermissionsRequest
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
		if !perm.ValidWikiOverride(allow, deny) {
			return httpx.Validation("entries.allow", "only WIKI_VIEW and WIKI_WRITE, not both allowed and denied")
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
	var before []perm.TreeNode
	var out *v1.WikiPermissionsResponse
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.page.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.page.TrashedAt != nil {
			return errTrashed
		}
		if _, err := q.GetWikiPageForUpdate(ctx, id); err != nil {
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
		if err := q.DeleteWikiPermissions(ctx, id); err != nil {
			return err
		}
		for _, e := range entries {
			if err := q.InsertWikiPermission(ctx, sqlc.InsertWikiPermissionParams{PageID: id, TargetType: e.tt, TargetID: e.id,
				Allow: int64(e.allow), Deny: int64(e.deny)}); err != nil { //nolint:gosec // bit masks ≤ 1 << 39
				return err
			}
		}
		restricted := a.page.Restricted
		if req.Restricted != nil {
			restricted = req.GetRestricted()
		}
		row, err := q.UpdateWikiPage(ctx, sqlc.UpdateWikiPageParams{ID: id, Restricted: &restricted, UpdatedBy: &a.c.uid})
		if err != nil {
			return err
		}
		ch, err := wikiacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		b, err := sharing(ctx, q, ws, a.page.Restricted, oldOvs)
		if err != nil {
			return err
		}
		af, err := sharing(ctx, q, ws, row.Restricted, ch.Overrides(id))
		if err != nil {
			return err
		}
		if err := s.journal(ctx, q, head(row), &a.c.uid, "share", b, af); err != nil {
			return err
		}
		out = &v1.WikiPermissionsResponse{Restricted: row.Restricted}
		for _, o := range ch.Overrides(id) {
			out.Entries = append(out.Entries, wikiacl.Entry(o))
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.upserted(ctx, id, before)
	s.recheck(ctx, id)
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

// createLink: POST /api/wiki/pages/{id}/link — turns the public link of a page on or changes it
// (include_children, expires_at; a live link keeps its code). The owner or WIKI_MANAGE; 201 for
// a new link, 200 for a changed one.
func (s *Service) createLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	var req v1.CreateWikiLinkRequest
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
	var link sqlc.WikiLink
	var a access
	fresh := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.page.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.page.TrashedAt != nil {
			return errTrashed
		}
		if _, err := q.GetWikiPageForUpdate(ctx, id); err != nil {
			return err
		}
		_, err := q.GetWikiLinkByPage(ctx, id)
		switch {
		case db.IsNotFound(err):
			fresh = true
		case err != nil:
			return err
		}
		if link, err = q.UpsertWikiLink(ctx, sqlc.UpsertWikiLinkParams{PageID: id, Code: code, IncludeChildren: req.GetIncludeChildren(),
			CreatedBy: &a.c.uid, ExpiresAt: expires}); err != nil {
			return err
		}
		if !fresh {
			return nil
		}
		after := snap{"include_children": link.IncludeChildren}
		if expires != nil {
			after["expires_at"] = expires.UTC().Format(time.RFC3339)
		}
		return s.journal(ctx, q, a.page, &a.c.uid, "link_on", nil, after)
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if fresh {
		status = http.StatusCreated
	}
	s.publish(ctx, a.page.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, a.page, a.nodes(), nil)})
	httpx.Write(w, status, &v1.WikiLinkResponse{Link: linkProto(link), Url: s.publicURL(link.Code)})
	return nil
}

// deleteLink: DELETE /api/wiki/pages/{id}/link — revokes the public link (the owner or
// WIKI_MANAGE); 404 without a live one.
func (s *Service) deleteLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.page.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		n, err := q.RevokeWikiLink(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("link")
		}
		return s.journal(ctx, q, a.page, &a.c.uid, "link_off", nil, nil)
	})
	if err != nil {
		return err
	}
	s.publish(ctx, a.page.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, a.page, a.nodes(), nil)})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
