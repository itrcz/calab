package admin

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Saved-card charges and chargebacks recorded by hand (audit M5 / M6, ADR-0083 amendment
// 2026-10-10 «Неизвестный исход списания, чарджбэки»).

// Audit actions of this file.
const (
	actionCheckCharge  = "charge.check"
	actionChargeback   = "chargeback"
	actionCloseDispute = "dispute.close"
)

// ManualDisputePrefix starts the provider_dispute_id of a chargeback a superadmin recorded (the
// provider has no dispute API): "manual:{payment id}:{bank reference}".
const ManualDisputePrefix = "manual:"

// ChargeChecker resolves one saved-card charge now (autotopup.Job.CheckAttempt).
type ChargeChecker interface {
	CheckAttempt(ctx context.Context, accountID, attemptID uuid.UUID) (sqlc.BillingAutotopupAttempt, error)
}

// chargeProto is the superadmin's view of a charge (the provider of its card, its window).
func chargeProto(ctx context.Context, q *sqlc.Queries, att sqlc.BillingAutotopupAttempt, now time.Time) (*v1.AdminChargeAttempt, error) {
	view := autotopup.Describe(att, now)
	out := &v1.AdminChargeAttempt{
		Attempt: &v1.AutoTopupAttempt{
			Id: att.ID.String(), Amount: money(att.AmountMinor, att.Currency), Status: attemptStatus(att.Status),
			FailureCode: att.FailureCode, CreatedAt: timestamppb.New(att.CreatedAt), FinishedAt: ts(att.FinishedAt),
		},
		Kind: att.Kind, DispatchedAt: ts(att.DispatchedAt), Reconcilable: view.Reconcilable, ResolveBy: ts(view.ResolveBy),
		Checkable: view.Checkable,
	}
	pm, err := q.GetBillingPaymentMethod(ctx, att.PmID)
	if err != nil && !db.IsNotFound(err) {
		return nil, err
	}
	out.Provider = pm.Provider
	return out, nil
}

// checkCharge: POST /api/admin/billing/accounts/{id}/charges/{attemptId}/check — «Проверить
// списание сейчас»: the charge is read at the provider at once (never sent again). Audited like
// «Сверить»: the audit row is written first, then the read runs; a retry of the request_id reads
// again.
func (h *Handlers) checkCharge(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	attID, err := httpx.PathUUID(r, "attemptId", "charge attempt")
	if err != nil {
		return err
	}
	var req v1.AdminCheckChargeRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionCheckCharge, &req, accID.String(), attID.String())
	if err != nil {
		return err
	}
	if h.d.Charges == nil {
		return billing.ErrNotImplemented
	}
	ctx := r.Context()
	res, replay, err := h.ahead(ctx, c, &accID, nil, func(q *sqlc.Queries, acc *sqlc.BillingAccount) (*effect, error) {
		if _, err := q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: attID, AccountID: acc.ID}); db.IsNotFound(err) {
			return nil, billing.ErrAttemptNotFound
		} else if err != nil {
			return nil, err
		}
		return &effect{before: acc, acc: acc, target: map[string]string{"account_id": acc.ID.String(), "attempt_id": attID.String()}}, nil
	})
	if err != nil {
		return err
	}
	if !c.preview {
		att, err := h.d.Charges.CheckAttempt(ctx, accID, attID)
		if err != nil {
			return err
		}
		now, err := h.now(ctx, h.d.DB.Q)
		if err != nil {
			return err
		}
		if res.Charge, err = chargeProto(ctx, h.d.DB.Q, att, now); err != nil {
			return err
		}
		acc, err := h.d.DB.Q.GetBillingAccount(ctx, accID)
		if err != nil {
			return err
		}
		res.Replayed = replay
		res.BalanceAfter = money(acc.BalanceMinor, acc.Currency)
		if h.d.Committed != nil {
			h.d.Committed(ctx, acc)
		}
	}
	return h.respond(w, r, res, accID)
}

// bankReference validates the bank's reference of a chargeback: 3..100 printable characters
// without ':' (it is the tail of the dispute id).
func bankReference(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 3 || n > 100 {
		return "", httpx.Validation("bankReference", "bank_reference must be 3..100 characters")
	}
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return "", httpx.Validation("bankReference", "bank_reference must be printable")
		}
	}
	return s, nil
}

// disputesByAPI reports whether the payment's provider sends its disputes (CapDisputes: Stripe),
// so a chargeback of it is never recorded by hand. A provider not registered now is judged by
// name: Stripe always has the dispute API.
func disputesByAPI(reg *provider.Registry, name string) bool {
	if reg != nil {
		if p, ok := reg.Provider(provider.ID(name)); ok {
			return p.Caps().Has(provider.CapDisputes)
		}
	}
	return provider.ID(name) == provider.Stripe
}

