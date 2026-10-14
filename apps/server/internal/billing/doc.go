// Package billing is the balance billing of workspaces (ADR-0080 v5, «v1 cut» 2026-10-09):
// a money balance per workspace billing account, seats charged per 24 hours from it, top-ups
// through a payment provider (Stripe first) and an optional auto-topup.
//
// This root package holds only the shared contracts the other packages build on: Clock,
// Seats (the admission hook) and the API errors / reasons (flags: config.Billing). Business
// logic lives in sub-packages, each owned by one task (docs/plans/billing-v1-tasks.md):
//
//	money/            T0  int64 minor-unit Money, half-up proration and discounts
//	provider/         T0  Provider / OffSessionCharger interfaces, Registry, capability matrix
//	provider/fake/    T0  deterministic fake provider for tests
//	core/             T1  ledger, funding lots FIFO, seat charges, debt episode, quotes, Seats impl
//	worker/           T1  daily renewal, suspension at the deadline, nightly ledger check
//	providers/stripe/ T2  Stripe adapter of provider.Provider + OffSessionCharger
//	http/             T5  REST handlers (/api/workspaces/{id}/billing, public webhook / return)
//	inbox/            T5  webhook inbox processing and pull-sync of checkouts / payments
//	admin/            T6  /api/admin/billing handlers
//	autotopup/        T7  consent, attempts, unknown-outcome recovery
//
// Database: migration 00074_billing.sql and queries/billing.sql are T0's and frozen; a task adds
// queries in its own file (queries/billing_core.sql, billing_stripe.sql, billing_http.sql,
// billing_admin.sql, billing_autotopup.sql) so parallel work does not collide.
//
// Rules for every task (money correctness, ADR-0080 v5):
//   - money is money.Money / int64 minor units; never float64; an account has one currency;
//   - every money mutation is one transaction that starts with sqlc LockBillingAccount (or
//     LockLiveBillingAccountByWorkspace) and makes no network call; provider calls happen
//     before (with a row written first) or after (recorded by a second transaction);
//   - lock order: workspace rows (membership) → billing account → dependent billing rows;
//   - time comes from Clock (passed to queries as now), so tests drive it with FakeClock;
//   - balance changes only through AppendBillingLedgerEntry (append-only ledger + cache);
//   - writes go through db.Tx / db.GuardValue (internal/app's mutation census refuses direct
//     d.Q mutations and Pool use);
//   - one credit per provider payment: billing_payments UNIQUE key + one funding lot per
//     payment; Checkout / Charge / Event are references only; re-read the payment from the
//     provider before crediting.
package billing
