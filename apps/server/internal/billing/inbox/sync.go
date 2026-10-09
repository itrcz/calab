package inbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Payment statuses and origins (billing_payments).
const (
	payProcessing = "processing"
	paySucceeded  = "succeeded"
	payFailed     = "failed"
	payCanceled   = "canceled"

	originCheckout  = "checkout"
	originAutoTopup = "auto_topup"
	originImport    = "import"
)

// Checkout statuses (billing_checkouts).
const (
	CheckoutOpen      = "open"
	CheckoutCompleted = "completed"
	CheckoutExpired   = "expired"
	CheckoutCanceled  = "canceled"
	CheckoutFailed    = "failed"
)

// PaymentResult is what SyncPayment found and did.
type PaymentResult struct {
	Fact     provider.PaymentFact
	Payment  *sqlc.BillingPayment // nil: nothing recorded (not paid, nothing received)
	Credited bool                 // the payment's money is on the balance (now or before)
	Fresh    bool                 // this call credited it
}

// SyncPayment re-reads a provider payment and applies it: a succeeded payment of one of our
// customers is recorded and credited once, a processing one recorded without money, a failed
// one closes a recorded processing row. path labels the metric (webhook, pull, reconcile).
func (in *Inbox) SyncPayment(ctx context.Context, p provider.Provider, paymentID, path string) (PaymentResult, error) {
	fact, err := p.GetPayment(ctx, paymentID)
	if errors.Is(err, provider.ErrNotFound) {
		return PaymentResult{}, permanent("payment %s: %w", paymentID, ErrOrphan)
	}
	if err != nil {
		return PaymentResult{}, err
	}
	return in.applyPayment(ctx, p, fact, path)
}

// ApplyPaymentFact applies a payment fact read from the provider by the caller (a list page of
// the reconciliation, a test): the same checks and the same single credit as SyncPayment.
func (in *Inbox) ApplyPaymentFact(ctx context.Context, p provider.Provider, fact provider.PaymentFact) (PaymentResult, error) {
	return in.applyPayment(ctx, p, fact, "reconcile")
}

func (in *Inbox) applyPayment(ctx context.Context, p provider.Provider, fact provider.PaymentFact, path string) (PaymentResult, error) {
	res := PaymentResult{Fact: fact}
	if fact.CustomerID == "" {
		return res, permanent("payment %s has no customer: %w", fact.ID, ErrOrphan)
	}
	cust, err := in.db.Q.GetBillingCustomerByProviderID(ctx, sqlc.GetBillingCustomerByProviderIDParams{
		Provider: string(p.ID()), ProviderAccount: fact.ProviderAccount, Livemode: fact.Livemode, CustomerID: fact.CustomerID,
	})
	if db.IsNotFound(err) {
		return res, permanent("payment %s: customer %s (%s, livemode %t): %w", fact.ID, fact.CustomerID, fact.ProviderAccount, fact.Livemode, ErrOrphan)
	}
	if err != nil {
		return res, err
	}
	if m := fact.Metadata.AccountID; m != uuid.Nil && m != cust.AccountID {
		return res, permanent("payment %s: metadata account %s, customer of %s: %w", fact.ID, m, cust.AccountID, ErrMismatch)
	}
	// The checkout / attempt the payment says it belongs to, if it is really this account's.
	var co *sqlc.BillingCheckout
	if id := fact.Metadata.CheckoutID; id != uuid.Nil {
		if c, err := in.db.Q.GetBillingCheckout(ctx, id); err == nil && c.AccountID == cust.AccountID {
			co = &c
		} else if err != nil && !db.IsNotFound(err) {
			return res, err
		}
	}
	var attempt *uuid.UUID
	if id := fact.Metadata.AttemptID; id != uuid.Nil && fact.Metadata.Kind == provider.MetadataKindAutoTopup {
		a, err := in.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: id, AccountID: cust.AccountID})
		if err == nil {
			attempt = &a.ID
		} else if !db.IsNotFound(err) {
			return res, err
		}
	}
	// A card saved by a checkout with save_method: read it before the transaction.
	var saved *provider.SavedMethod
	if co != nil && co.SaveMethod && fact.Status == provider.PaymentSucceeded && fact.PaymentMethodID != "" {
		saved = in.savedMethod(ctx, p, cust, fact.PaymentMethodID)
	}

	var acc sqlc.BillingAccount
	var mismatch error
	changed := false
	err = in.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if acc, err = q.LockBillingAccount(ctx, cust.AccountID); err != nil {
			return err
		}
		if err := sameCurrency(acc, fact); err != nil {
			mismatch = err
			return err
		}
		pay, err := q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
			Provider: string(p.ID()), ProviderAccount: fact.ProviderAccount, Livemode: fact.Livemode, ProviderPaymentID: fact.ID,
		})
		switch {
		case db.IsNotFound(err):
			row, ok, err := insertPayment(ctx, q, p, acc, fact, co, attempt)
			if err != nil || !ok {
				return err
			}
			pay, changed = row, true
		case err != nil:
			return err
		default:
			if pay.AccountID != acc.ID {
				mismatch = permanent("payment %s is recorded for account %s: %w", fact.ID, pay.AccountID, ErrMismatch)
				return mismatch
			}
			before := pay.Status
			if pay, err = advancePayment(ctx, q, pay, fact); err != nil {
				return err
			}
			changed = pay.Status != before
		}
		res.Payment = &pay
		if pay.Status != paySucceeded {
			return nil
		}
		_, err = q.GetBillingFundingLotByPayment(ctx, &pay.ID)
		res.Fresh = db.IsNotFound(err)
		if err != nil && !res.Fresh {
			return err
		}
		if acc, err = in.core.CreditPayment(ctx, q, pay.ID); err != nil {
			return err
		}
		res.Credited = true
		if pay.CheckoutID != nil {
			if _, err := q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{Status: CheckoutCompleted, Now: time.Now(), ID: *pay.CheckoutID}); err != nil && !db.IsNotFound(err) {
				return err
			}
		}
		if res.Fresh && pay.AttemptID != nil && in.AttemptSettled != nil {
			if err := in.AttemptSettled(ctx, q, *pay.AttemptID, pay); err != nil {
				return err
			}
		}
		if saved != nil {
			if err := upsertMethod(ctx, q, cust, *saved); err != nil {
				return err
			}
		}
		if res.Fresh {
			credits.WithLabelValues(path).Inc()
			return in.Mail.Notify(ctx, q, acc, "payment:"+pay.ID.String(), mail.TemplateBillingPaymentReceived, mail.Params{
				"amount": amountText(pay.AmountMinor, pay.Currency), "receipt_url": pay.ReceiptUrl,
			})
		}
		return nil
	})
	if mismatch != nil {
		return res, mismatch
	}
	if err != nil {
		return res, err
	}
	if res.Fresh || changed {
		in.committed(ctx, acc)
	}
	return res, nil
}

