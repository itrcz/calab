package mcp

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Signed file URLs (CBF-185/186/187, ADR-0158 addendum «files»). An agent has a shell, so a file
// goes between Calab and the agent's disk with curl, never through the model's context:
// get_task_attachment returns a download URL, upload_attachment an upload URL. A URL is a
// capability for ten minutes, bound to the tool's caller (auth.Grant) and to one file (download)
// or one upload target (a task's board, a room's workspace or DM; single use). It is not a
// permission: its handler replays the REST call the app makes (GET /api/files/{id}, POST
// …/files) in process as the caller, through the whole chain — the caller's token or MCP session
// must still be alive, and the handler's own checks (files.CanRead, ATTACH_FILES, quota, plan
// and size limits) decide again at request time.

// Routes of the signed URLs (outside bearer auth: the token in the path is the credential).
const (
	FileRoute   = "GET /api/mcp/file/{token}"
	UploadRoute = "POST /api/mcp/upload/{token}"
	filePrefix  = "/api/mcp/file/"
	uploadPfx   = "/api/mcp/upload/"
)

// LinkTTL is the lifetime of a signed URL.
const LinkTTL = 10 * time.Minute

// Source byte limits of the files the URLs move (CBF-186).
const (
	MaxFileBytes  = 3 << 20 // text, documents, archives, audio; uploads
	MaxImageBytes = 5 << 20 // PNG, JPEG, WebP, GIF
)

// maxUploadBody caps what an upload request may send: past it the size is reported as at least it.
const maxUploadBody = 64 << 20

const (
	opDownload = "dl"
	opUpload   = "ul"
	audience   = "calab-mcp-file"
)

// DeriveURLKey derives the signing key of the URLs from the API's JWT_SECRET (a separate key: a
// URL token never verifies as a session token, an office URL token or back).
func DeriveURLKey(apiSecret []byte) []byte {
	m := hmac.New(sha256.New, apiSecret)
	m.Write([]byte("calab-mcp-file-url-v1"))
	return m.Sum(nil)
}

type linkClaims struct {
	Op    string     `json:"op"`
	Grant auth.Grant `json:"g"`
	File  string     `json:"f,omitempty"` // download: the file id
	Name  string     `json:"n,omitempty"` // download: its name (Content-Disposition)
	Mime  string     `json:"m,omitempty"` // download: its type as the tool reported it
	// Target: upload: the REST route the file goes to (/api/boards/{id}/files,
	// /api/workspaces/{id}/files or /api/dms/{id}/files).
	Target string `json:"t,omitempty"`
	jwt.RegisteredClaims
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h *Handler) sign(c linkClaims) (string, error) {
	if len(h.URLKey) == 0 {
		return "", errors.New("file links are not configured on this server")
	}
	now := h.now()
	c.Audience = jwt.ClaimStrings{audience}
	c.ExpiresAt = jwt.NewNumericDate(now.Add(LinkTTL))
	c.IssuedAt = jwt.NewNumericDate(now)
	c.ID = uuid.NewString()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(h.URLKey)
}

var errLink = httpx.NotFound("link") // a bad, tampered or expired URL: nothing to tell apart

func (h *Handler) parse(tok, op string) (linkClaims, error) {
	var c linkClaims
	if len(h.URLKey) == 0 {
		return c, errLink
	}
	_, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return h.URLKey, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithAudience(audience),
		jwt.WithExpirationRequired(), jwt.WithTimeFunc(h.now))
	if err != nil || c.Op != op || c.ID == "" {
		return c, errLink
	}
	return c, nil
}

// origin is the app origin of the MCP request (its Host among Origins), else the first one.
func (h *Handler) origin(r *http.Request) string {
	for _, o := range h.Origins {
		if u, err := url.Parse(o); err == nil && strings.EqualFold(u.Host, r.Host) {
			return strings.TrimRight(o, "/")
		}
	}
	if len(h.Origins) > 0 {
		return strings.TrimRight(h.Origins[0], "/")
	}
	return ""
}

// link signs c for the caller of the MCP request outer and returns the absolute URL.
func (h *Handler) link(outer *http.Request, prefix string, c linkClaims) (string, error) {
	id, ok := auth.FromContext(outer.Context())
	if !ok {
		return "", errors.New("no caller")
	}
	g, ok := auth.GrantOf(id)
	if !ok {
		return "", ErrNotBot
	}
	c.Grant = g
	tok, err := h.sign(c)
	if err != nil {
		return "", err
	}
	return h.origin(outer) + prefix + tok, nil
}

