package admin

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Audit actions.
const (
	actionEnable        = "enable"
	actionManualCredit  = "manual_credit"
	actionReverseCredit = "manual_credit.reverse"
	actionAdminDebit    = "admin_debit"
	actionRefund        = "refund"
	actionDecide        = "refund_request.decide"
	actionHold          = "hold"
	actionDiscount      = "discount"
	actionPrice         = "price.create"
	actionReconcile     = "reconcile"
)

// PriceNotice is how far ahead a new price version starts (ADR-0080 §0: no consent flow,
// effective_from >= now + 10 days).
const PriceNotice = 10 * billing.Day

// MaxHold bounds an incident hold.
const MaxHold = 90 * billing.Day

var markets = map[string]string{"global": "USD", "ru": "RUB"}

// enable: POST /api/admin/billing/workspaces/{id}/enable — the inactive account of a
// workspace (core.EnableAccount; market global by default). 409 BILLING_ACCOUNT_EXISTS if the
// workspace has a live account.
func (h *Handlers) enable(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.AdminEnableBillingRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionEnable, &req, wsID.String())
	if err != nil {
		return err
	}
	market := req.GetMarket()
	if market == "" {
		market = "global"
	}
	currency, ok := markets[market]
	if !ok {
		return httpx.Validation("market", "market must be global or ru")
	}
	if p := req.GetPlan(); p != v1.Plan_PLAN_UNSPECIFIED && p != v1.Plan_PLAN_TEAM {
		return httpx.Validation("plan", "the owner chooses the paid plan at activation")
	}
	prov := h.providerOf(market)
	if prov == "" {
		return httpx.Validation("market", "no provider serves this market (BILLING_PROVIDERS)")
	}
	ctx := r.Context()
	res, replay, err := h.ahead(ctx, c, nil, &wsID, func(q *sqlc.Queries, _ *sqlc.BillingAccount) (*effect, error) {
		if _, err := q.GetWorkspace(ctx, wsID); err != nil {
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("workspace")
			}
			return nil, err
		}
		if _, err := q.GetLiveBillingAccountByWorkspace(ctx, &wsID); err == nil {
			return nil, billing.ErrAccountExists
		} else if !db.IsNotFound(err) {
			return nil, err
		}
		after := sqlc.BillingAccount{WorkspaceID: &wsID, Market: market, Currency: currency, Provider: prov,
			Plan: core.PlanTeam, Status: core.StatusInactive, Revision: 1}
		return &effect{acc: &after, target: map[string]string{"workspace_id": wsID.String(), "market": market, "provider": prov}}, nil
	})
	if err != nil {
		return err
	}
	if c.preview {
		httpx.Write(w, http.StatusOK, res)
		return nil
	}
	acc, err := h.d.Core.EnableAccount(ctx, wsID, market, prov, &c.actor)
	if errors.Is(err, billing.ErrAccountExists) && replay {
		acc, err = h.d.DB.Q.GetLiveBillingAccountByWorkspace(ctx, &wsID)
	}
	if err != nil {
		return err
	}
	res.Replayed = replay
	res.BalanceAfter = money(acc.BalanceMinor, acc.Currency)
	return h.respond(w, r, res, acc.ID)
}

// providerOf is the provider id serving a market per BILLING_PROVIDERS.
func (h *Handlers) providerOf(market string) string {
	spec, err := provider.ParseSpec(h.d.ProviderSpec)
	if err != nil {
		return ""
	}
	for id, ms := range spec {
		for _, m := range ms {
			if m == market {
				return string(id)
			}
		}
	}
	return ""
}

// manualCredit: POST /api/admin/billing/accounts/{id}/manual-credits — money at the
// service's expense (an admin_credit lot, never refundable as cash; core.AdminCredit).
func (h *Handlers) manualCredit(w http.ResponseWriter, r *http.Request) error {
	return h.creditOrDebit(w, r, actionManualCredit)
}

// adminDebit: POST /api/admin/billing/accounts/{id}/admin-debit — a correction off the free
// advance, never into debt (core.AdminDebit; 409 BILLING_INSUFFICIENT_FUNDS).
func (h *Handlers) adminDebit(w http.ResponseWriter, r *http.Request) error {
	return h.creditOrDebit(w, r, actionAdminDebit)
}