func sameCurrency(acc sqlc.BillingAccount, f provider.PaymentFact) error {
	for _, c := range []string{string(f.Amount.Currency), string(f.AmountReceived.Currency)} {
		if c != "" && c != acc.Currency {
			return permanent("payment %s in %s, account %s is %s: %w", f.ID, c, acc.ID, acc.Currency, ErrMismatch)
		}
	}
	return nil
}

// insertPayment records a payment we did not know: succeeded (with the amount received) or
// processing (requested amount, no money yet). ok = false: nothing to record (not paid).
func insertPayment(ctx context.Context, q *sqlc.Queries, p provider.Provider, acc sqlc.BillingAccount, f provider.PaymentFact,
	co *sqlc.BillingCheckout, attempt *uuid.UUID) (sqlc.BillingPayment, bool, error) {
	params := sqlc.InsertBillingPaymentParams{
		AccountID: acc.ID, Provider: string(p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode,
		ProviderPaymentID: f.ID, Currency: acc.Currency, Origin: originImport, ReceiptUrl: f.ReceiptURL,
	}
	if f.ChargeID != "" {
		params.ProviderChargeID = &f.ChargeID
	}
	switch {
	case attempt != nil:
		params.Origin, params.AttemptID = originAutoTopup, attempt
	case co != nil:
		params.Origin, params.CheckoutID = originCheckout, &co.ID
	}
	switch f.Status {
	case provider.PaymentSucceeded:
		if f.AmountReceived.Minor <= 0 {
			return sqlc.BillingPayment{}, false, permanent("payment %s succeeded without amount received: %w", f.ID, ErrMismatch)
		}
		at := succeededAt(f)
		params.Status, params.AmountMinor, params.SucceededAt = paySucceeded, f.AmountReceived.Minor, &at
	case provider.PaymentProcessing:
		if f.Amount.Minor <= 0 {
			return sqlc.BillingPayment{}, false, nil
		}
		params.Status, params.AmountMinor = payProcessing, f.Amount.Minor
	default:
		return sqlc.BillingPayment{}, false, nil // failed / canceled / requires action: no money, nothing to keep
	}
	pay, err := q.InsertBillingPayment(ctx, params)
	if db.IsNotFound(err) {
		// Recorded meanwhile under the same key (the account lock makes this a bug path).
		pay, err = q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
			Provider: params.Provider, ProviderAccount: params.ProviderAccount, Livemode: params.Livemode, ProviderPaymentID: params.ProviderPaymentID,
		})
	}
	return pay, err == nil, err
}

