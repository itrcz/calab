package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
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

// providerTimeout bounds one provider call of a refund (it runs detached from the request so
// a closed connection does not turn an answer into an unknown outcome).
const providerTimeout = 30 * time.Second

// refundKey is billing_refunds.idem_key and the provider Idempotency-Key of an admin refund.
func refundKey(requestID uuid.UUID, paymentID *uuid.UUID) string {
	if paymentID == nil {
		return "refund:" + requestID.String()
	}
	return "refund:" + requestID.String() + ":" + paymentID.String()
}

// refund: POST /api/admin/billing/payments/{id}/refunds — refunds unused money of one payment
// (amount <= core.RefundableForPayment, else 409 BILLING_REFUND_EXCEEDS_REFUNDABLE). The
// reservation and the audit row commit together; the provider is called afterwards.
func (h *Handlers) refund(w http.ResponseWriter, r *http.Request) error {
	payID, err := httpx.PathUUID(r, "id", "payment")
	if err != nil {
		return err
	}
	var req v1.AdminRefundRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionRefund, &req, payID.String())
	if err != nil {
		return err
	}
	var linked *uuid.UUID
	if s := req.GetRefundRequestId(); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("refundRequestId", "refund_request_id must be a uuid")
		}
		linked = &id
	}
	ctx := r.Context()
	pay, err := h.d.DB.Q.GetBillingPayment(ctx, payID)
	if db.IsNotFound(err) {
		return httpx.NotFound("payment")
	}
	if err != nil {
		return err
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
		refundable, err := h.d.Core.RefundableForPayment(ctx, q, pay.ID)
		if err != nil {
			return nil, err
		}
		if linked != nil {
			if _, err := h.decide(ctx, q, *linked, acc.ID, "approved", c.actor); err != nil {
				return nil, err
			}
		}
		ref, after, err := h.d.Core.ReserveRefund(ctx, q, core.RefundReq{
			PaymentID: pay.ID, Amount: amount, IdemKey: refundKey(c.requestID, nil), Origin: core.RefundOriginCalab,
			Reason: c.reason, RequestedBy: &c.actor,
		})
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after,
			target: map[string]string{"account_id": acc.ID.String(), "payment_id": pay.ID.String()},
			res: &v1.AdminBillingMutationResult{Amount: money(amount, acc.Currency), Refunds: []*v1.AdminBillingRefund{refundProto(ref)},
				Refundable: money(refundable.Minor, acc.Currency)}}, nil
	})
	if err != nil {
		return err
	}
	if !c.preview {
		if err := h.executeAll(ctx, res); err != nil {
			return err
		}
	}
	return h.respond(w, r, res, pay.AccountID)
}

// decideRefundRequest: POST /api/admin/billing/refund-requests/{id}/decide — approve: refunds
// of the requested amount from the account's payments in funding (FIFO) order, unused money
// only (409 if the account has less); reject: the request is closed, no money moves.
func (h *Handlers) decideRefundRequest(w http.ResponseWriter, r *http.Request) error {
	rrID, err := httpx.PathUUID(r, "id", "refund request")
	if err != nil {
		return err
	}
	var req v1.AdminDecideRefundRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionDecide, &req, rrID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	rr0, err := h.d.DB.Q.AdminGetBillingRefundRequest(ctx, rrID)
	if db.IsNotFound(err) {
		return httpx.NotFound("refund request")
	}
	if err != nil {
		return err
	}
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, rr0.AccountID)
		if err != nil {
			return nil, err
		}
		status := "rejected"
		if req.GetApprove() {
			status = "approved"
		}
		rr, err := h.decide(ctx, q, rrID, acc.ID, status, c.actor)
		if err != nil {
			return nil, err
		}
		eff := &effect{before: &acc, acc: &acc, target: map[string]string{"account_id": acc.ID.String(), "refund_request_id": rr.ID.String()},
			res: &v1.AdminBillingMutationResult{RefundRequest: refundRequestProto(rr, acc.WorkspaceID, acc.Currency)}}
		if !req.GetApprove() {
			return eff, nil
		}
		refunds, after, err := h.reserveFIFO(ctx, q, acc, rr.AmountMinor, c)
		if err != nil {
			return nil, err
		}
		eff.acc = &after
		eff.res.Amount = money(rr.AmountMinor, acc.Currency)
		for _, ref := range refunds {
			eff.res.Refunds = append(eff.res.Refunds, refundProto(ref))
		}
		return eff, nil
	})
	if err != nil {
		return err
	}
	if !c.preview {
		if err := h.executeAll(ctx, res); err != nil {
			return err
		}
	}
	return h.respond(w, r, res, rr0.AccountID)
}

// decide closes a requested refund request of the locked account.
func (h *Handlers) decide(ctx context.Context, q *sqlc.Queries, id, accountID uuid.UUID, status string, actor uuid.UUID) (sqlc.BillingRefundRequest, error) {
	rr, err := q.AdminLockBillingRefundRequest(ctx, id)
	if db.IsNotFound(err) || err == nil && rr.AccountID != accountID {
		return rr, httpx.NotFound("refund request")
	}
	if err != nil {
		return rr, err
	}
	if rr.Status != "requested" {
		return rr, conflict("refund request is " + rr.Status + " already")
	}
	now, err := h.now(ctx, q)
	if err != nil {
		return rr, err
	}
	return q.AdminDecideBillingRefundRequest(ctx, sqlc.AdminDecideBillingRefundRequestParams{Status: status, DecidedBy: &actor, Now: now, ID: id})
}

