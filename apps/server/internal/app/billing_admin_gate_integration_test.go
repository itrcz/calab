//go:build integration

package app_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

// /api/admin/billing/* sits behind the admin identity gate (ADR-0080 §13, T6): a
// non-superadmin gets 404 like an unknown route, a superadmin without a recent local proof
// gets 403 RECENT_AUTH_REQUIRED, a fresh superadmin reaches the billing handlers (501 while
// BILLING_ENABLED is off in this server).
func TestBillingAdminGate(t *testing.T) {
	routes := []struct{ method, path string }{
		{"GET", "/api/admin/billing/accounts"},
		{"POST", "/api/admin/billing/accounts/" + uuid.NewString() + "/manual-credits"},
		{"POST", "/api/admin/billing/payments/" + uuid.NewString() + "/refunds"},
		{"POST", "/api/admin/billing/refund-requests/" + uuid.NewString() + "/decide"},
		{"POST", "/api/admin/billing/accounts/" + uuid.NewString() + "/admin-debit"},
	}
	o := owner(t)
	for _, r := range routes {
		if st, e := o.apiErr(r.method, r.path); st != 404 || e.GetCode() != v1.ErrorCode_ERROR_CODE_NOT_FOUND {
			t.Errorf("%s %s by a non-superadmin: %d %v, want 404", r.method, r.path, st, e)
		}
	}

	su := superadminUser(t)
	for _, r := range routes {
		if st, e := su.apiErr(r.method, r.path); st != 501 {
			t.Errorf("%s %s by a fresh superadmin: %d %v, want 501 (billing off)", r.method, r.path, st, e)
		}
	}

	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET local_authenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", uuid.MustParse(su.session)); err != nil {
		t.Fatal(err)
	}
	auth.ForgetSessionChecks()
	for _, r := range routes {
		if st, e := su.apiErr(r.method, r.path); st != 403 || e.GetCode() != v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED {
			t.Errorf("%s %s with a stale proof: %d %v, want 403 RECENT_AUTH_REQUIRED", r.method, r.path, st, e)
		}
	}
	status, data, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", su.token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	if status != 200 {
		t.Fatalf("local reauth: %d %s", status, data)
	}
	auth.ForgetSessionChecks()
}
