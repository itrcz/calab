//go:build integration

package files

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// diskSeed creates a user and a workspace (the trigger adds the built-in roles).
func diskSeed(ctx context.Context, t *testing.T, d *db.DB) (user, ws uuid.UUID) {
	t.Helper()
	user, ws = uuid.New(), uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Disk')`, user, user.String()+"@disk.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Disk', $3)`, ws, "dk-"+ws.String()[:12], user); err != nil {
		t.Fatal(err)
	}
	return user, ws
}

// diskFile stores a files row of size bytes (its blob in store) created age ago.
func diskFile(ctx context.Context, t *testing.T, d *db.DB, store blob.Store, ws, user uuid.UUID, size int64, age time.Duration) sqlc.File {
	t.Helper()
	id := uuid.New()
	key := blob.FileKey(ws, id)
	if err := store.Put(ctx, key, bytes.NewReader(make([]byte, size)), size, "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	f, err := d.Q.InsertFile(ctx, sqlc.InsertFileParams{ID: id, WorkspaceID: &ws, UploaderID: user, Key: key, Name: "f.bin", Mime: "application/octet-stream", Size: size, Sha256: "00"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `UPDATE files SET created_at = now() - $2::interval WHERE id = $1`, id, age.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `UPDATE workspaces SET storage_used_bytes = storage_used_bytes + $2 WHERE id = $1`, ws, size); err != nil {
		t.Fatal(err)
	}
	return f
}

// ADR-0094: files of the Disk (live or in the trash) are references like attachments: the 24 h
// orphan cleanup keeps them and they are not «uploads waiting for a message».
func TestCleanupOrphansKeepsDiskFiles(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(d, store, nil, 1<<20, 0)
	user, ws := diskSeed(ctx, t, d)

	old := 25 * time.Hour
	live := diskFile(ctx, t, d, store, ws, user, 100, old)
	trashed := diskFile(ctx, t, d, store, ws, user, 200, old)
	orphan := diskFile(ctx, t, d, store, ws, user, 400, old)

	folder, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "folder", Name: "Docs", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &folder.ID, Kind: "file", Name: "a.bin", FileID: &live.ID, OwnerID: &user}); err != nil {
		t.Fatal(err)
	}
	tr, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &folder.ID, Kind: "file", Name: "b.bin", FileID: &trashed.ID, OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.TrashDiskSubtree(ctx, sqlc.TrashDiskSubtreeParams{ID: tr.ID, TrashedAt: time.Now(), TrashedBy: &user}); err != nil {
		t.Fatal(err)
	}

	pending, err := d.Q.UnattachedBytesByUploader(ctx, sqlc.UnattachedBytesByUploaderParams{UploaderID: user, WorkspaceID: &ws})
	if err != nil {
		t.Fatal(err)
	}
	if pending != orphan.Size {
		t.Fatalf("unattached bytes = %d, want only the orphan's %d", pending, orphan.Size)
	}

	n, err := s.CleanupOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("cleanup deleted %d files, want 1 (the orphan)", n)
	}
	for _, f := range []sqlc.File{live, trashed} {
		if _, err := d.Q.GetFile(ctx, f.ID); err != nil {
			t.Fatalf("disk file %s gone: %v", f.ID, err)
		}
		if _, err := store.Stat(ctx, f.Key); err != nil {
			t.Fatalf("disk file %s blob gone: %v", f.ID, err)
		}
	}
	if _, err := d.Q.GetFile(ctx, orphan.ID); !db.IsNotFound(err) {
		t.Fatalf("the orphan must go: %v", err)
	}
	w, err := d.Q.GetWorkspace(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if w.StorageUsedBytes != live.Size+trashed.Size {
		t.Fatalf("storage used = %d, want %d", w.StorageUsedBytes, live.Size+trashed.Size)
	}
}

// The Disk's queries on a small tree: path, trash / restore of a subtree, usage, delete forever,
// overrides of a deleted role, the member role's default bits.
func TestDiskQueries(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user, ws := diskSeed(ctx, t, d)
	q := d.Q

	member, err := q.GetBuiltinRole(ctx, sqlc.GetBuiltinRoleParams{WorkspaceID: ws, Builtin: ptr("member")})
	if err != nil {
		t.Fatal(err)
	}
	if perm.Bits(uint64(member.Permissions)) != perm.RoleDefaults[perm.RoleMember] { //nolint:gosec // bit mask
		t.Fatalf("member role of a new workspace = %d, want %d", member.Permissions, perm.RoleDefaults[perm.RoleMember])
	}

	a, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "folder", Name: "A", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	b, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &a.ID, Kind: "folder", Name: "B", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	f1 := diskFile(ctx, t, d, store, ws, user, 1000, time.Minute)
	c, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &b.ID, Kind: "file", Name: "c.txt", FileID: &f1.ID, OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	// Names are unique per folder ignoring case; the root counts as one folder.
	if _, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "folder", Name: "a", OwnerID: &user}); err == nil {
		t.Fatal("a second «a» in the root must clash")
	}
	if taken, err := q.DiskNameTaken(ctx, sqlc.DiskNameTakenParams{WorkspaceID: ws, ParentID: &b.ID, Name: "C.TXT"}); err != nil || !taken {
		t.Fatalf("name taken: %v %v", taken, err)
	}

	path, err := q.DiskItemPath(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(path) != 3 || path[0].DiskItem.ID != a.ID || path[2].DiskItem.ID != c.ID || path[0].Depth != 2 {
		t.Fatalf("path %+v", path)
	}
	if depth, err := q.CountDiskSubtreeDepth(ctx, a.ID); err != nil || depth != 2 {
		t.Fatalf("subtree depth %d %v", depth, err)
	}

	list, err := q.ListDiskFolderByName(ctx, sqlc.ListDiskFolderByNameParams{WorkspaceID: ws, Lim: 10})
	if err != nil || len(list) != 1 || list[0].DiskItem.ID != a.ID {
		t.Fatalf("root listing %+v %v", list, err)
	}
	sized, err := q.ListDiskFolderBySize(ctx, sqlc.ListDiskFolderBySizeParams{WorkspaceID: ws, ParentID: &b.ID, Lim: 10})
	if err != nil || len(sized) != 1 || sized[0].Size != 1000 {
		t.Fatalf("size listing %+v %v", sized, err)
	}

	// Trash B: B is the root, c.txt goes with it; the trash lists only B.
	at := time.Now()
	gone, err := q.TrashDiskSubtree(ctx, sqlc.TrashDiskSubtreeParams{ID: b.ID, TrashedAt: at, TrashedBy: &user})
	if err != nil || len(gone) != 2 {
		t.Fatalf("trash %d %v", len(gone), err)
	}
	trash, err := q.ListDiskTrash(ctx, sqlc.ListDiskTrashParams{WorkspaceID: ws, Lim: 10})
	if err != nil || len(trash) != 1 || trash[0].DiskItem.ID != b.ID {
		t.Fatalf("trash listing %+v %v", trash, err)
	}
	u, err := q.GetDiskUsage(ctx, ws)
	if err != nil || u.DiskBytes != 1000 || u.TrashBytes != 1000 || u.AddonMb != 0 {
		t.Fatalf("usage %+v %v", u, err)
	}
	// A new «B» may take the name while the old one is in the trash; the restore is renamed.
	if _, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: &a.ID, Kind: "folder", Name: "b", OwnerID: &user}); err != nil {
		t.Fatal(err)
	}
	back, err := q.RestoreDiskSubtree(ctx, sqlc.RestoreDiskSubtreeParams{ID: b.ID, ParentID: &a.ID, Name: "B (2)"})
	if err != nil || len(back) != 2 {
		t.Fatalf("restore %d %v", len(back), err)
	}
	if it, err := q.GetDiskItem(ctx, c.ID); err != nil || it.TrashedAt != nil {
		t.Fatalf("c.txt after restore %+v %v", it, err)
	}

	// Overrides of a deleted role go with it; the bits are checked by the table.
	role := uuid.New().String()
	if err := q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: a.ID, TargetType: "role", TargetID: role, Allow: int64(perm.DiskView)}); err != nil {
		t.Fatal(err)
	}
	if err := q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: a.ID, TargetType: "user", TargetID: role, Allow: int64(perm.BillingView)}); err == nil {
		t.Fatal("billing bits must not be stored in disk overrides")
	}
	if _, err := q.DeleteRoleOverrides(ctx, role); err != nil {
		t.Fatal(err)
	}
	if ps, err := q.ListDiskPermissions(ctx, a.ID); err != nil || len(ps) != 0 {
		t.Fatalf("overrides after the role was deleted: %+v %v", ps, err)
	}

	// A storage add-on counts.
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspace_storage_addons (workspace_id, size_mb, sku) VALUES ($1, 10240, 'storage.10gb.day')`, ws); err != nil {
		t.Fatal(err)
	}
	if mb, err := q.SumActiveStorageAddonsMB(ctx, ws); err != nil || mb != 10240 {
		t.Fatalf("add-ons %d %v", mb, err)
	}

	// Delete forever: the files of the subtree first (quota by the caller), then the folder.
	files, err := q.DeleteDiskSubtreeFiles(ctx, a.ID)
	if err != nil || len(files) != 1 || files[0].ID != f1.ID {
		t.Fatalf("subtree files %+v %v", files, err)
	}
	if n, err := q.DeleteDiskItem(ctx, a.ID); err != nil || n != 1 {
		t.Fatalf("delete %d %v", n, err)
	}
	if _, err := q.GetDiskItem(ctx, c.ID); !db.IsNotFound(err) {
		t.Fatalf("c.txt must be gone: %v", err)
	}
}

func ptr[T any](v T) *T { return &v }
