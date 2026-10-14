//go:build integration

package core_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// The custom plan (ADR-0086 «Индивидуальный тариф»): seats are bought and renewed at the account's
// own price versions, without the discount; a new price applies from its effective_from only.

func (e *env) assign(a core.AssignPlan) (core.AssignResult, error) {
	e.t.Helper()
	if a.RequestID == uuid.Nil {
		a.RequestID = uuid.New()
	}
	var res core.AssignResult
	err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, e.acc)
		if err != nil {
			return err
		}
		_, res, err = e.c.AssignPlanIn(ctx, q, acc, a, &e.owner)
		return err
	})
	return res, err
}

func (e *env) mustAssign(a core.AssignPlan) core.AssignResult {
	e.t.Helper()
	res, err := e.assign(a)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

func custom(name string) *core.CustomPlan {
	return &core.CustomPlan{Limits: []byte(`{"members":20,"room_members":12}`), Name: name, Description: "Contract 7"}
}

func validation(t *testing.T, what string, err error) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 422 {
		t.Fatalf("%s: %v, want 422", what, err)
	}
}

func TestCustomPlanDebitsAndPriceVersions(t *testing.T) {
	e := newEnv(t, 3)
	e.at(t0)
	e.pay(10000)
	e.activate(core.PlanTeam) // 3 × 10 = 30
	// A discount never applies to the custom price.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 5000 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}

	// Two hours in: the rest of the Team day back (22/24 of 30 = 27.5 → 28), a full custom day bought.
	e.at(t0.Add(2 * time.Hour))
	res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme Pro"), Unit: 25, Note: "admin: contract"})
	if !res.Switched || res.Price == nil || res.Price.UnitMinor != 25 || res.Charged != 75 || res.Compensated != 28 {
		t.Fatalf("switch to custom: %+v", res)
	}
	ch := e.lastCharge()
	if ch.Plan != core.PlanCustom || ch.Sku != "seat.custom.day" || ch.UnitMinor != 25 || ch.DiscountBps != 0 || ch.Qty != 3 || ch.PriceID != res.Price.ID {
		t.Fatalf("custom lot %+v", ch)
	}
	acc := e.account()
	if acc.Plan != core.PlanCustom || acc.Status != core.StatusActive {
		t.Fatalf("account %s/%s", acc.Plan, acc.Status)
	}
	e.wantBalance(10000 - 30 + 28 - 75)
	row := e.workspacePlan()
	if row.Source != "billing" || row.Plan != "custom" || row.DisplayName != "Acme Pro" || row.Description != "Contract 7" ||
		string(row.Limits) == "" || row.Note != "admin: contract" {
		t.Fatalf("plan row %+v", row)
	}

	// Renewal: the custom price.
	e.tick(t0.Add(26 * time.Hour))
	if ch := e.lastCharge(); ch.UnitMinor != 25 || ch.AmountMinor != 75 || ch.Reason != core.ReasonRenew {
		t.Fatalf("renewal %+v", ch)
	}

	// A new price from day 2 + 14 h: not for the lot running now, nor a seat bought before then.
	from := t0.Add(2*billing.Day + 14*time.Hour)
	if res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme Pro"), Unit: 40, From: from}); res.Switched || res.Price == nil || res.Charged != 0 {
		t.Fatalf("price version: %+v", res)
	}
	q, err := e.c.Quote(ctx, e.acc, "")
	if err != nil || q.UnitMinor != 25 || q.DailyMinor != 75 {
		t.Fatalf("quote before the new price: %+v %v", q, err)
	}
	e.at(t0.Add(2*billing.Day + 13*time.Hour))
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	if ch := e.lastCharge(); ch.UnitMinor != 25 || ch.Reason != core.ReasonAdmit {
		t.Fatalf("admission before effective_from %+v", ch)
	}
	e.at(from.Add(time.Hour))
	if _, err := e.join(); err != nil {
		t.Fatal(err)
	}
	if ch := e.lastCharge(); ch.UnitMinor != 40 || ch.AmountMinor != 40 {
		t.Fatalf("admission after effective_from %+v", ch)
	}
	q, err = e.c.Quote(ctx, e.acc, "")
	if err != nil || q.UnitMinor != 40 || q.DailyMinor != 5*40 || q.Plan != core.PlanCustom {
		t.Fatalf("quote after the new price: %+v %v", q, err)
	}
	// The day-2 renewal (boundary 2 d + 2 h, before from) kept 25; the next one is at 40.
	e.tick(t0.Add(3*billing.Day + 3*time.Hour))
	var at25, at40 int
	for _, c := range e.charges() {
		if c.Reason != core.ReasonRenew {
			continue
		}
		switch {
		case c.StartsAt.Before(from) && c.UnitMinor == 25:
			at25++
		case !c.StartsAt.Before(from) && c.UnitMinor == 40:
			at40++
		default:
			t.Fatalf("renewal %s at %d", c.StartsAt, c.UnitMinor)
		}
	}
	if at25 != 2 || at40 == 0 {
		t.Fatalf("renewals at 25: %d, at 40: %d", at25, at40)
	}
	e.check()

	// Back to Team: the custom lots' rest is compensated at their own price.
	e.at(t0.Add(3*billing.Day + 9*time.Hour))
	var want int64
	for _, c := range e.charges() {
		if c.Plan == core.PlanCustom && c.EndsAt.After(e.clk.Time()) && c.StartsAt.Before(e.clk.Time()) {
			got, err := core.CompensationTarget(c.AmountMinor, c.Qty, c.EndsAt.Sub(c.StartsAt), int64(c.Qty-c.CanceledQty)*c.EndsAt.Sub(e.clk.Time()).Microseconds()+c.CanceledSeatUs)
			if err != nil {
				t.Fatal(err)
			}
			want += got - c.CompensatedMinor
		}
	}
	res = e.mustAssign(core.AssignPlan{Plan: core.PlanTeam, Note: "admin: back"})
	if !res.Switched || res.Compensated != want || want == 0 {
		t.Fatalf("back to Team: %+v, want compensation %d", res, want)
	}
	if ch := e.lastCharge(); ch.Plan != core.PlanTeam || ch.DiscountBps != 5000 || ch.UnitMinor != 5 {
		t.Fatalf("Team lot after custom %+v", ch)
	}
	if row := e.workspacePlan(); row.Plan != "team" || row.Limits != nil || row.DisplayName != "" || row.Description != "" {
		t.Fatalf("plan row after custom %+v", row)
	}
	e.check()
}

