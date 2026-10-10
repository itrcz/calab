//go:build integration

package billinghttp_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// Refunds of Tochka subscription payments (prod 2026-10-10: a refund of a one-click charge stayed
// plain «pending», the bank has no such refund; Tochka: «Платежи, поступившие через подписки,
// можно вернуть только в интернет-банке»).

// adminAPI is the superadmin billing API over this env (local superadmin session).
type adminAPI struct {
	t   *testing.T
	mux *http.ServeMux
}

func (e *env) admin() *adminAPI {
	e.t.Helper()
	h := admin.New(admin.Deps{DB: e.d, Core: e.core, Clock: billing.DBClock{}, Providers: e.reg, ProviderSpec: "stripe:global,tochka:ru", Reconciler: e.in, RefundDone: e.in.NotifyRefundDone})
	id := e.user()
	ident := auth.Identity{UserID: id, Principal: identitypolicy.Principal{UserID: id, Authority: identitypolicy.LocalAccount}}
	mux := http.NewServeMux()
	h.Register(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), ident)))
		})
	})
	return &adminAPI{t: e.t, mux: mux}
}

func (a *adminAPI) call(method, path string, in, out proto.Message) (int, *v1.ApiError) {
	a.t.Helper()
	var body []byte
	if in != nil {
		var err error
		if body, err = protojson.Marshal(in); err != nil {
			a.t.Fatal(err)
		}
	}
	rec := httptest.NewRecorder()
	a.mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), method, path, bytes.NewReader(body)))
	if rec.Code >= 300 {
		var ae v1.ApiError
		_ = protojson.Unmarshal(rec.Body.Bytes(), &ae)
		return rec.Code, &ae
	}
	if out != nil {
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(rec.Body.Bytes(), out); err != nil {
			a.t.Fatalf("%s %s: %v", method, path, err)
		}
	}
	return rec.Code, nil
}

func (a *adminAPI) must(method, path string, in, out proto.Message) {
	a.t.Helper()
	if st, ae := a.call(method, path, in, out); st != 200 {
		a.t.Fatalf("%s %s: %d %v", method, path, st, ae)
	}
}

