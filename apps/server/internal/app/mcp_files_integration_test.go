//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// mcpBotBlocks calls a tool as the bot and returns every content block and isError.
func mcpBotBlocks(t *testing.T, b *bot, name string, args map[string]any) ([]map[string]any, bool) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:"+b.id)).Build()).Error()
	a, _ := json.Marshal(args)
	st, out := mcpPost(t, b.token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+name+`","arguments":`+string(a)+`}}`)
	res, ok := out["result"].(map[string]any)
	if st != 200 || !ok {
		t.Fatalf("%s: %d %v", name, st, out)
	}
	var bs []map[string]any
	for _, x := range res["content"].([]any) {
		bs = append(bs, x.(map[string]any))
	}
	isErr, _ := res["isError"].(bool)
	return bs, isErr
}

// local turns a signed URL of the configured origin into one of the test server.
func local(u string) string { return srv.URL + strings.TrimPrefix(u, "https://app.example.com") }

type fetched struct {
	status int
	header http.Header
	body   []byte
}

func fetchURL(t *testing.T, method, u string, body io.Reader, hdr http.Header) fetched {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), method, local(u), body)
	for k, v := range hdr {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return fetched{resp.StatusCode, resp.Header, b}
}

// curlUpload is `curl -F file=@name` to an upload URL.
func curlUpload(t *testing.T, u, name string, data []byte) fetched {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	return fetchURL(t, http.MethodPost, u, &body, http.Header{"Content-Type": {mw.FormDataContentType()}})
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func metaJSON(t *testing.T, bs []map[string]any) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(stringOf(bs, 0, "text")), &m); err != nil {
		t.Fatalf("meta: %v %v", err, bs)
	}
	return m
}

