//go:build integration

package admin_test

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// «Тариф не активен» in the superadmin list and details (ADR-0086 amendment 1): a stopped account
// with lapsed_at set reads lapsed = true, and status=lapsed lists exactly those.
func TestAdminAccountLapsedStateAndFilter(t *testing.T) {
	e := newEnv(t, 2)
	e.enable()
	ctx := context.Background()
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'stopped', next_due_at = NULL, lapsed_at = now() WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	var list v1.AdminBillingAccounts
	e.must("GET", "/api/admin/billing/accounts?q="+e.ws.String()+"&status=lapsed", nil, &list)
	if len(list.GetAccounts()) != 1 {
		t.Fatalf("lapsed filter: %v", &list)
	}
	a := list.GetAccounts()[0]
	if a.GetAccountId() != e.acc.String() || !a.GetLapsed() || a.GetLapsedAt() == nil || a.GetStatus() != v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_STOPPED {
		t.Fatalf("lapsed account: %v", a)
	}
	var det v1.AdminBillingAccountDetails
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	if !det.GetAccount().GetLapsed() {
		t.Fatalf("details: %v", &det)
	}
	// Plain stopped (Free after the paid days) is not lapsed, and the stopped filter still has both.
	e.must("GET", "/api/admin/billing/accounts?q="+e.ws.String()+"&status=stopped", nil, &list)
	if len(list.GetAccounts()) != 1 {
		t.Fatalf("stopped filter: %v", &list)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET lapsed_at = NULL WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	e.must("GET", "/api/admin/billing/accounts?q="+e.ws.String()+"&status=lapsed", nil, &list)
	if len(list.GetAccounts()) != 0 {
		t.Fatalf("lapsed filter after leaving the mode: %v", &list)
	}
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	if det.GetAccount().GetLapsed() || det.GetAccount().GetLapsedAt() != nil {
		t.Fatalf("details after leaving: %v", &det)
	}
	e.wantErr(422, "", "GET", "/api/admin/billing/accounts?status=nonsense", nil)
}
