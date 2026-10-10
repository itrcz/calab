package app

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	billinghttp "github.com/calaba/calaba/server/internal/billing/http"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/stripe"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
	"github.com/calaba/calaba/server/internal/billing/worker"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
)

// billingRuntime is balance billing assembled from config.Billing (ADR-0080 v5). With
// BILLING_ENABLED=false nothing is built: every route answers 501 and nothing runs.
type billingRuntime struct {
	cfg      config.Billing
	Handlers *billinghttp.Handlers
	// Core is the money core (nil when disabled); it implements billing.Seats (T3 admission).
	Core     *core.Core
	Inbox    *inbox.Inbox
	Registry *provider.Registry
	Clock    billing.Clock // *billing.SwitchClock when admin.TestClockAllowed (T6 test-clock route)
	due      *worker.Worker
	stripe   *stripe.Provider
	// AutoTopup runs the off-session attempts (T7); its recovery runs whenever billing is on,
	// new attempts only with BILLING_AUTO_TOPUP_ENABLED.
	AutoTopup *autotopup.Job
}

// newBilling wires the providers (BILLING_PROVIDERS; Stripe when BILLING_STRIPE_ENABLED), the
// core with its post-commit hook (Business identity grants, plans.Invalidate, WORKSPACE_UPDATE with Workspace.billing to
// the workspace, BILLING_UPDATE to the owner, state mails), the webhook inbox and the owner /
// public handlers. Invalid Stripe settings panic like other config errors (config.Validate
// checks them first).
func newBilling(d Deps, planSvc *plans.Service, pub events.Publisher, mailSvc *mail.Service) *billingRuntime {
	b := d.Config.Billing
	rt := &billingRuntime{cfg: b, Handlers: &billinghttp.Handlers{Enabled: b.Enabled}}
	if !b.Enabled {
		return rt
	}
	var providers []provider.Provider
	if b.StripeEnabled {
		sp, err := stripe.New(stripe.FromEnv(b.StripeSecretKey, b.StripeWebhookSecret, b.StripeAPIVersion, b.StripeLivemodeAllowed))
		if err != nil {
			panic(err)
		}
		rt.stripe = sp
		providers = append(providers, sp)
	}
	if b.TochkaEnabled {
		tp, err := tochka.New(TochkaConfig(b))
		if err != nil {
			panic(err)
		}
		providers = append(providers, tp)
	}
	rows := provider.DefaultMatrix()
	if b.TochkaSBPBindingEnabled {
		// ADR-0083 phase 3: SBP binding through the Pay Gateway; auto-topup only (no hosted
		// checkout), admitted to off-session together with the no-repost dispatch.
		pp, err := tochkapay.New(TochkaPayConfig(b))
		if err != nil {
			panic(err)
		}
		providers = append(providers, pp)
		rows = append(rows, provider.SBPBindingRow())
	}
	reg, err := provider.NewRegistry(b.Providers, rows, providers...)
	if err != nil {
		panic(err) // BILLING_PROVIDERS is validated by config.Validate
	}
	rt.Registry = reg
	rt.Clock = billing.DBClock{}
	var testClock *billing.SwitchClock
	if admin.TestClockAllowed(b) {
		testClock = &billing.SwitchClock{}
		rt.Clock = testClock
	}
	notifier := inbox.NewNotifier(d.DB, mailSvc, d.Config.PublicAppURL)
	committed := func(ctx context.Context, acc sqlc.BillingAccount) {
		billingCommitted(ctx, d, planSvc, pub, notifier, acc)
		if rt.AutoTopup != nil {
			rt.AutoTopup.Wake() // a renewal debit may have lowered the balance
		}
	}
	rt.Core = core.New(d.DB, rt.Clock, core.Config{Debits: b.DebitsEnabled, Enforcement: b.EnforcementEnabled}, core.Hooks{
		Committed: func(ctx context.Context, acc sqlc.BillingAccount, _ bool) { committed(ctx, acc) },
	})
	if d.Seats == nil {
		// Admission charges paid seats through the core (T3 hook; tests inject Deps.Seats).
		planSvc.SetBilling(plans.Billing{Seats: rt.Core, Enabled: true, Enforced: b.EnforcementEnabled})
	}
	rt.Inbox = inbox.New(d.DB, reg, rt.Core, inbox.Options{})
	rt.Inbox.Committed, rt.Inbox.Mail = committed, notifier
	rt.AutoTopup = autotopup.New(d.DB, rt.Core, reg, rt.Inbox, rt.Clock, autotopup.Options{
		Enabled: b.AutoTopupEnabled, RestoreMarker: b.AutoTopupRequireReconcile, ReturnURL: b.PublicReturnURL,
	})
	rt.Inbox.AttemptSettled = rt.AutoTopup.AttemptSettled
	svc := billinghttp.New(d.DB, rt.Core, reg, rt.Inbox, rt.Clock, billinghttp.Config{
		Checkouts: b.StripeEnabled || b.TochkaEnabled, ReturnURL: b.PublicReturnURL, AppURL: d.Config.PublicAppURL,
		SelfServe:  b.SelfServe,
		PlanLimits: func(p v1.Plan) *v1.PlanLimits { return planSvc.PlanLimits(p).Proto() },
		Committed:  committed,
		Contact:    d.Config.PlanContact(),

		SavedMethodTopups: b.SavedMethodTopupEnabled, Charger: rt.AutoTopup,
		// One-click top-ups: 5 per minute per billing account (a retry of the same request_id included).
		ChargeLimiter: redisx.NewRateLimiter(d.Redis, "rl:billing-charge:", 5, 5),

		LandingOrigins: d.Config.LandingOrigins(),
		// The landing reads it: 30 per minute and IP is plenty with Cache-Control max-age=300.
		PublicLimiter: redisx.NewRateLimiter(d.Redis, "rl:billing-public:", 30, 30),
	})
	rt.Handlers.Owner, rt.Handlers.Public = svc.Owner(), svc.Public()
	rt.Handlers.Admin = admin.New(admin.Deps{
		DB: d.DB, Core: rt.Core, Clock: rt.Clock, Providers: reg, ProviderSpec: b.Providers, Reconciler: rt.Inbox,
		TestClock: testClock, Limiter: redisx.NewRateLimiter(d.Redis, "rl:billing-admin:", 60, 60), // 60 per minute
		Committed: committed,
	}).Handlers()
	rt.Handlers.Admin[autotopup.ReconcileRoute] = rt.AutoTopup.ReconcileHandler()
	rt.due = worker.New(rt.Core, worker.Options{Suspend: b.EnforcementEnabled})
	return rt
}

