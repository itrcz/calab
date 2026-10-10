package billing_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
)

func TestWalkByID(t *testing.T) {
	ids := make([]uuid.UUID, 250)
	for i := range ids {
		ids[i] = uuid.Must(uuid.NewV7())
	}
	page := func(after uuid.UUID, lim int32) ([]uuid.UUID, error) {
		var out []uuid.UUID
		for _, id := range ids {
			if id.String() > after.String() && len(out) < int(lim) {
				out = append(out, id)
			}
		}
		return out, nil
	}
	self := func(id uuid.UUID) uuid.UUID { return id }
	for _, n := range []int{0, 99, 100, 250} {
		all := ids
		ids = ids[:n]
		got := 0
		if err := billing.WalkByID(context.Background(), 100, page, self, func(uuid.UUID) { got++ }); err != nil || got != n {
			t.Fatalf("%d rows: visited %d, %v", n, got, err)
		}
		ids = all
	}
	boom := errors.New("boom")
	calls := 0
	err := billing.WalkByID(context.Background(), 100, func(after uuid.UUID, lim int32) ([]uuid.UUID, error) {
		calls++
		if calls == 2 {
			return nil, boom
		}
		return page(after, lim)
	}, self, func(uuid.UUID) {})
	if !errors.Is(err, boom) {
		t.Fatalf("fetch error: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	got := 0
	err = billing.WalkByID(ctx, 100, page, self, func(uuid.UUID) {
		got++
		if got == 10 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || got != 10 {
		t.Fatalf("canceled: %d %v", got, err)
	}
}
