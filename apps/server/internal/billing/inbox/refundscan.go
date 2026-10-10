package inbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Refund polling (ADR-0083 amendment, owner 2026-10-10). Tochka sends no refund webhook, so a
// refund — ours or made in the bank's interface — is seen only in the operations' Order[]. One
// list call per merchant per tick reads every operation of the last RefundScanWindow (180 days,
// the card refund window) with its Order[]; each refund line is applied:
//   - a payment link's line: ApplyRefund — the Calab refund with this id, else the oldest
//     unclaimed Calab refund of that payment and amount, else booked as a bank refund;
//   - a subscription's line (no charge named): the oldest unclaimed Calab refund of the same
//     amount over every payment of the subscription (binding payment and charges), else booked
//     as a bank refund on the subscription's payments.
// A bank refund is a fact: booked at once, even into debt (core.BookBankRefund), listed in
// «Требует внимания» as information; only a refund in another currency, or larger than every
// payment can return, stays open there for a superadmin.
//
// Cadence (scanInterval): every minute for 24 h after the last payment or refund of the provider,
// every 5 minutes for 7 days, every 15 minutes up to 180 days, then not at all. The superadmin's
// «Сверить» runs a pass at once. One replica at a time (ScanLock), one scheduled pass per
// interval across replicas and a 429 backoff shared by all (ScanGate).

// RefundScanWindow bounds the operations read: older ones are not (cards are refundable 180 days).
const RefundScanWindow = 180 * 24 * time.Hour

// RefundScanTick is how often RunRefundScan wakes to check whether a pass is due.
const RefundScanTick = time.Minute

// unknownRefundTTL: an admin refund with an unknown outcome the bank does not list after this long
// never happened: closed as failed, nothing was deducted.
const unknownRefundTTL = 24 * time.Hour

// Issue reasons (billing_provider_issues.reason).
const (
	IssueBankRefund       = "bank_refund"
	IssueCurrencyMismatch = "currency_mismatch"
	IssueExceedsPayments  = "exceeds_payments"
)

// scanInterval is the pause between passes after the provider's last activity at `last`; 0 = none due.
func scanInterval(last, now time.Time) time.Duration {
	if last.IsZero() {
		return 0
	}
	switch age := now.Sub(last); {
	case age < 24*time.Hour:
		return time.Minute
	case age < 7*24*time.Hour:
		return 5 * time.Minute
	case age < RefundScanWindow:
		return 15 * time.Minute
	}
	return 0
}