// advancePayment moves a recorded processing payment to its final state.
func advancePayment(ctx context.Context, q *sqlc.Queries, pay sqlc.BillingPayment, f provider.PaymentFact) (sqlc.BillingPayment, error) {
	if pay.Status != payProcessing {
		return pay, nil
	}
	now := time.Now()
	switch f.Status {
	case provider.PaymentSucceeded:
		if f.AmountReceived.Minor <= 0 {
			return pay, permanent("payment %s succeeded without amount received: %w", f.ID, ErrMismatch)
		}
		var charge *string
		if f.ChargeID != "" {
			charge = &f.ChargeID
		}
		return q.MarkBillingPaymentSucceeded(ctx, sqlc.MarkBillingPaymentSucceededParams{
			AmountMinor: f.AmountReceived.Minor, ProviderChargeID: charge, ReceiptUrl: f.ReceiptURL, SucceededAt: succeededAt(f), Now: now, ID: pay.ID,
		})
	case provider.PaymentFailed, provider.PaymentCanceled:
		status := payFailed
		if f.Status == provider.PaymentCanceled {
			status = payCanceled
		}
		return q.SetBillingPaymentClosed(ctx, sqlc.SetBillingPaymentClosedParams{Status: status, Now: now, ID: pay.ID})
	}
	return pay, nil
}

func succeededAt(f provider.PaymentFact) time.Time {
	if !f.SucceededAt.IsZero() {
		return f.SucceededAt.UTC()
	}
	if !f.Created.IsZero() {
		return f.Created.UTC()
	}
	return time.Now().UTC()
}

// savedMethod finds the card a checkout saved (brand / last4 / expiry for the owner UI and
// T7). A failure is logged, not fatal: the credit matters more than the card.
func (in *Inbox) savedMethod(ctx context.Context, p provider.Provider, cust sqlc.BillingCustomer, pmID string) *provider.SavedMethod {
	charger, ok := in.reg.OffSession(p.ID())
	if !ok {
		return nil
	}
	ms, err := charger.ListMethods(ctx, provider.CustomerRef{Provider: p.ID(), ProviderAccount: cust.ProviderAccount, Livemode: cust.Livemode, ID: cust.CustomerID})
	if err != nil {
		slog.WarnContext(ctx, "billing inbox: list saved methods", "customer", cust.ID, "err", err)
		return nil
	}
	for _, m := range ms {
		if m.ID == pmID {
			return &m
		}
	}
	return nil
}

func upsertMethod(ctx context.Context, q *sqlc.Queries, cust sqlc.BillingCustomer, m provider.SavedMethod) error {
	kind := string(m.Kind)
	if kind == "" {
		kind = string(provider.MethodCard)
	}
	p := sqlc.UpsertBillingPaymentMethodParams{
		AccountID: cust.AccountID, CustomerID: cust.ID, Provider: cust.Provider, Livemode: cust.Livemode,
		ProviderPmID: m.ID, Kind: kind, Brand: m.Brand,
	}
	if len(m.Last4) == 4 {
		p.Last4 = &m.Last4
	}
	if m.ExpMonth >= 1 && m.ExpMonth <= 12 {
		v := int16(m.ExpMonth) //nolint:gosec // 1..12
		p.ExpMonth = &v
	}
	if m.ExpYear >= 2000 && m.ExpYear <= 2200 {
		v := int16(m.ExpYear) //nolint:gosec // 2000..2200
		p.ExpYear = &v
	}
	_, err := q.UpsertBillingPaymentMethod(ctx, p)
	if db.IsNotFound(err) {
		return nil // the method is recorded for another account: leave it
	}
	return err
}

// CheckoutResult is a checkout after a pull-sync.
type CheckoutResult struct {
	Checkout sqlc.BillingCheckout
	Payment  *sqlc.BillingPayment
	Credited bool
}