// TestMCPFileLinks (CBF-185/186/187): attachments go to the agent and back through signed URLs
// fetched with curl, as the tool's caller, rechecked at request time.
func TestMCPFileLinks(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	// The test server's MAX_FILE_SIZE_MB is 1: this workspace takes files up to 8 MB (ADR-0155).
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET max_file_mb = 8 WHERE id = $1", wid); err != nil {
		t.Fatal(err)
	}
	bt := createBot(t, o, wid, "filebot")
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Files", Key: "MFL", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	bpath := "/api/boards/" + board.GetId() + "/files"

	// Files of each class; the xlsx is exactly at the limit.
	xlsx := append([]byte("PK\x03\x04"), bytes.Repeat([]byte{'x'}, 3<<20-4)...)
	docx := append([]byte("PK\x03\x04"), []byte("word/document.xml")...)
	ogg := append([]byte("OggS\x00\x02"), bytes.Repeat([]byte{1}, 200)...)
	big := append([]byte("PK\x03\x04"), bytes.Repeat([]byte{'y'}, 3<<20-3)...)
	files := map[string]*v1.FileMeta{}
	for name, data := range map[string][]byte{"report.xlsx": xlsx, "spec.docx": docx, "data.csv": []byte("a,b\n1,2\n"), "shot.png": pngBytes(8, 8),
		"big.xlsx": big, "demo.mp4": append([]byte("\x00\x00\x00\x18ftypmp42"), make([]byte, 64)...)} {
		st, f, _ := upload(t, o, bpath, name, data)
		if st != 201 {
			t.Fatalf("upload %s: %d", name, st)
		}
		files[name] = f
	}
	var tr v1.TaskResponse
	o.must(201, "POST", "/api/boards/"+board.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "files", AttachmentIds: []string{
		files["report.xlsx"].GetId(), files["spec.docx"].GetId(), files["data.csv"].GetId(), files["shot.png"].GetId(), files["big.xlsx"].GetId(), files["demo.mp4"].GetId()}}, &tr)
	task := tr.GetTask()
	_, voice, _ := upload(t, o, bpath, "voice.ogg", ogg)
	var cm v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "голос", AttachmentIds: []string{voice.GetId()}, Nonce: uniq("n-")}, &cm)

	// Download: metadata + URL; the bytes by curl equal the stored SHA-256; again within the TTL.
	bs, isErr := mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": "report.xlsx"})
	m := metaJSON(t, bs)
	if isErr || m["mime"] != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || m["size"] != float64(3<<20) ||
		m["sha256"] != sum(xlsx) || m["expires_in"] != float64(600) || !strings.Contains(stringOf(bs, 1, "text"), "curl -fsSL -o \"report.xlsx\"") {
		t.Fatalf("xlsx: %v %v", isErr, bs)
	}
	xURL := m["download_url"].(string)
	for range 2 {
		r := fetchURL(t, "GET", xURL, nil, nil)
		if r.status != 200 || sum(r.body) != m["sha256"] || r.header.Get("Cache-Control") != "no-store" || r.header.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.HasPrefix(r.header.Get("Content-Disposition"), "attachment") || !strings.Contains(r.header.Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("download: %d %v", r.status, r.header)
		}
	}
	if r := fetchURL(t, "GET", xURL, nil, http.Header{"Range": {"bytes=0-3"}}); r.status != 206 || string(r.body) != "PK\x03\x04" {
		t.Fatalf("range: %d", r.status)
	}
	// docx, csv (inline too), png (inline image), a comment's ogg: each with its URL.
	for _, c := range []struct{ file, comment, mime string }{
		{"spec.docx", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"data.csv", "", "text/csv"},
		{"shot.png", "", "image/png"},
		{voice.GetId(), cm.GetMessage().GetId(), "audio/ogg"},
	} {
		bs, isErr = mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": c.file, "comment": c.comment})
		m := metaJSON(t, bs)
		if isErr || m["mime"] != c.mime || m["download_url"] == nil {
			t.Fatalf("%s: %v %v", c.file, isErr, bs)
		}
		if r := fetchURL(t, "GET", m["download_url"].(string), nil, nil); r.status != 200 || sum(r.body) != m["sha256"] {
			t.Fatalf("%s download: %d", c.file, r.status)
		}
	}
	// Over the limit, an unsupported type.
	if bs, isErr = mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": "big.xlsx"}); !isErr ||
		!strings.Contains(stringOf(bs, 0, "text"), `"error":"file_too_large"`) || !strings.Contains(stringOf(bs, 0, "text"), `"size":3145729`) {
		t.Fatalf("too large: %v", bs)
	}
	if bs, isErr = mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": "demo.mp4"}); !isErr ||
		!strings.Contains(stringOf(bs, 0, "text"), `"error":"unsupported_file_type"`) {
		t.Fatalf("unsupported: %v", bs)
	}
	// A tampered URL; no URL works for another file than it names.
	if r := fetchURL(t, "GET", xURL[:len(xURL)-2]+"xx", nil, nil); r.status != 404 {
		t.Fatalf("tampered: %d", r.status)
	}
	// Access lost: the comment is deleted, its file's URL answers 404 (files.CanRead at request time).
	bs, _ = mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": voice.GetId(), "comment": cm.GetMessage().GetId()})
	vURL := metaJSON(t, bs)["download_url"].(string)
	o.must(204, "DELETE", "/api/messages/"+cm.GetMessage().GetId(), nil, nil)
	if r := fetchURL(t, "GET", vURL, nil, nil); r.status != 404 {
		t.Fatalf("deleted comment's file: %d", r.status)
	}

	// Upload: one file at exactly 3 MiB, the answer's id attached to a comment.
	text, isErr := mcpTool(t, bt, "upload_attachment", map[string]any{"task": task.GetKey()})
	var up map[string]any
	_ = json.Unmarshal([]byte(text), &up)
	if isErr || !strings.Contains(up["curl"].(string), "curl -fsS -F file=@") {
		t.Fatalf("upload_attachment: %s", text)
	}
	uURL := up["upload_url"].(string)
	payload := append([]byte("PK\x03\x04"), bytes.Repeat([]byte{'z'}, 3<<20-4)...)
	r := curlUpload(t, uURL, "out.xlsx", payload)
	var got map[string]any
	_ = json.Unmarshal(r.body, &got)
	if r.status != 201 || got["size"] != float64(3<<20) || got["sha256"] != sum(payload) || got["name"] != "out.xlsx" ||
		got["mime"] != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Fatalf("upload: %d %s", r.status, r.body)
	}
	// Single use.
	if r := curlUpload(t, uURL, "again.txt", []byte("x")); r.status != http.StatusGone {
		t.Fatalf("reuse: %d %s", r.status, r.body)
	}
	// A download token is no upload token, and an upload token no download token.
	if r := curlUpload(t, strings.Replace(xURL, "/api/mcp/file/", "/api/mcp/upload/", 1), "x.txt", []byte("x")); r.status != 404 {
		t.Fatalf("download token on the upload route: %d %s", r.status, r.body)
	}
	// Two requests at once with one URL: one upload, one 410.
	text, _ = mcpTool(t, bt, "upload_attachment", map[string]any{"task": task.GetKey()})
	_ = json.Unmarshal([]byte(text), &up)
	if r := fetchURL(t, "GET", strings.Replace(up["upload_url"].(string), "/api/mcp/upload/", "/api/mcp/file/", 1), nil, nil); r.status != 404 {
		t.Fatalf("upload token on the download route: %d", r.status)
	}
	codes := make(chan int, 4)
	for range cap(codes) {
		go func() { codes <- curlUpload(t, up["upload_url"].(string), "race.txt", []byte("race")).status }()
	}
	created, gone := 0, 0
	for range cap(codes) {
		switch <-codes {
		case http.StatusCreated:
			created++
		case http.StatusGone:
			gone++
		}
	}
	if created != 1 || gone != cap(codes)-1 {
		t.Fatalf("concurrent uploads with one URL: %d created, %d gone", created, gone)
	}
	// Over the limit: file_too_large with the size and the limit.
	text, _ = mcpTool(t, bt, "upload_attachment", map[string]any{"task": task.GetKey()})
	_ = json.Unmarshal([]byte(text), &up)
	r = curlUpload(t, up["upload_url"].(string), "big.bin", bytes.Repeat([]byte{'q'}, 3<<20+1))
	var ae v1.ApiError
	_ = protojson.Unmarshal(r.body, &ae)
	if r.status != 413 || ae.GetReason() != "file_too_large" || ae.GetUsed() != 3<<20+1 || ae.GetLimit() != 3<<20 {
		t.Fatalf("too large upload: %d %s", r.status, r.body)
	}

	comments := func() int {
		var ms v1.ListMessagesResponse
		o.must(200, "GET", "/api/rooms/"+task.GetRoomId()+"/messages", nil, &ms)
		return len(ms.GetMessages())
	}
	before := comments()
	// Someone else's upload and an unknown id: nothing is posted.
	_, foreign, _ := upload(t, o, bpath, "owner.txt", []byte("mine"))
	for _, ids := range [][]string{{got["file"].(string), foreign.GetId()}, {got["file"].(string), "00000000-0000-0000-0000-000000000000"}} {
		if text, isErr = mcpTool(t, bt, "comment_task", map[string]any{"task": task.GetKey(), "text": "отчёт", "files": ids}); !isErr || !strings.Contains(text, "not an unattached upload of yours") {
			t.Fatalf("bad files %v: %s", ids, text)
		}
	}
	if n := comments(); n != before {
		t.Fatalf("a comment was posted: %d -> %d", before, n)
	}
	if text, isErr = mcpTool(t, bt, "comment_task", map[string]any{"task": task.GetKey(), "text": "отчёт", "files": []string{got["file"].(string)}}); isErr || !strings.Contains(text, got["file"].(string)) {
		t.Fatalf("comment with file: %s", text)
	}
	if text, _ = mcpTool(t, bt, "read", map[string]any{"task": task.GetKey(), "comments": 3}); !strings.Contains(text, `"name":"out.xlsx"`) {
		t.Fatalf("read back: %s", text)
	}

	// A room message: upload bound to the room, then send_message with files.
	room := textRoom(t, o, wid, "files-room", false)
	text, _ = mcpTool(t, bt, "upload_attachment", map[string]any{"room": room})
	_ = json.Unmarshal([]byte(text), &up)
	r = curlUpload(t, up["upload_url"].(string), "notes.md", []byte("# hi"))
	_ = json.Unmarshal(r.body, &got)
	if r.status != 201 {
		t.Fatalf("room upload: %d %s", r.status, r.body)
	}
	if text, isErr = mcpTool(t, bt, "send_message", map[string]any{"room": room, "files": []string{got["file"].(string)}}); isErr || !strings.Contains(text, "notes.md") {
		t.Fatalf("send_message with file: %s", text)
	}

	// No right to post here: the room denies the bot SEND_MESSAGES and ATTACH_FILES (403), nothing is posted.
	quiet := textRoom(t, o, wid, "no-files", false)
	o.must(200, "PUT", "/api/rooms/"+quiet+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bt.id, Deny: uint64(perm.AttachFiles | perm.SendMessages)},
	}}, nil)
	text, _ = mcpTool(t, bt, "upload_attachment", map[string]any{"room": room})
	_ = json.Unmarshal([]byte(text), &up)
	r = curlUpload(t, up["upload_url"].(string), "x.txt", []byte("x"))
	_ = json.Unmarshal(r.body, &got)
	if text, isErr = mcpTool(t, bt, "send_message", map[string]any{"room": quiet, "files": []string{got["file"].(string)}}); !isErr || !strings.Contains(text, "403") {
		t.Fatalf("no ATTACH_FILES: %s", text)
	}

	// The caller's token is replaced: its URLs stop working (401), whatever their expiry.
	bs, _ = mcpBotBlocks(t, bt, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": "data.csv"})
	cURL := metaJSON(t, bs)["download_url"].(string)
	text, _ = mcpTool(t, bt, "upload_attachment", map[string]any{"task": task.GetKey()})
	_ = json.Unmarshal([]byte(text), &up)
	var re v1.ReissueBotTokenResponse
	o.must(200, "POST", "/api/workspaces/"+wid+"/bots/"+bt.id+"/token", nil, &re)
	if r := fetchURL(t, "GET", cURL, nil, nil); r.status != 401 {
		t.Fatalf("download after token change: %d", r.status)
	}
	if r := curlUpload(t, up["upload_url"].(string), "x.txt", []byte("x")); r.status != 401 {
		t.Fatalf("upload after token change: %d", r.status)
	}
}
