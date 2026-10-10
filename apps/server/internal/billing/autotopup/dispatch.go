package autotopup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/perm"
)

// chargeDescription is the statement / receipt text of an auto-topup payment. It is part of
// the idempotent request: a retry sends the same.
const chargeDescription = "Calab balance auto top-up"

// errSkip rolls back a prepare that lost a race (another instance inserted the open attempt).
var errSkip = errors.New("auto-topup: skipped")

// plan is what an attempt charges: the checked consent, card, customer and amount.
type plan struct {
	acc     sqlc.BillingAccount
	consent sqlc.BillingAutotopup
	pm      sqlc.BillingPaymentMethod
	cust    sqlc.BillingCustomer
	opt     provider.MethodOption
	amount  int64
}

// verdict of check: ok, skip (nothing to do now) or revoke (the consent cannot be used any
// more: written by the caller under the lock).
type verdict struct {
	skip, revoke string
}

func (v verdict) ok() bool { return v.skip == "" && v.revoke == "" }

// check decides whether acc may be charged now. own is the attempt being fenced (nil when
// deciding a new one: then not_before and the open attempt count too). q may be read-only.
func (j *Job) check(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, now time.Time, own *sqlc.BillingAutotopupAttempt) (plan, verdict, error) {
	p := plan{acc: acc}
	switch {
	case acc.Status != core.StatusActive:
		return p, verdict{skip: "status_" + acc.Status}, nil
	case acc.DisputeHold:
		return p, verdict{skip: "dispute_hold"}, nil
	case acc.HoldUntil != nil && acc.HoldUntil.After(now):
		return p, verdict{skip: "hold"}, nil
	case acc.WorkspaceID == nil:
		return p, verdict{skip: "no_workspace"}, nil
	}
	t, err := q.GetBillingAutoTopup(ctx, acc.ID)
	if db.IsNotFound(err) {
		return p, verdict{skip: "no_consent"}, nil
	}
	if err != nil {
		return p, verdict{}, err
	}
	p.consent = t
	if t.RevokedAt != nil {
		return p, verdict{skip: CodeRevoked}, nil
	}
	ws, err := q.GetWorkspace(ctx, *acc.WorkspaceID)
	if err != nil {
		return p, verdict{}, err
	}
	// ADR-0087: the consent holds while the person who gave it is the owner or holds
	// BILLING_MANAGE (a revoked role, a removed member or an ownership change revokes it).
	if t.ConsentBy == nil {
		return p, verdict{revoke: "owner_changed"}, nil
	}
	if *t.ConsentBy != ws.OwnerID {
		bits, _, err := perm.LoadBilling(ctx, q, ws.ID, ws.OwnerID, *t.ConsentBy)
		if err != nil {
			return p, verdict{}, err
		}
		if !bits.Has(perm.BillingManage) {
			return p, verdict{revoke: "permission_lost"}, nil
		}
	}
	if _, known := ConsentTexts[uint32(max(t.ConsentVersion, 0))]; !known { //nolint:gosec // non-negative
		return p, verdict{skip: "consent_version"}, nil
	}
	pmID := t.PmID
	if own != nil {
		if own.PmID != t.PmID {
			return p, verdict{skip: "method_changed"}, nil
		}
	} else {
		if t.NotBefore != nil && t.NotBefore.After(now) {
			return p, verdict{skip: "not_before"}, nil
		}
		if _, err := q.GetOpenBillingAutoTopupAttempt(ctx, acc.ID); err == nil {
			return p, verdict{skip: "open_attempt"}, nil
		} else if !db.IsNotFound(err) {
			return p, verdict{}, err
		}
	}
	if p.pm, err = q.GetBillingPaymentMethod(ctx, pmID); err != nil {
		return p, verdict{}, err
	}
	if p.pm.AccountID != acc.ID || p.pm.DetachedAt != nil {
		return p, verdict{revoke: "method_detached"}, nil
	}
	if _, ok := j.reg.OffSession(provider.ID(p.pm.Provider)); !ok {
		return p, verdict{skip: "unavailable"}, nil
	}
	found := false
	for _, o := range j.reg.Methods(acc.Market, money.Currency(acc.Currency), "", "") {
		if o.Provider == provider.ID(p.pm.Provider) && string(o.Method) == p.pm.Kind && o.AutoTopupCapable {
			p.opt, found = o, true
			break
		}
	}
	if !found {
		return p, verdict{skip: "unavailable"}, nil
	}
	if p.cust, err = q.GetBillingCustomerByID(ctx, p.pm.CustomerID); err != nil {
		return p, verdict{}, err
	}
	if p.cust.AccountID != acc.ID {
		return p, verdict{skip: "customer_mismatch"}, nil
	}
	qt, err := j.core.QuoteIn(ctx, q, acc, "")
	if err != nil {
		return p, verdict{}, err
	}
	if !Need(qt.BalanceMinor, qt.DailyMinor) {
		return p, verdict{skip: CodeSuperseded}, nil
	}
	if p.amount = Amount(qt.AutoTopupMinor, t.MaxMinor, p.opt.Min, p.opt.Max); p.amount <= 0 {
		return p, verdict{skip: "no_amount"}, nil
	}
	return p, verdict{}, nil
}

