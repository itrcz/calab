package tochkapay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// maxResponse bounds a response body we read (a QR image is the largest, well under this).
const maxResponse = 4 << 20

// APIError is a definite answer of the bank that refused the request: nothing happened. Only
// non-secret fields; Message is redacted.
type APIError struct {
	Op        string
	Status    int
	Category  string // the bank's message category (REQUEST_VALIDATION_ERROR, OPERATION_FORBIDDEN, …)
	Code      string // the bank's errorCode (SIGNATURE_VERIFICATION_ERROR, MERCHANT_SITE_NOT_FOUND, …)
	RequestID string // the bank's error id, for the bank's support
	Message   string
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("tochkapay %s: %d", e.Op, e.Status)
	if e.Category != "" {
		s += " " + e.Category
	}
	if e.Code != "" {
		s += " code=" + e.Code
	}
	if e.RequestID != "" {
		s += " id=" + e.RequestID
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	return s
}

// errorBody is the bank's error envelope (Справочники → «Статусы и коды ошибок»).
type errorBody struct {
	Code    string `json:"code"`
	ID      string `json:"id"`
	Message string `json:"message"`
	Errors  []struct {
		ErrorCode string `json:"errorCode"`
		Message   string `json:"message"`
	} `json:"Errors"`
}

var (
	jwtLike  = regexp.MustCompile(`eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*`)
	linkLike = regexp.MustCompile(`https?://\S+`)
)

func redact(s string) string {
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	s = jwtLike.ReplaceAllString(s, "[redacted]")
	return linkLike.ReplaceAllString(s, "[url]")
}

// Site-level codes: the site id or merchant is wrong — a configuration error, never «this
// payment does not exist».
var siteCodes = map[string]bool{"MERCHANT_NOT_FOUND": true, "MERCHANT_SITE_NOT_FOUND": true}

// sitePath is /v1.0/sites/{siteUid}/… with escaped segments.
func (p *Provider) sitePath(segments ...string) string {
	s := "/" + APIVersion + "/sites/" + url.PathEscape(p.site)
	for _, seg := range segments {
		s += "/" + url.PathEscape(seg)
	}
	return s
}

// do sends one request (never retried here) and decodes a 2xx answer into out. signed: the body
// carries the Signature header (create payment / refund). Errors:
//   - transport errors, timeouts, 429, 5xx (but 501), 423 (the operation is locked: in progress)
//     and undecodable 2xx bodies: provider.ErrUnknownOutcome (the request may have happened);
//   - 404 of an object (PAYMENT_NOT_FOUND, ENTITY_NOT_FOUND of the object): provider.ErrNotFound;
//   - 404 MERCHANT(_SITE)_NOT_FOUND, 401, 403, 400, 501: *APIError, a definite refusal.
func (p *Provider) do(ctx context.Context, op, method, path string, body any, signed bool, out any) error {
	var raw []byte
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%w: %s: %w", ErrInvalidRequest, op, err)
		}
		raw, rd = b, bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.base+path, rd)
	if err != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalidRequest, op, err)
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if signed {
		sig, err := sign(p.key, raw)
		if err != nil {
			return err
		}
		req.Header.Set("Signature", sig)
	}
	resp, err := p.hc.Do(req)
	if err != nil {
		var cause error
		switch {
		case errors.Is(err, context.Canceled):
			cause = context.Canceled
		case errors.Is(err, context.DeadlineExceeded):
			cause = context.DeadlineExceeded
		}
		if cause != nil {
			return fmt.Errorf("tochkapay %s: %w: %w", op, provider.ErrUnknownOutcome, cause)
		}
		return fmt.Errorf("tochkapay %s: %w: %s", op, provider.ErrUnknownOutcome, redact(err.Error()))
	}
	defer func() { _ = resp.Body.Close() }()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return fmt.Errorf("tochkapay %s: %w: read body: %s", op, provider.ErrUnknownOutcome, redact(err.Error()))
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(rb, out); err != nil {
			return fmt.Errorf("tochkapay %s: %w: undecodable answer", op, provider.ErrUnknownOutcome)
		}
		return nil
	}
	var eb errorBody
	_ = json.Unmarshal(rb, &eb)
	ae := &APIError{Op: op, Status: resp.StatusCode, Category: eb.Message, RequestID: eb.ID}
	if len(eb.Errors) > 0 {
		ae.Code, ae.Message = eb.Errors[0].ErrorCode, redact(eb.Errors[0].Message)
	}
	switch {
	case resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode == http.StatusLocked,
		resp.StatusCode >= http.StatusInternalServerError && resp.StatusCode != http.StatusNotImplemented:
		return fmt.Errorf("%w: %w", provider.ErrUnknownOutcome, ae)
	case resp.StatusCode == http.StatusNotFound && !siteCodes[ae.Code]:
		return fmt.Errorf("%w: %w", provider.ErrNotFound, ae)
	}
	return ae
}
