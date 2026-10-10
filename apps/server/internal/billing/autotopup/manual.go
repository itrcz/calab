package autotopup

import (
	"context"
	"net/url"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// One-click top-up (ADR-0083 phase 2, owner 2026-10-10: «если человек вручную пополняет с уже
// привязанной картой — после подтверждения спишем, не открывая платёжную страницу»). A manual
// charge is an attempt of kind manual in the same table and through the same dispatcher as
// auto-topup, so the one-open-charge-per-account index serializes both kinds; it differs in:
//   - it starts from the owner's request (request_id + body hash: a retry returns the same
//     charge, another body is 409), not from the need, and touches neither the consent nor
//     not_before;
//   - Stripe confirms it on-session: a card that needs 3-D Secure leaves it requires_action with
//     the provider's page (action_url); the app opens the page and polls GET …/{id}, which
//     re-reads the payment; unconfirmed after ActionTimeout it is canceled and failed;
//   - failures are shown in the app, not mailed.

// Kinds of attempts (billing_autotopup_attempts.kind).
const (
	KindAuto   = "auto"
	KindManual = "manual"
)

// manualDescription is the statement / receipt text of a one-click top-up.
const manualDescription = "Calab balance top-up"

// ManualRequest is the owner's one-click top-up, validated by the HTTP layer (method of the
// account, amount within its limits and currency).
type ManualRequest struct {
	AccountID   uuid.UUID
	UserID      uuid.UUID
	RequestID   uuid.UUID
	BodyHash    []byte
	PmID        uuid.UUID
	AmountMinor int64
	Currency    string
}

// checkManual: the card may be charged for the owner now.
func (j *Job) checkManual(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, pmID uuid.UUID) (verdict, error) {
	if acc.Status == core.StatusClosed {
		return verdict{skip: "status_" + acc.Status}, nil
	}
	pm, err := q.GetBillingPaymentMethod(ctx, pmID)
	if err != nil {
		return verdict{}, err
	}
	if pm.AccountID != acc.ID || pm.DetachedAt != nil {
		return verdict{skip: "method_detached"}, nil
	}
	if _, ok := j.reg.OffSession(provider.ID(pm.Provider)); !ok {
		return verdict{skip: "unavailable"}, nil
	}
	return verdict{}, nil
}

// StartManual records the owner's one-click top-up and sends it (or returns the charge of the
// same request). Errors: billing.ErrRequestReused, billing.ErrPaymentPending (another charge of
// a saved card in flight), billing.ErrAccountNotFound, billing.ErrMethodUnavailable.
func (j *Job) StartManual(ctx context.Context, r ManualRequest) (sqlc.BillingAutotopupAttempt, error) {
	var att sqlc.BillingAutotopupAttempt
	err := j.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, r.AccountID)
		if err != nil {
			return err
		}
		if old, err := q.GetBillingChargeByRequest(ctx, sqlc.GetBillingChargeByRequestParams{AccountID: acc.ID, RequestID: &r.RequestID}); err == nil {
			if string(old.BodyHash) != string(r.BodyHash) {
				return billing.ErrRequestReused
			}
			att = old
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		if acc.Status == core.StatusClosed {
			return billing.ErrAccountNotFound
		}
		v, err := j.checkManual(ctx, q, acc, r.PmID)
		if err != nil {
			return err
		}
		if !v.ok() {
			return billing.ErrMethodUnavailable
		}
		if _, err := q.GetOpenBillingAutoTopupAttempt(ctx, acc.ID); err == nil {
			return billing.ErrPaymentPending
		} else if !db.IsNotFound(err) {
			return err
		}
		att, err = q.InsertBillingManualCharge(ctx, sqlc.InsertBillingManualChargeParams{
			AccountID: acc.ID, PmID: r.PmID, AmountMinor: r.AmountMinor, Currency: r.Currency, RequestID: &r.RequestID,
			BodyHash: r.BodyHash, CreatedBy: &r.UserID, Now: j.now(ctx, q),
		})
		if db.UniqueViolation(err) != "" {
			return billing.ErrPaymentPending
		}
		return err
	})
	if err != nil {
		return att, err
	}
	if att.Status == statusPrepared {
		if _, err := j.dispatch(ctx, att); err != nil {
			return att, err
		}
	}
	return j.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: att.ID, AccountID: att.AccountID})
}

// RefreshManual re-reads the provider for a one-click charge that is not final (the app polls it
// after the 3-D Secure page, or while the provider has not answered): the same settle paths as
// the recovery, without a same-key retry. Returns the current row.
func (j *Job) RefreshManual(ctx context.Context, att sqlc.BillingAutotopupAttempt) (sqlc.BillingAutotopupAttempt, error) {
	if att.Status != statusDispatched && att.Status != statusRequiresAction && att.Status != statusUnknown {
		return att, nil
	}
	t, err := j.targetOf(ctx, att)
	if err != nil {
		return att, err
	}
	switch {
	case t.reconcilable():
		f, found, err := j.findCharge(ctx, t, att)
		if err != nil {
			return att, err
		}
		if found {
			if err := j.credit(ctx, t, att, f); err != nil {
				return att, err
			}
		}
	case att.ProviderPaymentID != nil:
		f, err := t.p.GetPayment(ctx, *att.ProviderPaymentID)
		if err != nil {
			return att, err
		}
		if err := j.settle(ctx, t, att, f); err != nil {
			return att, err
		}
	}
	return j.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: att.ID, AccountID: att.AccountID})
}

// returnURL is where the 3-D Secure page returns the payer: the public return page with the
// charge id (BILLING_PUBLIC_RETURN_URL).
func (j *Job) returnURL(id uuid.UUID) string {
	u, err := url.Parse(j.opts.ReturnURL)
	if err != nil || j.opts.ReturnURL == "" {
		return j.opts.ReturnURL
	}
	q := u.Query()
	q.Set("topup", id.String())
	u.RawQuery = q.Encode()
	return u.String()
}