// SyncCheckout pulls a checkout from the provider (success redirect, reconciliation, checkout
// events): its payment goes through SyncPayment; an expired session closes the checkout, a
// completed one with a failed payment fails it. A checkout without a provider session is
// returned as it is.
func (in *Inbox) SyncCheckout(ctx context.Context, co sqlc.BillingCheckout, path string) (CheckoutResult, error) {
	res := CheckoutResult{Checkout: co}
	if co.ProviderSessionID == nil {
		return res, nil
	}
	p, ok := in.reg.Provider(provider.ID(co.Provider))
	if !ok {
		return res, fmt.Errorf("billing inbox: provider %q is not configured", co.Provider)
	}
	fact, err := p.GetCheckout(ctx, *co.ProviderSessionID)
	if errors.Is(err, provider.ErrNotFound) {
		return res, permanent("checkout %s: session %s: %w", co.ID, *co.ProviderSessionID, ErrOrphan)
	}
	if err != nil {
		return res, err
	}
	if m := fact.Metadata.CheckoutID; m != uuid.Nil && m != co.ID {
		return res, permanent("session %s belongs to checkout %s, not %s: %w", fact.ID, m, co.ID, ErrMismatch)
	}
	status := ""
	if fact.PaymentID != "" {
		pr, err := in.SyncPayment(ctx, p, fact.PaymentID, path)
		if err != nil {
			return res, err
		}
		res.Payment, res.Credited = pr.Payment, pr.Credited
		switch pr.Fact.Status {
		case provider.PaymentSucceeded, provider.PaymentProcessing:
			if fact.Status == provider.CheckoutComplete {
				status = CheckoutCompleted
			}
		case provider.PaymentFailed, provider.PaymentCanceled:
			if fact.Status == provider.CheckoutComplete {
				status = CheckoutFailed
			}
		}
	}
	if fact.Status == provider.CheckoutExpired && !res.Credited {
		status = CheckoutExpired
	}
	if status != "" {
		if _, err := db.GuardValue(ctx, in.db, func(q *sqlc.Queries) (sqlc.BillingCheckout, error) {
			return q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{Status: status, Now: time.Now(), ID: co.ID})
		}); err != nil && !db.IsNotFound(err) {
			return res, err
		}
	}
	if res.Checkout, err = in.db.Q.GetBillingCheckout(ctx, co.ID); err != nil {
		return res, err
	}
	return res, nil
}

// checkoutEvent: checkout.session.* (and async failure). The session row may not carry the
// session id yet (the webhook raced the API answer): find it by the metadata checkout id.
func (in *Inbox) checkoutEvent(ctx context.Context, p provider.Provider, ev provider.Event) error {
	co, err := in.db.Q.GetBillingCheckoutBySession(ctx, &ev.ObjectID)
	if db.IsNotFound(err) && ev.Metadata.CheckoutID != uuid.Nil {
		co, err = in.db.Q.GetBillingCheckout(ctx, ev.Metadata.CheckoutID)
		if err == nil && co.ProviderSessionID == nil {
			// Session not stored yet: the topup request stores it; retry later.
			return fmt.Errorf("checkout %s: session %s not stored yet", co.ID, ev.ObjectID)
		}
		if err == nil && *co.ProviderSessionID != ev.ObjectID {
			return permanent("checkout %s has session %s, event %s: %w", co.ID, *co.ProviderSessionID, ev.ObjectID, ErrMismatch)
		}
	}
	if db.IsNotFound(err) {
		if ev.PaymentID != "" {
			_, err := in.SyncPayment(ctx, p, ev.PaymentID, "webhook") // the customer mapping decides
			return err
		}
		return permanent("session %s: %w", ev.ObjectID, ErrOrphan)
	}
	if err != nil {
		return err
	}
	if co.Provider != string(p.ID()) {
		return permanent("checkout %s is of provider %s: %w", co.ID, co.Provider, ErrMismatch)
	}
	_, err = in.SyncCheckout(ctx, co, "webhook")
	return err
}

// methodDetached: the card was detached at the provider (dashboard, our DELETE): mark it and
// end an auto-topup consent that used it.
func (in *Inbox) methodDetached(ctx context.Context, pmID string) error {
	if pmID == "" {
		return nil
	}
	return in.db.Tx(ctx, func(q *sqlc.Queries) error {
		m, err := q.DetachBillingPaymentMethodByProviderID(ctx, sqlc.DetachBillingPaymentMethodByProviderIDParams{Now: time.Now(), ProviderPmID: pmID})
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		_, err = q.RevokeBillingAutoTopupForMethod(ctx, sqlc.RevokeBillingAutoTopupForMethodParams{Now: time.Now(), Reason: "method_detached", PmID: m.ID})
		return err
	})
}
