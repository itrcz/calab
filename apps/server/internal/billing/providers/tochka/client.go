package tochka

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// maxResponse bounds a response body we read (a list page of 100 operations is far smaller).
const maxResponse = 4 << 20

// APIError is a definite answer of the bank that refused the request (4xx other than the cases
// mapped to provider.ErrNotFound): nothing happened. Only non-secret fields; Message is redacted.
type APIError struct {
	Op        string
	Status    int
	Code      string // the bank's errorCode
	RequestID string // the bank's error id
	Message   string
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("tochka %s: %d", e.Op, e.Status)
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

// errDuplicate: a payment link with this paymentLinkId exists already (424 «заказ … существует»).
var errDuplicate = errors.New("tochka: payment link id exists")

// errorBody is the bank's error envelope.
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

// do sends one request (never retried: no request of this API is idempotent) and decodes a 2xx
// answer into out. Errors:
//   - transport errors, timeouts, 5xx, 429 and undecodable 2xx bodies: provider.ErrUnknownOutcome
//     (the request may have happened);
//   - 404, or 424 whose message says the object is not found: provider.ErrNotFound;
//   - 424 «… существует» on a create: errDuplicate (with *APIError);
//   - other 4xx (and 424): *APIError, a definite refusal.
func (p *Provider) do(ctx context.Context, op, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%w: %s: %w", ErrInvalidRequest, op, err)
		}
		rd = bytes.NewReader(b)
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
			return fmt.Errorf("tochka %s: %w: %w", op, provider.ErrUnknownOutcome, cause)
		}
		return fmt.Errorf("tochka %s: %w: %s", op, provider.ErrUnknownOutcome, redact(err.Error()))
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return fmt.Errorf("tochka %s: %w: read body: %s", op, provider.ErrUnknownOutcome, redact(err.Error()))
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("tochka %s: %w: undecodable answer", op, provider.ErrUnknownOutcome)
		}
		return nil
	}
	var eb errorBody
	_ = json.Unmarshal(raw, &eb)
	ae := &APIError{Op: op, Status: resp.StatusCode, RequestID: eb.ID, Message: redact(eb.Message)}
	msg := eb.Message
	if len(eb.Errors) > 0 {
		ae.Code, msg = eb.Errors[0].ErrorCode, eb.Errors[0].Message
		ae.Message = redact(msg)
	}
	low := strings.ToLower(msg)
	switch {
	case resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode >= http.StatusInternalServerError:
		return fmt.Errorf("%w: %w", provider.ErrUnknownOutcome, ae)
	case resp.StatusCode == http.StatusNotFound,
		resp.StatusCode == http.StatusFailedDependency && (strings.Contains(low, "not found") || strings.Contains(low, "не найден")):
		return fmt.Errorf("%w: %w", provider.ErrNotFound, ae)
	case resp.StatusCode == http.StatusFailedDependency && strings.Contains(low, "существует"):
		return fmt.Errorf("%w: %w", errDuplicate, ae)
	}
	return ae
}
