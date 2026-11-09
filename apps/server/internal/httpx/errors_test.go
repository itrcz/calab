package httpx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
)

// ADR-0166: a database that does not answer is an outage (503, the client waits it out and
// keeps its state), not an internal error.
func TestAsErrorDependencyDownIsUnavailable(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		want int
	}{
		{"deadline", fmt.Errorf("load room: timeout: %w", context.DeadlineExceeded), http.StatusServiceUnavailable},
		{"dial", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}, http.StatusServiceUnavailable},
		{"read", &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset")}, http.StatusInternalServerError},
		{"bug", errors.New("nil map"), http.StatusInternalServerError},
		{"canceled", context.Canceled, http.StatusInternalServerError},
		{"typed", NotFound("room"), http.StatusNotFound},
	} {
		if got := AsError(c.err).Status; got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}
