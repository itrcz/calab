package admin

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	bmoney "github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Refunds, the synchronous model (ADR-0080 / ADR-0083 amendment, owner 2026-10-10): the
// superadmin picks a payment and an amount ≤ refundable (paid − refunded − pending); the server
// records the attempt (nothing reserved), calls the provider at once outside any transaction and
// answers its outcome:
//   - executed → the ledger entry now (the balance may go negative: debt rules), «Возвращено»,
//     the owner's mail;
//   - refused, or not possible through the API (Tochka subscription payments, digital ruble) →
//     nothing on the balance; for the latter the answer says what to refund in the bank
//     (manual_refund), and the refund polling books it once the bank lists it;
//   - unknown (timeout, 5xx; Tochka has no idempotency) → the one pending row, never sent again;
//     the polling books it (executed) or closes it (absent).
// Each attempt is audited: the request (refund) and its outcome (refund.outcome).

// providerTimeout bounds the provider call of a refund (the admin waits for it).
const providerTimeout = 15 * time.Second

const actionRefundOutcome = "refund.outcome"

// refundKey is billing_refunds.idem_key and the provider Idempotency-Key of an admin refund.
func refundKey(requestID uuid.UUID) string { return "refund:" + requestID.String() }

// refund: POST /api/admin/billing/payments/{id}/refunds.
func (h *Handlers) refund(w http.ResponseWriter, r *http.Request) error {
	payID, err := httpx.PathUUID(r, "id", "payment")
	if err != nil {
		return err
	}
	var req v1.AdminRefundRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if req.GetRefundRequestId() != "" {
		return httpx.Validation("refundRequestId", "refund requests are no longer decided here")
	}
	c, err := newCmd(r, actionRefund, &req, payID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	pay, err := h.d.DB.Q.GetBillingPayment(ctx, payID)
	if db.IsNotFound(err) {
		return httpx.NotFound("payment")
	}
	if err != nil {
		return err
	}
	var p provider.Provider
	if h.d.Providers != nil {
		p, _ = h.d.Providers.Provider(provider.ID(pay.Provider))
	}
	byHand := false
	if p != nil {
		if byHand, err = core.RefundByHand(ctx, h.d.DB.Q, p, pay); err != nil {
			return err
		}
	}
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, pay.AccountID)
		if err != nil {
			return nil, err
		}
		amount, err := amountOf(req.GetAmount(), acc)
		if err != nil {
			return nil, err
		}
		refundable, err := h.d.Core.RefundLeft(ctx, q, pay.ID)
		if err != nil {
			return nil, err
		}
		if refundable.DisputeHold {
			return nil, billing.ErrDisputeHold
		}
		if amount > refundable.Minor {
			return nil, billing.ErrRefundExceedsRefundable
		}
		eff := &effect{before: &acc, acc: &acc,
			target: map[string]string{"account_id": acc.ID.String(), "payment_id": pay.ID.String()},
			res:    &v1.AdminBillingMutationResult{Amount: money(amount, acc.Currency), Refundable: money(refundable.Minor, acc.Currency)}}
		if byHand {
			// Nothing to send: the answer says what to refund in the bank.
			eff.target["outcome"] = "manual"
			eff.res.ManualRefund = h.manualRefund(pay, amount, acc.Currency)
			return eff, nil
		}
		if c.preview {
			after := acc
			after.BalanceMinor -= amount // what an executed refund takes (the spent part becomes debt)
			eff.acc = &after
			return eff, nil
		}
		ref, _, err := h.d.Core.StartRefund(ctx, q, core.RefundReq{
			PaymentID: pay.ID, Amount: amount, IdemKey: refundKey(c.requestID), Reason: c.reason, RequestedBy: &c.actor,
		})
		if err != nil {
			return nil, err
		}
		eff.res.Refunds = []*v1.AdminBillingRefund{refundProto(ref)}
		return eff, nil
	})
	if err != nil {
		return err
	}
	if !c.preview && !byHand {
		if err := h.executeAll(ctx, res, c); err != nil {
			return err
		}
		acc, err := h.d.DB.Q.GetBillingAccount(ctx, pay.AccountID)
		if err != nil {
			return err
		}
		res.BalanceAfter, res.Account = money(acc.BalanceMinor, acc.Currency), nil
	}
	return h.respond(w, r, res, pay.AccountID)
}

