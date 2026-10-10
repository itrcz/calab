package plans

import (
	"errors"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestBillable(t *testing.T) {
	for _, c := range []struct {
		role string
		bot  bool
		want bool
	}{
		{"owner", false, true}, {"admin", false, true}, {"member", false, true},
		{"guest", false, false}, {"member", true, false}, {"", false, false},
	} {
		if got := Billable(c.role, c.bot); got != c.want {
			t.Errorf("Billable(%q, %v) = %v", c.role, c.bot, got)
		}
	}
}

func TestResolveBilling(t *testing.T) {
	at := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	if b := resolveBilling(sqlc.GetWorkspaceBillingStatusRow{Source: "manual"}, true); b != nil {
		t.Fatal("no account must leave Workspace.billing unset")
	}
	for _, c := range []struct {
		row    sqlc.GetWorkspaceBillingStatusRow
		state  v1.BillingState
		source v1.PlanSource
		due    bool
	}{
		{sqlc.GetWorkspaceBillingStatusRow{Source: "manual", AccountStatus: "inactive"}, v1.BillingState_BILLING_STATE_INACTIVE, v1.PlanSource_PLAN_SOURCE_MANUAL, false},
		{sqlc.GetWorkspaceBillingStatusRow{Source: "billing", AccountStatus: "active"}, v1.BillingState_BILLING_STATE_ACTIVE, v1.PlanSource_PLAN_SOURCE_BILLING, false},
		{sqlc.GetWorkspaceBillingStatusRow{Source: "billing", AccountStatus: "active", NegativeSince: &at, SuspendAt: &at}, v1.BillingState_BILLING_STATE_IN_ARREARS, v1.PlanSource_PLAN_SOURCE_BILLING, true},
		{sqlc.GetWorkspaceBillingStatusRow{Source: "manual", AccountStatus: "stopped", NegativeSince: &at, SuspendAt: &at}, v1.BillingState_BILLING_STATE_STOPPED, v1.PlanSource_PLAN_SOURCE_MANUAL, true},
		{sqlc.GetWorkspaceBillingStatusRow{Source: "billing", AccountStatus: "suspended", NegativeSince: &at, SuspendAt: &at}, v1.BillingState_BILLING_STATE_SUSPENDED, v1.PlanSource_PLAN_SOURCE_BILLING, true},
	} {
		p := resolveBilling(c.row, true).proto()
		if p.GetState() != c.state || p.GetSource() != c.source || (p.GetSuspendAt() != nil) != c.due {
			t.Errorf("%+v → %v", c.row, p)
		}
	}
}

func TestSeatRefused(t *testing.T) {
	if !SeatRefused(billing.ErrSeatGrowthRequiresFunds) || !SeatRefused(billing.ErrWorkspaceBillingSuspended) {
		t.Fatal("billing refusals")
	}
	worded := httpx.Coded(409, v1.ErrorCode_ERROR_CODE_CONFLICT, seatFundsMember).WithDetails(billing.ReasonSeatGrowthRequiresFunds, 0, 0)
	if !SeatRefused(worded) {
		t.Fatal("reworded refusal")
	}
	if SeatRefused(errors.New("db down")) || SeatRefused(LimitError("members", 1, 1)) {
		t.Fatal("other errors are no seat refusal")
	}
}
