package tochka

import (
	"context"
	"log/slog"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Refunds the API cannot make, and the refunds made at the bank (ADR-0083 amendment 2026-10-10).
// The bank's documentation: «Платежи, поступившие через подписки, можно вернуть только в
// интернет-банке» — a saved card's binding payment and its charges are refunded by an operator in
// the bank's interface. The bank sends no refund webhook (its webhook types are
// acquiringInternetPayment, incomingPayment, incomingSbpPayment, outgoingPayment): every refund,
// ours or made at the bank, is seen in the operations' Order[] by ScanRefunds.

var (
	_ provider.HandRefunder  = (*Provider)(nil)
	_ provider.RefundScanner = (*Provider)(nil)
)

// RefundsByHand reports that a charge of a subscription, or the subscription's binding payment, is refunded
// only in the bank's interface.
func (p *Provider) RefundsByHand(paymentID string, savedMethod bool) bool {
	_, _, charge := splitChargeID(paymentID)
	return charge || savedMethod
}

// ScanRefunds lists every operation of our customer code created since `since` (all pages; the
// list carries each operation's Order[]) and returns those with refunds: a payment link's refunds
// as RefundFacts of the link, a subscription's as unattributed ones (Subscription: Order[] does
// not say which approval a refund returns).
func (p *Provider) ScanRefunds(ctx context.Context, since time.Time) ([]provider.OperationRefunds, error) {
	var out []provider.OperationRefunds
	for page := 1; ; page++ {
		ops, pages, err := p.listPage(ctx, since, page)
		if err != nil {
			return nil, err
		}
		for _, op := range ops {
			if p.ours(op) != nil {
				continue
			}
			facts, err := p.refundFacts(op)
			if err != nil {
				// An unreadable amount skips this operation, never the whole pass (audit M4).
				slog.WarnContext(ctx, "tochka: refund lines unreadable, skipped", "err", err)
				continue
			}
			for i := range facts {
				// Listed in Order[] = executed by the bank (owner 2026-10-10: a bank refund is a fact,
				// booked at once; ON-REFUND is the bank's settlement, not a doubt).
				facts[i].Status = provider.RefundSucceeded
			}
			if len(facts) > 0 {
				out = append(out, provider.OperationRefunds{PaymentID: op.OperationID, Subscription: op.bound(), Refunds: facts})
			}
		}
		if page >= pages {
			return out, nil
		}
	}
}
