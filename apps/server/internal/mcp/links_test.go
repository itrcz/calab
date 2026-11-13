package mcp

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

// linked is a handler over api that makes signed URLs (no Valkey: uploads are integration-tested).
func linked(api http.Handler) *Handler {
	h := New("test")
	h.API = api
	h.URLKey = DeriveURLKey([]byte("test-secret"))
	h.Origins = []string{"https://app.example.com"}
	return h
}

func metaOf(t *testing.T, bs []map[string]any) map[string]any {
	t.Helper()
	var m map[string]any
	if len(bs) == 0 {
		return nil
	}
	_ = json.Unmarshal([]byte(bs[0]["text"].(string)), &m)
	return m
}

// signFor is a URL token of op for the caller id (as the tool signs it).
func signFor(t *testing.T, h *Handler, id auth.Identity, c linkClaims) string {
	t.Helper()
	r := httptest.NewRequestWithContext(auth.WithIdentity(t.Context(), id), http.MethodPost, Path, nil)
	r.Host = "app.example.com"
	u, err := h.link(r, filePrefix, c)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimPrefix(u, "https://app.example.com"+filePrefix)
}

// innerSeen records the replayed REST request.
type innerSeen struct {
	r    *http.Request
	body []byte
	ans  func(w http.ResponseWriter)
}

func (s *innerSeen) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.r = r
	var b bytes.Buffer
	_, _ = b.ReadFrom(r.Body)
	s.body = b.Bytes()
	s.ans(w)
}

func TestServeFile(t *testing.T) {
	seen := &innerSeen{ans: func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `inline; filename="x"`)
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Header().Set("ETag", `"abc"`)
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("PK"))
	}}
	h := linked(seen)
	now := time.Now()
	h.Now = func() time.Time { return now }
	file := uuid.NewString()
	owner := auth.Identity{UserID: uuid.New(), SessionID: uuid.New(), ViaBot: uuid.New()} // a bot on behalf of its owner
	tok := signFor(t, h, owner, linkClaims{Op: opDownload, File: file, Name: "report.xlsx", Mime: extMimes[".xlsx"]})

	get := func(path string, hdr http.Header) *httptest.ResponseRecorder {
		mux := http.NewServeMux()
		mux.HandleFunc(FileRoute, h.ServeFile)
		mux.HandleFunc(UploadRoute, h.ServeUpload)
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer someone-else") // never forwarded: the grant decides
		for k, v := range hdr {
			r.Header[k] = v
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := get(filePrefix+tok, http.Header{"Range": {"bytes=0-1"}})
	if w.Code != http.StatusPartialContent || w.Body.String() != "PK" {
		t.Fatalf("download: %d %s", w.Code, w.Body)
	}
	hd := w.Header()
	if hd.Get("Cache-Control") != "no-store" || hd.Get("ETag") != "" || hd.Get("Content-Type") != extMimes[".xlsx"] ||
		hd.Get("Content-Disposition") != `attachment; filename=report.xlsx` {
		t.Fatalf("headers: %v", hd)
	}
	in := seen.r
	if in.URL.Path != "/api/files/"+file || in.Header.Get("Authorization") != "" || in.Header.Get("Range") != "bytes=0-1" ||
		in.Header.Get(auth.OnBehalfHeader) != auth.OnBehalfOwner {
		t.Fatalf("inner request: %s %v", in.URL, in.Header)
	}
	if c := auth.Channel(in.Context()); c == nil || *c != auth.ChannelMCP {
		t.Fatal("inner request is not on the MCP channel")
	}
	// The same URL again (a second download within the TTL).
	if w := get(filePrefix+tok, nil); w.Code != http.StatusPartialContent {
		t.Fatalf("repeat: %d", w.Code)
	}

	seen.r = nil
	// Tampered: another file id in the payload, the signature of the old one.
	parts := strings.Split(tok, ".")
	other := signFor(t, h, owner, linkClaims{Op: opDownload, File: uuid.NewString()})
	forged := parts[0] + "." + strings.Split(other, ".")[1] + "." + parts[2]
	// An upload token on the download route; a token of another key.
	upTok := signFor(t, h, owner, linkClaims{Op: opUpload, Target: "/api/boards/" + uuid.NewString() + "/files"})
	h2 := linked(seen)
	h2.URLKey = DeriveURLKey([]byte("other"))
	foreign := signFor(t, h2, owner, linkClaims{Op: opDownload, File: file})
	for name, tk := range map[string]string{"tampered": forged, "upload token": upTok, "other key": foreign, "garbage": "x.y.z"} {
		if w := get(filePrefix+tk, nil); w.Code != http.StatusNotFound || seen.r != nil {
			t.Fatalf("%s: %d", name, w.Code)
		}
	}
	// Expired.
	now = now.Add(LinkTTL + time.Second)
	if w := get(filePrefix+tok, nil); w.Code != http.StatusNotFound || seen.r != nil {
		t.Fatalf("expired: %d", w.Code)
	}
}

func TestGrantOf(t *testing.T) {
	bot := auth.Identity{UserID: uuid.New(), SessionID: uuid.New(), IsBot: true}
	if g, _ := auth.GrantOf(bot); !g.Bot || g.UserID != bot.UserID || g.OnBehalf != "" {
		t.Fatalf("bot: %+v", g)
	}
	member := auth.Identity{UserID: uuid.New(), SessionID: uuid.New(), ViaBot: uuid.New(), ForMember: true}
	if g, _ := auth.GrantOf(member); !g.Bot || g.UserID != member.ViaBot || g.OnBehalf != member.UserID.String() {
		t.Fatalf("member: %+v", g)
	}
	mcpSession := auth.Identity{UserID: uuid.New(), SessionID: uuid.New(), MCP: true}
	if g, _ := auth.GrantOf(mcpSession); g.Bot || g.UserID != mcpSession.UserID {
		t.Fatalf("mcp: %+v", g)
	}
	if _, ok := auth.GrantOf(auth.Identity{UserID: uuid.New(), SessionID: uuid.New()}); ok {
		t.Fatal("an app session got a grant")
	}
}

func TestUploadAttachmentTool(t *testing.T) {
	f := newTaskFixture()
	dm := uuid.NewString()
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		if r.URL.Path == "/api/rooms/"+dm {
			return 200, &v1.GetRoomResponse{Room: &v1.Room{Id: dm}}, true
		}
		if r.URL.Path == "/api/rooms/room-9" {
			return 200, &v1.GetRoomResponse{Room: &v1.Room{Id: "room-9", WorkspaceId: f.ws}}, true
		}
		return 0, nil, false
	})
	h := linked(fa)
	if _, isErr := call(t, h, "upload_attachment", `{}`); !isErr {
		t.Fatal("neither task nor room")
	}
	if _, isErr := call(t, h, "upload_attachment", `{"task":"DEV-7","room":"room-9"}`); !isErr {
		t.Fatal("both task and room")
	}
	for args, target := range map[string]string{
		`{"task":"DEV-7"}`:      "/api/boards/" + f.boardID + "/files",
		`{"room":"room-9"}`:     "/api/workspaces/" + f.ws + "/files",
		`{"room":"` + dm + `"}`: "/api/dms/" + dm + "/files",
	} {
		text, isErr := call(t, h, "upload_attachment", args)
		var out map[string]any
		_ = json.Unmarshal([]byte(text), &out)
		u, _ := out["upload_url"].(string)
		if isErr || !strings.HasPrefix(u, "https://app.example.com"+uploadPfx) || out["curl"] != `curl -fsS -F file=@./report.xlsx "`+u+`"` || out["max_size"] != float64(MaxFileBytes) {
			t.Fatalf("%s: %s", args, text)
		}
		c, err := h.parse(strings.TrimPrefix(u, "https://app.example.com"+uploadPfx), opUpload)
		if err != nil || c.Target != target || c.Grant.UserID != botID.UserID {
			t.Fatalf("%s: claims %+v %v", args, c, err)
		}
	}
}