// savedCardEnv: a card top-up of 200 ₽ with «save» (the subscription's binding payment) and a
// one-click top-up of 150 ₽ (a charge of the subscription), like the prod account.
func savedCardEnv(t *testing.T) (e *env, sub string, binding, charge sqlc.BillingPayment) {
	t.Helper()
	e = newEnv(t, envOpt{bank: tochkatest.New(t), market: "ru", recurring: true, charger: true})
	var out v1.CreateTopupResponse
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "tochka:card", Amount: rub(20000),
		RequestId: uuid.NewString(), SaveMethod: true}, &out); st != 200 {
		t.Fatalf("topup: %d %s", st, reason)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	sub = *co.ProviderSessionID
	e.bank.Pay(sub, "card")
	e.tochkaWebhook(e.bank.Webhook(sub))
	e.process()
	pm := e.summary().GetSavedMethods()[0].GetId()
	var r v1.SavedMethodTopup
	if st, reason := e.do(e.owner, "POST", e.base()+"/saved-method-topups", &v1.CreateSavedMethodTopupRequest{
		PaymentMethodId: pm, Amount: rub(15000), RequestId: uuid.NewString()}, &r); st != 200 || !r.GetCredited() {
		t.Fatalf("one-click: %d %s %v", st, reason, &r)
	}
	var err error
	if binding, err = e.d.Q.GetBillingPaymentByCheckout(ctx, &co.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.d.Pool.QueryRow(ctx, `SELECT id FROM billing_payments WHERE account_id = $1 AND origin = 'saved_method'`, e.acc).Scan(&charge.ID); err != nil {
		t.Fatal(err)
	}
	if charge, err = e.d.Q.GetBillingPayment(ctx, charge.ID); err != nil {
		t.Fatal(err)
	}
	return e, sub, binding, charge
}

// refund posts a synchronous admin refund and returns the answer.
func (a *adminAPI) refund(pay sqlc.BillingPayment, minor int64) *v1.AdminBillingMutationResult {
	a.t.Helper()
	var res v1.AdminBillingMutationResult
	a.must("POST", "/api/admin/billing/payments/"+pay.ID.String()+"/refunds",
		&v1.AdminRefundRequest{Amount: rub(minor), Reason: "customer asked", RequestId: uuid.NewString()}, &res)
	return &res
}

func (a *adminAPI) reconcile(acc uuid.UUID) (int, *v1.ApiError) {
	a.t.Helper()
	return a.call("POST", "/api/admin/billing/accounts/"+acc.String()+"/reconcile",
		&v1.AdminReconcileRequest{Reason: "checked in the bank", RequestId: uuid.NewString()}, nil)
}

func (a *adminAPI) issues(acc uuid.UUID) []*v1.AdminBillingIssue {
	a.t.Helper()
	var out v1.AdminBillingIssues
	a.must("GET", "/api/admin/billing/issues?account_id="+acc.String(), nil, &out)
	return out.GetIssues()
}

// The synchronous model: a refund of a payment link is sent at once; the bank executed it — the
// ledger entry now, «Возвращено», the owner's mail; the polling later finds the bank's line and
// books nothing twice. Each attempt is audited with its outcome.
func TestTochkaAdminRefundExecuted(t *testing.T) {
	e := ruEnv(t)
	pay := e.payRU(15000)
	a := e.admin()
	res := a.refund(pay, 5000)
	if len(res.GetRefunds()) != 1 || res.GetRefunds()[0].GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_SUCCEEDED ||
		res.GetBalanceAfter().GetMinor() != 10000 || e.account().BalanceMinor != 10000 || e.bank.RefundPosts != 1 {
		t.Fatalf("refund %v balance %d posts %d", res, e.account().BalanceMinor, e.bank.RefundPosts)
	}
	if n := e.count(`SELECT count(*) FROM billing_audit WHERE account_id = $1 AND action = 'refund.outcome' AND details->'target'->>'outcome' = 'executed'`, e.acc); n != 1 {
		t.Fatalf("outcome audit %d", n)
	}
	if n := e.count(`SELECT count(*) FROM billing_notifications WHERE account_id = $1 AND key LIKE 'refund:%'`, e.acc); n != 1 {
		t.Fatalf("refund mails %d", n)
	}
	for range 2 {
		if st, ae := a.reconcile(e.acc); st != 200 {
			t.Fatalf("reconcile %d %v", st, ae)
		}
	}
	if e.account().BalanceMinor != 10000 || e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1`, e.acc) != 1 {
		t.Fatalf("after polling: balance %d", e.account().BalanceMinor)
	}
}

// A Tochka subscription payment (one-click charge, first payment) cannot be refunded through the
// API: nothing is sent, reserved or booked; the answer says what to refund in the bank (the
// full operation id: the superadmin finds the operation by it). The prod case of 2026-10-10.
func TestTochkaAdminRefundManual(t *testing.T) {
	e, sub, binding, charge := savedCardEnv(t)
	a := e.admin()
	bal := e.account().BalanceMinor
	res := a.refund(charge, 15000)
	m := res.GetManualRefund()
	order := strings.TrimPrefix(charge.ProviderPaymentID, sub+":charge:")
	if m == nil || m.GetCharge() != order || m.GetAmount().GetMinor() != 15000 || m.GetOperation() != sub {
		t.Fatalf("manual %v", m)
	}
	if len(res.GetRefunds()) != 0 || e.account().BalanceMinor != bal || e.bank.RefundPosts != 0 ||
		e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1`, e.acc) != 0 {
		t.Fatalf("something moved: %v balance %d posts %d", res, e.account().BalanceMinor, e.bank.RefundPosts)
	}
	if m := a.refund(binding, 10000).GetManualRefund(); m == nil || m.GetCharge() != "" || m.GetOperation() != sub {
		t.Fatalf("first payment %v", m)
	}
	if n := e.count(`SELECT count(*) FROM billing_audit WHERE account_id = $1 AND action = 'refund' AND details->'target'->>'outcome' = 'manual'`, e.acc); n != 2 {
		t.Fatalf("audit %d", n)
	}
	var pays v1.AdminBillingPayments
	a.must("GET", "/api/admin/billing/payments?account_id="+e.acc.String(), nil, &pays)
	for _, p := range pays.GetPayments() {
		if !p.GetRefundByHand() {
			t.Fatalf("payment %v not marked refund_by_hand", p)
		}
	}
}