// TryAccount starts an attempt for one account if it needs one: a read-only check first (no
// lock for the accounts that do not), then prepare, fence, charge and settle. ok = an attempt
// was dispatched.
func (j *Job) TryAccount(ctx context.Context, accountID uuid.UUID) (bool, error) {
	need := false
	err := j.db.ReadTx(ctx, func(tx pgx.Tx) error {
		q := j.db.Q.WithTx(tx)
		acc, err := q.GetBillingAccount(ctx, accountID)
		if err != nil {
			return err
		}
		now, err := j.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		_, v, err := j.check(ctx, q, acc, now, nil)
		need = err == nil && (v.ok() || v.revoke != "")
		return err
	})
	if err != nil || !need {
		return false, err
	}
	att, err := j.prepare(ctx, accountID)
	if err != nil || att == nil {
		return false, err
	}
	return j.dispatch(ctx, *att)
}

// prepare: phase 1 under the account lock — the checks, the prepared attempt (one open per
// account) and not_before = now + 24 h. nil attempt: nothing to do.
func (j *Job) prepare(ctx context.Context, accountID uuid.UUID) (*sqlc.BillingAutotopupAttempt, error) {
	var out *sqlc.BillingAutotopupAttempt
	err := j.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, accountID)
		if err != nil {
			return err
		}
		now, err := j.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		p, v, err := j.check(ctx, q, acc, now, nil)
		if err != nil {
			return err
		}
		if v.revoke != "" {
			_, err := q.RevokeBillingAutoTopup(ctx, sqlc.RevokeBillingAutoTopupParams{Now: now, Reason: v.revoke, AccountID: acc.ID})
			return err
		}
		if !v.ok() {
			return nil
		}
		att, err := q.InsertBillingAutoTopupAttempt(ctx, sqlc.InsertBillingAutoTopupAttemptParams{
			AccountID: acc.ID, PmID: p.pm.ID, AmountMinor: p.amount, Currency: acc.Currency, Now: now,
		})
		if db.UniqueViolation(err) != "" {
			return errSkip
		}
		if err != nil {
			return err
		}
		if err := q.SetBillingAutoTopupNotBefore(ctx, sqlc.SetBillingAutoTopupNotBeforeParams{
			NotBefore: now.Add(MinInterval), Now: now, AccountID: acc.ID,
		}); err != nil {
			return err
		}
		out = &att
		return nil
	})
	if errors.Is(err, errSkip) {
		return nil, nil
	}
	return out, err
}

// target is the provider side of an attempt.
type target struct {
	p       provider.Provider
	charger provider.OffSessionCharger
	pm      sqlc.BillingPaymentMethod
	cust    sqlc.BillingCustomer
}

