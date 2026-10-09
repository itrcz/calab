package billing_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestFakeAndSwitchClock(t *testing.T) {
	start := time.Date(2026, 10, 9, 10, 0, 0, 0, time.FixedZone("x", 3600))
	c := billing.NewFakeClock(start)
	now, _ := c.Now(context.Background(), nil)
	if !now.Equal(start) || now.Location() != time.UTC {
		t.Fatalf("fake now %v", now)
	}
	if got := c.Advance(6 * time.Hour); !got.Equal(start.Add(6 * time.Hour)) {
		t.Fatalf("advance %v", got)
	}
	var s billing.SwitchClock
	fixed := start.Add(billing.Day)
	s.Set(&fixed)
	if got, err := s.Now(context.Background(), nil); err != nil || !got.Equal(fixed) {
		t.Fatalf("switch fixed %v %v", got, err)
	}
}

func TestErrorsAreAPIErrors(t *testing.T) {
	for err, want := range map[error]struct {
		status int
		code   v1.ErrorCode
		reason string
	}{
		billing.ErrSeatGrowthRequiresFunds:   {http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, "BILLING_SEAT_GROWTH_REQUIRES_FUNDS"},
		billing.ErrWorkspaceBillingSuspended: {http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "WORKSPACE_BILLING_SUSPENDED"},
		billing.ErrOwnerRequired:             {http.StatusForbidden, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "BILLING_OWNER_REQUIRED"},
		billing.ErrDisabled:                  {http.StatusNotImplemented, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "BILLING_DISABLED"},
	} {
		e := httpx.AsError(err)
		if e.Status != want.status || e.Code != want.code || e.Proto().GetReason() != want.reason {
			t.Errorf("%v: %d %v %q", err, e.Status, e.Code, e.Proto().GetReason())
		}
		if !errors.Is(err, err) {
			t.Errorf("%v does not match itself", err)
		}
	}
	// Billing suspension is a definitive denial (enforcement sweeps may evict on it).
	if !httpx.IsDenial(billing.ErrWorkspaceBillingSuspended) {
		t.Fatal("suspension is not a denial")
	}
}

func TestNoSeatsPasses(t *testing.T) {
	var s billing.Seats = billing.NoSeats{}
	id := uuid.New()
	if s.Admit(context.Background(), nil, id, id, id) != nil || s.Promote(context.Background(), nil, id, id, id) != nil || s.Removed(context.Background(), nil, id, id) != nil {
		t.Fatal("NoSeats refused")
	}
}
