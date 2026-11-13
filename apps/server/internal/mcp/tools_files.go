package mcp

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// CBF-182: the files of a task and of its comments for the agent, and editing its own messages.
// Like every tool, the file is read through the REST download route with the caller's token, so
// the rights are exactly the app's (files.CanRead); the tool only checks that the file belongs to
// the task or to one of its comments, so an agent asked about a task gets that task's files.

// Inline caps of get_task_attachment.
const (
	// textInline: a text file up to this size comes back whole, a longer one cut to it.
	textInline = 256 << 10
	// imageInline: an image up to this size comes back as is; a larger one as its 1024 px preview.
	imageInline = 3 << 20
	// commentScan: without comment, the latest comments searched for the file.
	commentScan = 100
)

// content is a tool result given as MCP content blocks (text, image) instead of one JSON text.
type content []map[string]any

func textBlock(s string) map[string]any { return map[string]any{"type": "text", "text": s} }

// ---- get_task_attachment ----

// getTaskAttachment (CBF-182, CBF-185/186): the file's metadata with a signed download URL
// (links.go) for every supported file within the limits; text and images also inline, as before.
// Without a URL (another type, over the limit) an image still gives its preview and a text file
// its head, with no_download saying why; anything else is refused.
func getTaskAttachment(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("task", a.Task), need("file", a.File)); err != nil {
		return nil, err
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	f, comment, err := attachmentOf(ctx, c, tr.GetTask(), strings.TrimSpace(a.File), strings.TrimSpace(a.Comment))
	if err != nil {
		return nil, err
	}
	mt := fileMime(f.GetMime(), f.GetName())
	meta := compact(map[string]any{"file": f.GetId(), "name": f.GetName(), "mime": mt, "size": f.GetSize(),
		"sha256": f.GetSha256(), "task": tr.GetTask().GetKey(), "comment": comment})
	kind := fileKind(mt, f.GetName())
	limit := uint64(MaxFileBytes)
	if kind == "image" {
		limit = MaxImageBytes
	}
	fileURL := "/api/files/" + seg(f.GetId())
	// No download URL for a type outside the list or a file over the limit. What the tool gave
	// before the URLs stays: an image's preview (HEIC and the like too), the head of a text file.
	refusal := ""
	switch {
	case kind == "":
		refusal = "unsupported_file_type"
		meta["supported"] = supportedTypes
	case f.GetSize() > limit:
		refusal = "file_too_large"
		meta["limit"] = limit
	}
	if refusal != "" {
		meta["no_download"] = refusal
		var out content
		var ok bool
		var err error
		switch {
		case kind == "text":
			out, ok, err = textHead(ctx, c, meta, f, fileURL, "open it in Calab for the rest")
		case strings.HasPrefix(mt, "image/"): // SVG is text
			out, ok, err = imagePreview(ctx, c, meta, fileURL)
		}
		if err != nil {
			return nil, err
		}
		if ok {
			return out, nil
		}
		delete(meta, "no_download")
		meta["error"] = refusal
		return nil, errors.New(jsonText(meta))
	}
	u, err := c.m.link(c.outer, filePrefix, linkClaims{Op: opDownload, File: f.GetId(), Name: f.GetName(), Mime: mt})
	if err != nil {
		return nil, err
	}
	meta["download_url"], meta["expires_in"] = u, int(LinkTTL/time.Second)
	switch {
	case kind == "image" && f.GetSize() <= imageInline:
		b, got, err := c.fetch(ctx, fileURL, nil, nil, imageInline)
		if err != nil {
			return nil, err
		}
		return imageResult(meta, b, got, mt), nil
	case kind == "image":
		// Over 3 MiB: the preview the app shows (1024 px WebP) inline, the original by the URL.
		out, ok, err := imagePreview(ctx, c, meta, fileURL)
		if err != nil {
			return nil, err
		}
		if ok {
			return out, nil
		}
	case kind == "text":
		out, ok, err := textHead(ctx, c, meta, f, fileURL, "the whole file by download_url")
		if err != nil {
			return nil, err
		}
		if ok {
			return out, nil
		} // else not UTF-8: the file only
	}
	return binaryResult(meta), nil
}