// replay builds the in-process REST request of a signed URL: as the grant's caller (no
// Authorization: Require takes the grant), channel MCP, with the caller's Calab-On-Behalf again.
func replay(outer *http.Request, g auth.Grant, method, path string, body io.Reader) (*http.Request, context.CancelFunc, error) {
	ctx, cancel := context.WithCancel(auth.WithGrant(auth.WithChannel(context.Background(), auth.ChannelMCP), g))
	stop := context.AfterFunc(outer.Context(), cancel)
	req, err := http.NewRequestWithContext(ctx, method, path, body)
	if err != nil {
		stop()
		cancel()
		return nil, nil, err
	}
	for _, k := range []string{"X-Forwarded-For", "X-Real-Ip", "User-Agent"} {
		if v := outer.Header.Values(k); len(v) > 0 {
			req.Header[k] = v
		}
	}
	if g.OnBehalf != "" {
		req.Header.Set(auth.OnBehalfHeader, g.OnBehalf)
	}
	req.RemoteAddr, req.Host = outer.RemoteAddr, outer.Host
	return req, func() { stop(); cancel() }, nil
}

// ---- download: GET /api/mcp/file/{token} ----

// ServeFile serves a download URL: GET /api/files/{id} as the caller (files.CanRead at request
// time, Range, the sandbox CSP), as an attachment that is never cached.
func (h *Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	c, err := h.parse(r.PathValue("token"), opDownload)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	if _, err := uuid.Parse(c.File); err != nil {
		httpx.WriteError(w, r, errLink)
		return
	}
	req, done, err := replay(r, c.Grant, http.MethodGet, "/api/files/"+c.File, http.NoBody)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	defer done()
	for _, k := range []string{"Range", "If-Range"} {
		if v := r.Header.Values(k); len(v) > 0 {
			req.Header[k] = v
		}
	}
	h.API.ServeHTTP(&fileWriter{ResponseWriter: w, name: c.Name, mime: c.Mime}, req)
}

// fileWriter makes a successful answer a download that is not cached: attachment (an image
// too), no-store, the type the tool reported (an OOXML file stored as application/zip).
type fileWriter struct {
	http.ResponseWriter
	name, mime string
	wrote      bool
}

func (f *fileWriter) WriteHeader(code int) {
	if !f.wrote {
		f.wrote = true
		if code < 300 {
			hd := f.Header()
			hd.Set("Cache-Control", "no-store")
			hd.Del("ETag")
			// Always a download, also when the name cannot be put in the header.
			disp := mime.FormatMediaType("attachment", map[string]string{"filename": f.name})
			if f.name == "" || disp == "" {
				disp = "attachment"
			}
			hd.Set("Content-Disposition", disp)
			if f.mime != "" {
				hd.Set("Content-Type", f.mime)
			}
		}
	}
	f.ResponseWriter.WriteHeader(code)
}

func (f *fileWriter) Write(b []byte) (int, error) {
	if !f.wrote {
		f.WriteHeader(http.StatusOK)
	}
	return f.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection (the serve path's write deadline).
func (f *fileWriter) Unwrap() http.ResponseWriter { return f.ResponseWriter }

// ---- upload: POST /api/mcp/upload/{token} ----

// ReasonFileTooLarge marks a refused file over the MCP limits (ApiError.reason; used = the
// file's size, limit = the limit).
const ReasonFileTooLarge = "file_too_large"

func fileTooLarge(size, limit int64) error {
	return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE, "file exceeds the MCP limit").
		WithDetails(ReasonFileTooLarge, uint64(max(size, 0)), uint64(max(limit, 0)))
}

var errUsed = httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_CONFLICT, "this upload URL was already used; call upload_attachment again").
	WithDetails("upload_url_used", 0, 0)