// RunRefundScan runs the polling until ctx is done: each tick, a pass for every provider that
// reads refunds this way when its cadence says one is due.
func (in *Inbox) RunRefundScan(ctx context.Context) {
	sched := map[provider.ID]*scanSchedule{}
	t := time.NewTicker(RefundScanTick)
	defer t.Stop()
	for {
		for _, p := range in.reg.Providers() {
			if _, ok := p.(provider.RefundScanner); !ok {
				continue
			}
			act, err := in.db.Q.LastBillingActivity(ctx, string(p.ID()))
			if err != nil {
				slog.WarnContext(ctx, "billing refund scan: activity", "provider", p.ID(), "err", err)
				continue
			}
			s := sched[p.ID()]
			if s == nil {
				s = &scanSchedule{}
				sched[p.ID()] = s
			}
			now := time.Now()
			if !in.scanDue(ctx, string(p.ID()), s, scanInterval(act, now), now) {
				continue
			}
			err = in.ScanRefunds(ctx, p)
			in.scanDone(ctx, string(p.ID()), s, err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// scanSchedule is one replica's view of a provider's polling: its last pass and the backoff
// after a 429 (2, 4, 8, 15 min).
type scanSchedule struct {
	last    time.Time
	backoff time.Duration
}

// scanDue tells whether this replica runs the provider's pass now: the cadence (every; 0 =
// none) or a backoff has elapsed, and no other replica claimed this slot (ScanGate).
func (in *Inbox) scanDue(ctx context.Context, prov string, s *scanSchedule, every time.Duration, now time.Time) bool {
	wait := max(every, s.backoff) - time.Second // a tick's jitter
	if every == 0 || now.Sub(s.last) < wait {
		return false
	}
	s.last = now
	return in.ScanGate == nil || in.ScanGate(ctx, prov, wait, false)
}

// scanDone records a pass's outcome: a 429 backs off (every replica, through ScanGate).
func (in *Inbox) scanDone(ctx context.Context, prov string, s *scanSchedule, err error) {
	switch {
	case errors.Is(err, provider.ErrRateLimited):
		s.backoff = min(max(2*s.backoff, 2*time.Minute), 15*time.Minute)
		if in.ScanGate != nil {
			in.ScanGate(ctx, prov, s.backoff-time.Second, true)
		}
		slog.WarnContext(ctx, "billing refund scan: rate limited, backing off", "provider", prov, "retry_in", s.backoff.String())
	case err != nil && ctx.Err() == nil:
		s.backoff = 0
		slog.WarnContext(ctx, "billing refund scan", "provider", prov, "err", err)
	default:
		s.backoff = 0
	}
}

// ScanRefunds runs one pass for p (no-op for a provider without provider.RefundScanner, or
// while another replica runs one): applies every refund line and closes admin refunds with an
// unknown outcome the bank never listed.
func (in *Inbox) ScanRefunds(ctx context.Context, p provider.Provider) error {
	sc, ok := p.(provider.RefundScanner)
	if !ok {
		return nil
	}
	if in.ScanLock != nil {
		release, ok := in.ScanLock(ctx, string(p.ID()))
		if !ok {
			return nil // another replica is on it
		}
		defer release()
	}
	ops, err := sc.ScanRefunds(ctx, time.Now().Add(-RefundScanWindow))
	if err != nil {
		return err
	}
	var errs []error
	lines := 0
	for _, op := range ops {
		lines += len(op.Refunds)
		if op.Subscription {
			errs = append(errs, in.applySubscriptionRefunds(ctx, p, op))
			continue
		}
		for _, f := range op.Refunds {
			if err := in.ApplyRefund(ctx, p, f); err != nil && !errors.Is(err, errPaymentUnknown) {
				errs = append(errs, err)
			}
		}
	}
	errs = append(errs, in.closeUnknownRefunds(ctx, p))
	slog.DebugContext(ctx, "billing refund scan", "provider", p.ID(), "operations", len(ops), "refund_lines", lines)
	return errors.Join(errs...)
}

// errPaymentUnknown: a refund of a payment we have not recorded (not ours, or its events are
// behind) — ApplyRefund's caller retries later.
var errPaymentUnknown = errors.New("payment not recorded")

// applySubscriptionRefunds applies the refund lines of one subscription operation.
func (in *Inbox) applySubscriptionRefunds(ctx context.Context, p provider.Provider, op provider.OperationRefunds) error {
	if len(op.Refunds) == 0 {
		return nil
	}
	f0 := op.Refunds[0]
	pay, err := in.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
		Provider: string(p.ID()), ProviderAccount: f0.ProviderAccount, Livemode: f0.Livemode, ProviderPaymentID: op.PaymentID,
	})
	if db.IsNotFound(err) {
		return nil // not ours / not recorded yet
	}
	if err != nil {
		return err
	}
	// One line that cannot be applied does not stop the others (audit M4).
	var errs []error
	for _, f := range op.Refunds {
		errs = append(errs, in.applySubscriptionRefund(ctx, p, pay, op.PaymentID, f))
	}
	return errors.Join(errs...)
}

func (in *Inbox) applySubscriptionRefund(ctx context.Context, p provider.Provider, binding sqlc.BillingPayment, sub string, f provider.RefundFact) error {
	if _, err := in.db.Q.GetBillingRefundByProviderID(ctx, &f.ID); err == nil {
		return nil // applied before
	} else if !db.IsNotFound(err) {
		return err
	}
	var acc sqlc.BillingAccount
	var mailed *sqlc.BillingRefund
	err := in.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if acc, err = q.LockBillingAccount(ctx, binding.AccountID); err != nil {
			return err
		}
		if _, err := q.GetBillingRefundByProviderID(ctx, &f.ID); err == nil {
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		if string(f.Amount.Currency) != acc.Currency {
			return reportIssue(ctx, q, acc.ID, &binding.ID, string(p.ID()), f, IssueCurrencyMismatch, "open")
		}
		ours, err := q.ListUnclaimedCalabBillingRefundsOfSubscription(ctx, sqlc.ListUnclaimedCalabBillingRefundsOfSubscriptionParams{Provider: string(p.ID()), Subscription: sub})
		if err != nil {
			return err
		}
		for _, r := range ours {
			if r.AmountMinor != f.Amount.Minor {
				continue
			}
			id := f.ID
			if _, err := q.ClaimBillingRefundProviderID(ctx, sqlc.ClaimBillingRefundProviderIDParams{ProviderRefundID: id, Now: time.Now(), ID: r.ID}); err != nil {
				return err
			}
			if r.Status == core.RefundSucceeded {
				return nil // booked when the API answered
			}
			ref, a, err := in.core.ApplyRefundResult(ctx, q, r.ID, core.RefundSucceeded, &id)
			if err != nil {
				return err
			}
			acc, mailed = a, &ref
			return nil
		}
		refs, a, err := in.bookBankRefund(ctx, q, acc, nil, sub, string(p.ID()), f)
		if err != nil || len(refs) == 0 {
			return err
		}
		acc, mailed = a, &refs[0]
		return nil
	})
	if err != nil {
		return fmt.Errorf("subscription refund %s: %w", f.ID, err)
	}
	if mailed != nil {
		in.committed(ctx, acc)
	}
	return nil
}

// bookBankRefund books a refund executed at the provider that no Calab refund claims (core.
// BookBankRefund: its payment first, then the group's, then the account's others), with an
// informational «Требует внимания» row and the owner's mail. More than every payment can return:
// an open row, nothing booked.
func (in *Inbox) bookBankRefund(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, payment *uuid.UUID, group, prov string, f provider.RefundFact) ([]sqlc.BillingRefund, sqlc.BillingAccount, error) {
	refs, a, err := in.core.BookBankRefund(ctx, q, acc.ID, payment, group, f.ID, f.Amount.Minor, "refund made at the provider", nil)
	if errors.Is(err, billing.ErrRefundExceedsRefundable) {
		return nil, acc, reportIssue(ctx, q, acc.ID, payment, prov, f, IssueExceedsPayments, "open")
	}
	if err != nil {
		return nil, acc, err
	}
	pid := payment
	if pid == nil && len(refs) > 0 {
		pid = &refs[0].PaymentID
	}
	if err := reportIssue(ctx, q, acc.ID, pid, prov, f, IssueBankRefund, "imported"); err != nil {
		return nil, a, err
	}
	slog.WarnContext(ctx, "billing: refund made at the provider booked", "account", acc.ID, "provider_refund", f.ID, "amount_minor", f.Amount.Minor,
		"balance_after", a.BalanceMinor)
	if err := in.Mail.Notify(ctx, q, a, "refund:"+refs[0].ID.String(), mail.TemplateBillingRefundDone, mail.Params{
		"amount": amountText(f.Amount.Minor, string(f.Amount.Currency)),
	}); err != nil {
		return nil, a, err
	}
	return refs, a, nil
}

// reportIssue records a provider refund for «Требует внимания» (once per refund; a resolved one is
// not reopened). status "open" = waits for a superadmin (ERROR log), "imported" = information.
func reportIssue(ctx context.Context, q *sqlc.Queries, account uuid.UUID, payment *uuid.UUID, prov string, f provider.RefundFact, reason, status string) error {
	var at *time.Time
	if !f.Created.IsZero() {
		at = &f.Created
	}
	row, err := q.InsertBillingProviderIssue(ctx, sqlc.InsertBillingProviderIssueParams{
		AccountID: account, PaymentID: payment, Provider: prov, ProviderRef: f.ID, AmountMinor: f.Amount.Minor,
		Currency: string(f.Amount.Currency), Reason: reason, Status: status, OccurredAt: at,
	})
	if db.IsNotFound(err) {
		return nil // reported before
	}
	if err != nil {
		return err
	}
	if status == "open" {
		issuesOpened.Inc()
		slog.ErrorContext(ctx, "billing: provider refund needs a superadmin («Требует внимания»)", "issue", row.ID, "account", account,
			"provider", prov, "reason", reason, "amount_minor", f.Amount.Minor, "currency", f.Amount.Currency)
	}
	return nil
}

// closeUnknownRefunds closes the admin refunds with an unknown outcome the provider has not
// listed for unknownRefundTTL: they never happened, nothing was deducted.
func (in *Inbox) closeUnknownRefunds(ctx context.Context, p provider.Provider) error {
	refs, err := in.db.Q.ListBillingRefundsToClose(ctx, sqlc.ListBillingRefundsToCloseParams{Before: time.Now().Add(-unknownRefundTTL), Lim: reconcileBatch})
	if err != nil {
		return err
	}
	for _, ref := range refs {
		pay, err := in.db.Q.GetBillingPayment(ctx, ref.PaymentID)
		if err != nil || pay.Provider != string(p.ID()) {
			continue
		}
		slog.WarnContext(ctx, "billing: admin refund never executed at the provider, closed", "refund", ref.ID, "account", ref.AccountID)
		if err := in.settleRefund(ctx, ref, core.RefundFailed, ""); err != nil {
			return err
		}
	}
	return nil
}