// imagePreview is the preview the app shows of an image (1024 px WebP); false when it has none.
func imagePreview(ctx context.Context, c *api, meta map[string]any, fileURL string) (content, bool, error) {
	b, got, err := c.fetch(ctx, fileURL+"/thumbnail", url.Values{"w": {"1024"}}, nil, imageInline)
	if err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.status == http.StatusNotFound {
			return nil, false, nil
		}
		return nil, false, err
	}
	meta["preview"] = "1024 px"
	return imageResult(meta, b, got, "image/webp"), true, nil
}

// textHead is a text file inline: whole up to textInline, else its first textInline bytes cut at
// a whole character (rest says where the rest is); false when the bytes are not UTF-8.
func textHead(ctx context.Context, c *api, meta map[string]any, f *v1.FileMeta, fileURL, rest string) (content, bool, error) {
	var h http.Header
	if f.GetSize() > textInline {
		h = http.Header{"Range": {"bytes=0-" + strconv.Itoa(textInline-1)}}
	}
	b, _, err := c.fetch(ctx, fileURL, nil, h, textInline)
	if err != nil {
		return nil, false, err
	}
	cut := f.GetSize() > uint64(len(b))
	if cut {
		// A multi-byte rune split by the range is dropped.
		for len(b) > 0 && !utf8.Valid(b) && len(b) > textInline-utf8.UTFMax {
			b = b[:len(b)-1]
		}
	}
	if !utf8.Valid(b) {
		return nil, false, nil
	}
	if cut {
		meta["truncated"] = fmt.Sprintf("first %d of %d bytes; %s", len(b), f.GetSize(), rest)
	}
	return content{textBlock(jsonText(meta)), textBlock(string(b))}, true, nil
}

// binaryResult is a file without an inline body: its metadata and how to fetch it with a shell.
func binaryResult(meta map[string]any) content {
	name := safeShellName(meta["name"].(string))
	return content{textBlock(jsonText(meta)), textBlock(fmt.Sprintf(
		"Download with a shell (the URL works %d min; keep the bytes out of the chat): curl -fsSL -o %q %q && shasum -a 256 %q (must equal sha256)",
		int(LinkTTL/time.Minute), name, meta["download_url"], name))}
}

// safeShellName is a file name to suggest in a shell command: the base name without quotes,
// dollars, backticks, backslashes or a leading dash or dot.
func safeShellName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune("\"'`$\\!", r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimLeft(name, "-.")
	if name == "" || name == "/" {
		return "file"
	}
	return name
}

// supportedTypes is what get_task_attachment returns (unsupported_file_type lists it).
var supportedTypes = []string{"text (txt, csv, tsv, json, xml, md, sql, yaml, code, logs)", "xlsx", "docx", "pptx", "pdf", "zip",
	"ogg/opus", "mp3", "wav", "m4a", "png", "jpeg", "webp", "gif"}

// extMimes: the type of a file by its extension, when the stored one is generic (sniffing stores
// an OOXML document as application/zip, an Ogg file as application/ogg).
var extMimes = map[string]string{
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".pdf":  "application/pdf", ".zip": "application/zip",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
	".txt": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
	".xml": "application/xml", ".md": "text/markdown", ".sql": "application/sql", ".yaml": "application/yaml", ".yml": "application/yaml",
}

// genericMimes are stored types that say less than the extension.
var genericMimes = map[string]bool{"": true, "application/octet-stream": true, "application/zip": true, "application/x-zip-compressed": true,
	"text/plain": true, "application/ogg": true, "audio/x-wav": true, "audio/wave": true, "audio/x-m4a": true, "audio/mp3": true}

// fileMime is the type of a file for the agent: the stored one, or the extension's when the
// stored one is generic.
func fileMime(stored, name string) string {
	mt, _, _ := strings.Cut(stored, ";")
	mt = strings.TrimSpace(strings.ToLower(mt))
	if byExt, ok := extMimes[strings.ToLower(path.Ext(name))]; ok && genericMimes[mt] {
		return byExt
	}
	return mt
}

// fileKind is the class of a supported file ("" = not supported): text, image, document,
// archive or audio.
func fileKind(mt, name string) string {
	switch mt {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return "image"
	case "application/pdf", extMimes[".xlsx"], extMimes[".docx"], extMimes[".pptx"]:
		return "document"
	case "application/zip":
		return "archive"
	case "audio/ogg", "audio/opus", "audio/mpeg", "audio/wav", "audio/mp4":
		return "audio"
	}
	if textual(mt, name) {
		return "text"
	}
	return ""
}

