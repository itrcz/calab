package inbox

import (
	"context"
	"errors"
	"fmt"

	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// disputeEvent: charge.dispute.* (object dp_, PaymentID pi_). With a provider.DisputeReader
// the amount and the outcome come from a fresh read; without one, the amount is the whole
// payment and a close is won only on funds_reinstated (else lost: the money stays taken, the
// conservative side).
func (in *Inbox) disputeEvent(ctx context.Context, p provider.Provider, ev provider.Event) error {
	if ev.ObjectID == "" {
		return permanent("dispute event %s without dispute id", ev.EventID)
	}
	fact := provider.DisputeFact{ID: ev.ObjectID, PaymentID: ev.PaymentID, ProviderAccount: ev.ProviderAccount, Livemode: ev.Livemode, Status: provider.DisputeOpen}
	if ev.Kind == provider.EventDisputeClosed {
		fact.Status = provider.DisputeLost
		if ev.Type == "charge.dispute.funds_reinstated" {
			fact.Status = provider.DisputeWon
		}
	}
	if r, ok := p.(provider.DisputeReader); ok {
		f, err := r.GetDispute(ctx, ev.ObjectID)
		if errors.Is(err, provider.ErrNotFound) {
			return permanent("dispute %s: %w", ev.ObjectID, ErrOrphan)
		}
		if err != nil {
			return err
		}
		if f.PaymentID == "" {
			f.PaymentID = ev.PaymentID
		}
		if f.ProviderAccount == "" {
			f.ProviderAccount = ev.ProviderAccount
		}
		fact = f
	}
	return in.ApplyDispute(ctx, p, fact)
}

// ApplyDispute records a dispute fact: an open dispute takes its amount off the balance once
// (core.OpenDispute), a closed one returns it when won / withdrawn (core.CloseDispute). A
// dispute whose opening was never seen is opened first.
func (in *Inbox) ApplyDispute(ctx context.Context, p provider.Provider, f provider.DisputeFact) error {
	if f.PaymentID == "" {
		return permanent("dispute %s without payment: %w", f.ID, ErrOrphan)
	}
	pay, err := in.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
		Provider: string(p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.PaymentID,
	})
	if db.IsNotFound(err) {
		return fmt.Errorf("dispute %s: payment %s not recorded yet", f.ID, f.PaymentID)
	}
	if err != nil {
		return err
	}
	amount := pay.AmountMinor
	if f.Amount.Minor > 0 {
		if string(f.Amount.Currency) != pay.Currency {
			return permanent("dispute %s in %s, payment in %s: %w", f.ID, f.Amount.Currency, pay.Currency, ErrMismatch)
		}
		amount = min(f.Amount.Minor, pay.AmountMinor)
	}
	var acc sqlc.BillingAccount
	changed := false
	err = in.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if acc, err = q.LockBillingAccount(ctx, pay.AccountID); err != nil {
			return err
		}
		d, err := q.GetBillingDisputeByProviderID(ctx, f.ID)
		if db.IsNotFound(err) {
			if d, acc, err = in.core.OpenDispute(ctx, q, core.DisputeReq{PaymentID: pay.ID, ProviderDisputeID: f.ID, Amount: amount}); err != nil {
				return err
			}
			changed = true
			if err := in.Mail.Notify(ctx, q, acc, "dispute:"+d.ID.String(), mail.TemplateBillingDisputeOpened, mail.Params{
				"amount": amountText(d.AmountMinor, d.Currency),
			}); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		outcome := ""
		switch f.Status {
		case provider.DisputeWon:
			outcome = core.DisputeWon
		case provider.DisputeLost:
			outcome = core.DisputeLost
		case provider.DisputeWithdrawn:
			outcome = core.DisputeWithdrawn
		}
		if outcome == "" || d.Status != "open" {
			return nil
		}
		if _, acc, err = in.core.CloseDispute(ctx, q, f.ID, outcome); err != nil {
			return err
		}
		changed = true
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		in.committed(ctx, acc)
	}
	return nil
}
