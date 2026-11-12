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
	meta := compact(map[string]any{"file": f.GetId(), "name": f.GetName(), "mime": f.GetMime(), "size": f.GetSize(),
		"task": tr.GetTask().GetKey(), "comment": comment})
	fileURL := "/api/files/" + seg(f.GetId())
	switch {
	case inlineImage(f.GetMime()) && f.GetSize() <= imageInline:
		b, mime, err := c.fetch(ctx, fileURL, nil, nil, imageInline)
		if err != nil {
			return nil, err
		}
		return imageResult(meta, b, mime, f.GetMime()), nil
	case strings.HasPrefix(f.GetMime(), "image/") && !strings.HasPrefix(f.GetMime(), "image/svg+xml"):
		// Too large (or a type models do not take): the preview the app shows, 1024 px WebP.
		// SVG (textMimes) is text: the app makes it no thumbnail.
		b, mime, err := c.fetch(ctx, fileURL+"/thumbnail", url.Values{"w": {"1024"}}, nil, imageInline)
		if err != nil {
			var ae *apiError
			if errors.As(err, &ae) && ae.status == http.StatusNotFound {
				return nil, tooLarge(meta, "an image without a preview")
			}
			return nil, err
		}
		meta["preview"] = "1024 px"
		return imageResult(meta, b, mime, "image/webp"), nil
	case textual(f.GetMime(), f.GetName()):
		var h http.Header
		if f.GetSize() > textInline {
			h = http.Header{"Range": {"bytes=0-" + strconv.Itoa(textInline-1)}}
		}
		b, _, err := c.fetch(ctx, fileURL, nil, h, textInline)
		if err != nil {
			return nil, err
		}
		if f.GetSize() > uint64(len(b)) {
			// Cut at a whole character: a multi-byte rune split by the range is dropped.
			for len(b) > 0 && !utf8.Valid(b) && len(b) > textInline-utf8.UTFMax {
				b = b[:len(b)-1]
			}
			meta["truncated"] = fmt.Sprintf("first %d of %d bytes", len(b), f.GetSize())
		}
		if !utf8.Valid(b) {
			return nil, tooLarge(meta, "not UTF-8 text")
		}
		return content{textBlock(jsonText(meta)), textBlock(string(b))}, nil
	}
	return nil, tooLarge(meta, "a binary file")
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

// inlineImage: the image types MCP clients pass to models as they are.
func inlineImage(mime string) bool {
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
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

// tooLarge is the refusal of a file the tool does not return: what it is, and where to open it.
func tooLarge(meta map[string]any, why string) error {
	return errors.New(why + ", not returned inline (text up to 256 KiB, images up to 3 MiB or as a preview): " + jsonText(meta) + "; open it in Calab")
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