func (h *Handlers) creditOrDebit(w http.ResponseWriter, r *http.Request, action string) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminManualCreditRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, action, &req, accID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	var amount int64
	res, replay, err := h.ahead(ctx, c, &accID, nil, func(q *sqlc.Queries, acc *sqlc.BillingAccount) (*effect, error) {
		if err := notClosed(*acc); err != nil {
			return nil, err
		}
		if err := checkRevision(*acc, req.GetExpectedRevision()); err != nil {
			return nil, err
		}
		var err error
		if amount, err = amountOf(req.GetAmount(), *acc); err != nil {
			return nil, err
		}
		after := *acc
		if action == actionAdminDebit {
			free, err := q.BillingFreeAdvance(ctx, acc.ID)
			if err != nil {
				return nil, err
			}
			if amount > free {
				return nil, billing.ErrInsufficientFunds
			}
			after.BalanceMinor -= amount
		} else {
			after.BalanceMinor += amount
		}
		return &effect{before: acc, acc: &after, target: map[string]string{"account_id": acc.ID.String()},
			res: &v1.AdminBillingMutationResult{Amount: money(amount, acc.Currency)}}, nil
	})
	if err != nil {
		return err
	}
	if c.preview {
		return h.respond(w, r, res, accID)
	}
	if replay {
		acc, err := h.d.DB.Q.GetBillingAccount(ctx, accID)
		if err != nil {
			return err
		}
		amount = req.GetAmount().GetMinor()
		if _, err := amountOf(req.GetAmount(), acc); err != nil {
			return err
		}
	}
	var acc sqlc.BillingAccount
	if action == actionAdminDebit {
		acc, err = h.d.Core.AdminDebit(ctx, accID, amount, c.reason, c.requestID, &c.actor)
	} else {
		var lot uuid.UUID
		if lot, err = h.d.Core.AdminCredit(ctx, accID, amount, c.reason, c.requestID, &c.actor); err == nil {
			res.CreditId = lot.String()
			acc, err = h.d.DB.Q.GetBillingAccount(ctx, accID)
		}
	}
	if err != nil {
		return err
	}
	res.Replayed = replay
	res.BalanceAfter = money(acc.BalanceMinor, acc.Currency)
	return h.respond(w, r, res, accID)
}

// reverseCredit: POST …/accounts/{id}/manual-credits/{creditId}/reverse — takes an unused
// manual credit back (core.ReverseAdminCredit). A credit that already paid for service is
// refused (409): reversing it would turn delivered service into debt.
func (h *Handlers) reverseCredit(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	lotID, err := httpx.PathUUID(r, "creditId", "credit")
	if err != nil {
		return err
	}
	var req v1.AdminReverseCreditRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionReverseCredit, &req, accID.String(), lotID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	res, replay, err := h.ahead(ctx, c, &accID, nil, func(q *sqlc.Queries, acc *sqlc.BillingAccount) (*effect, error) {
		if err := checkRevision(*acc, req.GetExpectedRevision()); err != nil {
			return nil, err
		}
		lot, err := q.LockBillingFundingLot(ctx, lotID)
		if db.IsNotFound(err) || err == nil && lot.AccountID != acc.ID {
			return nil, httpx.NotFound("credit")
		}
		if err != nil {
			return nil, err
		}
		if lot.Source != core.SourceAdminCredit {
			return nil, httpx.Validation("creditId", "only a manual credit can be reversed")
		}
		if _, err := q.GetBillingLedgerEntryByKey(ctx, "admin_reverse:"+lot.ID.String()); err == nil {
			return nil, core.ErrCreditAlreadyReversed
		} else if !db.IsNotFound(err) {
			return nil, err
		}
		if lot.ConsumedMinor > 0 {
			return nil, conflict("the manual credit already paid for service: only an unused credit can be reversed")
		}
		unused := lot.AmountMinor - lot.ConsumedMinor - lot.RefundedMinor
		after := *acc
		after.BalanceMinor -= unused
		return &effect{before: acc, acc: &after, target: map[string]string{"account_id": acc.ID.String(), "credit_id": lot.ID.String()},
			res: &v1.AdminBillingMutationResult{Amount: money(unused, acc.Currency), CreditId: lot.ID.String()}}, nil
	})
	if err != nil {
		return err
	}
	if c.preview {
		return h.respond(w, r, res, accID)
	}
	taken, err := h.d.Core.ReverseUnusedAdminCredit(ctx, accID, lotID, c.reason, &c.actor)
	if errors.Is(err, core.ErrCreditAlreadyReversed) && replay {
		e, gerr := h.d.DB.Q.GetBillingLedgerEntryByKey(ctx, "admin_reverse:"+lotID.String())
		taken, err = -e.AmountMinor, gerr
	}
	if err != nil {
		return err
	}
	acc, err := h.d.DB.Q.GetBillingAccount(ctx, accID)
	if err != nil {
		return err
	}
	res.Replayed = replay
	res.Amount = money(taken, acc.Currency)
	res.BalanceAfter = money(acc.BalanceMinor, acc.Currency)
	return h.respond(w, r, res, accID)
}

