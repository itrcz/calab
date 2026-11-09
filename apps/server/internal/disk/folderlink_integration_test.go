//go:build integration

package disk

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// pub makes an anonymous request of a public link route and decodes a 200 into out.
func (e *env) pub(want int, path string, out proto.Message) http.Header {
	e.t.Helper()
	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+path, nil, nil)
	if w.Code != want {
		e.t.Fatalf("GET %s: %d, want %d: %s", path, w.Code, want, w.Body.String())
	}
	if want == http.StatusOK && out != nil {
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatalf("GET %s: %v", path, err)
		}
	}
	return w.Header()
}

func entryNames(f *v1.PublicDiskFolder) []string {
	var out []string
	for _, it := range f.GetItems() {
		out = append(out, it.GetName())
	}
	return out
}

// TestDiskFolderLinkRights: a folder link is turned on and off by the folder's owner, a person
// with «Управление» on it or DISK_MANAGE — not «Правка» —, and both are in the folder's history
// with the actor (ADR-0165).
func TestDiskFolderLinkRights(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	carol := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Carol')`, carol, "carol-"+carol.String()[:8]+"@disk.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: carol, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	usr := func(id uuid.UUID, allow uint64) *v1.DiskPermissionEntry {
		return &v1.DiskPermissionEntry{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: id.String(), Allow: allow}
	}
	f := e.folder(e.alice, "", "Shared")
	e.must(200, e.alice, "PUT", item(f.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{
		usr(e.bob, uint64(perm.Disk)), usr(carol, uint64(perm.DiskView|perm.DiskWrite)),
	}}, nil)

	// «Правка» only: 403 both ways.
	e.must(403, carol, "POST", item(f.GetId())+"/link", &v1.CreateDiskLinkRequest{}, nil)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(f.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	if len(link.GetLink().GetCode()) != CodeLength || !strings.HasSuffix(link.GetUrl(), "/d/"+link.GetLink().GetCode()) {
		t.Fatalf("folder link %v", &link)
	}
	e.must(403, carol, "DELETE", item(f.GetId())+"/link", nil, nil)
	// «Управление» revokes and re-enables it; DISK_MANAGE (the admin) revokes someone else's.
	e.must(204, e.bob, "DELETE", item(f.GetId())+"/link", nil, nil)
	e.must(201, e.bob, "POST", item(f.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	var seen v1.DiskItemResponse
	e.must(200, e.admin, "GET", item(f.GetId()), nil, &seen)
	if seen.GetItem().GetLink().GetCode() != link.GetLink().GetCode() {
		t.Fatalf("DISK_MANAGE does not see the folder link: %v", seen.GetItem().GetLink())
	}
	e.must(204, e.admin, "DELETE", item(f.GetId())+"/link", nil, nil)
	e.pub(404, link.GetLink().GetCode(), nil)

	// History: link_on / link_off with the actor, newest first.
	var page v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(f.GetId())+"/activity", nil, &page)
	type entry struct {
		kind  v1.DiskActivityKind
		actor string
	}
	var got []entry
	for _, a := range page.GetActivities() {
		if k := a.GetKind(); k == v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_ON || k == v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_OFF {
			got = append(got, entry{k, a.GetActorId()})
		}
	}
	want := []entry{
		{v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_OFF, e.admin.String()},
		{v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_ON, e.bob.String()},
		{v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_OFF, e.bob.String()},
		{v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_ON, e.alice.String()},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("history %v, want %v", got, want)
	}
}

// TestDiskFolderLinkBrowse: listing, navigation, the hidden parts of the subtree, ids outside it,
// the trash, files added later, expiry and the file routes of a folder link.
func TestDiskFolderLinkBrowse(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	outside := e.folder(e.alice, "", "Outside")
	secretOut := e.upload(e.alice, outside.GetId(), "out.txt", 7)
	root := e.folder(e.alice, "", "Project")
	docs := e.folder(e.alice, root.GetId(), "Docs")
	spec := e.upload(e.alice, docs.GetId(), "spec.md", 12)
	readme := e.upload(e.alice, root.GetId(), "readme.txt", 30)
	// «Только выбранные» lower in the tree, a subfolder under it, a file inside.
	private := e.folder(e.alice, root.GetId(), "Private")
	e.must(200, e.alice, "PUT", item(private.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	deep := e.folder(e.alice, private.GetId(), "Deep")
	hiddenFile := e.upload(e.alice, deep.GetId(), "salary.txt", 9)
	// A role denied DISK_VIEW on a subfolder (not restricted).
	role := memberRole(t, e)
	denied := e.folder(e.alice, root.GetId(), "NoView")
	e.must(200, e.alice, "PUT", item(denied.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: role.String(), Deny: uint64(perm.DiskView | perm.DiskWrite)},
	}}, nil)
	deniedFile := e.upload(e.alice, denied.GetId(), "x.txt", 4)
	trashed := e.upload(e.alice, root.GetId(), "old.txt", 5)
	e.must(200, e.alice, "POST", item(trashed.GetId())+"/trash", nil, nil)

	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(root.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code := link.GetLink().GetCode()

	var meta v1.PublicDiskFile
	r := e.pub(200, code, &meta)
	if meta.GetKind() != v1.DiskItemKind_DISK_ITEM_KIND_FOLDER || meta.GetName() != "Project" || !strings.Contains(r.Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("folder meta %v", &meta)
	}
	// The file routes of a file link do not serve a folder link.
	e.pub(404, code+"/content", nil)
	e.pub(404, code+"/thumbnail", nil)

	var top v1.PublicDiskFolder
	r = e.pub(200, code+"/items", &top)
	if got := entryNames(&top); !slices.Equal(got, []string{"Docs", "readme.txt"}) {
		t.Fatalf("root listing %v", got)
	}
	if len(top.GetPath()) != 1 || top.GetPath()[0].GetId() != root.GetId() || r.Get("Cache-Control") != "no-store" {
		t.Fatalf("root path %v", top.GetPath())
	}
	if f := top.GetItems()[1]; f.GetSize() != 30 || f.GetKind() != v1.DiskItemKind_DISK_ITEM_KIND_FILE {
		t.Fatalf("file entry %v", f)
	}
	var sub v1.PublicDiskFolder
	e.pub(200, code+"/items?parent="+docs.GetId(), &sub)
	if got := entryNames(&sub); !slices.Equal(got, []string{"spec.md"}) || len(sub.GetPath()) != 2 || sub.GetPath()[1].GetName() != "Docs" {
		t.Fatalf("Docs listing %v path %v", got, sub.GetPath())
	}
	// Bytes of a file inside, counted; Range.
	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/items/"+spec.GetId()+"/content", nil, nil)
	if w.Code != 200 || w.Body.Len() != 12 {
		t.Fatalf("content %d %d", w.Code, w.Body.Len())
	}
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/items/"+readme.GetId()+"/content", nil, map[string]string{"Range": "bytes=5-9"}); w.Code != http.StatusPartialContent || w.Body.Len() != 5 {
		t.Fatalf("range %d %d", w.Code, w.Body.Len())
	}
	if l, err := e.d.Q.GetDiskLinkByItem(ctx, uuid.MustParse(root.GetId())); err != nil || l.Downloads != 1 {
		t.Fatalf("downloads %d %v", l.Downloads, err)
	}

	// Hidden: restricted, below restricted, denied, trashed, outside, the folder itself as a file,
	// junk ids — listings and contents alike.
	for _, p := range []string{
		"/items?parent=" + private.GetId(),
		"/items?parent=" + deep.GetId(),
		"/items?parent=" + denied.GetId(),
		"/items?parent=" + outside.GetId(),
		"/items?parent=" + readme.GetId(),
		"/items?parent=" + uuid.NewString(),
		"/items?parent=junk",
		"/items/" + hiddenFile.GetId() + "/content",
		"/items/" + deniedFile.GetId() + "/content",
		"/items/" + trashed.GetId() + "/content",
		"/items/" + secretOut.GetId() + "/content",
		"/items/" + secretOut.GetId() + "/thumbnail",
		"/items/" + docs.GetId() + "/content",
		"/items/junk/content",
		"/archive?parent=" + private.GetId(),
		"/archive?parent=" + outside.GetId(),
	} {
		e.pub(404, code+p, nil)
	}

	// Added later: listed at once; trashed: gone at once.
	later := e.upload(e.alice, root.GetId(), "later.txt", 3)
	e.pub(200, code+"/items", &top)
	if !slices.Contains(entryNames(&top), "later.txt") {
		t.Fatalf("a new file is not listed: %v", entryNames(&top))
	}
	e.must(200, e.alice, "POST", item(later.GetId())+"/trash", nil, nil)
	e.pub(200, code+"/items", &top)
	if slices.Contains(entryNames(&top), "later.txt") {
		t.Fatal("a trashed file is listed")
	}
	e.pub(404, code+"/items/"+later.GetId()+"/content", nil)
	// A subfolder moved out of the linked folder leaves the link.
	e.must(200, e.alice, "PATCH", item(docs.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String(outside.GetId())}, nil)
	e.pub(404, code+"/items?parent="+docs.GetId(), nil)
	e.pub(404, code+"/items/"+spec.GetId()+"/content", nil)
	e.must(200, e.alice, "PATCH", item(docs.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String(root.GetId())}, nil)

	// The linked folder in the trash: the link answers nothing until it is restored.
	e.must(200, e.alice, "POST", item(root.GetId())+"/trash", nil, nil)
	e.pub(404, code, nil)
	e.pub(404, code+"/items", nil)
	e.must(200, e.alice, "POST", item(root.GetId())+"/restore", nil, nil)
	e.pub(200, code+"/items", &top)

	// Expired: like a file link.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE disk_links SET expires_at = now() - interval '1 second' WHERE code = $1`, code); err != nil {
		t.Fatal(err)
	}
	e.pub(404, code, nil)
	e.pub(404, code+"/items", nil)
	e.pub(404, code+"/items/"+readme.GetId()+"/content", nil)
	e.pub(404, code+"/archive", nil)
}

