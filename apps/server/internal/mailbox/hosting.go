package mailbox

// The mail-hosting admin API client (ADR-0100): one call — reset the password of a mailbox.
// The hosting generates the new password (≥ 16 chars) and revokes the old one immediately;
// the answer carries the password in plain JSON over the admin token's TLS connection.
// Errors are distinguishable: 401 (bad admin token), 404 (no such mailbox), 429 (the
// hosting's own limit) and network/5xx. The password is never logged.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HostingCallTimeout is the per-call timeout (ADR-0100: ~10 s; a stuck hosting must not hold
// the bot's request).
const HostingCallTimeout = 10 * time.Second

// Hosting error codes: the hosting's own ("mailbox_not_found") and ours.
const (
	CodeMailboxNotFound = "mailbox_not_found"
	CodeNetwork         = "network"
	CodeHTTP            = "http"
	CodeBadAnswer       = "bad_answer"
)

// HostingError is a failed hosting call. Status 0 = no HTTP answer (network / timeout).
type HostingError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *HostingError) Error() string {
	return fmt.Sprintf("mailhost: %d %s: %s", e.Status, e.Code, e.Message)
}

// AsHostingError extracts a *HostingError.
func AsHostingError(err error) (*HostingError, bool) {
	var e *HostingError
	ok := errors.As(err, &e)
	return e, ok
}

// Hosting calls the admin API at BaseURL (MAILHOST_ADMIN_URL) with the Bearer admin token.
type Hosting struct {
	base  string
	token string
	hc    *http.Client
	// CallTimeout per call (tests shorten it).
	CallTimeout time.Duration
}

// NewHosting creates the client; an empty baseURL means the feature is off and the client
// is never called.
func NewHosting(baseURL, token string) *Hosting {
	return &Hosting{base: strings.TrimRight(baseURL, "/"), token: token, hc: &http.Client{}, CallTimeout: HostingCallTimeout}
}

// minHostingPassword is the shortest password the hosting may answer with (ADR-0100).
const minHostingPassword = 16

// ResetPassword asks for a new password of the mailbox: the old one stops working on the
// hosting immediately. The address goes out only here, to the hosting.
func (h *Hosting) ResetPassword(ctx context.Context, address string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, h.CallTimeout)
	defer cancel()
	u := h.base + "/admin/api/mailboxes/" + url.PathEscape(address) + "/password/reset"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader([]byte("{}"))) //nolint:gosec // G107: operator-configured URL
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.token)
	resp, err := h.hc.Do(req) //nolint:gosec // G107: operator-configured URL
	if err != nil {
		if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
			return "", ctx.Err()
		}
		return "", &HostingError{Code: CodeNetwork, Message: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", &HostingError{Status: resp.StatusCode, Code: CodeNetwork, Message: err.Error()}
	}
	if resp.StatusCode != http.StatusOK {
		e := &HostingError{Status: resp.StatusCode, Code: CodeHTTP, Message: "HTTP " + strconv.Itoa(resp.StatusCode)}
		var eb struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &eb) == nil && eb.Error != "" {
			e.Code = eb.Error
			if eb.Message != "" {
				e.Message = eb.Message
			}
		}
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 {
			e.RetryAfter = time.Duration(s) * time.Second
		}
		return "", e
	}
	var out struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Password) < minHostingPassword {
		return "", &HostingError{Status: resp.StatusCode, Code: CodeBadAnswer, Message: "reset answer without a password"}
	}
	return out.Password, nil
}