func (t target) ref() provider.CustomerRef {
	return provider.CustomerRef{Provider: provider.ID(t.cust.Provider), ProviderAccount: t.cust.ProviderAccount,
		Livemode: t.cust.Livemode, ID: t.cust.CustomerID}
}

// reconcilable: the provider has no idempotency keys (Tochka): one request per attempt, the
// charge is found by reading the method's charges (ListCharges), never by sending again.
func (t target) reconcilable() bool { return !t.p.Caps().SafeRetry() }

func (t target) lister() (provider.ChargeLister, bool) {
	l, ok := t.p.(provider.ChargeLister)
	return l, ok
}

// targetOf loads the card and customer an attempt charges (its own pm_id, not the consent's).
func (j *Job) targetOf(ctx context.Context, att sqlc.BillingAutotopupAttempt) (target, error) {
	var t target
	var err error
	if t.pm, err = j.db.Q.GetBillingPaymentMethod(ctx, att.PmID); err != nil {
		return t, err
	}
	if t.cust, err = j.db.Q.GetBillingCustomerByID(ctx, t.pm.CustomerID); err != nil {
		return t, err
	}
	var ok bool
	if t.p, ok = j.reg.Provider(provider.ID(t.pm.Provider)); !ok {
		return t, fmt.Errorf("auto-topup: provider %q is not configured", t.pm.Provider)
	}
	if t.charger, ok = j.reg.OffSession(t.p.ID()); !ok {
		return t, fmt.Errorf("auto-topup: provider %q cannot charge off-session", t.pm.Provider)
	}
	return t, nil
}

// request is the charge of an attempt; identical on every retry. A manual (one-click) charge is
// on-session: the owner is in the app and may confirm 3-D Secure on the provider's page.
func (j *Job) request(att sqlc.BillingAutotopupAttempt, t target) provider.OffSessionReq {
	r := provider.OffSessionReq{
		IdemKey: att.ID.String(), Customer: t.ref(), PaymentMethodID: t.pm.ProviderPmID,
		Amount: money.New(att.AmountMinor, money.Currency(att.Currency)), Description: chargeDescription,
		Metadata: provider.Metadata{AccountID: att.AccountID, AttemptID: att.ID, Kind: provider.MetadataKindAutoTopup},
	}
	if att.Kind == KindManual {
		r.Description, r.Metadata.Kind = manualDescription, provider.MetadataKindSavedMethod
		r.OnSession, r.ReturnURL = true, j.returnURL(att.ID)
	}
	return r
}