// manualRefund is what the operator refunds in the provider's interface. The operation id is
// given in full (owner 2026-10-10): it is the bank's reference the superadmin finds the operation
// by in the bank's interface; it stays masked in lists, logs and errors.
func (h *Handlers) manualRefund(pay sqlc.BillingPayment, amount int64, currency string) *v1.AdminManualRefund {
	op, charge, _ := strings.Cut(pay.ProviderPaymentID, ":charge:")
	return &v1.AdminManualRefund{Provider: pay.Provider, PaymentId: pay.ID.String(), Operation: op, Charge: charge, Amount: money(amount, currency)}
}

// executeAll sends every pending refund of res and replaces it with its state after the answer
// (a replay of the same request_id only reads: a refund is never sent twice).
func (h *Handlers) executeAll(ctx context.Context, res *v1.AdminBillingMutationResult, c *cmd) error {
	for i, pr := range res.GetRefunds() {
		id, err := uuid.Parse(pr.GetRefund().GetId())
		if err != nil {
			return err
		}
		ref, err := h.d.DB.Q.GetBillingRefund(ctx, id)
		if err != nil {
			return err
		}
		ref, outcome, manual, err := h.execute(ctx, ref)
		if err != nil {
			return err
		}
		res.Refunds[i] = refundProto(ref)
		if manual != nil {
			res.ManualRefund = manual
		}
		if outcome != "" {
			h.auditOutcome(ctx, c, ref, outcome)
		}
	}
	return nil
}

// Outcomes of one provider call (audit refund.outcome).
const (
	outcomeExecuted = "executed"
	outcomeRefused  = "refused"
	outcomeManual   = "manual"
	outcomeUnknown  = "unknown"
)