// Routes registers every billing route (501 while disabled or not built yet).
func (rt *billingRuntime) Routes(mux httpx.Router, private func(http.Handler) http.Handler) {
	rt.Handlers.Routes(mux, private)
}

// Run starts the background work of billing until ctx is done: the merchant account lookup,
// the inbox worker and the reconciliation, the due worker (BILLING_DEBITS_ENABLED), the
// nightly integrity check and the auto-topup job. Nothing runs while billing is disabled.
func (rt *billingRuntime) Run(ctx context.Context) {
	if !rt.cfg.Enabled {
		return
	}
	if rt.stripe != nil {
		go resolveStripeAccount(ctx, rt.stripe)
	}
	go rt.Inbox.Run(ctx)
	go rt.Inbox.RunReconcile(ctx)
	if rt.cfg.TochkaEnabled {
		go rt.Inbox.RunPoll(ctx) // ADR-0083: open checkouts of providers without failure webhooks
	}
	if worker.Enabled(rt.cfg) {
		go rt.due.Run(ctx)
	}
	go rt.due.RunIntegrity(ctx)
	go rt.AutoTopup.Run(ctx)
}

// TochkaConfig is the adapter config of the env (also used by `server tochka …`).
func TochkaConfig(b config.Billing) tochka.Config {
	return tochka.Config{
		BaseURL: b.TochkaAPIURL, Token: b.TochkaAPIToken, CustomerCode: b.TochkaCustomerCode, MerchantID: b.TochkaMerchantID,
		TaxSystem: b.TochkaTaxSystem, VatType: b.TochkaVatType, WebhookKey: b.TochkaWebhookKey, ClientID: b.TochkaClientID,
		Recurring: b.TochkaRecurring,
	}
}

// TochkaPayConfig is the Pay Gateway adapter config of the env (also used by `server tochkapay …`).
func TochkaPayConfig(b config.Billing) tochkapay.Config {
	return tochkapay.Config{
		BaseURL: b.TochkaPayAPIURL, Token: b.TochkaPayToken(), SiteUID: b.TochkaPaySiteUID, SigningKey: b.TochkaPaySigningKey,
		Live: b.TochkaPayLive, WebhookKey: b.TochkaWebhookKey, CallbackURL: b.TochkaPayCallbackURL,
	}
}

// resolveStripeAccount resolves the merchant account once at startup so webhooks do not wait
// on the first lookup; retried every 30 s until it answers.
func resolveStripeAccount(ctx context.Context, p *stripe.Provider) {
	for {
		_, err := p.Account(ctx)
		if err == nil || ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "billing: resolve Stripe account", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}

// billingCommitted runs after a committed billing change of acc: the Business identity grants
// of the billing plan (plans.SyncBillingIdentity, the post-commit equivalent of the superadmin
// plan edit; never inside the core's transaction, which holds the account lock), the plan
// cache, the members' Workspace.billing (WORKSPACE_UPDATE, no amounts), the owner's
// BILLING_UPDATE and the owner mails of the new state (debt started, suspended).
func billingCommitted(ctx context.Context, d Deps, planSvc *plans.Service, pub events.Publisher, n *inbox.Notifier, acc sqlc.BillingAccount) {
	if acc.WorkspaceID == nil {
		return
	}
	ctx, done := events.Detached(ctx, 5*time.Second)
	defer done()
	wsID := *acc.WorkspaceID
	if _, err := plans.SyncBillingIdentity(ctx, d.DB, wsID); err != nil {
		slog.WarnContext(ctx, "billing: committed: identity grants", "workspace", wsID, "err", err)
	}
	if err := planSvc.BillingChanged(ctx, d.DB.Q, pub, wsID); err != nil {
		slog.WarnContext(ctx, "billing: committed: workspace update", "workspace", wsID, "err", err)
	}
	ws, err := d.DB.Q.GetWorkspace(ctx, wsID)
	if err != nil {
		slog.WarnContext(ctx, "billing: committed: workspace", "workspace", wsID, "err", err)
		return
	}
	pub.User(ctx, ws.OwnerID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BillingUpdate{BillingUpdate: &v1.BillingUpdate{
		WorkspaceId: wsID.String(), Revision: uint64(acc.Revision), //nolint:gosec // revision >= 1 (CHECK)
	}}})
	if err := n.StateChanged(ctx, acc); err != nil {
		slog.WarnContext(ctx, "billing: committed: mail", "account", acc.ID, "err", err)
	}
}