// lockAccount locks an account for a command of this package.
func lockAccount(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (sqlc.BillingAccount, error) {
	acc, err := q.LockBillingAccount(ctx, id)
	if db.IsNotFound(err) {
		return acc, billing.ErrAccountNotFound
	}
	return acc, err
}

// hold: POST /api/admin/billing/accounts/{id}/hold — incident hold until hold_until (unset =
// release): no renewals, seat purchases or suspension meanwhile (core).
func (h *Handlers) hold(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminHoldRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionHold, &req, accID.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, accID)
		if err != nil {
			return nil, err
		}
		if err := notClosed(acc); err != nil {
			return nil, err
		}
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		var until *time.Time
		if req.HoldUntil != nil {
			t := req.GetHoldUntil().AsTime().UTC()
			if !t.After(now) || t.After(now.Add(MaxHold)) {
				return nil, httpx.Validation("holdUntil", "hold_until must be in the next 90 days")
			}
			until = &t
		}
		after, err := q.AdminSetBillingAccountHold(ctx, sqlc.AdminSetBillingAccountHoldParams{HoldUntil: until, Now: now, ID: acc.ID})
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after, target: map[string]string{"account_id": acc.ID.String()}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, accID)
}

// discount: PUT /api/admin/billing/accounts/{id}/discount — basis points off future seat
// charges; bought lots keep their price.
func (h *Handlers) discount(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminDiscountRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionDiscount, &req, accID.String())
	if err != nil {
		return err
	}
	if req.GetDiscountBps() > 10000 {
		return httpx.Validation("discountBps", "discount_bps must be 0..10000")
	}
	ctx := r.Context()
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, accID)
		if err != nil {
			return nil, err
		}
		if err := notClosed(acc); err != nil {
			return nil, err
		}
		if err := checkRevision(acc, req.GetExpectedRevision()); err != nil {
			return nil, err
		}
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		after, err := q.AdminSetBillingAccountDiscount(ctx, sqlc.AdminSetBillingAccountDiscountParams{
			DiscountBps: int32(req.GetDiscountBps()), Now: now, ID: acc.ID, //nolint:gosec // <= 10000
		})
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after, target: map[string]string{"account_id": acc.ID.String()}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, accID)
}

