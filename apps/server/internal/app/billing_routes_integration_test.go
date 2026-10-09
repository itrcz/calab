//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	billinghttp "github.com/calaba/calaba/server/internal/billing/http"
)

// With BILLING_ENABLED=false (the test server's default) every billing route exists and
// answers 501 BILLING_DISABLED after the usual gates: members of another workspace get 404,
// anonymous callers 401 on private routes, and the public webhook / return page need no session.
func TestBillingRoutesDisabled(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	base := "/api/workspaces/" + ws.GetId() + "/billing"
	for _, p := range []struct{ method, path string }{
		{"GET", base}, {"POST", base + "/topups"}, {"GET", base + "/ledger"}, {"DELETE", base + "/auto-topup"},
	} {
		if st := o.do(p.method, p.path, nil, nil); st != 501 {
			t.Fatalf("%s %s: %d", p.method, p.path, st)
		}
		if reason, _ := errReason(o.client); reason != "BILLING_DISABLED" {
			t.Fatalf("%s %s: reason %q", p.method, p.path, reason)
		}
	}
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, o, other.GetId())) // a member of another workspace only
	stranger.must(404, "GET", base, nil, nil)
	anon := &client{t: t}
	anon.must(401, "GET", base, nil, nil)
	anon.must(501, "POST", "/api/billing/stripe/webhook", nil, nil)
	anon.must(501, "GET", "/api/billing/return", nil, nil)
	if len(billinghttp.OwnerRoutes)+len(billinghttp.AdminRoutes)+len(billinghttp.PublicRoutes) != 41 {
		t.Fatal("billing route list changed: update the route tables and this count")
	}
}