// dispatch: phase 2 (fence under the lock: prepared → dispatched, or failed when the consent or
// the need went away), the provider call outside any transaction, then the outcome. A provider
// without idempotency keys gets the method's charges read first (the snapshot is stored with the
// fence): the charge of this attempt is the new one that appears after the call.
func (j *Job) dispatch(ctx context.Context, att sqlc.BillingAutotopupAttempt) (bool, error) {
	t, err := j.targetOf(ctx, att)
	if err != nil {
		return false, err
	}
	var snapshot []string
	if t.reconcilable() {
		snapshot, err = j.snapshot(ctx, t, att)
		if err != nil {
			// Not sent: the attempt is closed now instead of waiting to be abandoned.
			slog.WarnContext(ctx, "billing auto-topup: read charges before dispatch", "attempt", att.ID, "err", err)
			ferr := j.db.Tx(ctx, func(q *sqlc.Queries) error {
				if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
					return err
				}
				_, err := q.FailBillingAutoTopupAttemptPrepared(ctx, sqlc.FailBillingAutoTopupAttemptPreparedParams{FailureCode: CodeUnavailable, Now: j.now(ctx, q), ID: att.ID})
				if db.IsNotFound(err) {
					return nil
				}
				return err
			})
			return false, errors.Join(err, ferr)
		}
	}
	sent := false
	err = j.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, att.AccountID)
		if err != nil {
			return err
		}
		cur, err := q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: att.ID, AccountID: acc.ID})
		if err != nil || cur.Status != statusPrepared {
			return err
		}
		now, err := j.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		v, err := j.fence(ctx, q, acc, now, cur)
		if err != nil {
			return err
		}
		if !v.ok() {
			code := v.skip
			if v.revoke != "" {
				code = CodeRevoked
				if _, err := q.RevokeBillingAutoTopup(ctx, sqlc.RevokeBillingAutoTopupParams{Now: now, Reason: v.revoke, AccountID: acc.ID}); err != nil {
					return err
				}
			}
			attempts.WithLabelValues(code).Inc()
			_, err := q.FailBillingAutoTopupAttemptPrepared(ctx, sqlc.FailBillingAutoTopupAttemptPreparedParams{FailureCode: code, Now: now, ID: cur.ID})
			return err
		}
		if snapshot == nil && t.reconcilable() {
			snapshot = []string{} // stored as an empty array: «read, nothing yet»
		}
		if _, err := q.MarkBillingAutoTopupAttemptDispatched(ctx, sqlc.MarkBillingAutoTopupAttemptDispatchedParams{
			Now: now, OrderSnapshot: snapshot, ID: cur.ID,
		}); err != nil {
			return err
		}
		sent = true
		return nil
	})
	if err != nil || !sent {
		return false, err
	}
	att.OrderSnapshot = snapshot
	attempts.WithLabelValues("dispatched").Inc()
	cctx, cancel := context.WithTimeout(ctx, j.opts.ChargeTimeout)
	fact, err := t.charger.ChargeOffSession(cctx, j.request(att, t))
	cancel()
	// The outcome is recorded even if ctx ends now (shutdown): an unrecorded success would
	// otherwise wait for the recovery.
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer rcancel()
	if t.reconcilable() {
		return true, j.outcomeReconcilable(rctx, t, att, fact, err)
	}
	return true, j.outcome(rctx, t, att, fact, err, false)
}

// fence re-checks an attempt under the account lock just before it is sent.
func (j *Job) fence(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, now time.Time, cur sqlc.BillingAutotopupAttempt) (verdict, error) {
	if cur.Kind == KindManual {
		return j.checkManual(ctx, q, acc, cur.PmID)
	}
	p, v, err := j.check(ctx, q, acc, now, &cur)
	if err != nil {
		return v, err
	}
	if v.ok() && cur.AmountMinor > p.consent.MaxMinor {
		v.skip = "cap_lowered" // the owner lowered the cap after prepare: never charge above it
	}
	return v, nil
}

