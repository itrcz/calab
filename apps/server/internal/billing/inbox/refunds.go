package inbox

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// refundEvent: refund.* (object re_) or charge.refunded (object ch_: list the payment's
// refunds). Every refund is re-read and applied by applyRefund.
func (in *Inbox) refundEvent(ctx context.Context, p provider.Provider, ev provider.Event) error {
	var facts []provider.RefundFact
	switch {
	case strings.HasPrefix(ev.ObjectID, "re_"):
		f, err := p.GetRefund(ctx, ev.ObjectID)
		if errors.Is(err, provider.ErrNotFound) {
			return permanent("refund %s: %w", ev.ObjectID, ErrOrphan)
		}
		if err != nil {
			return err
		}
		facts = []provider.RefundFact{f}
	case ev.PaymentID != "":
		l, ok := p.(provider.RefundLister)
		if !ok {
			return permanent("provider %s cannot list refunds of %s", p.ID(), ev.PaymentID)
		}
		fs, err := l.ListRefunds(ctx, ev.PaymentID)
		if err != nil {
			return err
		}
		facts = fs
	default:
		return permanent("refund event %s without refund or payment", ev.EventID)
	}
	for _, f := range facts {
		if err := in.ApplyRefund(ctx, p, f); err != nil {
			return err
		}
	}
	return nil
}

func refundStatus(s provider.RefundStatus) string {
	switch s {
	case provider.RefundSucceeded:
		return core.RefundSucceeded
	case provider.RefundFailed:
		return core.RefundFailed
	case provider.RefundCanceled:
		return core.RefundCanceled
	case provider.RefundRequiresAction:
		return core.RefundRequiresAction
	}
	return core.RefundPending
}

// ApplyRefund records a fresh refund fact: a refund we know (by provider id, or a Calab
// refund of the same payment and amount still waiting for its provider id) gets its status;
// an unknown one was made in the provider dashboard and is imported once (origin dashboard,
// idem key dashboard:{re_…}): its money leaves the balance as it is.
func (in *Inbox) ApplyRefund(ctx context.Context, p provider.Provider, f provider.RefundFact) error {
	pay, err := in.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
		Provider: string(p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.PaymentID,
	})
	if db.IsNotFound(err) {
		// The payment may not be recorded yet (its own events are behind): retry with backoff.
		return fmt.Errorf("refund %s: payment %s not recorded yet", f.ID, f.PaymentID)
	}
	if err != nil {
		return err
	}
	status := refundStatus(f.Status)
	var acc sqlc.BillingAccount
	done := false
	var refusal error
	err = in.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if acc, err = q.LockBillingAccount(ctx, pay.AccountID); err != nil {
			return err
		}
		if string(f.Amount.Currency) != acc.Currency {
			refusal = permanent("refund %s in %s, account %s: %w", f.ID, f.Amount.Currency, acc.Currency, ErrMismatch)
			return refusal
		}
		ref, err := q.GetBillingRefundByProviderID(ctx, &f.ID)
		if db.IsNotFound(err) {
			ref, err = matchCalabRefund(ctx, q, pay, f)
		}
		var before string
		switch {
		case err == nil:
			before = ref.Status
			if status == core.RefundPending || before == status {
				if ref.ProviderRefundID == nil {
					// A Calab refund still pending at the provider: remember its id.
					_, err := q.AdminSetBillingRefundProviderID(ctx, sqlc.AdminSetBillingRefundProviderIDParams{ProviderRefundID: f.ID, Now: time.Now(), ID: ref.ID})
					if err != nil && !db.IsNotFound(err) {
						return err
					}
				}
				return nil
			}
			if ref, acc, err = in.core.ApplyRefundResult(ctx, q, ref.ID, status, &f.ID); err != nil {
				return err
			}
		case db.IsNotFound(err):
			ref, acc, err = in.core.ReserveRefund(ctx, q, core.RefundReq{
				PaymentID: pay.ID, Amount: f.Amount.Minor, IdemKey: "dashboard:" + f.ID, Origin: core.RefundOriginDashboard,
				Status: status, ProviderRefundID: &f.ID, Reason: "provider dashboard",
			})
			if errors.Is(err, billing.ErrRefundExceedsRefundable) || errors.Is(err, billing.ErrRequestReused) {
				refusal = permanent("dashboard refund %s of %s: %w", f.ID, f.PaymentID, err)
				return refusal
			}
			if err != nil {
				return err
			}
		default:
			return err
		}
		done = true
		if ref.Status == core.RefundSucceeded && before != core.RefundSucceeded {
			return in.Mail.Notify(ctx, q, acc, "refund:"+ref.ID.String(), mail.TemplateBillingRefundDone, mail.Params{
				"amount": amountText(ref.AmountMinor, ref.Currency),
			})
		}
		return nil
	})
	if refusal != nil {
		return refusal
	}
	if err != nil {
		return err
	}
	if done {
		in.committed(ctx, acc)
	}
	return nil
}

// matchCalabRefund finds the Calab refund a provider refund answers when the provider id was
// not stored yet (the webhook raced the API answer): same payment and amount, oldest first.
func matchCalabRefund(ctx context.Context, q *sqlc.Queries, pay sqlc.BillingPayment, f provider.RefundFact) (sqlc.BillingRefund, error) {
	rs, err := q.ListPendingCalabBillingRefunds(ctx, pay.ID)
	if err != nil {
		return sqlc.BillingRefund{}, err
	}
	for _, r := range rs {
		if r.AmountMinor == f.Amount.Minor {
			return r, nil
		}
	}
	return sqlc.BillingRefund{}, pgx.ErrNoRows
}
