// Package autotopup charges the owner's saved card off-session when the balance runs low
// (ADR-0080 §7 and v5 «v1 cut», T7). The owner's consent (PUT …/billing/auto-topup) is stored
// by billing/http; this package decides, dispatches and settles the attempts.
//
// # When and how much
//
// A worker tick (and a wake after any committed billing change, e.g. a renewal debit) looks at
// active accounts with a live consent, not_before passed, no open attempt and no dispute /
// incident hold. An account needs a top-up when its balance is below the cost of the next
// ThresholdDays (3) days of the current team, or negative (Need). The amount is the owner's
// formula A = debt + 30 days of the current team (core.Quote.AutoTopupMinor), capped by the
// owner's max_minor and the method's maximum, raised to the method's minimum (Amount).
//
// # Two-phase dispatch (no network inside a transaction)
//
//  1. prepare (account lock): re-check consent / owner / card / limits / no open attempt /
//     not_before / need; insert the attempt as prepared (the partial UNIQUE index allows one
//     open attempt per account) and set not_before = now + 24 h (≤ 1 new attempt per 24 h).
//  2. fence (account lock): the same checks again; a revoked consent or a need that went away
//     (a manual top-up landed) fails the prepared attempt — it was never sent. Otherwise the
//     attempt becomes dispatched before the provider is called: a prepared attempt is
//     therefore always unsent.
//  3. ChargeOffSession with Idempotency-Key = attempt id and metadata {kind=auto_topup,
//     attempt_id, account_id}.
//  4. settle: succeeded → the payment goes through the inbox credit path (inbox.SyncPayment:
//     fresh read, one billing_payments row per PaymentIntent, one funding lot), the inbox hook
//     AttemptSettled marks the attempt succeeded in the credit transaction, so a webhook that
//     arrives first or second credits once; processing → wait (webhook / recovery);
//     failed → failed + owner mail (dedup key auto_topup:{attempt}); requires_action →
//     CancelPayment, failed + owner mail with the manual top-up link; a lost answer
//     (provider.ErrUnknownOutcome) → unknown.
//
// # Recovery (every tick, also with BILLING_AUTO_TOPUP_ENABLED off)
//
// prepared older than Grace → failed «abandoned» (never sent). dispatched / unknown older than
// Grace: with a PaymentIntent id → GetPayment and settle; without one → the same request with
// the same key while younger than RetryWindow (23 h, inside Stripe's 24 h idempotency window)
// and auto-topup is on, unpaused, the consent still live; otherwise a lookup (ListPayments of
// the customer, metadata attempt_id). Nothing found after GiveUpAfter (24 h) → failed
// «not_found» (no owner mail: not a decline). An open attempt blocks every new one, so an
// unknown outcome never leads to a second charge.
//
// # Consent ends
//
// DELETE …/auto-topup, a detached / deleted card, a closed account and an owner change revoke
// the consent: no new attempt, and a prepared one is failed at the fence; a dispatched one is
// still settled. The owner check is also enforced at every dispatch (consent_by must be the
// workspace owner), so an ownership change revokes the consent even without a hook; there is
// no ownership transfer API today — a future one calls OwnerChanged in its transaction.
//
// # After a database restore
//
// A restored database can lack attempts that were sent: a new attempt would use a new key and
// charge twice. With BILLING_AUTO_TOPUP_REQUIRE_RECONCILE=<marker> no new attempt starts until
// a superadmin runs POST /api/admin/billing/auto-topup/reconcile: it lists the auto-topup
// payments of the last 48 h of every customer with a consent or attempt, credits the ones we do
// not have (once, through the inbox), settles local attempts, pushes not_before to 24 h after
// the newest one and records the marker in billing_audit (docs/06 «Резервные копии»).
package autotopup