// snapshot reads the ids of the charges a saved method has now. The attempt being sent is the
// account's only open one and was not sent yet, so a succeeded charge with no payment row belongs
// to a closed attempt (an approval that appeared after «declined» or after not_found): it is
// credited once as an import here, never hidden in the snapshot. An error leaves the attempt
// unsent.
func (j *Job) snapshot(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt) ([]string, error) {
	l, ok := t.lister()
	if !ok {
		return nil, errors.New("auto-topup: provider cannot list the charges of a method")
	}
	cctx, cancel := context.WithTimeout(ctx, j.opts.ChargeTimeout)
	defer cancel()
	facts, err := l.ListCharges(cctx, t.ref(), t.pm.ProviderPmID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(facts))
	var stray []provider.PaymentFact
	for _, f := range facts {
		ids = append(ids, f.ID)
		// Only a charge made after the card was saved: the binding payment (recorded under its
		// own id) can never be taken for a stray charge, whatever order the bank lists it in.
		if f.Status != provider.PaymentSucceeded || !f.Created.After(t.pm.CreatedAt) {
			continue
		}
		_, err := j.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
			Provider: string(t.p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.ID,
		})
		if db.IsNotFound(err) {
			stray = append(stray, f)
		} else if err != nil {
			return nil, err
		}
	}
	if len(stray) == 0 {
		return ids, nil
	}
	// Read after the list: still prepared means this attempt was not sent before the list was read
	// (the send follows the dispatched mark), so none of these charges is its own. Moved on (a
	// concurrent dispatch of the same attempt): no import, the fence will not send it again.
	cur, err := j.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: att.ID, AccountID: att.AccountID})
	if err != nil {
		return nil, err
	}
	if cur.Status != statusPrepared {
		return ids, nil
	}
	for _, f := range stray {
		slog.ErrorContext(ctx, "billing auto-topup: a charge of the saved method had no payment, credited as an import",
			"account", att.AccountID, "attempt", att.ID, "amount", f.Amount.String())
		if _, err := j.inbox.ApplyPaymentFact(ctx, t.p, f); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// findCharge looks for the charge of a reconcilable attempt: a charge of its method that was not
// there before it was sent (order_snapshot), is not recorded as a payment yet and has its amount.
// One charge in flight per account (and one subscription per method) makes it unambiguous.
func (j *Job) findCharge(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt) (provider.PaymentFact, bool, error) {
	if att.OrderSnapshot == nil {
		return provider.PaymentFact{}, false, fmt.Errorf("auto-topup: attempt %s has no charge snapshot", att.ID)
	}
	l, ok := t.lister()
	if !ok {
		return provider.PaymentFact{}, false, errors.New("auto-topup: provider cannot list the charges of a method")
	}
	facts, err := l.ListCharges(ctx, t.ref(), t.pm.ProviderPmID)
	if err != nil {
		return provider.PaymentFact{}, false, err
	}
	want := money.New(att.AmountMinor, money.Currency(att.Currency))
	for _, f := range facts {
		if slices.Contains(att.OrderSnapshot, f.ID) || f.Amount != want || f.Status != provider.PaymentSucceeded {
			continue
		}
		pay, err := j.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
			Provider: string(t.p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.ID,
		})
		if err == nil && (pay.AttemptID == nil || *pay.AttemptID != att.ID) {
			continue // another attempt's (or imported) charge
		}
		if err != nil && !db.IsNotFound(err) {
			return provider.PaymentFact{}, false, err
		}
		kind := provider.MetadataKindAutoTopup
		if att.Kind == KindManual {
			kind = provider.MetadataKindSavedMethod
		}
		f.Metadata = provider.Metadata{AccountID: att.AccountID, AttemptID: att.ID, Kind: kind}
		return f, true, nil
	}
	return provider.PaymentFact{}, false, nil
}

// outcomeReconcilable records the answer of a charge of a provider without idempotency keys. The
// answer never identifies the payment: the charge is looked up right away and, if not visible yet,
// by the recovery. A definite refusal (4xx) charged nothing; a «declined» answer is trusted only
// once no new charge is visible.
func (j *Job) outcomeReconcilable(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt, fact provider.PaymentFact, err error) error {
	if err != nil && !errors.Is(err, provider.ErrUnknownOutcome) && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		slog.WarnContext(ctx, "billing auto-topup: refused", "attempt", att.ID, "account", att.AccountID, "err", err)
		return j.fail(ctx, att, nil, CodeRefused, j.failMail(att, mail.TemplateBillingAutoTopupFailed))
	}
	f, found, ferr := j.findCharge(ctx, t, att)
	if ferr == nil && found {
		return j.credit(ctx, t, att, f)
	}
	if err != nil || ferr != nil {
		attempts.WithLabelValues("unknown").Inc()
		slog.WarnContext(ctx, "billing auto-topup: outcome unknown (resolved by reading the charges)", "attempt", att.ID, "account", att.AccountID, "err", errors.Join(err, ferr))
		return j.setStatus(ctx, att, statusUnknown, nil, "")
	}
	if fact.Status == provider.PaymentFailed {
		code := fact.FailureCode
		if code == "" {
			code = string(provider.PaymentFailed)
		}
		return j.fail(ctx, att, nil, code, j.failMail(att, mail.TemplateBillingAutoTopupFailed))
	}
	return nil // accepted, not listed yet: dispatched until the recovery finds it
}

