// Package httpx holds HTTP plumbing: the ApiError model, protojson encoding and middleware.
package httpx

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Error is an API error: machine code + HTTP status + safe message for the client.
type Error struct {
	Status  int
	Code    v1.ErrorCode
	Message string
	Field   string
	Err     error // internal cause, logged but never sent
	// RetryAfter, if set, is sent as the Retry-After header (429).
	RetryAfter time.Duration
	// Reason, Used, Limit: optional details (ApiError.reason / used / limit), e.g. a plan
	// limit (ADR-0024).
	Reason      string
	Used, Limit uint64
	base        *Error // the error WithDetails copied (errors.Is matches it)
}

// ReasonPlanLimit marks errors caused by a limit of the workspace plan (ADR-0024).
const ReasonPlanLimit = "PLAN_LIMIT"

// ReasonIdentityNotConfigured marks a CONFLICT from an SSO / directory / OAuth provider route
// of a server without the identity operator configuration (ADR-0054): a normal state of the
// install, not an outage, so clients show «not configured on the server» instead of an error.
const ReasonIdentityNotConfigured = "IDENTITY_NOT_CONFIGURED"

// IsPlanLimit reports whether err is an API error with reason PLAN_LIMIT.
func IsPlanLimit(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Reason == ReasonPlanLimit
}

// WithDetails returns a copy of e with ApiError.reason / used / limit set; errors.Is(copy, e)
// holds.
func (e *Error) WithDetails(reason string, used, limit uint64) *Error {
	c := *e
	c.Reason, c.Used, c.Limit = reason, used, limit
	if c.base == nil {
		c.base = e
	}
	return &c
}

// Is reports whether target is the error this one was copied from by WithDetails.
func (e *Error) Is(target error) bool { return e.base != nil && target == error(e.base) }

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

// Proto converts the error to the wire message.
func (e *Error) Proto() *v1.ApiError {
	p := &v1.ApiError{Code: e.Code, Message: e.Message, Field: e.Field}
	if e.Reason != "" {
		p.Reason = &e.Reason
	}
	if e.Limit > 0 {
		p.Used, p.Limit = &e.Used, &e.Limit
	}
	return p
}

// IsDenial reports a definitive access decision (401, 403, 404, or a 409 plan limit), as
// opposed to a dependency failure or timeout, which says nothing about access. Enforcement
// sweeps evict only on a denial (incident 2026-10-05: a slow DB evicted every participant).
func IsDenial(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return true
	case http.StatusConflict:
		return e.Reason == ReasonPlanLimit
	}
	return false
}

// AsError extracts an *Error from err; unknown errors become 500 INTERNAL.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Status: http.StatusInternalServerError, Code: v1.ErrorCode_ERROR_CODE_INTERNAL, Message: "internal error", Err: err}
}

func newErr(status int, code v1.ErrorCode, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

// BadRequest is a malformed request (400).
func BadRequest(msg string) *Error {
	return newErr(http.StatusBadRequest, v1.ErrorCode_ERROR_CODE_BAD_REQUEST, msg)
}

// Validation reports an invalid field value; field is the lowerCamelCase JSON name.
func Validation(field, msg string) *Error {
	e := newErr(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, msg)
	e.Field = field
	return e
}

// Unauthenticated is a missing or invalid access token (401).
func Unauthenticated(msg string) *Error {
	return newErr(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, msg)
}

// Forbidden is a missing permission (403).
func Forbidden(msg string) *Error {
	if msg == "" {
		msg = "missing permission"
	}
	return newErr(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_FORBIDDEN, msg)
}

// NotFound reports that `what` does not exist or is hidden from the caller (404).
func NotFound(what string) *Error {
	return newErr(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_NOT_FOUND, what+" not found")
}

// Conflict is a uniqueness or state conflict (409).
func Conflict(msg string) *Error {
	return newErr(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, msg)
}

// RateLimited is 429.
func RateLimited() *Error {
	return newErr(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_RATE_LIMITED, "too many requests")
}

// Unavailable is a dependency failure (503).
func Unavailable(err error) *Error {
	e := newErr(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "service unavailable")
	e.Err = err
	return e
}

// Coded builds an error with an explicit status and code.
func Coded(status int, code v1.ErrorCode, msg string) *Error {
	return newErr(status, code, msg)
}

// Internal wraps an unexpected error.
func Internal(err error) *Error {
	return AsError(err)
}
