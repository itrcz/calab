// Package core is the money core of balance billing (ADR-0080 v5 «v1 cut», T1): the only code
// that changes balances, funding lots, seat lots (billing_charges) and the debt episode.
//
// # Model
//
// An account has one currency. Money comes in as funding lots (a provider payment or a
// superadmin credit) and is spent FIFO (lot id order) on seat lots: qty seats of one plan for
// [starts_at, ends_at), normally 24 h. The part of a seat lot no lot paid is debt
// (unfunded_minor). Invariants after every command (checked nightly by CheckIntegrity):
//
//	balance = sum(ledger) = free advance of the lots - debt of the charges
//	free advance > 0 and debt > 0 never at once (money in pays the oldest debt first)
//	a charge's amount = its allocations + its debt + its compensation
//
// Every command is one transaction that starts with SELECT … FOR UPDATE of the account
// (lock order: workspace rows → account → its lots / charges / refunds), takes the time from
// billing.Clock after the lock, makes no network call, writes the balance only through
// AppendBillingLedgerEntry and checks its idempotency key (charge business_key or ledger
// business_key) before writing. Any error rolls the whole command back.
//
// # Seats (billing.Seats, used by T3 admission)
//
// Core implements billing.Seats: Admit / Promote inside the caller's transaction after the
// membership row was written; Removed is a no-op (the next renewal counts the members). Admit
// first applies everything due (catch-up), then: covered capacity → no charge (replacement,
// also in debt: M3, M23); else one day of the missing seats from the free advance, never into
// debt → billing.ErrSeatGrowthRequiresFunds (409, M22); suspended → billing.ErrWorkspaceBillingSuspended;
// backlog beyond MaxCatchUpSteps → billing.ErrReconciling. Inactive / stopped accounts and
// workspaces without a live account pass.
//
// # Commands (own transaction; Hooks.Committed runs after the commit)
//
//	EnableAccount(ws, market, provider, actor)        superadmin: inactive account (ErrAccountExists)
//	Activate(acc, plan, requestID, actor)             first day of the uncovered members from advance (ErrInsufficientFunds)
//	Stop(acc, actor)                                  no new charges; running lots stay, plan Free when they end
//	ChangePlan(acc, plan, requestID, actor)           compensate the rest of the current lots + full day of the new plan;
//	                                                  upgrade only without debt (ErrChangeIncompatible / ErrInsufficientFunds)
//	CancelSeats(acc, qty, requestID, actor)           give back unused seats from now (M10); keeps the current team's seats
//	Resume(acc, free|paid, plan, requestID, actor)    after suspension, debt paid: free → stopped/Free (M21);
//	                                                  paid → first day of the team (M17)
//	AdminCredit / AdminDebit(acc, amount, reason, requestID, actor)   superadmin corrections (debit never creates debt)
//	ReverseAdminCredit(lot, reason, actor)            take a manual credit back in full (spent part becomes debt)
//	CreditPaymentTx(payment)                          CreditPayment in its own transaction
//	Quote(acc, plan)                                  catch-up + Quote; QuoteIn without catch-up in the caller's tx
//	ProcessDue(kind, skip)                            one due account (worker): renewal | coverage | suspension
//	CheckIntegrity()                                  read-only nightly reconciliation
//
// # In the caller's transaction (T5 inbox / T6 admin; caller notifies after its commit)
//
//	CreditPayment(q, paymentID)        a verified succeeded billing_payments row → lot + top-up, pays debt FIFO,
//	                                   closes the episode after the due catch-up; once per payment.
//	                                   Applies what was due up to succeeded_at first (receipt barrier).
//	RefundableForPayment(q, paymentID) unused money of the payment's own lot (+ dispute hold)
//	ReserveRefund(q, RefundReq)        takes the amount off the balance at once; Calab refunds: unused money
//	                                   only (ErrRefundExceedsRefundable, ErrDisputeHold); dashboard refunds:
//	                                   recorded as they are (spent part becomes debt). IdemKey idempotent.
//	ApplyRefundResult(q, id, status)   succeeded → payment.refunded_minor; failed / canceled → released back
//	OpenDispute(q, DisputeReq)         disputed money leaves at once, dispute_hold, episode if negative
//	CloseDispute(q, id, outcome)       won / withdrawn → money back; hold ends with the last open dispute
//	SyncPlan(q, acc, actor)            workspace_plans (source = billing) = PlanFor(acc)
//
// # Plans
//
// PlanFor(acc) is the workspace plan billing gives: active / suspended → the account plan,
// stopped → the account plan while its lots run, then free; inactive / closed → not managed
// (the manual row stays). Commands write it into workspace_plans with source = billing in their
// transaction and call Hooks.PlanChanged there (T3: identity grants of Business,
// auth.InvalidateIdentity); Hooks.Committed gets planChanged for plans.Invalidate and events.
//
// # Debt (ADR-0080 §8)
//
// A renewal of the current team may go into debt; the first negative balance writes
// negative_since and suspend_at = +7 d once (at the renewal boundary, or now for a dispute /
// reversed credit). Inside the episode a renewal that would stay negative is cut at suspend_at
// (half up, M18). At suspend_at with the balance still negative the account is suspended: no
// further charges (M16). Partial payments keep the deadline (M14); the episode closes when the
// balance is not negative after the due catch-up (M15). With Config.Enforcement off nobody is
// suspended and growth may go into debt; with Config.Debits off nothing is charged.
//
// # Kill switches and hold
//
// Config.Debits = BILLING_DEBITS_ENABLED, Config.Enforcement = BILLING_ENFORCEMENT_ENABLED.
// billing_accounts.hold_until (incident hold) freezes renewals, seat purchases and suspension
// until it passes; the catch-up afterwards starts at the old boundaries.
//
// # Business keys
//
//	charges: activate:{acc}:{req}  admit:{acc}:{req}  renew:{acc}:{plan}:{boundary}  change_plan:{acc}:{req}  resume:{acc}:{req}
//	ledger:  charge:{charge}  topup:{payment}  admin_credit:{req}  admin_debit:{req}  admin_reverse:{lot}
//	         refund:{refund}  refund_release:{refund}  dispute:{dispute}  dispute_reversal:{dispute}
//	         change_plan:{acc}:{req}:comp:{i}  cancel:{acc}:{req}:{i}
package core