// credit applies a charge found by reading (reconcilable providers): the inbox credit path with the
// attempt in the metadata, then the attempt row.
func (j *Job) credit(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt, f provider.PaymentFact) error {
	res, err := j.inbox.ApplyPaymentFact(ctx, t.p, f)
	if err != nil {
		return err
	}
	if res.Credited && res.Payment != nil {
		return j.markPaid(ctx, att, *res.Payment)
	}
	return nil
}

// outcome records the answer of a charge request. retry: a same-key retry of an open attempt
// (a definite refusal then proves nothing about the first request: the attempt stays unknown).
func (j *Job) outcome(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt, fact provider.PaymentFact, err error, retry bool) error {
	if err != nil {
		if retry || errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			attempts.WithLabelValues("unknown").Inc()
			slog.WarnContext(ctx, "billing auto-topup: outcome unknown", "attempt", att.ID, "account", att.AccountID, "err", err)
			return j.setStatus(ctx, att, statusUnknown, nil, "")
		}
		// A definite refusal before any payment (invalid card reference, livemode): nothing
		// was charged; the owner learns that the automatic top-up did not happen.
		slog.WarnContext(ctx, "billing auto-topup: refused", "attempt", att.ID, "account", att.AccountID, "err", err)
		return j.fail(ctx, att, nil, CodeRefused, j.failMail(att, mail.TemplateBillingAutoTopupFailed))
	}
	if fact.Metadata.AttemptID != uuid.Nil && fact.Metadata.AttemptID != att.ID {
		return fmt.Errorf("auto-topup: payment %s belongs to attempt %s, not %s", fact.ID, fact.Metadata.AttemptID, att.ID)
	}
	return j.settle(ctx, t, att, fact)
}

// Attempt statuses (billing_autotopup_attempts.status).
const (
	statusPrepared       = "prepared"
	statusDispatched     = "dispatched"
	statusRequiresAction = "requires_action"
	statusSucceeded      = "succeeded"
	statusFailed         = "failed"
	statusUnknown        = "unknown"
)

// settle applies a fresh payment fact of the attempt (a provider with idempotency keys: the fact
// names its payment). done-ness is in the attempt row.
func (j *Job) settle(ctx context.Context, t target, att sqlc.BillingAutotopupAttempt, f provider.PaymentFact) error {
	switch f.Status {
	case provider.PaymentSucceeded, provider.PaymentProcessing:
		if err := j.setPayment(ctx, att, f.ID); err != nil {
			return err
		}
		// The inbox credit path: fresh read, one payment row per PaymentIntent, one lot; the
		// AttemptSettled hook marks the attempt in the credit transaction.
		res, err := j.inbox.SyncPayment(ctx, t.p, f.ID, "auto_topup")
		if err != nil {
			return err
		}
		if res.Credited && res.Payment != nil {
			return j.markPaid(ctx, att, *res.Payment)
		}
		return nil
	case provider.PaymentRequiresAction:
		if att.Kind == KindManual && f.NextActionURL != "" && f.ID != "" {
			// The owner confirms 3-D Secure on the provider's page; the GET of the top-up or the
			// recovery re-reads the payment (and cancels it after ActionTimeout).
			attempts.WithLabelValues("requires_action").Inc()
			return j.requiresAction(ctx, att, f.ID, f.NextActionURL)
		}
		// Off-session the payer cannot authenticate: cancel, never continue the intent.
		cf, err := t.charger.CancelPayment(ctx, f.ID)
		if err != nil {
			_ = j.setStatus(ctx, att, statusUnknown, &f.ID, CodeAuthRequired)
			return err
		}
		if cf.Status == provider.PaymentSucceeded {
			return j.settle(ctx, t, att, cf)
		}
		attempts.WithLabelValues("requires_action").Inc()
		return j.fail(ctx, att, &f.ID, CodeAuthRequired, j.failMail(att, mail.TemplateBillingAutoTopupActionRequired))
	default: // failed, canceled
		code := f.FailureCode
		if code == "" {
			code = string(f.Status)
		}
		return j.fail(ctx, att, &f.ID, code, j.failMail(att, mail.TemplateBillingAutoTopupFailed))
	}
}