// prices: GET /api/admin/billing/prices — every price version, newest first per SKU.
func (h *Handlers) prices(w http.ResponseWriter, r *http.Request) error {
	rows, err := h.d.DB.Q.ListBillingPrices(r.Context())
	if err != nil {
		return err
	}
	out := &v1.AdminPriceVersions{Prices: make([]*v1.AdminPriceVersion, 0, len(rows))}
	for _, p := range rows {
		out.Prices = append(out.Prices, priceProto(p))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// createPrice: POST /api/admin/billing/prices — a new immutable price version starting at
// effective_from >= now + 10 days (422 BILLING_PRICE_EFFECTIVE_TOO_SOON).
func (h *Handlers) createPrice(w http.ResponseWriter, r *http.Request) error {
	var req v1.AdminCreatePriceRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionPrice, &req)
	if err != nil {
		return err
	}
	market := req.GetMarket()
	if market == "" {
		market = "global"
	}
	currency, ok := markets[market]
	if !ok {
		return httpx.Validation("market", "market must be global or ru")
	}
	plan := planName(req.GetPlan())
	if plan == "" {
		return httpx.Validation("plan", "plan must be team or enterprise")
	}
	if req.GetUnit().GetMinor() <= 0 {
		return httpx.Validation("unit", "unit price must be positive")
	}
	if req.GetUnit().GetCurrency() != currency {
		return billing.ErrCurrencyMismatch
	}
	if req.EffectiveFrom == nil {
		return httpx.Validation("effectiveFrom", "effective_from required")
	}
	from := req.GetEffectiveFrom().AsTime().UTC()
	ctx := r.Context()
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		if from.Before(now.Add(PriceNotice)) {
			return nil, billing.ErrPriceEffectiveTooSoon
		}
		p, err := q.InsertBillingPrice(ctx, sqlc.InsertBillingPriceParams{
			Market: market, Currency: currency, Sku: core.SKU(plan), Plan: &plan, UnitMinor: req.GetUnit().GetMinor(),
			EffectiveFrom: from, CreatedBy: &c.actor,
		})
		if db.UniqueViolation(err) != "" {
			return nil, conflict("a price version of this SKU starts at that time already")
		}
		if err != nil {
			return nil, err
		}
		return &effect{target: map[string]string{"market": market, "sku": p.Sku},
			res: &v1.AdminBillingMutationResult{Price: priceProto(p)}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, uuid.Nil)
}

// reconcile: POST /api/admin/billing/accounts/{id}/reconcile — re-read the account's provider
// objects now (T5 Reconciler).
func (h *Handlers) reconcile(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminReconcileRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionReconcile, &req, accID.String())
	if err != nil {
		return err
	}
	if h.d.Reconciler == nil {
		return billing.ErrNotImplemented
	}
	ctx := r.Context()
	res, replay, err := h.ahead(ctx, c, &accID, nil, func(_ *sqlc.Queries, acc *sqlc.BillingAccount) (*effect, error) {
		return &effect{before: acc, acc: acc, target: map[string]string{"account_id": acc.ID.String()}}, nil
	})
	if err != nil {
		return err
	}
	if !c.preview {
		if err := h.d.Reconciler.ReconcileAccount(ctx, accID); err != nil {
			return err
		}
		acc, err := h.d.DB.Q.GetBillingAccount(ctx, accID)
		if err != nil {
			return err
		}
		res.Replayed = replay
		res.BalanceAfter = money(acc.BalanceMinor, acc.Currency)
	}
	return h.respond(w, r, res, accID)
}

// testClock: POST /api/admin/billing/test-clock — moves the billing clock (E2E only:
// BILLING_TEST_CLOCK=1 and no live Stripe keys, else 404). Not audited: no money moves by it,
// the scheduler applies what became due.
func (h *Handlers) testClock(w http.ResponseWriter, r *http.Request) error {
	if h.d.TestClock == nil {
		return billing.ErrTestClockOff
	}
	var req v1.AdminBillingTestClockRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	var t *time.Time
	if req.Now != nil {
		v := req.GetNow().AsTime().UTC()
		t = &v
	}
	if adv := req.GetAdvanceSeconds(); adv > 0 {
		if adv > uint64(365*24*3600) {
			return httpx.Validation("advanceSeconds", "advance at most a year")
		}
		if t == nil {
			cur, err := h.d.TestClock.Now(ctx, h.d.DB.Q)
			if err != nil {
				return err
			}
			t = &cur
		}
		v := t.Add(time.Duration(adv) * time.Second) //nolint:gosec // bounded above
		t = &v
	}
	h.d.TestClock.Set(t)
	now, err := h.d.TestClock.Now(ctx, h.d.DB.Q)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminBillingTestClockResponse{Now: timestamppb.New(now), Fixed: t != nil})
	return nil
}