func TestReadFilePartSizes(t *testing.T) {
	for _, n := range []int{MaxFileBytes, MaxFileBytes + 1} {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		fw, _ := mw.CreateFormFile("file", "a.bin")
		_, _ = fw.Write(bytes.Repeat([]byte{'x'}, n))
		_ = mw.Close()
		r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", &body)
		r.Header.Set("Content-Type", mw.FormDataContentType())
		name, _, data, size, err := readFilePart(httptest.NewRecorder(), r)
		if err != nil || name != "a.bin" || size != int64(n) || len(data) != min(n, MaxFileBytes+1) {
			t.Fatalf("%d: %s %d %d %v", n, name, size, len(data), err)
		}
	}
	if !uploadTarget("/api/boards/"+uuid.NewString()+"/files") || uploadTarget("/api/rooms/"+uuid.NewString()+"/messages") || uploadTarget("/api/boards/x/files") {
		t.Fatal("uploadTarget")
	}
}

// comment_task and send_message pass files to the app's message route; its refusal is the tool's.
func TestMessageFiles(t *testing.T) {
	f := newTaskFixture()
	var sent []string
	fa := f.api(t, func(r *http.Request, body string) (int, proto.Message, bool) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/messages") {
			var req v1.CreateMessageRequest
			_ = protojson.Unmarshal([]byte(body), &req)
			sent = append(sent, strings.Join(req.GetAttachmentIds(), ","))
			if slices.Contains(req.GetAttachmentIds(), "bad") {
				return 422, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_VALIDATION, Message: "file bad is not an unattached upload of yours in this workspace"}, true
			}
			var atts []*v1.FileMeta
			for _, id := range req.GetAttachmentIds() {
				atts = append(atts, &v1.FileMeta{Id: id, Name: id + ".xlsx", Size: 3})
			}
			return 201, &v1.CreateMessageResponse{Message: &v1.Message{Id: "m-9", RoomId: strings.Split(r.URL.Path, "/")[3], Attachments: atts}}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa
	text, isErr := call(t, h, "comment_task", `{"task":"DEV-7","files":["f1","f2"]}`)
	if isErr || !strings.Contains(text, `"files":[{"id":"f1"`) || sent[0] != "f1,f2" {
		t.Fatalf("comment with files: %s", text)
	}
	if text, isErr = call(t, h, "send_message", `{"room":"room-9","text":"see","files":["f3"]}`); isErr || !strings.Contains(text, `"id":"f3"`) {
		t.Fatalf("message with files: %s", text)
	}
	if text, isErr = call(t, h, "comment_task", `{"task":"DEV-7","text":"x","files":["f4","bad"]}`); !isErr || !strings.Contains(text, "422") {
		t.Fatalf("bad file: %s", text)
	}
	if _, isErr = call(t, h, "send_message", `{"room":"room-9"}`); !isErr {
		t.Fatal("a message without text or files")
	}
}
