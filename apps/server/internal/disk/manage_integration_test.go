//go:build integration

package disk

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// «Управление» (CBF-161, ADR-0161): a person in a folder's list with DISK_MANAGE in their
// override opens and changes «Доступ…» of the folder and its subtree and handles everyone's
// items inside; «Правка» does not; the owner's row stays; roles and guests never get it; a
// restricted folder stays hidden from the admin and the workspace owner.
func TestDiskManageLevel(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	carol := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Carol')`, carol, "carol-"+carol.String()[:8]+"@disk.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: carol, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	const (
		vw  = uint64(perm.DiskView | perm.DiskWrite)
		vwm = uint64(perm.Disk)
	)
	usr := func(id uuid.UUID, allow, deny uint64) *v1.DiskPermissionEntry {
		return &v1.DiskPermissionEntry{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: id.String(), Allow: allow, Deny: deny}
	}
	put := func(want int, as uuid.UUID, id string, restricted *bool, entries ...*v1.DiskPermissionEntry) {
		t.Helper()
		e.must(want, as, "PUT", item(id)+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: restricted, Entries: entries}, nil)
	}

	legal := e.folder(e.alice, "", "Legal")
	put(200, e.alice, legal.GetId(), proto.Bool(true), usr(e.bob, vwm, 0), usr(carol, vw, 0), usr(e.guest, vw, 0))
	archive := e.folder(e.alice, legal.GetId(), "Archive")
	mine := e.upload(e.alice, legal.GetId(), "alice.txt", 3)
	theirs := e.upload(carol, legal.GetId(), "carol.txt", 4)

	// The manager's bits on the folder, inherited by its subtree.
	var got v1.DiskItemResponse
	for _, id := range []string{legal.GetId(), archive.GetId(), mine.GetId()} {
		e.must(200, e.bob, "GET", item(id), nil, &got)
		if perm.Bits(got.GetItem().GetMyBits()) != perm.Disk {
			t.Fatalf("bob's bits on %s: %b", got.GetItem().GetName(), got.GetItem().GetMyBits())
		}
	}
	// The folder's owner is at least its manager (ADR-0161): someone else's file inside and its
	// access are hers too — all but the file owner's own row; the file's owner keeps all three
	// on it.
	e.must(200, e.alice, "PATCH", item(theirs.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("carol v2.txt")}, nil)
	e.must(200, e.alice, "GET", item(theirs.GetId())+"/permissions", nil, nil)
	put(403, e.alice, theirs.GetId(), nil, usr(carol, 0, vwm))
	put(200, e.alice, theirs.GetId(), nil, usr(e.bob, uint64(perm.DiskView), uint64(perm.DiskWrite|perm.DiskManage)))
	e.must(200, e.bob, "GET", item(theirs.GetId()), nil, &got)
	if perm.Bits(got.GetItem().GetMyBits()) != perm.DiskView {
		t.Fatalf("bob's bits on carol's file after «Просмотр»: %b", got.GetItem().GetMyBits())
	}
	put(200, e.alice, theirs.GetId(), nil)
	e.must(200, carol, "GET", item(theirs.GetId()), nil, &got)
	if perm.Bits(got.GetItem().GetMyBits()) != perm.Disk {
		t.Fatalf("carol's bits on her own file: %b", got.GetItem().GetMyBits())
	}
	// «Правка» neither opens «Доступ…» nor touches someone else's file.
	e.must(403, carol, "GET", item(legal.GetId())+"/permissions", nil, nil)
	put(403, carol, legal.GetId(), nil, usr(carol, vwm, 0))
	e.must(403, carol, "PATCH", item(mine.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("x.txt")}, nil)
	e.must(403, carol, "POST", item(mine.GetId())+"/trash", nil, nil)
	// The admin and the workspace owner are not in the list: the folder stays hidden.
	for _, u := range []uuid.UUID{e.admin, e.owner} {
		e.must(404, u, "GET", item(legal.GetId()), nil, nil)
		e.must(404, u, "GET", item(legal.GetId())+"/permissions", nil, nil)
	}

	// The manager: never MANAGE to a role or a guest, never the owner's row.
	role := &v1.DiskPermissionEntry{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: memberRole(t, e).String(), Allow: vwm}
	put(http.StatusUnprocessableEntity, e.bob, legal.GetId(), nil, usr(e.bob, vwm, 0), role)
	put(http.StatusUnprocessableEntity, e.bob, legal.GetId(), nil, usr(e.bob, vwm, 0), usr(e.guest, vwm, 0))
	put(http.StatusUnprocessableEntity, e.bob, legal.GetId(), nil, usr(e.bob, uint64(perm.DiskManage), 0))
	put(403, e.bob, legal.GetId(), nil, usr(e.bob, vwm, 0), usr(e.alice, 0, vwm))
	// …but changes the list: adds the admin, carol to «Просмотр», removes the guest.
	e.must(200, e.bob, "GET", item(legal.GetId())+"/permissions", nil, nil)
	put(200, e.bob, legal.GetId(), proto.Bool(true), usr(e.bob, vwm, 0), usr(carol, uint64(perm.DiskView), uint64(perm.DiskWrite|perm.DiskManage)), usr(e.admin, vw, 0))
	e.must(200, e.admin, "GET", item(legal.GetId()), nil, nil)
	e.must(404, e.guest, "GET", item(legal.GetId()), nil, nil)
	e.must(404, e.owner, "GET", item(legal.GetId()), nil, nil)
	var act v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(legal.GetId())+"/activity", nil, &act)
	if a := act.GetActivities(); len(a) == 0 || a[0].GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_SHARE || a[0].GetActorId() != e.bob.String() {
		t.Fatalf("the folder's history: %v", a)
	}
	// Someone else's items inside: move, rename, trash, restore, the public link, a subfolder's access.
	e.must(200, e.bob, "PATCH", item(theirs.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String(archive.GetId())}, nil)
	e.must(200, e.bob, "PATCH", item(mine.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("contract.txt")}, nil)
	e.must(200, e.bob, "POST", item(mine.GetId())+"/trash", nil, nil)
	e.must(200, e.bob, "POST", item(mine.GetId())+"/restore", nil, nil)
	e.must(201, e.bob, "POST", item(theirs.GetId())+"/link", &v1.CreateDiskLinkRequest{}, nil)
	e.must(204, e.bob, "DELETE", item(theirs.GetId())+"/link", nil, nil)
	put(200, e.bob, archive.GetId(), nil, usr(carol, vw, 0))
	e.must(200, e.bob, "POST", item(theirs.GetId())+"/trash", nil, nil)

	// A plain folder works the same; «Просмотр» below the managed folder takes it back.
	open := e.folder(e.alice, "", "Open")
	put(200, e.alice, open.GetId(), nil, usr(e.bob, vwm, 0))
	inner := e.folder(e.alice, open.GetId(), "Inner")
	put(200, e.alice, inner.GetId(), nil, usr(e.bob, uint64(perm.DiskView), uint64(perm.DiskWrite|perm.DiskManage)))
	cf := e.upload(carol, open.GetId(), "c.txt", 1)
	e.must(200, e.bob, "PATCH", item(cf.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("c2.txt")}, nil)
	e.must(403, e.bob, "GET", item(inner.GetId())+"/permissions", nil, nil)
	e.must(200, e.bob, "GET", item(inner.GetId()), nil, &got)
	if perm.Bits(got.GetItem().GetMyBits()) != perm.DiskView {
		t.Fatalf("bob's bits below «Просмотр»: %b", got.GetItem().GetMyBits())
	}
}

// memberRole is the workspace's built-in member role.
func memberRole(t *testing.T, e *env) uuid.UUID {
	t.Helper()
	rs, err := e.d.Q.ListWorkspaceRoles(context.Background(), e.ws)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rs {
		if r.Builtin != nil && *r.Builtin == string(perm.RoleMember) {
			return r.ID
		}
	}
	t.Fatal("no member role")
	return uuid.Nil
}