func TestCustomPlanAssignRules(t *testing.T) {
	e := newEnv(t, 2)
	e.at(t0)
	validation(t, "no price", func() error {
		_, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("")})
		return err
	}())
	validation(t, "over the cap", func() error {
		_, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: core.CustomUnitCap("USD") + 1})
		return err
	}())
	validation(t, "first price later", func() error {
		_, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: 20, From: t0.Add(time.Hour)})
		return err
	}())
	// Inactive without money: started from the free advance only.
	if _, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: 20}); !errors.Is(err, billing.ErrInsufficientFunds) {
		t.Fatalf("no money: %v", err)
	}
	e.pay(40)
	res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: 20})
	if !res.Switched || res.Charged != 40 {
		t.Fatalf("start on custom: %+v", res)
	}
	if acc := e.account(); acc.Status != core.StatusActive || acc.Plan != core.PlanCustom || acc.NextDueAt == nil {
		t.Fatalf("account %+v", acc)
	}
	validation(t, "price in the past", func() error {
		_, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: 30, From: t0.Add(-time.Hour)})
		return err
	}())
	validation(t, "price too far ahead", func() error {
		_, err := e.assign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom(""), Unit: 30, From: t0.Add(core.MaxCustomAhead + time.Hour)})
		return err
	}())
	// The same price again writes no version; a definition-only edit keeps the price.
	if res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Renamed"), Unit: 20}); res.Price != nil || res.Switched {
		t.Fatalf("same price: %+v", res)
	}
	if row := e.workspacePlan(); row.DisplayName != "Renamed" {
		t.Fatalf("plan row %+v", row)
	}
	// A dearer price later replaces nothing bought; owner commands cannot pick custom.
	if _, err := e.c.Activate(ctx, e.acc, core.PlanCustom, uuid.New(), &e.owner); err == nil {
		t.Fatal("the owner activated custom")
	}
	if _, err := e.c.ChangePlan(ctx, e.acc, core.PlanCustom, uuid.New(), &e.owner); err == nil {
		t.Fatal("the owner changed to custom")
	}
	e.check()
}