// The prod sequel: the operator refunds 100 ₽ in the bank's interface on the subscription; no
// Calab refund exists. The polling («Сверить») books it at once on the subscription's payments,
// lists it in «Требует внимания» as information, never twice.
func TestTochkaBankRefundOfSubscriptionBooked(t *testing.T) {
	e, sub, _, _ := savedCardEnv(t)
	a := e.admin()
	bal := e.account().BalanceMinor
	e.bank.RefundByHand(sub, "100.00")
	for range 2 {
		if st, ae := a.reconcile(e.acc); st != 200 {
			t.Fatalf("reconcile %d %v", st, ae)
		}
	}
	if e.account().BalanceMinor != bal-10000 {
		t.Fatalf("balance %d, want %d", e.account().BalanceMinor, bal-10000)
	}
	if n := e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1 AND origin = 'dashboard' AND status = 'succeeded'`, e.acc); n != 1 {
		t.Fatalf("dashboard refunds %d", n)
	}
	is := a.issues(e.acc)
	if len(is) != 1 || is[0].GetReason() != "bank_refund" || is[0].GetStatus() != "imported" || strings.Contains(is[0].GetProviderRef(), sub) {
		t.Fatalf("issues %v", is)
	}
}

// A refund made in the bank's interface on a payment link with no Calab refund: deducted at once
// even when the money paid for service already — the balance goes negative, the debt starts.
func TestTochkaBankRefundIntoDebt(t *testing.T) {
	e := ruEnv(t)
	pay := e.payRU(15000)
	if _, err := e.core.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	spent := 15000 - e.account().BalanceMinor
	if spent <= 0 {
		t.Fatal("activation took nothing")
	}
	e.bank.RefundByHand(pay.ProviderPaymentID, "150.00")
	if st, ae := e.admin().reconcile(e.acc); st != 200 {
		t.Fatalf("reconcile %d %v", st, ae)
	}
	acc := e.account()
	if acc.BalanceMinor != -spent || acc.NegativeSince == nil {
		t.Fatalf("balance %d negative since %v (spent %d)", acc.BalanceMinor, acc.NegativeSince, spent)
	}
}

// Unknown outcome (the answer is lost, Tochka has no idempotency): one pending row, nothing
// deducted, never sent again; the polling books it when the bank lists it (once). A pending row
// the bank never lists is closed after a day, nothing deducted.
func TestTochkaAdminRefundUnknownOutcome(t *testing.T) {
	e := ruEnv(t)
	pay := e.payRU(15000)
	a := e.admin()
	e.bank.LoseNextRefund = true
	res := a.refund(pay, 5000)
	ref := res.GetRefunds()[0]
	if ref.GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_PENDING || e.account().BalanceMinor != 15000 {
		t.Fatalf("unknown %v balance %d", ref, e.account().BalanceMinor)
	}
	for range 2 {
		if st, ae := a.reconcile(e.acc); st != 200 {
			t.Fatalf("reconcile %d %v", st, ae)
		}
	}
	if r := e.refundRow(uuid.MustParse(ref.GetRefund().GetId())); r.Status != core.RefundSucceeded || r.ProviderRefundID == nil ||
		e.account().BalanceMinor != 10000 || e.bank.RefundPosts != 1 {
		t.Fatalf("resolved %+v balance %d posts %d", r, e.account().BalanceMinor, e.bank.RefundPosts)
	}
	// Never reached the bank: closed after a day, nothing deducted.
	var ghost sqlc.BillingRefund
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		ghost, _, err = e.core.StartRefund(ctx, q, core.RefundReq{PaymentID: pay.ID, Amount: 2000, IdemKey: "refund:" + uuid.NewString(), Reason: "test"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	e.ageRefund(ghost.ID, 25*time.Hour)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_refunds SET dispatched_at = now() - interval '25 hours' WHERE id = $1`, ghost.ID); err != nil {
		t.Fatal(err)
	}
	if st, ae := a.reconcile(e.acc); st != 200 {
		t.Fatalf("reconcile %d %v", st, ae)
	}
	if r := e.refundRow(ghost.ID); r.Status != core.RefundFailed || e.account().BalanceMinor != 10000 {
		t.Fatalf("ghost %+v balance %d", r, e.account().BalanceMinor)
	}
}

// Refund requests are gone (owner 2026-10-10): the owner's routes answer 404.
func TestRefundRequestsRemoved(t *testing.T) {
	e := ruEnv(t)
	if st, _ := e.do(e.owner, "POST", e.base()+"/refund-requests", &v1.CreateRefundRequest{Amount: rub(100), Reason: "please", RequestId: uuid.NewString()}, nil); st != 404 && st != 405 {
		t.Fatalf("owner refund request: %d", st)
	}
}

// A «save the card» checkout (a subscription link: no bank TTL) left unpaid is closed once past
// its expiry and the grace, not polled forever (audit M1).
func TestTochkaSaveCardCheckoutExpires(t *testing.T) {
	e := newEnv(t, envOpt{bank: tochkatest.New(t), market: "ru", recurring: true})
	var out v1.CreateTopupResponse
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "tochka:card", Amount: rub(20000),
		RequestId: uuid.NewString(), SaveMethod: true}, &out); st != 200 {
		t.Fatalf("topup: %d %s", st, reason)
	}
	id := uuid.MustParse(out.GetCheckoutId())
	co, _ := e.d.Q.GetBillingCheckout(ctx, id)
	if res, err := e.in.SyncCheckout(ctx, co, "poll"); err != nil || res.Checkout.Status != "open" {
		t.Fatalf("fresh: %+v %v", res.Checkout, err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_checkouts SET expires_at = now() - interval '2 hours' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	co, _ = e.d.Q.GetBillingCheckout(ctx, id)
	if res, err := e.in.SyncCheckout(ctx, co, "poll"); err != nil || res.Checkout.Status != "expired" {
		t.Fatalf("past expiry: %+v %v", res.Checkout, err)
	}
}