// ServeUpload serves an upload URL (once): the multipart field "file", at most MaxFileBytes, goes
// to the bound target as the caller — the app's upload route with its checks (ATTACH_FILES /
// commenting, quota, plan and size limits). The answer is {file, name, mime, size, sha256}.
func (h *Handler) ServeUpload(w http.ResponseWriter, r *http.Request) {
	if err := h.upload(w, r); err != nil {
		httpx.WriteError(w, r, err)
	}
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request) error {
	c, err := h.parse(r.PathValue("token"), opUpload)
	if err != nil {
		return err
	}
	if !uploadTarget(c.Target) {
		return errLink
	}
	if h.Redis == nil {
		return httpx.Unavailable(errors.New("mcp: no valkey for upload nonces"))
	}
	// Single use: the first request takes the URL, whatever happens to it next.
	key := redisx.Key("mcp:upload:" + c.ID)
	ttl := time.Until(c.ExpiresAt.Time) + time.Minute
	err = h.Redis.Do(r.Context(), h.Redis.B().Set().Key(key).Value("1").Nx().Px(ttl).Build()).Error()
	if rueidis.IsRedisNil(err) {
		return errUsed
	}
	if err != nil {
		return httpx.Unavailable(err)
	}
	name, ctype, data, size, err := readFilePart(w, r)
	if err != nil {
		return err
	}
	if size > MaxFileBytes {
		return fileTooLarge(size, MaxFileBytes)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	ph := textproto.MIMEHeader{}
	ph.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": name}))
	if ctype != "" {
		ph.Set("Content-Type", ctype)
	}
	pw, err := mw.CreatePart(ph)
	if err != nil {
		return err
	}
	if _, err := pw.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	req, done, err := replay(r, c.Grant, http.MethodPost, c.Target, &body)
	if err != nil {
		return err
	}
	defer done()
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.ContentLength = int64(body.Len())
	rec := &recorder{header: http.Header{}, limit: 1 << 20}
	h.API.ServeHTTP(rec, req)
	if st := rec.code(); st >= 300 {
		for k, v := range rec.header {
			w.Header()[k] = v
		}
		w.WriteHeader(st)
		_, _ = w.Write(rec.buf.Bytes())
		return nil
	}
	var up v1.UploadFileResponse
	if err := unmarshal.Unmarshal(rec.buf.Bytes(), &up); err != nil {
		return err
	}
	f := up.GetFile()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	return json.NewEncoder(w).Encode(map[string]any{"file": f.GetId(), "name": f.GetName(), "mime": fileMime(f.GetMime(), f.GetName()),
		"size": f.GetSize(), "sha256": f.GetSha256()})
}

// uploadTarget: one of the app's upload routes (the claim is signed; this keeps it so).
func uploadTarget(t string) bool {
	parts := strings.Split(t, "/") // "", "api", kind, id, "files"
	if len(parts) != 5 || parts[0] != "" || parts[1] != "api" || parts[4] != "files" {
		return false
	}
	if _, err := uuid.Parse(parts[3]); err != nil {
		return false
	}
	switch parts[2] {
	case "boards", "workspaces", "dms":
		return true
	}
	return false
}

// readFilePart reads the "file" part of a multipart upload: its name, declared type, the first
// MaxFileBytes+1 bytes and its whole size (counted up to maxUploadBody).
func readFilePart(w http.ResponseWriter, r *http.Request) (name, ctype string, data []byte, size int64, err error) {
	if r.ContentLength > maxUploadBody {
		return "", "", nil, 0, fileTooLarge(r.ContentLength, MaxFileBytes)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
	mr, err := r.MultipartReader()
	if err != nil {
		return "", "", nil, 0, httpx.BadRequest(`expected multipart/form-data with a "file" field (curl -F file=@./name)`)
	}
	for i := 0; ; i++ {
		part, err := mr.NextPart()
		if err != nil || i > 8 {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return "", "", nil, 0, fileTooLarge(maxUploadBody, MaxFileBytes)
			}
			return "", "", nil, 0, httpx.BadRequest(`multipart field "file" not found`)
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		defer func() { _ = part.Close() }()
		data, err = io.ReadAll(io.LimitReader(part, MaxFileBytes+1))
		size = int64(len(data))
		if err == nil && size > MaxFileBytes {
			var n int64
			n, err = io.Copy(io.Discard, part) // only to tell the size
			size += n
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return "", "", nil, 0, fileTooLarge(max(size, maxUploadBody), MaxFileBytes)
			}
			return "", "", nil, 0, httpx.BadRequest("could not read the file")
		}
		return part.FileName(), part.Header.Get("Content-Type"), data, size, nil
	}
}