// execute calls the provider once for a pending admin refund and books its answer. A refund
// already sent (dispatched, a provider id, or past the repost window) is only read back: the
// polling resolves it.
func (h *Handlers) execute(ctx context.Context, ref sqlc.BillingRefund) (sqlc.BillingRefund, string, *v1.AdminManualRefund, error) {
	if ref.Origin != core.RefundOriginCalab || ref.Status != core.RefundPending && ref.Status != core.RefundRequiresAction {
		return ref, "", nil, nil
	}
	pay, err := h.d.DB.Q.GetBillingPayment(ctx, ref.PaymentID)
	if err != nil {
		return ref, "", nil, err
	}
	var p provider.Provider
	if h.d.Providers != nil {
		p, _ = h.d.Providers.Provider(provider.ID(pay.Provider))
	}
	if p == nil {
		slog.WarnContext(ctx, "billing admin: refund left pending, provider not configured", "refund", ref.ID, "provider", pay.Provider)
		return ref, outcomeUnknown, nil, nil
	}
	if ref.ProviderRefundID != nil || ref.DispatchedAt != nil || !core.RefundMayRepost(ref) {
		return ref, "", nil, nil // sent before: the polling finishes it
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), providerTimeout)
	defer cancel()
	if !p.Caps().SafeRetry() {
		// No idempotency at the provider (Tochka): marked before the request, never sent again.
		sent, err := h.d.Core.MarkRefundDispatched(pctx, ref.ID)
		if err != nil {
			return ref, "", nil, err
		}
		if !sent {
			return ref, "", nil, nil
		}
	}
	fact, err := p.Refund(pctx, provider.RefundReq{
		IdemKey: ref.IdemKey, PaymentID: pay.ProviderPaymentID, Amount: bmoney.New(ref.AmountMinor, bmoney.Currency(ref.Currency)),
		Reason: ref.Reason, Metadata: provider.Metadata{AccountID: ref.AccountID, RefundID: ref.ID},
	})
	status, outcome := "", ""
	var manual *v1.AdminManualRefund
	switch {
	case errors.Is(err, provider.ErrNotSupported):
		// Refunded only in the provider's interface (Tochka: digital ruble, a subscription the
		// local data did not know): nothing moved; the polling books the operator's refund.
		slog.WarnContext(ctx, "billing admin: refund to be made in the provider's interface", "refund", ref.ID, "err", err)
		status, outcome = core.RefundFailed, outcomeManual
		manual = h.manualRefund(pay, ref.AmountMinor, ref.Currency)
	case errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, context.DeadlineExceeded):
		slog.WarnContext(ctx, "billing admin: refund outcome unknown, the polling resolves it", "refund", ref.ID, "err", err)
		return ref, outcomeUnknown, nil, nil
	case err != nil:
		slog.WarnContext(ctx, "billing admin: provider refused the refund", "refund", ref.ID, "err", err)
		status, outcome = core.RefundFailed, outcomeRefused
	case fact.PaymentID != pay.ProviderPaymentID || fact.Amount.Minor != ref.AmountMinor || string(fact.Amount.Currency) != ref.Currency:
		slog.ErrorContext(ctx, "billing admin: provider refund does not match, the polling resolves it", "refund", ref.ID, "provider_refund", fact.ID)
		return ref, outcomeUnknown, nil, nil
	case fact.Status == provider.RefundFailed || fact.Status == provider.RefundCanceled:
		status, outcome = core.RefundFailed, outcomeRefused
	default:
		// Created at the provider (Stripe pending / succeeded, Tochka accepted): executed.
		status, outcome = core.RefundSucceeded, outcomeExecuted
	}
	var pid *string
	if fact.ID != "" {
		pid = &fact.ID
	}
	var out sqlc.BillingRefund
	var acc sqlc.BillingAccount
	err = h.d.DB.Tx(pctx, func(q *sqlc.Queries) error {
		var err error
		out, acc, err = h.d.Core.ApplyRefundResult(pctx, q, ref.ID, status, pid)
		return err
	})
	if err != nil {
		return ref, "", nil, err
	}
	if h.d.Committed != nil {
		h.d.Committed(ctx, acc)
	}
	if status == core.RefundSucceeded && h.d.RefundDone != nil {
		h.d.RefundDone(ctx, out)
	}
	return out, outcome, manual, nil
}

// auditOutcome appends the provider's answer to the audit (append-only, best effort: the money
// state is in the refund row and the ledger).
func (h *Handlers) auditOutcome(ctx context.Context, c *cmd, ref sqlc.BillingRefund, outcome string) {
	det, _ := json.Marshal(details{Target: map[string]string{ //nolint:errchkjson // plain strings
		"account_id": ref.AccountID.String(), "payment_id": ref.PaymentID.String(), "refund_id": ref.ID.String(),
		"outcome": outcome, "status": ref.Status, "amount_minor": bmoney.New(ref.AmountMinor, bmoney.Currency(ref.Currency)).Decimal(),
	}})
	h1 := sha256.Sum256(det)
	acc := ref.AccountID
	actx := context.WithoutCancel(ctx)
	if _, err := db.GuardValue(actx, h.d.DB, func(q *sqlc.Queries) (sqlc.BillingAudit, error) {
		return q.InsertBillingAudit(actx, sqlc.InsertBillingAuditParams{
			RequestID: uuid.NewSHA1(c.requestID, []byte(actionRefundOutcome+ref.Status)), BodyHash: h1[:], AccountID: &acc, ActorID: &c.actor,
			Action: actionRefundOutcome, Reason: c.reason, Details: det,
		})
	}); err != nil && !db.IsNotFound(err) {
		slog.WarnContext(ctx, "billing admin: audit refund outcome", "refund", ref.ID, "err", err)
	}
}
