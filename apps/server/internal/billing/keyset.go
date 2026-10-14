package billing

import (
	"context"

	"github.com/google/uuid"
)

// WalkByID visits every row of a keyset query paged by id (after = the last id of the previous
// page, uuid.Nil first; batch rows per page) until a short page or ctx ends. Background passes
// use it instead of one LIMIT page, so rows that stay in a queue (waiting on the provider, on a
// backoff, on an operator) never hide the rows behind them (audit M2). Returns the first fetch
// error or ctx's error; each handles (and logs) its own errors.
func WalkByID[T any](ctx context.Context, batch int32, fetch func(after uuid.UUID, lim int32) ([]T, error), id func(T) uuid.UUID, each func(T)) error {
	after := uuid.Nil
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		rows, err := fetch(after, batch)
		if err != nil {
			return err
		}
		for _, r := range rows {
			if err := ctx.Err(); err != nil {
				return err
			}
			each(r)
		}
		if int32(len(rows)) < batch { //nolint:gosec // a page is at most batch rows
			return nil
		}
		after = id(rows[len(rows)-1])
	}
}
