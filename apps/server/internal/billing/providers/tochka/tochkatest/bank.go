// Package tochkatest is an in-memory Tochka Bank for integration tests of the billing core
// with the real adapter (ADR-0083): payment links with receipts, subscriptions without a
// schedule and their charges (phase 2), operation reads and lists, refunds with Order[], and
// webhooks signed by a test RSA key. Shapes follow the recorded
// fixtures of providers/tochka/testdata.
package tochkatest

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
)

// Customer and merchant of the test bank (the values of the bank's documentation examples).
const (
	Customer = "300123123"
	Merchant = "200000000001234"
)

// Op is one payment operation of the bank.
type Op struct {
	ID, LinkID, ConsumerID, Status, PaymentType, Mode, Email string
	Amount                                                   string // rubles, "150.00"
	Orders                                                   []Order
	CreatedAt, PaidAt                                        time.Time
	Recurring                                                bool // a subscription without a schedule
}

// Order is one entry of Order[].
type Order struct {
	ID, Type, Amount string
	Time             time.Time
}

// Bank is the fake. Safe for concurrent use.
type Bank struct {
	mu      sync.Mutex
	ops     map[string]*Op
	order   []string
	key     *rsa.PrivateKey
	srv     *httptest.Server
	nextOrd int

	Creates, RefundPosts, Charges int
	// DeclineNextCharge: the next Charge Subscription answers result=false (nothing charged).
	// LoseNextCharge: the next charge is applied but its answer is lost (502).
	DeclineNextCharge, LoseNextCharge bool
	// LoseNextCreate / LoseNextRefund: the bank applies the request but the answer is lost (502).
	LoseNextCreate, LoseNextRefund bool
	// RefundsSettle: a refund turns the payment REFUNDED / REFUNDED_PARTIALLY at once (else ON-REFUND).
	RefundsSettle bool
	// HideOrders: Order[] stays empty (the sandbox shows refunded payments so).
	HideOrders bool
	// RefundAnswerOtherOrder: the refund answer carries another orderId than the refund's entry
	// in Order[] (the bank does not document that they agree).
	RefundAnswerOtherOrder bool
}

// New starts the bank; closed by t.Cleanup.
func New(t testing.TB) *Bank {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	b := &Bank{ops: map[string]*Op{}, key: k, RefundsSettle: true}
	b.srv = httptest.NewServer(http.HandlerFunc(b.serve))
	t.Cleanup(b.srv.Close)
	return b
}

// Config of an adapter talking to this bank.
func (b *Bank) Config() tochka.Config {
	return tochka.Config{BaseURL: b.srv.URL, Token: "test.token.value", CustomerCode: Customer, MerchantID: Merchant,
		WebhookKey: b.JWK(), ClientID: "test-client", HTTPClient: b.srv.Client()}
}

// JWK is the public webhook key.
func (b *Bank) JWK() string {
	raw, _ := jose.JSONWebKey{Key: &b.key.PublicKey, Algorithm: "RS256"}.MarshalJSON()
	return string(raw)
}

// Op returns a copy of an operation.
func (b *Bank) Op(id string) Op {
	b.mu.Lock()
	defer b.mu.Unlock()
	if o := b.ops[id]; o != nil {
		return *o
	}
	return Op{}
}

// ByLink finds the operation of a paymentLinkId ("" if none).
func (b *Bank) ByLink(linkID string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, id := range b.order {
		if b.ops[id].LinkID == linkID {
			return id
		}
	}
	return ""
}

// Pay marks the operation paid (APPROVED) by paymentType ("card", "sbp", "digitalRuble").
func (b *Bank) Pay(id, paymentType string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.ops[id]
	o.Status, o.PaymentType, o.PaidAt = "APPROVED", paymentType, time.Now().UTC()
	o.Orders = append(o.Orders, Order{ID: b.ord(), Type: "approval", Amount: o.Amount, Time: o.PaidAt})
}

// ApprovalCount is the number of approvals (binding payment + charges) of an operation.
func (b *Bank) ApprovalCount(id string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, r := range b.ops[id].Orders {
		if r.Type == "approval" {
			n++
		}
	}
	return n
}

// Expire marks the operation EXPIRED.
func (b *Bank) Expire(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ops[id].Status = "EXPIRED"
}

// RefundByHand records a refund an operator made in the bank's interface.
func (b *Bank) RefundByHand(id, amount string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refund(b.ops[id], amount)
}

// Settle turns ON-REFUND payments into their refunded status.
func (b *Bank) Settle(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.ops[id]
	if o.Status == "ON-REFUND" {
		o.Status = b.refundedStatus(o)
	}
}

