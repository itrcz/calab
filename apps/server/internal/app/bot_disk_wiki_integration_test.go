//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// diskUpload posts one file to the Disk as the token's owner (multipart "file").
func diskUpload(t *testing.T, token, wsID, parent, name string, data []byte) (int, *v1.DiskItem) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	path := "/api/workspaces/" + wsID + "/disk/upload"
	if parent != "" {
		path += "?parent=" + parent
	}
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		t.Logf("disk upload %s -> %d %s", name, resp.StatusCode, raw)
		return resp.StatusCode, nil
	}
	var r v1.DiskItemResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, r.GetItem()
}

// Bots use the Disk like people (ADR-0094 §2, addendum 2026-10-14): the member role's
// DISK_VIEW | DISK_WRITE, their own items' structure, sharing and the public link, the trash.
func TestBotDisk(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBot(t, o, wid, "disky")

	var folder v1.DiskItemResponse
	b.must(201, "POST", "/api/workspaces/"+wid+"/disk/folders", &v1.CreateDiskFolderRequest{Name: "Reports"}, &folder)
	fid := folder.GetItem().GetId()
	if folder.GetItem().GetOwnerId() != b.id || folder.GetItem().GetMyBits()&uint64(perm.DiskWrite) == 0 {
		t.Fatalf("folder: %v", folder.GetItem())
	}
	code, file := diskUpload(t, b.token, wid, fid, "report.txt", []byte("quarterly numbers"))
	if code != 201 || file.GetParentId() != fid || file.GetOwnerId() != b.id {
		t.Fatalf("upload: %d %v", code, file)
	}
	var list v1.ListDiskItemsResponse
	b.must(200, "GET", "/api/workspaces/"+wid+"/disk/items?parent="+fid, nil, &list)
	if len(list.GetItems()) != 1 || list.GetItems()[0].GetName() != "report.txt" {
		t.Fatalf("list: %v", list.GetItems())
	}
	// The bot restricts its folder to itself and shares it with bob only.
	on := true
	b.must(200, "PUT", "/api/disk/items/"+fid+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: &on, Entries: []*v1.DiskPermissionEntry{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.DiskView)},
	}}, nil)
	var got v1.DiskItemResponse
	bob.must(200, "GET", "/api/disk/items/"+file.GetId(), nil, &got)
	if got.GetItem().GetMyBits()&uint64(perm.DiskWrite) != 0 {
		t.Fatalf("bob writes a view-only share: %v", got.GetItem())
	}
	var link v1.DiskLinkResponse
	if c := b.do("POST", "/api/disk/items/"+file.GetId()+"/link", &v1.CreateDiskLinkRequest{}, &link); c >= 300 || link.GetLink().GetCode() == "" {
		t.Fatalf("link: %d %v", c, &link)
	}
	b.must(204, "DELETE", "/api/disk/items/"+file.GetId()+"/link", nil, nil)
	name := "Q3.txt"
	b.must(200, "PATCH", "/api/disk/items/"+file.GetId(), &v1.UpdateDiskItemRequest{Name: &name}, nil)
	b.must(200, "POST", "/api/disk/items/"+fid+"/trash", nil, nil)
	bob.must(200, "GET", "/api/disk/items/"+file.GetId(), nil, &got)
	if got.GetItem().GetTrashedAt() == nil {
		t.Fatalf("not in the trash: %v", got.GetItem())
	}
	b.must(200, "POST", "/api/disk/items/"+fid+"/restore", nil, nil)
	b.must(200, "GET", "/api/disk/items/"+fid+"/activity", nil, nil)

	// A bot without access: o's restricted folder is invisible to it, like to any member.
	var secret v1.DiskItemResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/disk/folders", &v1.CreateDiskFolderRequest{Name: "Secret"}, &secret)
	o.must(200, "PUT", "/api/disk/items/"+secret.GetItem().GetId()+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: &on}, nil)
	b.must(404, "GET", "/api/disk/items/"+secret.GetItem().GetId(), nil, nil)
	// The trash retention needs DISK_MANAGE, which the member role does not give.
	if c := b.do("PUT", "/api/workspaces/"+wid+"/disk/settings", &v1.DiskSettings{TrashDays: 7}, nil); c != 403 {
		t.Fatalf("disk settings as a member bot: %d", c)
	}
}