// failMail is the owner mail of a failed attempt: auto-topup only (a one-click top-up shows its
// result in the app).
func (j *Job) failMail(att sqlc.BillingAutotopupAttempt, t mail.Template) mail.Template {
	if att.Kind == KindManual {
		return ""
	}
	return t
}

// requiresAction keeps a one-click charge waiting for 3-D Secure.
func (j *Job) requiresAction(ctx context.Context, att sqlc.BillingAutotopupAttempt, pi, actionURL string) error {
	return j.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
			return err
		}
		_, err := q.SetBillingAttemptRequiresAction(ctx, sqlc.SetBillingAttemptRequiresActionParams{ProviderPaymentID: &pi, ActionUrl: actionURL, ID: att.ID})
		if db.IsNotFound(err) {
			return nil // final already
		}
		return err
	})
}

func (j *Job) now(ctx context.Context, q *sqlc.Queries) time.Time {
	t, err := j.clock.Now(ctx, q)
	if err != nil {
		return time.Now().UTC()
	}
	return t
}

// setStatus moves an open attempt (dispatched / unknown) under the account lock.
func (j *Job) setStatus(ctx context.Context, att sqlc.BillingAutotopupAttempt, status string, pi *string, code string) error {
	return j.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
			return err
		}
		now, err := j.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		_, err = q.SetBillingAutoTopupAttemptStatus(ctx, sqlc.SetBillingAutoTopupAttemptStatusParams{
			Status: status, ProviderPaymentID: pi, FailureCode: code, Now: now, ID: att.ID,
		})
		if db.IsNotFound(err) {
			return nil // final already
		}
		return err
	})
}

// setPayment keeps the PaymentIntent id of a payment that is not final yet.
func (j *Job) setPayment(ctx context.Context, att sqlc.BillingAutotopupAttempt, pi string) error {
	return j.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
			return err
		}
		_, err := q.SetBillingAutoTopupAttemptPayment(ctx, sqlc.SetBillingAutoTopupAttemptPaymentParams{ProviderPaymentID: &pi, ID: att.ID})
		if db.IsNotFound(err) {
			return nil
		}
		return err
	})
}

// markPaid: the attempt's payment is on the balance (the hook did it, or the payment was
// credited before the attempt row could follow).
func (j *Job) markPaid(ctx context.Context, att sqlc.BillingAutotopupAttempt, pay sqlc.BillingPayment) error {
	if pay.AttemptID == nil || *pay.AttemptID != att.ID {
		return nil // credited as an import (no attempt row when it was recorded)
	}
	return j.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, att.AccountID); err != nil {
			return err
		}
		return j.AttemptSettled(ctx, q, att.ID, pay)
	})
}

// fail closes an attempt as failed and mails the owner (once per attempt; t "" = no mail).
func (j *Job) fail(ctx context.Context, att sqlc.BillingAutotopupAttempt, pi *string, code string, t mail.Template) error {
	err := j.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, att.AccountID)
		if err != nil {
			return err
		}
		now, err := j.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		_, err = q.SetBillingAutoTopupAttemptStatus(ctx, sqlc.SetBillingAutoTopupAttemptStatusParams{
			Status: statusFailed, ProviderPaymentID: pi, FailureCode: code, Now: now, ID: att.ID,
		})
		if db.IsNotFound(err) {
			return nil // final already (a late webhook settled it)
		}
		if err != nil {
			return err
		}
		attempts.WithLabelValues("failed").Inc()
		if t == "" {
			return nil
		}
		return j.inbox.Mail.Notify(ctx, q, acc, "auto_topup:"+att.ID.String(), t, mail.Params{
			"amount": money.New(att.AmountMinor, money.Currency(att.Currency)).String(), "code": code,
		})
	})
	if err == nil {
		j.inbox.Mail.Wake()
	}
	return err
}