// reserveFIFO reserves refunds of amount over the account's payments with unused money, in
// funding lot order.
func (h *Handlers) reserveFIFO(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, amount int64, c *cmd) ([]sqlc.BillingRefund, sqlc.BillingAccount, error) {
	if acc.DisputeHold {
		return nil, acc, billing.ErrDisputeHold
	}
	ids, err := q.AdminListRefundableBillingPayments(ctx, acc.ID)
	if err != nil {
		return nil, acc, err
	}
	rest := amount
	var out []sqlc.BillingRefund
	for _, id := range ids {
		if rest == 0 {
			break
		}
		ref, err := h.d.Core.RefundableForPayment(ctx, q, id)
		if err != nil {
			return nil, acc, err
		}
		take := min(rest, ref.Minor)
		if take <= 0 {
			continue
		}
		r, after, err := h.d.Core.ReserveRefund(ctx, q, core.RefundReq{
			PaymentID: id, Amount: take, IdemKey: refundKey(c.requestID, &id), Origin: core.RefundOriginCalab,
			Reason: c.reason, RequestedBy: &c.actor,
		})
		if err != nil {
			return nil, acc, err
		}
		out, acc, rest = append(out, r), after, rest-take
	}
	if rest > 0 {
		return nil, acc, billing.ErrRefundExceedsRefundable
	}
	return out, acc, nil
}

// executeAll sends every not-final refund of res to the provider and updates res with the
// current state of each.
func (h *Handlers) executeAll(ctx context.Context, res *v1.AdminBillingMutationResult) error {
	for i, pr := range res.GetRefunds() {
		id, err := uuid.Parse(pr.GetRefund().GetId())
		if err != nil {
			return err
		}
		ref, err := h.d.DB.Q.GetBillingRefund(ctx, id)
		if err != nil {
			return err
		}
		if ref, err = h.execute(ctx, ref); err != nil {
			return err
		}
		res.Refunds[i] = refundProto(ref)
	}
	return nil
}

// execute calls the provider for one reserved refund (Idempotency-Key = idem_key) and applies
// its answer. Unknown outcome / no provider: the refund stays pending (webhook, reconcile or a
// retry of the same request_id finish it).
func (h *Handlers) execute(ctx context.Context, ref sqlc.BillingRefund) (sqlc.BillingRefund, error) {
	if ref.Origin != core.RefundOriginCalab || ref.Status != core.RefundPending && ref.Status != core.RefundRequiresAction {
		return ref, nil
	}
	pay, err := h.d.DB.Q.GetBillingPayment(ctx, ref.PaymentID)
	if err != nil {
		return ref, err
	}
	var p provider.Provider
	if h.d.Providers != nil {
		p, _ = h.d.Providers.Provider(provider.ID(pay.Provider))
	}
	if p == nil {
		slog.WarnContext(ctx, "billing admin: refund left pending, provider not configured", "refund", ref.ID, "provider", pay.Provider)
		return ref, nil
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), providerTimeout)
	defer cancel()
	var fact provider.RefundFact
	if ref.ProviderRefundID != nil {
		fact, err = p.GetRefund(pctx, *ref.ProviderRefundID)
	} else {
		fact, err = p.Refund(pctx, provider.RefundReq{
			IdemKey: ref.IdemKey, PaymentID: pay.ProviderPaymentID, Amount: bmoney.New(ref.AmountMinor, bmoney.Currency(ref.Currency)),
			Reason: ref.Reason, Metadata: provider.Metadata{AccountID: ref.AccountID},
		})
	}
	status := ""
	switch {
	case errors.Is(err, provider.ErrUnknownOutcome):
		slog.WarnContext(ctx, "billing admin: refund outcome unknown, left pending", "refund", ref.ID, "err", err)
		return ref, nil
	case err != nil && ref.ProviderRefundID != nil:
		slog.WarnContext(ctx, "billing admin: refund re-read failed, left pending", "refund", ref.ID, "err", err)
		return ref, nil
	case err != nil:
		// The provider refused to create the refund: nothing left the merchant account.
		slog.WarnContext(ctx, "billing admin: provider refused the refund", "refund", ref.ID, "err", err)
		status = core.RefundFailed
	case fact.PaymentID != pay.ProviderPaymentID || fact.Amount.Minor != ref.AmountMinor || string(fact.Amount.Currency) != ref.Currency:
		slog.ErrorContext(ctx, "billing admin: provider refund does not match, left pending", "refund", ref.ID, "provider_refund", fact.ID)
		return ref, nil
	default:
		status = string(fact.Status)
	}
	var pid *string
	if fact.ID != "" {
		pid = &fact.ID
	}
	var out sqlc.BillingRefund
	var acc sqlc.BillingAccount
	err = h.d.DB.Tx(pctx, func(q *sqlc.Queries) error {
		var err error
		if status == core.RefundPending {
			if acc, err = lockAccount(pctx, q, ref.AccountID); err != nil {
				return err
			}
			if pid == nil {
				out = ref
				return nil
			}
			now, err := h.now(pctx, q)
			if err != nil {
				return err
			}
			out, err = q.AdminSetBillingRefundProviderID(pctx, sqlc.AdminSetBillingRefundProviderIDParams{ProviderRefundID: *pid, Now: now, ID: ref.ID})
			if db.IsNotFound(err) {
				out, err = q.GetBillingRefund(pctx, ref.ID)
			}
			return err
		}
		out, acc, err = h.d.Core.ApplyRefundResult(pctx, q, ref.ID, status, pid)
		return err
	})
	if err != nil {
		return ref, fmt.Errorf("billing admin: apply refund %s: %w", ref.ID, err)
	}
	if h.d.Committed != nil && status != core.RefundPending {
		h.d.Committed(ctx, acc)
	}
	return out, nil
}