// syncFrame is a client → server frame of the wiki sync socket (internal/wiki/sync.go).
func syncFrame(t byte, body []byte) []byte {
	out := make([]byte, 9+len(body))
	out[0] = t
	copy(out[9:], body)
	return out
}

// Bots use the Wiki like people (ADR-0096 §2, addendum 2026-10-14): pages over REST and the
// sync socket with a bot token as the first frame, writing with WIKI_WRITE.
func TestBotWiki(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBot(t, o, wid, "wikibot")

	var pg v1.WikiPageResponse
	b.must(201, "POST", "/api/workspaces/"+wid+"/wiki/pages", &v1.CreateWikiPageRequest{Title: "Bot notes"}, &pg)
	pid := pg.GetPage().GetId()
	var list v1.ListWikiPagesResponse
	b.must(200, "GET", "/api/workspaces/"+wid+"/wiki/pages", nil, &list)
	if len(list.GetPages()) != 1 || list.GetPages()[0].GetId() != pid {
		t.Fatalf("list: %v", list.GetPages())
	}
	var child v1.WikiPageResponse
	b.must(201, "POST", "/api/workspaces/"+wid+"/wiki/pages", &v1.CreateWikiPageRequest{ParentId: pid, Title: "Child"}, &child)
	b.must(200, "GET", "/api/wiki/pages/"+pid+"/versions", nil, nil)
	b.must(200, "GET", "/api/wiki/pages/"+pid+"/permissions", nil, nil)
	b.must(200, "POST", "/api/wiki/pages/"+child.GetPage().GetId()+"/trash", nil, nil)
	b.must(200, "POST", "/api/wiki/pages/"+child.GetPage().GetId()+"/restore", nil, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/wiki/pages/" + pid + "/sync"
	conn, resp, err := websocket.Dial(ctx, url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	if err := conn.Write(ctx, websocket.MessageText, []byte(b.token)); err != nil {
		t.Fatal(err)
	}
	_, f, err := conn.Read(ctx)
	if err != nil || f[0] != 0 {
		t.Fatalf("snapshot: %x %v", f, err)
	}
	// WRITE: an update is stored and relayed back with seq 1.
	if err := conn.Write(ctx, websocket.MessageBinary, syncFrame(1, []byte("bot-update"))); err != nil {
		t.Fatal(err)
	}
	_, f, err = conn.Read(ctx)
	if err != nil || f[0] != 1 || binary.BigEndian.Uint64(f[1:9]) != 1 || string(f[9:]) != "bot-update" {
		t.Fatalf("update: %x %v", f, err)
	}

	// A page the bot cannot see: the socket closes with 4003 / 4004, as for a member.
	var secret v1.WikiPageResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/wiki/pages", &v1.CreateWikiPageRequest{Title: "Secret"}, &secret)
	on := true
	o.must(200, "PUT", "/api/wiki/pages/"+secret.GetPage().GetId()+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: &on}, nil)
	b.must(404, "GET", "/api/wiki/pages/"+secret.GetPage().GetId(), nil, nil)
	c2, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/wiki/pages/"+secret.GetPage().GetId()+"/sync", nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c2.CloseNow() }()
	_ = c2.Write(ctx, websocket.MessageText, []byte(b.token))
	if _, _, err := c2.Read(ctx); websocket.CloseStatus(err) != 4003 && websocket.CloseStatus(err) != 4004 {
		t.Fatalf("restricted page: %v", err)
	}
}
