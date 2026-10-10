// Package billinghttp registers the billing REST routes (ADR-0080 v5 §13, docs/plans/
// billing-v1-tasks.md). T0 registered every route with a 501 handler so the route tables
// (internal/app botroutes.go / identityroutes.go) are final; T5 (owner + public routes) and
// T6 (admin routes, billing/admin) fill Handlers.Owner / Public / Admin, not the patterns.
//
// Classification (internal/app):
//   - /api/workspaces/{id}/billing/…: private, people only (bots denied), identity scope
//     "billing" (workspace of {id}; the owner and BILLING_TOPUP / MANAGE holders keep it under a
//     billing suspension). Handlers check
//     the caller's billing bit of the route (ADR-0087: 403 BILLING_PERMISSION_REQUIRED) except
//     GET /, which shows members without BILLING_VIEW the status only.
//   - POST /api/billing/{stripe,tochka,tochkapay}/webhook, GET /api/billing/public/offers and GET
//     /api/billing/return: public, no session; a webhook reads the raw body and verifies the
//     provider signature itself.
//   - /api/admin/billing/…: private, identity scope admin (superadmin + recent local auth);
//     handlers additionally answer 404 to non-superadmins like plans.Admin.
package billinghttp

import (
	"net/http"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/httpx"
)

// OwnerRoutes are the routes under /api/workspaces/{id}/billing.
var OwnerRoutes = []string{
	"GET /api/workspaces/{id}/billing",
	"POST /api/workspaces/{id}/billing/quote",
	"POST /api/workspaces/{id}/billing/activate",
	"POST /api/workspaces/{id}/billing/stop",
	"POST /api/workspaces/{id}/billing/change-plan",
	"POST /api/workspaces/{id}/billing/resume",
	"GET /api/workspaces/{id}/billing/payer",
	"PUT /api/workspaces/{id}/billing/payer",
	"GET /api/workspaces/{id}/billing/payer-schema", // ADR-0080 §0.1: the country requisites
	"POST /api/workspaces/{id}/billing/topups",
	"GET /api/workspaces/{id}/billing/checkouts/{cid}",
	"GET /api/workspaces/{id}/billing/auto-topup",
	"PUT /api/workspaces/{id}/billing/auto-topup",
	"DELETE /api/workspaces/{id}/billing/auto-topup",
	"GET /api/workspaces/{id}/billing/payment-methods",
	"DELETE /api/workspaces/{id}/billing/payment-methods/{pmId}",
	"POST /api/workspaces/{id}/billing/saved-method-topups",      // ADR-0083 phase 2: one-click top-up
	"GET /api/workspaces/{id}/billing/saved-method-topups/{tid}", // its state (re-reads the provider)
	"GET /api/workspaces/{id}/billing/ledger",
	"GET /api/workspaces/{id}/billing/payments",
	"GET /api/workspaces/{id}/billing/refund-requests",
	"POST /api/workspaces/{id}/billing/refund-requests",
}

// PublicRoutes need no session.
var PublicRoutes = []string{
	"POST /api/billing/stripe/webhook",
	"POST /api/billing/tochka/webhook",    // ADR-0083: RS256 JWT body, verified by the adapter
	"POST /api/billing/tochkapay/webhook", // ADR-0083 phase 3: Pay Gateway, RS256 JWT body
	"GET /api/billing/public/offers",      // ADR-0083: landing prices, cacheable, rate-limited
	"GET /api/billing/return",
}

// AdminRoutes are the routes under /api/admin/billing.
var AdminRoutes = []string{
	"GET /api/admin/billing/accounts",
	"GET /api/admin/billing/accounts/{id}",
	"GET /api/admin/billing/accounts/{id}/ledger",
	"GET /api/admin/billing/payments",
	"GET /api/admin/billing/refunds",
	"GET /api/admin/billing/refund-requests",
	"GET /api/admin/billing/disputes",
	"GET /api/admin/billing/events",
	"POST /api/admin/billing/workspaces/{id}/enable",
	"POST /api/admin/billing/accounts/{id}/manual-credits",
	"POST /api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse",
	"POST /api/admin/billing/accounts/{id}/admin-debit",
	"POST /api/admin/billing/payments/{id}/refunds",
	"POST /api/admin/billing/refund-requests/{id}/decide",
	"POST /api/admin/billing/accounts/{id}/hold",
	"POST /api/admin/billing/accounts/{id}/reconcile",
	"POST /api/admin/billing/auto-topup/reconcile", // restore reconcile of auto-topup (T7)
	"PUT /api/admin/billing/accounts/{id}/discount",
	"POST /api/admin/billing/accounts/{id}/market", // ADR-0083: before the first payment only
	"GET /api/admin/billing/providers",             // ADR-0083: «принимать новых клиентов»
	"PUT /api/admin/billing/providers/{provider}",
	"GET /api/admin/billing/prices",
	"POST /api/admin/billing/prices",
	"POST /api/admin/billing/test-clock", // BILLING_TEST_CLOCK=1 only, else 404
}

// Handlers serves the billing routes. Owner and Public map an owner / public pattern to its
// implementation (T5, Service.Owner / Service.Public); Admin maps an admin pattern (T6,
// billing/admin). A pattern without one answers 501 BILLING_NOT_IMPLEMENTED
// (BILLING_DISABLED while the master switch is off).
type Handlers struct {
	Enabled bool // BILLING_ENABLED
	Owner   map[string]httpx.HandlerFunc
	Public  map[string]httpx.HandlerFunc
	Admin   map[string]httpx.HandlerFunc
}

// Routes registers every billing route: private wraps the authenticated ones (auth, bot and
// identity gates of internal/app); public ones are registered as they are.
func (h *Handlers) Routes(mux httpx.Router, private func(http.Handler) http.Handler) {
	for _, p := range OwnerRoutes {
		mux.Handle(p, private(h.handler(h.Owner[p])))
	}
	for _, p := range AdminRoutes {
		mux.Handle(p, private(h.handler(h.Admin[p])))
	}
	for _, p := range PublicRoutes {
		mux.Handle(p, h.handler(h.Public[p]))
	}
}

func (h *Handlers) handler(impl httpx.HandlerFunc) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		if !h.Enabled {
			return billing.ErrDisabled
		}
		if impl == nil {
			return billing.ErrNotImplemented
		}
		return impl(w, r)
	}
}