func (b *Bank) ord() string {
	b.nextOrd++
	return strconv.Itoa(100 + b.nextOrd)
}

func (b *Bank) refund(o *Op, amount string) string {
	id := b.ord()
	o.Orders = append(o.Orders, Order{ID: id, Type: "refund", Amount: amount, Time: time.Now().UTC()})
	if b.RefundsSettle {
		o.Status = b.refundedStatus(o)
	} else {
		o.Status = "ON-REFUND"
	}
	return id
}

func (b *Bank) refundedStatus(o *Op) string {
	var refunded, total float64
	_, _ = fmt.Sscan(o.Amount, &total)
	for _, r := range o.Orders {
		if r.Type == "refund" {
			var v float64
			_, _ = fmt.Sscan(r.Amount, &v)
			refunded += v
		}
	}
	if refunded+0.001 >= total {
		return "REFUNDED"
	}
	return "REFUNDED_PARTIALLY"
}

// Webhook is the signed acquiringInternetPayment body of a paid operation.
func (b *Bank) Webhook(id string) []byte {
	return b.WebhookFor(id, Customer)
}

// WebhookFor signs a webhook of the operation as if for another customer code.
func (b *Bank) WebhookFor(id, customer string) []byte {
	o := b.Op(id)
	claims := jwt.MapClaims{
		"webhookType": "acquiringInternetPayment", "customerCode": customer, "merchantId": Merchant, "operationId": o.ID,
		"paymentLinkId": o.LinkID, "consumerId": o.ConsumerID, "status": o.Status, "paymentType": o.PaymentType,
		"amount": o.Amount, "purpose": "Пополнение баланса Calab",
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(b.key)
	if err != nil {
		panic(err)
	}
	return []byte(tok)
}

func (b *Bank) opJSON(o *Op) map[string]any {
	orders := []any{}
	if !b.HideOrders {
		for _, r := range o.Orders {
			orders = append(orders, map[string]any{"orderId": r.ID, "type": r.Type, "amount": json.Number(r.Amount), "time": r.Time.Format(time.RFC3339)})
		}
	}
	m := map[string]any{
		"customerCode": Customer, "merchantId": Merchant, "operationId": o.ID, "paymentLink": "https://merch.example.test/order/?uuid=" + o.ID,
		"paymentLinkId": o.LinkID, "consumerId": o.ConsumerID, "status": o.Status, "amount": json.Number(o.Amount),
		"createdAt": o.CreatedAt.In(time.FixedZone("+05", 5*3600)).Format(time.RFC3339), "paymentMode": []string{o.Mode}, "Order": orders,
		"Client": map[string]any{"email": o.Email},
	}
	if o.PaymentType != "" {
		m["paymentType"], m["paymentId"] = o.PaymentType, "1"+o.ID[:6]
		m["paidAt"] = o.PaidAt.In(time.FixedZone("+03", 3*3600)).Format(time.RFC3339)
		if o.Recurring {
			m["CofToken"] = map[string]any{"tokenCardId": "208452", "cardType": "Mir", "maskedPan": "220445******0792"}
		}
	}
	if o.Recurring {
		m["recurring"] = true
	}
	return m
}

func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func bankErr(w http.ResponseWriter, status int, msg string) {
	write(w, status, map[string]any{"code": strconv.Itoa(status), "id": uuid.NewString(), "message": "Что-то пошло не так",
		"Errors": []any{map[string]any{"errorCode": "Something going wrong", "message": msg, "url": ""}}})
}

func (b *Bank) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer test.token.value" {
		bankErr(w, 401, "unauthorized")
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	p := r.URL.Path
	switch {
	case r.Method == "POST" && (p == "/acquiring/v1.0/payments_with_receipt" || p == "/acquiring/v1.0/subscriptions_with_receipt"):
		var body struct {
			Data struct {
				CustomerCode, MerchantID, PaymentLinkID, ConsumerID string
				Amount                                              json.Number
				PaymentMode                                         []string
				Client                                              struct{ Email string }
				Recurring                                           bool
				SaveCard                                            *bool
				Options                                             any
			}
		}
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		if err := dec.Decode(&body); err != nil || body.Data.CustomerCode != Customer || body.Data.MerchantID != Merchant {
			bankErr(w, 400, "validation")
			return
		}
		sub := p == "/acquiring/v1.0/subscriptions_with_receipt"
		if sub && (!body.Data.Recurring || body.Data.SaveCard != nil || body.Data.Options != nil) {
			bankErr(w, 400, "a subscription without a schedule: recurring only")
			return
		}
		if sub {
			body.Data.PaymentMode = []string{"card"}
		}
		for _, id := range b.order {
			if b.ops[id].LinkID == body.Data.PaymentLinkID {
				bankErr(w, 424, "Ошибка валидации: заказ с номером "+body.Data.PaymentLinkID+" существует")
				return
			}
		}
		b.Creates++
		amt := body.Data.Amount.String()
		if !strings.Contains(amt, ".") {
			amt += ".00"
		}
		o := &Op{ID: uuid.NewString(), LinkID: body.Data.PaymentLinkID, ConsumerID: body.Data.ConsumerID, Status: "CREATED",
			Mode: body.Data.PaymentMode[0], Email: body.Data.Client.Email, Amount: amt, CreatedAt: time.Now().UTC(), Recurring: sub}
		b.ops[o.ID] = o
		b.order = append(b.order, o.ID)
		if b.LoseNextCreate {
			b.LoseNextCreate = false
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		write(w, 200, map[string]any{"Data": map[string]any{"operationId": o.ID, "paymentLink": "https://merch.example.test/order/?uuid=" + o.ID,
			"paymentLinkId": o.LinkID, "status": "CREATED", "amount": json.Number(o.Amount)}})
	case r.Method == "GET" && p == "/acquiring/v1.0/payments":
		var ops []any
		for _, id := range b.order {
			ops = append(ops, b.opJSON(b.ops[id]))
		}
		write(w, 200, map[string]any{"Data": map[string]any{"Operation": ops}, "Meta": map[string]any{"totalPages": 1}})
	case r.Method == "GET" && strings.HasPrefix(p, "/acquiring/v1.0/payments/"):
		o := b.ops[strings.TrimPrefix(p, "/acquiring/v1.0/payments/")]
		if o == nil {
			bankErr(w, 424, "Order not found")
			return
		}
		write(w, 200, map[string]any{"Data": map[string]any{"Operation": []any{b.opJSON(o)}}, "Meta": map[string]any{"totalPages": 1}})
	case r.Method == "POST" && strings.HasPrefix(p, "/acquiring/v1.0/payments/") && strings.HasSuffix(p, "/refund"):
		o := b.ops[strings.TrimSuffix(strings.TrimPrefix(p, "/acquiring/v1.0/payments/"), "/refund")]
		if o == nil {
			bankErr(w, 424, "Order not found")
			return
		}
		var body struct{ Data struct{ Amount json.Number } }
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		_ = dec.Decode(&body)
		b.RefundPosts++
		amt := body.Data.Amount.String()
		ord := b.refund(o, amt)
		if b.LoseNextRefund {
			b.LoseNextRefund = false
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if b.RefundAnswerOtherOrder {
			ord = "9" + ord
		}
		write(w, 200, map[string]any{"Data": map[string]any{"isRefund": true, "operationId": uuid.NewString(), "amount": json.Number(amt),
			"date": time.Now().Format("2006-01-02"), "orderId": ord}})
	case r.Method == "GET" && p == "/acquiring/v1.0/subscriptions":
		subs := []any{}
		for _, id := range b.order {
			if o := b.ops[id]; o.Recurring {
				subs = append(subs, b.opJSON(o))
			}
		}
		write(w, 200, map[string]any{"Data": map[string]any{"Subscription": subs}, "Meta": map[string]any{"totalPages": 1}})
	case r.Method == "POST" && strings.HasPrefix(p, "/acquiring/v1.0/subscriptions/") && strings.HasSuffix(p, "/charge"):
		o := b.ops[strings.TrimSuffix(strings.TrimPrefix(p, "/acquiring/v1.0/subscriptions/"), "/charge")]
		if o == nil || !o.Recurring || o.Status != "APPROVED" {
			bankErr(w, 424, "Subscription not found")
			return
		}
		var body struct{ Data struct{ Amount json.Number } }
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		_ = dec.Decode(&body)
		b.Charges++
		if b.DeclineNextCharge {
			b.DeclineNextCharge = false
			write(w, 200, map[string]any{"Data": map[string]any{"result": false}})
			return
		}
		o.Orders = append(o.Orders, Order{ID: b.ord(), Type: "approval", Amount: body.Data.Amount.String(), Time: time.Now().UTC()})
		if b.LoseNextCharge {
			b.LoseNextCharge = false
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		write(w, 200, map[string]any{"Data": map[string]any{"result": true}})
	case r.Method == "POST" && strings.HasPrefix(p, "/acquiring/v1.0/subscriptions/") && strings.HasSuffix(p, "/status"):
		bankErr(w, 424, "Subscription not found") // recurring subscriptions cannot change status (live 2026-10-10)
	default:
		bankErr(w, 404, "not found")
	}
}
