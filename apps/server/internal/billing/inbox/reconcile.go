package inbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// reconcileBatch bounds the rows one reconciliation pass looks at per kind.
const reconcileBatch = 100

// RunReconcile pulls what webhooks may have missed until ctx is done: every ReconcileEvery the
// stale open checkouts and processing payments (and the «one day left» mails), every
// ImportEvery the payments of recently active customers. Idle cost: a few indexed queries per
// pass, no provider call without a pending row or recent activity.
func (in *Inbox) RunReconcile(ctx context.Context) {
	t := time.NewTicker(in.opts.ReconcileEvery)
	defer t.Stop()
	lastImport := time.Time{}
	for {
		in.Reconcile(ctx)
		if time.Since(lastImport) >= in.opts.ImportEvery {
			lastImport = time.Now()
			in.Import(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Reconcile runs one pass over stale checkouts, processing payments and accounts about to be
// suspended. Errors are logged per row.
func (in *Inbox) Reconcile(ctx context.Context) {
	now, err := billing.DBClock{}.Now(ctx, in.db.Q)
	if err != nil {
		slog.WarnContext(ctx, "billing reconcile: clock", "err", err)
		return
	}
	cos, err := in.db.Q.ListBillingCheckoutsToReconcile(ctx, sqlc.ListBillingCheckoutsToReconcileParams{Before: now.Add(-in.opts.StaleCheckout), Lim: reconcileBatch})
	if err != nil {
		slog.WarnContext(ctx, "billing reconcile: checkouts", "err", err)
	}
	for _, co := range cos {
		if co.ProviderSessionID == nil {
			// The provider call never answered: the payer has no page to pay on.
			if _, err := db.GuardValue(ctx, in.db, func(q *sqlc.Queries) (sqlc.BillingCheckout, error) {
				return q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{Status: CheckoutCanceled, Now: now, ID: co.ID})
			}); err != nil && !db.IsNotFound(err) {
				slog.WarnContext(ctx, "billing reconcile: cancel checkout", "checkout", co.ID, "err", err)
			}
			continue
		}
		if _, err := in.SyncCheckout(ctx, co, "reconcile"); err != nil {
			slog.WarnContext(ctx, "billing reconcile: checkout", "checkout", co.ID, "err", err)
		}
	}
	pays, err := in.db.Q.ListBillingPaymentsProcessing(ctx, reconcileBatch)
	if err != nil {
		slog.WarnContext(ctx, "billing reconcile: payments", "err", err)
	}
	for _, pay := range pays {
		p, ok := in.reg.Provider(provider.ID(pay.Provider))
		if !ok {
			continue
		}
		if _, err := in.SyncPayment(ctx, p, pay.ProviderPaymentID, "reconcile"); err != nil {
			slog.WarnContext(ctx, "billing reconcile: payment", "payment", pay.ID, "err", err)
		}
	}
	if err := in.retryRefunds(ctx, nil, now.Add(-refundRetryAfter)); err != nil {
		slog.WarnContext(ctx, "billing reconcile: refunds", "err", err)
	}
	if in.Mail != nil {
		soon, err := in.db.Q.ListBillingAccountsSuspendingSoon(ctx, sqlc.ListBillingAccountsSuspendingSoonParams{Now: now, Until: now.Add(billing.Day), Lim: reconcileBatch})
		if err != nil {
			slog.WarnContext(ctx, "billing reconcile: suspending soon", "err", err)
		}
		for _, acc := range soon {
			if err := in.Mail.NotifyTx(ctx, acc.ID, "suspend_soon:"+stamp(*acc.SuspendAt), mail.TemplateBillingSuspendSoon, mail.Params{
				"amount": amountText(-acc.BalanceMinor, acc.Currency), "deadline": deadline(*acc.SuspendAt),
			}); err != nil {
				slog.WarnContext(ctx, "billing reconcile: mail", "account", acc.ID, "err", err)
			}
		}
	}
}

// Import lists the payments of customers with activity in the last ImportWindow and applies
// the succeeded ones we do not have (origin checkout / auto_topup from their metadata, else
// import): webhooks that never arrived are credited once like any other.
func (in *Inbox) Import(ctx context.Context) {
	now, err := billing.DBClock{}.Now(ctx, in.db.Q)
	if err != nil {
		return
	}
	since := now.Add(-in.opts.ImportWindow)
	custs, err := in.db.Q.ListBillingDirtyCustomers(ctx, sqlc.ListBillingDirtyCustomersParams{Since: since, Lim: reconcileBatch})
	if err != nil {
		slog.WarnContext(ctx, "billing import: customers", "err", err)
		return
	}
	for _, c := range custs {
		p, ok := in.reg.Provider(provider.ID(c.Provider))
		if !ok || !p.Caps().Has(provider.CapListPayments) {
			continue
		}
		if err := in.importCustomer(ctx, p, c, since); err != nil {
			slog.WarnContext(ctx, "billing import: customer", "customer", c.ID, "err", err)
		}
	}
}

func (in *Inbox) importCustomer(ctx context.Context, p provider.Provider, c sqlc.BillingCustomer, since time.Time) error {
	ref := provider.CustomerRef{Provider: p.ID(), ProviderAccount: c.ProviderAccount, Livemode: c.Livemode, ID: c.CustomerID}
	cursor := ""
	for range 10 { // ≤ 1000 payments per customer and pass
		facts, next, err := p.ListPayments(ctx, provider.ListReq{Customer: ref, CreatedAfter: since, Cursor: cursor, Limit: 100})
		if err != nil {
			return err
		}
		for _, f := range facts {
			if f.Status != provider.PaymentSucceeded && f.Status != provider.PaymentProcessing {
				continue
			}
			pay, err := in.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
				Provider: string(p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.ID,
			})
			if err == nil && pay.Status == string(f.Status) {
				continue
			}
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if _, err := in.applyPayment(ctx, p, f, "reconcile"); err != nil {
				slog.WarnContext(ctx, "billing import: payment", "payment", f.ID, "err", err)
			}
		}
		if next == "" {
			return nil
		}
		cursor = next
	}
	return nil
}