// Second review of the custom plan: an edit that resends the current price keeps a scheduled
// change, a paid resume after debt returns to the same custom plan at the price in force, and a
// switch custom → Team → custom compensates each side once at its own price.
func TestCustomPlanScheduledPriceAndResume(t *testing.T) {
	e := newEnv(t, 2)
	e.at(t0)
	e.pay(100)
	if res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme"), Unit: 20}); res.Charged != 40 {
		t.Fatalf("start: %+v", res)
	}
	from := day(3)
	e.at(t0.Add(time.Hour))
	if res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme"), Unit: 30, From: from}); res.Price == nil {
		t.Fatalf("scheduled version: %+v", res)
	}
	// The editor resends the price in force (20, from now) with a new name: no version, the
	// scheduled 30 stays.
	if res := e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme Pro"), Unit: 20}); res.Price != nil {
		t.Fatalf("a name edit wrote a price version: %+v", res.Price)
	}
	if unit, at, ok, err := e.c.NextPriceIn(ctx, e.d.Q, e.account(), e.clk.Time()); err != nil || !ok || unit != 30 || !at.Equal(from) {
		t.Fatalf("next price %d at %s (%v, %v)", unit, at, ok, err)
	}

	// Renewals run the balance into debt until the suspension (from day 3 at 30).
	for d := 1; d <= 10; d++ {
		e.tick(day(d))
	}
	acc := e.account()
	if acc.Status != core.StatusSuspended || acc.Plan != core.PlanCustom {
		t.Fatalf("not suspended on custom: %s/%s", acc.Status, acc.Plan)
	}
	for _, c := range e.charges() {
		want := int64(30)
		if c.StartsAt.Before(from) {
			want = 20
		}
		if c.UnitMinor != want {
			t.Fatalf("lot at %s: unit %d, want %d", c.StartsAt, c.UnitMinor, want)
		}
	}
	if row := e.workspacePlan(); row.Plan != "custom" || row.DisplayName != "Acme Pro" {
		t.Fatalf("suspended plan row %+v", row)
	}
	// Paying the debt and a first day resumes the same custom plan at the price in force (30).
	e.at(day(10).Add(time.Hour))
	e.pay(-acc.BalanceMinor + 2*30)
	if _, err := e.c.Resume(ctx, e.acc, core.ResumePaid, core.PlanCustom, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(0)
	if c := e.lastCharge(); c.Plan != core.PlanCustom || c.UnitMinor != 30 || c.Qty != 2 || c.Reason != core.ReasonResume || c.DiscountBps != 0 {
		t.Fatalf("resume lot %+v", c)
	}
	if row := e.workspacePlan(); row.Plan != "custom" || row.Source != "billing" || row.DisplayName != "Acme Pro" || string(row.Limits) == "" {
		t.Fatalf("resumed plan row %+v", row)
	}
	e.check()

	// custom → Team → custom: each switch returns the rest of the running lots at their own price.
	e.pay(1000)
	e.at(day(10).Add(7 * time.Hour)) // 18 h of the 24 h lot (60) left: 45 back, Team 2 × 10
	res := e.mustAssign(core.AssignPlan{Plan: core.PlanTeam})
	if !res.Switched || res.Compensated != 45 || res.Charged != 20 {
		t.Fatalf("custom → Team: %+v", res)
	}
	e.at(day(10).Add(13 * time.Hour)) // 18 h of the Team lot (20) left: 15 back, custom 2 × 30 again
	res = e.mustAssign(core.AssignPlan{Plan: core.PlanCustom, Custom: custom("Acme Pro"), Unit: 30})
	if !res.Switched || res.Price != nil || res.Compensated != 15 || res.Charged != 60 {
		t.Fatalf("Team → custom: %+v", res)
	}
	e.wantBalance(1000 + 45 - 20 + 15 - 60)
	e.check()
}

// A custom price is always in the account's currency (00080: (account_id, currency) references
// the account), and an account with custom prices cannot switch its market.
func TestCustomPriceCurrencyFixed(t *testing.T) {
	e := newEnv(t, 1)
	e.at(t0)
	acc := e.account()
	if _, err := e.d.Q.InsertBillingCustomPrice(ctx, sqlc.InsertBillingCustomPriceParams{Market: "ru", Currency: "RUB", UnitMinor: 500,
		EffectiveFrom: t0, AccountID: &acc.ID}); err == nil {
		t.Fatal("a RUB custom price for a USD account")
	}
	if _, err := e.d.Q.InsertBillingCustomPrice(ctx, sqlc.InsertBillingCustomPriceParams{Market: acc.Market, Currency: acc.Currency, UnitMinor: 5,
		EffectiveFrom: t0, AccountID: &acc.ID}); err != nil {
		t.Fatal(err)
	}
	_, err := e.c.SwitchMarket(ctx, e.acc, "ru", "tochka", 0, &e.owner)
	wantErr(t, err, billing.ErrMarketFixed)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET market = 'ru', currency = 'RUB' WHERE id = $1`, e.acc); err == nil {
		t.Fatal("the account's currency moved away from its custom price")
	}
}