// ---- upload_attachment ----

// uploadAttachment (CBF-187): a single-use upload URL for a file the agent then attaches with
// comment_task or send_message (files). The URL goes to the route the app uses: a task's board
// (its comments' attachments, ADR-0042), else the room's workspace, or the DM.
func uploadAttachment(ctx context.Context, c *api, a args) (any, error) {
	task, room := strings.TrimSpace(a.Task), strings.TrimSpace(a.Room)
	if (task == "") == (room == "") {
		return nil, errors.New("give task or room (exactly one)")
	}
	out := map[string]any{}
	var target string
	if task != "" {
		tr, err := taskByRef(ctx, c, task, a.Workspace)
		if err != nil {
			return nil, err
		}
		target = "/api/boards/" + seg(tr.GetTask().GetBoardId()) + "/files"
		out["task"] = tr.GetTask().GetKey()
	} else {
		var r v1.GetRoomResponse
		if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(room), nil, nil, &r); err != nil {
			return nil, err
		}
		if ws := r.GetRoom().GetWorkspaceId(); ws != "" {
			target = "/api/workspaces/" + seg(ws) + "/files"
		} else {
			target = "/api/dms/" + seg(r.GetRoom().GetId()) + "/files"
		}
		out["room"] = r.GetRoom().GetId()
	}
	if !uploadTarget(target) {
		return nil, errors.New("this task or room takes no files")
	}
	u, err := c.m.link(c.outer, uploadPfx, linkClaims{Op: opUpload, Target: target})
	if err != nil {
		return nil, err
	}
	out["upload_url"], out["expires_in"], out["max_size"] = u, int(LinkTTL/time.Second), MaxFileBytes
	out["curl"] = fmt.Sprintf("curl -fsS -F file=@./report.xlsx %q", u)
	out["next"] = "the answer is {file, name, mime, size, sha256}; attach with files: [file] in " + map[bool]string{true: "comment_task", false: "send_message"}[task != ""] + "; the URL works once"
	return out, nil
}

// attachmentOf finds file (an id, or a name) among the attachments of task t, then of its
// comment (a message id of the task's room) or, without one, of its latest comments. It returns
// the file and the comment it was found in ("" = the task).
func attachmentOf(ctx context.Context, c *api, t *v1.Task, file, comment string) (*v1.FileMeta, string, error) {
	if comment == "" {
		if f, err := pick(t.GetAttachments(), file); f != nil || err != nil {
			return f, "", err
		}
	}
	room := t.GetRoomId()
	if room == "" {
		return nil, "", errors.New("file " + strconv.Quote(file) + " is not attached to " + t.GetKey())
	}
	var msgs []*v1.Message
	if comment != "" {
		var m v1.Message
		if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(room)+"/messages/"+seg(comment), nil, nil, &m); err != nil {
			return nil, "", err
		}
		msgs = []*v1.Message{&m}
	} else {
		var r v1.ListMessagesResponse
		if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(room)+"/messages", url.Values{"limit": {strconv.Itoa(commentScan)}}, nil, &r); err != nil {
			return nil, "", err
		}
		msgs = r.GetMessages()
	}
	for _, m := range msgs {
		if f, err := pick(m.GetAttachments(), file); f != nil || err != nil {
			return f, m.GetId(), err
		}
	}
	if comment != "" {
		return nil, "", errors.New("file " + strconv.Quote(file) + " is not attached to comment " + comment + " of " + t.GetKey())
	}
	return nil, "", errors.New("file " + strconv.Quote(file) + " is not attached to " + t.GetKey() + " or its latest " + strconv.Itoa(commentScan) + " comments; for an older comment give comment (its message id)")
}

// pick is the file with id ref, else the only one named ref (case-insensitive).
func pick(fs []*v1.FileMeta, ref string) (*v1.FileMeta, error) {
	var named []*v1.FileMeta
	for _, f := range fs {
		if f.GetId() == ref {
			return f, nil
		}
		if strings.EqualFold(f.GetName(), ref) {
			named = append(named, f)
		}
	}
	switch len(named) {
	case 0:
		return nil, nil
	case 1:
		return named[0], nil
	}
	ids := make([]string, 0, len(named))
	for _, f := range named {
		ids = append(ids, f.GetId())
	}
	return nil, errors.New("several files are named " + strconv.Quote(ref) + ", give the id: " + strings.Join(ids, ", "))
}

