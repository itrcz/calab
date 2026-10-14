//go:build integration

package files

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0094 §7: a file of the Disk is readable with DISK_VIEW on its item (perm.ComputeDiskItem):
// members while it is not restricted, a guest only through a personal override, in the trash too.
func TestCanReadDiskFile(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(d, store, nil, 1<<20, 0)
	owner, ws := diskSeed(ctx, t, d)
	person := func(name, role string, guest bool) uuid.UUID {
		id := uuid.New()
		var email any = id.String() + "@disk.test"
		if guest {
			email = nil
		}
		if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name, is_guest) VALUES ($1, $2, $3, $4)`, id, email, name, guest); err != nil {
			t.Fatal(err)
		}
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws, UserID: id, Role: role}); err != nil {
			t.Fatal(err)
		}
		return id
	}
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws, UserID: owner, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	bob, guest := person("Bob", "member", false), person("Guest", "guest", true)
	outsider := uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Out')`, outsider, outsider.String()+"@disk.test"); err != nil {
		t.Fatal(err)
	}
	f := diskFile(ctx, t, d, store, ws, owner, 10, 0)
	folder, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "folder", Name: "Docs", OwnerID: &owner})
	if err != nil {
		t.Fatal(err)
	}
	it, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &folder.ID, Kind: "file", Name: "a.bin", FileID: &f.ID, OwnerID: &owner})
	if err != nil {
		t.Fatal(err)
	}
	can := func(u uuid.UUID) bool {
		t.Helper()
		r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/files/"+f.ID.String(), nil)
		c := perm.WithResolver(auth.WithIdentity(r.Context(), auth.Identity{UserID: u, SessionID: uuid.New()}), d.Q)
		ok, err := s.CanRead(r.WithContext(c), f)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	check := func(name string, want map[uuid.UUID]bool) {
		t.Helper()
		for u, w := range want {
			if got := can(u); got != w {
				t.Errorf("%s: %s reads = %v, want %v", name, map[uuid.UUID]string{owner: "owner", bob: "bob", guest: "guest", outsider: "outsider"}[u], got, w)
			}
		}
	}
	check("open folder", map[uuid.UUID]bool{owner: true, bob: true, guest: false, outsider: false})
	if _, err := d.Q.UpdateDiskItem(ctx, sqlc.UpdateDiskItemParams{ID: folder.ID, Restricted: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	check("restricted folder", map[uuid.UUID]bool{owner: true, bob: false, guest: false})
	if err := d.Q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: folder.ID, TargetType: "user", TargetID: guest.String(),
		Allow: int64(perm.DiskView)}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.TrashDiskSubtree(ctx, sqlc.TrashDiskSubtreeParams{ID: it.ID, TrashedAt: time.Now(), TrashedBy: &owner}); err != nil {
		t.Fatal(err)
	}
	check("shared with the guest, in the trash", map[uuid.UUID]bool{owner: true, bob: false, guest: true})
}
