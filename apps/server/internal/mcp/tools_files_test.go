package mcp

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// filesAPI serves the task DEV-7 with a log and a screenshot, a comment with a big log, and the
// files' bytes; it records the requests.
type filesAPI struct {
	f      *taskFixture
	files  map[string][]byte
	ranges []string
	paths  []string
}

func (a *filesAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.paths = append(a.paths, r.Method+" "+r.URL.Path)
	var m proto.Message
	switch {
	case r.URL.Path == "/api/workspaces":
		m = &v1.ListWorkspacesResponse{Workspaces: []*v1.Workspace{{Id: a.f.ws}}}
	case r.URL.Path == "/api/t/DEV-7":
		t := proto.Clone(a.f.task).(*v1.Task)
		t.Attachments = []*v1.FileMeta{
			{Id: "f-log", Name: "build.log", Mime: "text/plain", Size: uint64(len(a.files["f-log"]))},
			{Id: "f-png", Name: "shot.png", Mime: "image/png", Size: uint64(len(a.files["f-png"]))},
			{Id: "f-zip", Name: "dump.zip", Mime: "application/zip", Size: 10, Sha256: "abc"},
			{Id: "f-big", Name: "photo.jpg", Mime: "image/jpeg", Size: MaxImageBytes},
			{Id: "f-huge-img", Name: "huge.png", Mime: "image/png", Size: MaxImageBytes + 1},
			{Id: "f-xlsx", Name: "report.xlsx", Mime: "application/zip", Size: MaxFileBytes},
			{Id: "f-docx", Name: "spec.docx", Mime: "application/octet-stream", Size: 100},
			{Id: "f-xl-big", Name: "big.xlsx", Mime: "application/zip", Size: MaxFileBytes + 1},
			{Id: "f-mp4", Name: "demo.mp4", Mime: "video/mp4", Size: 100},
			{Id: "f-bin", Name: "blob.txt", Mime: "text/plain", Size: 4},
			{Id: "f-svg", Name: "icon.svg", Mime: "image/svg+xml", Size: uint64(len(a.files["f-svg"]))},
			{Id: "f-heic", Name: "photo.heic", Mime: "image/heic", Size: 100},
			{Id: "f-tiff", Name: "scan.tiff", Mime: "image/tiff", Size: 100},
			{Id: "f-biglog", Name: "server.log", Mime: "text/plain", Size: uint64(len(a.files["f-biglog"]))},
		}
		m = &v1.TaskResponse{Task: t, Board: a.f.board}
	case r.URL.Path == "/api/rooms/room-7/messages":
		m = &v1.ListMessagesResponse{Messages: []*v1.Message{{Id: "m-1", RoomId: "room-7",
			Attachments: []*v1.FileMeta{{Id: "f-huge", Name: "trace.txt", Mime: "text/plain", Size: 1 << 20},
				{Id: "f-ogg", Name: "voice.ogg", Mime: "audio/ogg", Size: 900}}}}}
	case r.URL.Path == "/api/files/f-big/thumbnail", r.URL.Path == "/api/files/f-heic/thumbnail":
		w.Header().Set("Content-Type", "image/webp")
		_, _ = w.Write([]byte("WEBP"))
		return
	case strings.HasPrefix(r.URL.Path, "/api/files/") && !strings.HasSuffix(r.URL.Path, "/thumbnail"):
		id := strings.TrimPrefix(r.URL.Path, "/api/files/")
		a.ranges = append(a.ranges, r.Header.Get("Range"))
		b := a.files[id]
		if r.Header.Get("Range") != "" {
			b = b[:textInline]
		}
		_, _ = w.Write(b)
		return
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"not found"}`))
		return
	}
	b, _ := protojson.Marshal(m)
	_, _ = w.Write(b)
}

func blocks(t *testing.T, h http.Handler, args string) ([]map[string]any, bool) {
	t.Helper()
	st, out := post(t, h, &botID, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_task_attachment","arguments":`+args+`}}`)
	if st != 200 || out["error"] != nil {
		t.Fatalf("tools/call: %d %v", st, out)
	}
	res := out["result"].(map[string]any)
	isErr, _ := res["isError"].(bool)
	var bs []map[string]any
	for _, b := range res["content"].([]any) {
		bs = append(bs, b.(map[string]any))
	}
	return bs, isErr
}