var textMimes = map[string]bool{
	"application/json": true, "application/xml": true, "application/yaml": true, "application/x-yaml": true,
	"application/javascript": true, "application/x-javascript": true, "application/typescript": true,
	"application/sql": true, "application/x-sh": true, "application/toml": true, "application/x-ndjson": true,
	"application/csv": true, "image/svg+xml": true,
}

var textExts = map[string]bool{
	".txt": true, ".md": true, ".log": true, ".csv": true, ".tsv": true, ".json": true, ".jsonl": true, ".yaml": true,
	".yml": true, ".toml": true, ".ini": true, ".xml": true, ".html": true, ".css": true, ".sql": true, ".sh": true,
	".diff": true, ".patch": true, ".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true,
	".py": true, ".rb": true, ".rs": true, ".java": true, ".kt": true, ".swift": true, ".c": true, ".h": true,
	".cpp": true, ".cs": true, ".php": true, ".proto": true, ".graphql": true, ".vue": true, ".svelte": true,
}

// textual: a file read as text (by its type, or by its extension when the type is generic).
func textual(mime, name string) bool {
	mime, _, _ = strings.Cut(mime, ";")
	return strings.HasPrefix(mime, "text/") || textMimes[mime] || textExts[strings.ToLower(path.Ext(name))]
}

func imageResult(meta map[string]any, b []byte, got, want string) content {
	mime, _, _ := strings.Cut(got, ";")
	if !strings.HasPrefix(mime, "image/") {
		mime = want
	}
	return content{textBlock(jsonText(meta)), {"type": "image", "data": base64.StdEncoding.EncodeToString(b), "mimeType": mime}}
}

// ---- edit_message ----

func editMessage(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("message", a.Message), need("text", a.Text)); err != nil {
		return nil, err
	}
	var r v1.UpdateMessageResponse
	if err := c.call(ctx, http.MethodPatch, "/api/messages/"+seg(a.Message), nil, &v1.UpdateMessageRequest{Content: a.Text}, &r); err != nil {
		return nil, err
	}
	m := r.GetMessage()
	return compact(map[string]any{"id": m.GetId(), "room": m.GetRoomId(), "edited": ts(m.GetEditedAt())}), nil
}

// ---- find people ----

// people lists members of the workspaces matching q (name, nickname or username), for the ids
// the other tools return (authors, assignees).
func people(ctx context.Context, c *api, wss []string, q string, limit int) ([]map[string]any, error) {
	low := strings.ToLower(strings.TrimPrefix(q, "@"))
	var out []map[string]any
	seen := map[string]bool{}
	for _, ws := range wss {
		var r v1.ListMembersResponse
		if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/members", nil, nil, &r); err != nil {
			return nil, err
		}
		for _, m := range r.GetMembers() {
			u := m.GetUser()
			if len(out) >= limit || seen[u.GetId()] {
				continue
			}
			if low != "" && !strings.Contains(strings.ToLower(u.GetDisplayName()), low) && !strings.Contains(strings.ToLower(m.GetNickname()), low) &&
				!strings.Contains(strings.ToLower(u.GetUsername()), low) && u.GetId() != q {
				continue
			}
			seen[u.GetId()] = true
			out = append(out, compact(map[string]any{"id": u.GetId(), "name": u.GetDisplayName(), "nick": m.GetNickname(),
				"username": u.GetUsername(), "bot": u.GetIsBot(), "workspace": ws}))
		}
	}
	return out, nil
}

// ---- read: a task's files, checklists and comments ----

func fileList(fs []*v1.FileMeta) []map[string]any {
	var out []map[string]any
	for _, f := range fs {
		out = append(out, compact(map[string]any{"id": f.GetId(), "name": f.GetName(), "mime": f.GetMime(), "size": f.GetSize()}))
	}
	return out
}

func checklists(t *v1.Task) []map[string]any {
	var out []map[string]any
	for _, cl := range t.GetChecklists() {
		var items []string
		for _, it := range cl.GetItems() {
			mark := "[ ] "
			if it.GetDone() {
				mark = "[x] "
			}
			items = append(items, mark+it.GetText())
		}
		out = append(out, compact(map[string]any{"title": cl.GetTitle(), "items": items}))
	}
	return out
}