// TestDiskFolderLinkArchive: «Скачать всё» streams the visible subtree as a zip, counts one
// download and refuses above the ceilings.
func TestDiskFolderLinkArchive(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	root := e.folder(e.alice, "", "Photos")
	e.upload(e.alice, root.GetId(), "a.txt", 10)
	trip := e.folder(e.alice, root.GetId(), "Trip")
	e.upload(e.alice, trip.GetId(), "b.txt", 20)
	e.folder(e.alice, trip.GetId(), "Empty")
	private := e.folder(e.alice, root.GetId(), "Private")
	e.upload(e.alice, private.GetId(), "secret.txt", 5)
	e.must(200, e.alice, "PUT", item(private.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	gone := e.upload(e.alice, root.GetId(), "gone.txt", 6)
	e.must(200, e.alice, "POST", item(gone.GetId())+"/trash", nil, nil)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(root.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code := link.GetLink().GetCode()

	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/archive", nil, nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/zip" || !strings.Contains(w.Header().Get("Content-Disposition"), "Photos.zip") {
		t.Fatalf("archive %d %v", w.Code, w.Header())
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	sizes := map[string]int{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		sizes[f.Name] = len(b)
	}
	want := map[string]int{"a.txt": 10, "Trip/": 0, "Trip/b.txt": 20, "Trip/Empty/": 0}
	if len(sizes) != len(want) {
		t.Fatalf("archive entries %v", sizes)
	}
	for k, v := range want {
		if sizes[k] != v {
			t.Fatalf("archive entries %v, want %v", sizes, want)
		}
	}
	// A subfolder only.
	w = e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/archive?parent="+trip.GetId(), nil, nil)
	if zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len())); w.Code != 200 || err != nil || len(zr.File) != 2 {
		t.Fatalf("sub-archive %d %v", w.Code, err)
	}
	if l, err := e.d.Q.GetDiskLinkByItem(ctx, uuid.MustParse(root.GetId())); err != nil || l.Downloads != 2 {
		t.Fatalf("downloads %d %v", l.Downloads, err)
	}
	// Ceilings: bytes and items.
	e.pub(http.StatusNoContent, code+"/archive?check=1", nil)
	e.svc.ArchiveMaxBytes = 29
	e.pub(http.StatusRequestEntityTooLarge, code+"/archive?check=1", nil)
	e.pub(http.StatusRequestEntityTooLarge, code+"/archive", nil)
	e.pub(200, code+"/archive?parent="+trip.GetId(), nil)
	e.svc.ArchiveMaxBytes, e.svc.ArchiveMaxItems = 0, 3
	e.pub(http.StatusRequestEntityTooLarge, code+"/archive", nil)
	e.svc.ArchiveMaxItems = 0
	// A file link has no archive.
	f := e.upload(e.alice, "", "single.txt", 3)
	e.must(201, e.alice, "POST", item(f.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	e.pub(404, link.GetLink().GetCode()+"/archive", nil)
	e.pub(404, link.GetLink().GetCode()+"/items", nil)
	var meta v1.PublicDiskFile
	e.pub(200, link.GetLink().GetCode(), &meta)
	if meta.GetKind() != v1.DiskItemKind_DISK_ITEM_KIND_FILE || meta.GetSize() != 3 || meta.GetId() != f.GetId() {
		t.Fatalf("file meta %v", &meta)
	}
}
