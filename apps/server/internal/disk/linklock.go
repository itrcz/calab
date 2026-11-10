package disk

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Password and «Без скачивания» of public links (ADR-0167).
//
// A link with a password answers nothing about its item until the visitor unlocks it: POST
// …/unlock checks the password (argon2id, auth.VerifyPassword) under a per-IP and a per-link
// limit and sets a cookie scoped to the link's path. The cookie is an HMAC token over the link
// id, its code, its password_version and an expiry: changing or removing the password, or
// re-enabling the link, bumps the version (and a re-enable changes the code), so every older
// unlock stops working; a revoked link answers 404 before any of this.

const (
	// UnlockTTL is how long an unlock lasts.
	UnlockTTL = 12 * time.Hour
	// PasswordMin bounds a link password from below (characters).
	PasswordMin = 4
	// PasswordMax bounds a link password from above (characters).
	PasswordMax = 128
	// unlockCookie is the cookie's name; its path is the link's own API path.
	unlockCookie = "calab_dl"
	unlockMACLen = 16
)

var (
	// errLocked is the one answer to a locked link and to a wrong password: no difference to
	// tell a guess from a missing unlock.
	errLocked = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_LINK_PASSWORD_REQUIRED, "the link needs its password")
	// errViewOnly: «Без скачивания» refuses a download (the archive, a file with no viewer).
	errViewOnly = httpx.Forbidden("the link is view-only")
)

// DeriveUnlockKey derives the unlock-token key from JWT_SECRET.
func DeriveUnlockKey(secret []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("calab/disk-link-unlock/v1"))
	return m.Sum(nil)
}

// unlockMAC signs the claims of an unlock token of link l valid until exp (unix seconds).
func unlockMAC(key []byte, l sqlc.DiskLink, exp uint64) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(l.ID[:])
	var b [12]byte
	binary.BigEndian.PutUint32(b[:4], uint32(l.PasswordVersion)) //nolint:gosec // a counter, wraps harmlessly
	binary.BigEndian.PutUint64(b[4:], exp)
	m.Write(b[:])
	m.Write([]byte(l.Code))
	return m.Sum(nil)[:unlockMACLen]
}

// signUnlock is the cookie value: base64url(exp ‖ MAC).
func signUnlock(key []byte, l sqlc.DiskLink, exp time.Time) string {
	e := uint64(max(exp.Unix(), 0))
	b := binary.BigEndian.AppendUint64(make([]byte, 0, 8+unlockMACLen), e)
	return base64.RawURLEncoding.EncodeToString(append(b, unlockMAC(key, l, e)...))
}

// verifyUnlock checks tok for link l at now (constant-time MAC comparison).
func verifyUnlock(key []byte, l sqlc.DiskLink, tok string, now time.Time) bool {
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || len(raw) != 8+unlockMACLen || len(key) == 0 {
		return false
	}
	exp := binary.BigEndian.Uint64(raw[:8])
	if !hmac.Equal(raw[8:], unlockMAC(key, l, exp)) {
		return false
	}
	return now.Unix() < int64(min(exp, 1<<62)) //nolint:gosec // bounded above
}

// linkPath is the API path the unlock cookie is scoped to.
func linkPath(code string) string { return "/api/public/disk/" + code }

// unlocked reports whether the request carries a valid unlock of link l (a link without a
// password is always open).
func (s *Service) unlocked(r *http.Request, l sqlc.DiskLink) bool {
	if l.PasswordHash == nil {
		return true
	}
	for _, c := range r.CookiesNamed(unlockCookie) {
		if verifyUnlock(s.UnlockKey, l, c.Value, s.Now()) {
			return true
		}
	}
	return false
}

// validPassword checks a new link password's length (characters).
func validPassword(p string) error {
	if n := utf8.RuneCountInString(p); n < PasswordMin || n > PasswordMax || !utf8.ValidString(p) {
		return httpx.Validation("password", "4 to 128 characters")
	}
	return nil
}

// publicUnlock: POST /api/public/disk/{code}/unlock — anonymous: the password of a protected
// link. 204 + the unlock cookie; a wrong password (or none sent) is errLocked. Spends the per-IP
// limit first, then the per-link one, before any hashing; a link without a password answers 204
// without a cookie.
func (s *Service) publicUnlock(w http.ResponseWriter, r *http.Request) error {
	row, err := s.resolveLink(w, r, s.LinkUnlockLimit)
	if err != nil {
		return err
	}
	var req v1.UnlockDiskLinkRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	l := row.link
	if l.PasswordHash == nil {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	ctx := r.Context()
	if s.LinkUnlockLinkLimit != nil {
		if err := s.LinkUnlockLinkLimit.Take(ctx, l.ID.String()); err != nil {
			return err
		}
	}
	pw := req.GetPassword()
	if len(pw) > PasswordMax*4 {
		pw = "" // never hash an oversized body; still runs the hash below for the same timing
	}
	ok, err := auth.VerifyPassword(ctx, pw, *l.PasswordHash)
	if err != nil {
		return err
	}
	if !ok || pw == "" || len(s.UnlockKey) == 0 {
		return errLocked
	}
	exp := s.Now().Add(UnlockTTL)
	if l.ExpiresAt != nil && l.ExpiresAt.Before(exp) {
		exp = *l.ExpiresAt
	}
	http.SetCookie(w, &http.Cookie{
		Name: unlockCookie, Value: signUnlock(s.UnlockKey, l, exp), Path: linkPath(l.Code), Expires: exp,
		MaxAge: max(int(time.Until(exp).Seconds()), 1), HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// inlineExt are text-like files the page's text viewer opens (the client's diskPreview lists).
var inlineExt = map[string]bool{
	"md": true, "markdown": true, "csv": true, "tsv": true,
	"txt": true, "log": true, "ini": true, "cfg": true, "conf": true, "env": true, "diff": true, "patch": true,
	"js": true, "jsx": true, "mjs": true, "cjs": true, "ts": true, "tsx": true, "json": true, "jsonl": true, "go": true,
	"py": true, "rs": true, "java": true, "kt": true, "swift": true, "c": true, "h": true, "cpp": true, "cs": true,
	"rb": true, "php": true, "html": true, "css": true, "scss": true, "yml": true, "yaml": true, "sh": true,
	"sql": true, "xml": true, "toml": true,
}

// viewable reports whether a file opens in one of the page's in-browser viewers (images, video,
// audio, PDF, text / code / Markdown / CSV): what a view-only link still serves, inline.
func viewable(name, mime string) bool {
	m := strings.ToLower(mime)
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	switch {
	case strings.HasPrefix(m, "image/"), strings.HasPrefix(m, "video/"), strings.HasPrefix(m, "audio/"),
		strings.HasPrefix(m, "text/"), m == "application/pdf":
		return true
	case m == "application/json", m == "application/xml", m == "application/javascript", m == "application/x-sh",
		m == "application/x-yaml", m == "application/sql":
		return true
	}
	return inlineExt[strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")]
}