// recordChargeback: POST /api/admin/billing/payments/{id}/chargebacks — «Зафиксировать
// чарджбэк» of a payment whose provider reports chargebacks outside its API (Tochka: letter,
// statement, chargeback registry). core.OpenDispute in this package's transaction: the amount
// leaves the balance at once (what the payment's lot paid becomes debt again), dispute_hold stops
// auto-topups and refunds of the account until the dispute is closed. Preview answers the
// balance after.
func (h *Handlers) recordChargeback(w http.ResponseWriter, r *http.Request) error {
	payID, err := httpx.PathUUID(r, "id", "payment")
	if err != nil {
		return err
	}
	var req v1.AdminRecordChargebackRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	ref, err := bankReference(req.GetBankReference())
	if err != nil {
		return err
	}
	c, err := newCmd(r, actionChargeback, &req, payID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	var accID uuid.UUID
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		pay, err := q.GetBillingPayment(ctx, payID)
		if db.IsNotFound(err) {
			return nil, httpx.NotFound("payment")
		}
		if err != nil {
			return nil, err
		}
		accID = pay.AccountID
		acc, err := lockAccount(ctx, q, pay.AccountID)
		if err != nil {
			return nil, err
		}
		if err := checkRevision(acc, req.GetExpectedRevision()); err != nil {
			return nil, err
		}
		amount, err := amountOf(req.GetAmount(), acc)
		if err != nil {
			return nil, err
		}
		if pay.Status != "succeeded" {
			return nil, conflict("only a succeeded payment can be charged back")
		}
		if disputesByAPI(h.d.Providers, pay.Provider) {
			// Its webhook records the dispute (another provider_dispute_id): a manual one too
			// would take the money twice.
			return nil, conflict("this provider reports chargebacks through its API; they are recorded by its webhook")
		}
		disputed, err := q.AdminBillingDisputedOfPayment(ctx, pay.ID)
		if err != nil {
			return nil, err
		}
		if amount > pay.AmountMinor-pay.RefundedMinor-disputed {
			return nil, httpx.Validation("amount", "amount exceeds what the payment can still lose (paid − refunded − disputed)")
		}
		id := ManualDisputePrefix + pay.ID.String() + ":" + ref
		if _, err := q.GetBillingDisputeByProviderID(ctx, id); err == nil {
			return nil, conflict("a chargeback with this bank reference is recorded already")
		} else if !db.IsNotFound(err) {
			return nil, err
		}
		d, after, err := h.d.Core.OpenDispute(ctx, q, core.DisputeReq{PaymentID: pay.ID, ProviderDisputeID: id, Amount: amount})
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after, target: map[string]string{"account_id": acc.ID.String(), "payment_id": pay.ID.String(), "dispute_id": d.ID.String()},
			res: &v1.AdminBillingMutationResult{Amount: money(amount, acc.Currency), Dispute: disputeProto(d)}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, accID)
}

// closeDispute: POST /api/admin/billing/disputes/{id}/close — the outcome of a chargeback
// recorded by hand (core.CloseDispute): won / withdrawn → the money returns, lost → it stays
// taken; the dispute hold ends with the account's last open dispute. A provider's dispute
// (Stripe) is closed by its webhook only: 409.
func (h *Handlers) closeDispute(w http.ResponseWriter, r *http.Request) error {
	dID, err := httpx.PathUUID(r, "id", "dispute")
	if err != nil {
		return err
	}
	var req v1.AdminCloseDisputeRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var outcome string
	switch req.GetOutcome() {
	case v1.DisputeStatus_DISPUTE_STATUS_WON:
		outcome = core.DisputeWon
	case v1.DisputeStatus_DISPUTE_STATUS_LOST:
		outcome = core.DisputeLost
	case v1.DisputeStatus_DISPUTE_STATUS_WITHDRAWN:
		outcome = core.DisputeWithdrawn
	default:
		return httpx.Validation("outcome", "outcome must be WON, LOST or WITHDRAWN")
	}
	c, err := newCmd(r, actionCloseDispute, &req, dID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	var accID uuid.UUID
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		d, err := q.AdminGetBillingDispute(ctx, dID)
		if db.IsNotFound(err) {
			return nil, billing.ErrDisputeNotFound
		}
		if err != nil {
			return nil, err
		}
		accID = d.AccountID
		if !strings.HasPrefix(d.ProviderDisputeID, ManualDisputePrefix) {
			return nil, conflict("a provider's dispute is closed by the provider's webhook")
		}
		acc, err := lockAccount(ctx, q, d.AccountID)
		if err != nil {
			return nil, err
		}
		if d.Status != "open" {
			return nil, conflict("the dispute is closed already")
		}
		done, after, err := h.d.Core.CloseDispute(ctx, q, d.ProviderDisputeID, outcome)
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after, target: map[string]string{"account_id": acc.ID.String(), "dispute_id": d.ID.String()},
			res: &v1.AdminBillingMutationResult{Amount: money(d.AmountMinor, d.Currency), Dispute: disputeProto(done)}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, accID)
}
