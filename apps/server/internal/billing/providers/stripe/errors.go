package stripe

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// APIError is a definite refusal by Stripe (4xx other than 404 / 409 / 429): the request did
// not happen. It carries only non-secret fields; Message is redacted.
type APIError struct {
	Op          string
	Status      int
	Type        string // card_error, invalid_request_error, …
	Code        string // card_declined, authentication_required, …
	DeclineCode string
	Param       string
	RequestID   string
	Message     string
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("stripe %s: %d %s", e.Op, e.Status, e.Type)
	if e.Code != "" {
		s += " code=" + e.Code
	}
	if e.DeclineCode != "" {
		s += " decline_code=" + e.DeclineCode
	}
	if e.Param != "" {
		s += " param=" + e.Param
	}
	if e.RequestID != "" {
		s += " request_id=" + e.RequestID
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	return s
}

// secretLike matches anything that looks like a key, a client secret or a webhook secret.
var secretLike = regexp.MustCompile(`(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*]+|whsec_[A-Za-z0-9]+|_secret_[A-Za-z0-9]+`)

func redact(s string) string {
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return secretLike.ReplaceAllString(s, "[redacted]")
}

// mapErr turns a stripe-go error into the provider contract. The stripe-go error text (a JSON
// dump that can include the PaymentIntent and its client secret) is never wrapped.
func mapErr(op string, err error) error {
	if err == nil {
		return nil
	}
	var se *stripego.Error
	if !errors.As(err, &se) {
		// Network error, timeout, canceled context, undecodable body: the request may have
		// reached Stripe. errors.Is on the context error still works.
		var cause error
		switch {
		case errors.Is(err, context.Canceled):
			cause = context.Canceled
		case errors.Is(err, context.DeadlineExceeded):
			cause = context.DeadlineExceeded
		}
		if cause != nil {
			return fmt.Errorf("stripe %s: %w: %w", op, provider.ErrUnknownOutcome, cause)
		}
		return fmt.Errorf("stripe %s: %w: %s", op, provider.ErrUnknownOutcome, redact(err.Error()))
	}
	ae := &APIError{
		Op: op, Status: se.HTTPStatusCode, Type: string(se.Type), Code: string(se.Code),
		DeclineCode: string(se.DeclineCode), Param: se.Param, RequestID: se.RequestID, Message: redact(se.Msg),
	}
	switch {
	case se.Type == stripego.ErrorTypeIdempotency:
		// The key was used before with other parameters: whatever the first request created
		// (a refund, a charge) may exist. Never a definite refusal: callers keep the money
		// reserved and reconcile instead of releasing it.
		return fmt.Errorf("%w: %w: %w", ErrIdempotencyMismatch, provider.ErrUnknownOutcome, ae)
	case se.HTTPStatusCode == http.StatusNotFound || se.Code == stripego.ErrorCodeResourceMissing:
		return fmt.Errorf("%w: %w", provider.ErrNotFound, ae)
	case se.HTTPStatusCode == http.StatusConflict, se.HTTPStatusCode == http.StatusTooManyRequests,
		se.HTTPStatusCode >= http.StatusInternalServerError, se.HTTPStatusCode == 0:
		return fmt.Errorf("%w: %w", provider.ErrUnknownOutcome, ae)
	}
	return ae
}

// asStripeError returns the raw stripe-go error (for card errors carrying a PaymentIntent).
func asStripeError(err error) (*stripego.Error, bool) {
	var se *stripego.Error
	ok := errors.As(err, &se)
	return se, ok
}
