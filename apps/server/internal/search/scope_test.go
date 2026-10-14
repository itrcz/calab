package search

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// scope=all skips a workspace only when it is closed to the caller; a failed dependency fails
// the search instead of silently dropping the workspace (httpx.AsError never returns nil).
func TestRefused(t *testing.T) {
	for name, c := range map[string]struct {
		err  error
		want bool
	}{
		"not a member":     {perm.ErrNotMember, true},
		"wrapped member":   {fmt.Errorf("x: %w", perm.ErrNotMember), true},
		"access policy":    {httpx.Forbidden("access policy"), true},
		"wrapped policy":   {fmt.Errorf("guard: %w", httpx.Forbidden("sso")), true},
		"rate limited":     {httpx.RateLimited(), true},
		"db error":         {fmt.Errorf("perm: load member: %w", &pgconn.PgError{Code: "57014"}), false},
		"plain error":      {errors.New("connection refused"), false},
		"internal":         {httpx.Internal(errors.New("boom")), false},
		"unavailable":      {httpx.Unavailable(errors.New("valkey down")), false},
		"AsError wrapping": {httpx.AsError(errors.New("boom")), false},
	} {
		if got := refused(c.err); got != c.want {
			t.Errorf("%s: refused = %v, want %v", name, got, c.want)
		}
	}
}