func TestGetTaskAttachment(t *testing.T) {
	f := newTaskFixture()
	a := &filesAPI{f: f, files: map[string][]byte{
		"f-log":    []byte("ok\nFAIL TestX\n"),
		"f-png":    {0x89, 'P', 'N', 'G'},
		"f-huge":   []byte(strings.Repeat("é", 1<<19)), // 1 MiB of two-byte runes
		"f-svg":    []byte("<svg/>"),
		"f-bin":    {0xff, 0xfe, 0x00, 0x01},
		"f-biglog": []byte(strings.Repeat("x", MaxFileBytes+1)),
	}}
	h := linked(a)

	bs, isErr := blocks(t, h, `{"task":"DEV-7","file":"f-log"}`)
	if isErr || len(bs) != 2 || bs[1]["text"] != "ok\nFAIL TestX\n" || !strings.Contains(bs[0]["text"].(string), `"name":"build.log"`) {
		t.Fatalf("text: %v %v", isErr, bs)
	}
	// By name; an image comes back as an image block.
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"SHOT.png"}`)
	if isErr || len(bs) != 2 || bs[1]["type"] != "image" || bs[1]["mimeType"] != "image/png" || bs[1]["data"] != base64.StdEncoding.EncodeToString(a.files["f-png"]) {
		t.Fatalf("image: %v %v", isErr, bs)
	}
	// A large image: its preview.
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-big"}`)
	if isErr || bs[1]["mimeType"] != "image/webp" || !strings.Contains(bs[0]["text"].(string), "preview") {
		t.Fatalf("preview: %v %v", isErr, bs)
	}
	// SVG is text, not a preview (the app makes none for it).
	if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"icon.svg"}`); isErr || len(bs) != 2 || bs[1]["text"] != "<svg/>" {
		t.Fatalf("svg: %v %v", isErr, bs)
	}
	// A binary file: its metadata, a download URL and the curl line, nothing inline.
	n0 := len(a.ranges)
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-zip"}`)
	meta := metaOf(t, bs)
	if isErr || len(bs) != 2 || meta["name"] != "dump.zip" || meta["mime"] != "application/zip" || meta["sha256"] != "abc" ||
		meta["expires_in"] != float64(600) || !strings.HasPrefix(meta["download_url"].(string), "https://app.example.com/api/mcp/file/") ||
		!strings.Contains(bs[1]["text"].(string), `curl -fsSL -o "dump.zip" "`+meta["download_url"].(string)+`"`) || !strings.Contains(bs[1]["text"].(string), "shasum -a 256") {
		t.Fatalf("binary: %v %v", isErr, bs)
	}
	if len(a.ranges) != n0 {
		t.Fatal("a binary file was downloaded into the context")
	}
	// Each supported class, MIME by extension for OOXML; exactly at the limit passes.
	for _, c := range []struct{ file, mime string }{
		{"f-xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"voice.ogg", "audio/ogg"},
	} {
		bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"`+c.file+`"}`)
		if m := metaOf(t, bs); isErr || m["mime"] != c.mime || m["download_url"] == nil {
			t.Fatalf("%s: %v %v", c.file, isErr, bs)
		}
	}
	// Not UTF-8 "text": the file only, by URL.
	if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-bin"}`); isErr || metaOf(t, bs)["download_url"] == nil || !strings.Contains(bs[1]["text"].(string), "curl") {
		t.Fatalf("binary text: %v %v", isErr, bs)
	}
	// Over the limits, and an unsupported type: structured errors.
	for _, c := range []struct{ file, code string }{
		{"f-xl-big", `"error":"file_too_large","file":"f-xl-big","limit":3145728`},
		{"f-huge-img", `"limit":5242880`},
		{"f-mp4", `"error":"unsupported_file_type"`},
	} {
		if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"`+c.file+`"}`); !isErr || !strings.Contains(bs[0]["text"].(string), c.code) {
			t.Fatalf("%s: %v %v", c.file, isErr, bs)
		}
	}
	// Without a URL the old inline answers stay: a preview of an image of another type (HEIC), the
	// head of a text file over the limit; an image without a preview is refused.
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-heic"}`)
	if m := metaOf(t, bs); isErr || bs[1]["mimeType"] != "image/webp" || m["no_download"] != "unsupported_file_type" || m["download_url"] != nil {
		t.Fatalf("heic: %v %v", isErr, bs)
	}
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-biglog"}`)
	if m := metaOf(t, bs); isErr || len(bs[1]["text"].(string)) != textInline || m["no_download"] != "file_too_large" || m["limit"] != float64(MaxFileBytes) ||
		m["download_url"] != nil || !strings.Contains(m["truncated"].(string), "open it in Calab") {
		t.Fatalf("big text: %v %s", isErr, bs[0]["text"])
	}
	if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-tiff"}`); !isErr || !strings.Contains(bs[0]["text"].(string), `"error":"unsupported_file_type"`) ||
		strings.Contains(bs[0]["text"].(string), "no_download") {
		t.Fatalf("tiff: %v %v", isErr, bs)
	}
	// A comment's binary file.
	if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-ogg"}`); isErr || metaOf(t, bs)["comment"] != "m-1" {
		t.Fatalf("comment ogg: %v %v", isErr, bs)
	}
	// A comment's file, cut to 256 KiB with a Range request, on a whole character.
	bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"f-huge"}`)
	if isErr || len(bs[1]["text"].(string)) != textInline || !strings.Contains(bs[0]["text"].(string), `"comment":"m-1"`) ||
		!strings.Contains(bs[0]["text"].(string), "truncated") || a.ranges[len(a.ranges)-1] != "bytes=0-262143" {
		t.Fatalf("comment file: %v %s", isErr, bs[0]["text"])
	}
	// A file of another task (or none) is refused before any download.
	n := len(a.ranges)
	if bs, isErr = blocks(t, h, `{"task":"DEV-7","file":"`+uuid.NewString()+`"}`); !isErr || !strings.Contains(bs[0]["text"].(string), "not attached") {
		t.Fatalf("foreign file: %v %v", isErr, bs)
	}
	if len(a.ranges) != n {
		t.Fatal("downloaded a file not attached to the task")
	}
}

func TestReadTaskFilesAndComments(t *testing.T) {
	f := newTaskFixture()
	a := &filesAPI{f: f, files: map[string][]byte{"f-log": []byte("x"), "f-png": []byte("y")}}
	h := New("test")
	h.API = a
	text, isErr := call(t, h, "read", `{"task":"DEV-7","comments":5}`)
	var out map[string]any
	_ = json.Unmarshal([]byte(text), &out)
	if isErr || out["files"] == nil || out["recent_comments"] == nil || !strings.Contains(text, `"id":"f-huge"`) {
		t.Fatalf("read: %v %s", isErr, text)
	}
}
