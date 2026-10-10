// Package tochkapaytest is an in-memory Tochka Pay Gateway test site for tests of the adapter
// and of the billing core with it (ADR-0083 phase 3). It follows the documented contract
// (OpenAPI «API Приёма платежей» 1.0, snapshot 2026-10-10) and the documented test scenarios
// (createQrc in the tokenization purpose, payWithToken in the payment comment). Where the bank
// does not document a behaviour, the fake makes the assumption the adapter is built for, named
// in a comment ("assumption"): the first real test-site run (`server tochkapay smoke`) checks
// each of them.
package tochkapaytest

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/golang-jwt/jwt/v5"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
)

// Site is the test site id.
const Site = "calab-test-site"

// QR is a registered TOKEN code.
type QR struct {
	QrcID, MerchantQrcID, Account, Metadata, Purpose string
	Status, Token, MemberID                          string // Status "" = pending
}

// Payment is one payment of the site.
type Payment struct {
	UID, Token, Account, Amount, Status, Reason, Metadata, Comment string
	Created, Changed                                               time.Time
	Refunded                                                       int64 // kopecks
}

// Refund is one refund of a payment.
type Refund struct {
	UID, Amount, Status, Reason, Metadata string
	Created                               time.Time
}

// Bank is the fake. Safe for concurrent use.
type Bank struct {
	mu       sync.Mutex
	qrs      map[string]*QR // by merchant QR id
	payments map[string]*Payment
	refunds  map[string][]*Refund
	bankKey  *rsa.PrivateKey // webhook signing key of the bank
	merchant *rsa.PrivateKey // our request signing key (the bank holds its public half)
	srv      *httptest.Server
	seq      int

	// Live: the site answers isTest=false (a production site).
	Live bool
	// LoseNextCharge / LoseNextRefund: the bank applies the request but the answer is lost (502).
	LoseNextCharge, LoseNextRefund bool
	// Charges, RefundPosts count create requests that reached the bank.
	Charges, RefundPosts, QRPosts int
}

// New starts the bank; closed by t.Cleanup.
func New(t testing.TB) *Bank {
	t.Helper()
	bk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	mk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	b := &Bank{qrs: map[string]*QR{}, payments: map[string]*Payment{}, refunds: map[string][]*Refund{}, bankKey: bk, merchant: mk}
	b.srv = httptest.NewServer(http.HandlerFunc(b.serve))
	t.Cleanup(b.srv.Close)
	return b
}

// SigningKeyPEM is our private key as the operator puts it into TOCHKA_PAY_SIGNING_KEY.
func (b *Bank) SigningKeyPEM() string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(b.merchant)}))
}

// Config of an adapter talking to this site.
func (b *Bank) Config() tochkapay.Config {
	return tochkapay.Config{BaseURL: b.srv.URL, Token: "test.token.value", SiteUID: Site, SigningKey: b.SigningKeyPEM(),
		Live: b.Live, WebhookKey: b.JWK(), HTTPClient: b.srv.Client()}
}

// JWK is the bank's public webhook key.
func (b *Bank) JWK() string {
	raw, _ := jose.JSONWebKey{Key: &b.bankKey.PublicKey, Algorithm: "RS256"}.MarshalJSON()
	return string(raw)
}

// QR returns a copy of a code by our binding id.
func (b *Bank) QR(merchantQrcID string) QR {
	b.mu.Lock()
	defer b.mu.Unlock()
	if q := b.qrs[merchantQrcID]; q != nil {
		return *q
	}
	return QR{}
}

// Payment returns a copy of a payment.
func (b *Bank) Payment(uid string) Payment {
	b.mu.Lock()
	defer b.mu.Unlock()
	if p := b.payments[uid]; p != nil {
		return *p
	}
	return Payment{}
}

// Decide plays the payer's bank: accepts (with a token) or rejects a pending binding.
func (b *Bank) Decide(merchantQrcID string, accept bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.decide(b.qrs[merchantQrcID], accept)
}

func (b *Bank) decide(q *QR, accept bool) {
	if q == nil {
		return
	}
	if accept {
		b.seq++
		q.Status, q.Token, q.MemberID = "ACCEPTED", fmt.Sprintf("5B4kFDCZm4mVQzx2DnPWN6Lx%04d", b.seq), "100000000111"
	} else {
		q.Status = "REJECTED"
	}
}

// Settle moves a WAITING payment to COMPLETED (or DECLINED with reason).
func (b *Bank) Settle(uid string, ok bool, reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if p := b.payments[uid]; p != nil {
		p.Status, p.Reason, p.Changed = "COMPLETED", "", time.Now().UTC()
		if !ok {
			p.Status, p.Reason = "DECLINED", reason
		}
	}
}

func (b *Bank) isTest() bool { return !b.Live }

func (b *Bank) fail(w http.ResponseWriter, status int, category, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code": fmt.Sprint(status), "id": "c397b21a-d998-4c4d-9471-e60eaf816b87", "message": category,
		"Errors": []map[string]string{{"errorCode": code, "message": "fake bank: " + code, "url": "https://enter.tochka.com/uapi/pay"}},
	})
}

func (b *Bank) ok(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"Data": data, "Links": map[string]string{"self": "https://enter.tochka.com/uapi/pay"}, "Meta": map[string]int{"totalPages": 1}})
}

func status(value, reason string, at time.Time) map[string]string {
	s := map[string]string{"value": value, "changedDateTime": at.Format(time.RFC3339)}
	if value == "DECLINED" {
		s["reasonSource"], s["reasonCode"], s["reasonMessage"] = "PROCESSING", reason, "fake bank decline"
	}
	return s
}

func (b *Bank) paymentJSON(p *Payment) map[string]any {
	return map[string]any{
		"paymentUid": p.UID, "createdDateTime": p.Created.Format(time.RFC3339),
		"amount":            map[string]string{"currency": "RUB", "amount": p.Amount},
		"refundedAmount":    map[string]string{"currency": "RUB", "amount": money.New(p.Refunded, money.RUB).Decimal()},
		"chargebackSummary": map[string]any{"chargedAmount": map[string]string{"currency": "RUB", "amount": "0.00"}, "reversedAmount": map[string]string{"currency": "RUB", "amount": "0.00"}},
		"paymentMethod":     map[string]string{"type": "SBP_TOKEN", "qrcId": "AS1000670LSS7DN18SJQDNP4B05KLJL2", "nspkTransactionId": "A12930013057370100000546241820D7"},
		"status":            status(p.Status, p.Reason, p.Changed),
		"customer":          map[string]string{"account": p.Account},
		"comment":           p.Comment, "isTest": b.isTest(), "metadata": p.Metadata,
	}
}

func refundJSON(r *Refund) map[string]any {
	return map[string]any{
		"refundUid": r.UID, "createdDateTime": r.Created.Format(time.RFC3339),
		"amount": map[string]string{"currency": "RUB", "amount": r.Amount}, "status": status(r.Status, r.Reason, r.Created),
		"metadata": r.Metadata,
	}
}

// scenarioField reads a field of a scenario JSON string ("" when not a scenario).
func scenarioField(s, field string) string {
	var kv map[string]string
	if json.Unmarshal([]byte(s), &kv) != nil {
		return ""
	}
	return kv[field]
}

func (b *Bank) serve(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		b.fail(w, 401, "INVALID_TOKEN", "UNKNOWN_TOKEN")
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != tochkapay.APIVersion || parts[1] != "sites" {
		b.fail(w, 404, "ENTITY_NOT_FOUND", "ENTITY_NOT_FOUND")
		return
	}
	if parts[2] != Site { // recorded live 2026-10-10 for an unknown site
		b.fail(w, 404, "ENTITY_NOT_FOUND", "MERCHANT_SITE_NOT_FOUND")
		return
	}
	body, _ := io.ReadAll(r.Body)
	b.mu.Lock()
	defer b.mu.Unlock()
	rest := parts[3:]
	switch {
	case r.Method == http.MethodPost && len(rest) == 2 && rest[0] == "sbp" && rest[1] == "qrc":
		b.createQR(w, body)
	case r.Method == http.MethodGet && len(rest) == 3 && rest[0] == "sbp" && rest[1] == "qrc":
		q := b.qrs[rest[2]]
		if q == nil || r.URL.Query().Get("qrcIdType") != "MERCHANT" {
			b.fail(w, 404, "ENTITY_NOT_FOUND", "ENTITY_NOT_FOUND")
			return
		}
		b.ok(w, map[string]any{"qrcId": q.QrcID, "merchantQrcId": q.MerchantQrcID, "payload": "https://qr.nspk.ru/" + q.QrcID, "isTest": b.isTest()})
	case r.Method == http.MethodGet && len(rest) == 5 && rest[0] == "sbp" && rest[3] == "tokenization":
		q := b.qrs[rest[2]]
		if q == nil || q.Status == "" { // assumption: no result before the payer's bank decides
			b.fail(w, 404, "ENTITY_NOT_FOUND", "ENTITY_NOT_FOUND")
			return
		}
		d := map[string]any{"status": q.Status, "qrcId": q.QrcID, "merchantQrcId": q.MerchantQrcID, "metadata": q.Metadata}
		if q.Status == "ACCEPTED" {
			d["token"], d["memberId"] = q.Token, q.MemberID
		}
		b.ok(w, d)
	case r.Method == http.MethodPost && len(rest) == 1 && rest[0] == "payments":
		if !b.signed(w, r, body) {
			return
		}
		b.createPayment(w, body)
	case r.Method == http.MethodGet && len(rest) == 2 && rest[0] == "payments":
		p := b.payments[rest[1]]
		if p == nil {
			b.fail(w, 404, "ENTITY_NOT_FOUND", "PAYMENT_NOT_FOUND")
			return
		}
		b.ok(w, b.paymentJSON(p))
	case r.Method == http.MethodPost && len(rest) == 3 && rest[0] == "payments" && rest[2] == "refunds":
		if !b.signed(w, r, body) {
			return
		}
		b.createRefund(w, rest[1], body)
	case r.Method == http.MethodGet && len(rest) == 3 && rest[0] == "payments" && rest[2] == "refunds":
		if b.payments[rest[1]] == nil {
			b.fail(w, 404, "ENTITY_NOT_FOUND", "PAYMENT_NOT_FOUND")
			return
		}
		out := []map[string]any{}
		for _, rf := range b.refunds[rest[1]] {
			out = append(out, refundJSON(rf))
		}
		b.ok(w, out)
	case r.Method == http.MethodGet && len(rest) == 4 && rest[0] == "payments" && rest[2] == "refunds":
		for _, rf := range b.refunds[rest[1]] {
			if rf.UID == rest[3] {
				b.ok(w, refundJSON(rf))
				return
			}
		}
		b.fail(w, 404, "ENTITY_NOT_FOUND", "REFUND_NOT_FOUND")
	default:
		b.fail(w, 404, "ENTITY_NOT_FOUND", "ENTITY_NOT_FOUND")
	}
}

// signed checks the Signature header against our public key (403 as the bank documents).
func (b *Bank) signed(w http.ResponseWriter, r *http.Request, body []byte) bool {
	if tochkapay.Verify(&b.merchant.PublicKey, body, r.Header.Get("Signature")) != nil {
		b.fail(w, 403, "OPERATION_FORBIDDEN", "SIGNATURE_VERIFICATION_ERROR")
		return false
	}
	return true
}

func (b *Bank) createQR(w http.ResponseWriter, body []byte) {
	var req struct {
		Data struct {
			QrcType       string `json:"qrcType"`
			MerchantQrcID string `json:"merchantQrcId"`
			PaymentToken  struct {
				TokenizationPurpose string `json:"tokenizationPurpose"`
			} `json:"paymentToken"`
			Customer struct {
				Account string `json:"account"`
			} `json:"customer"`
			Metadata string `json:"metadata"`
		} `json:"Data"`
	}
	if json.Unmarshal(body, &req) != nil || req.Data.QrcType != "TOKEN" || req.Data.MerchantQrcID == "" {
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "VALIDATION_ERROR")
		return
	}
	b.QRPosts++
	if b.qrs[req.Data.MerchantQrcID] != nil { // assumption: merchantQrcId is unique per site
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "VALIDATION_ERROR")
		return
	}
	sc := scenarioField(req.Data.PaymentToken.TokenizationPurpose, "createQrc")
	if sc == "ERROR" {
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "QR_CODE_NOT_FOUND")
		return
	}
	b.seq++
	q := &QR{
		QrcID: fmt.Sprintf("AS10006%025d", b.seq), MerchantQrcID: req.Data.MerchantQrcID, Account: req.Data.Customer.Account,
		Metadata: req.Data.Metadata, Purpose: req.Data.PaymentToken.TokenizationPurpose,
	}
	b.qrs[q.MerchantQrcID] = q
	switch sc {
	case "OK_SUBSCRIPTION_ACCEPTED":
		b.decide(q, true)
	case "OK_SUBSCRIPTION_REJECTED":
		b.decide(q, false)
	}
	b.ok(w, map[string]any{
		"qrcId": q.QrcID, "merchantQrcId": q.MerchantQrcID, "payload": "https://qr.nspk.ru/" + q.QrcID + "?type=03&bank=100000000284",
		"image": map[string]string{"mediaType": "image/png", "content": "iVBORw0KGgo="}, "isTest": b.isTest(),
	})
}

func (b *Bank) createPayment(w http.ResponseWriter, body []byte) {
	var req struct {
		Data struct {
			PaymentUID string `json:"paymentUid"`
			Amount     struct {
				Currency, Amount string
			} `json:"amount"`
			PaymentMethod struct {
				Type, Token string
			} `json:"paymentMethod"`
			Customer struct {
				Account string `json:"account"`
			} `json:"customer"`
			Comment  string `json:"comment"`
			Metadata string `json:"metadata"`
		} `json:"Data"`
	}
	if json.Unmarshal(body, &req) != nil || req.Data.PaymentMethod.Type != "SBP_TOKEN" || req.Data.Amount.Currency != "RUB" {
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "VALIDATION_ERROR")
		return
	}
	if _, err := money.ParseDecimal(req.Data.Amount.Amount, money.RUB); err != nil {
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "INCORRECT_AMOUNT")
		return
	}
	b.Charges++
	if b.payments[req.Data.PaymentUID] != nil { // assumption: a repeated paymentUid is refused
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "VALIDATION_ERROR")
		return
	}
	sc := scenarioField(req.Data.Comment, "payWithToken")
	if sc == "ERROR" {
		b.fail(w, 500, "INTERNAL_ERROR", "INTERNAL_ERROR")
		return
	}
	now := time.Now().UTC()
	p := &Payment{
		UID: req.Data.PaymentUID, Token: req.Data.PaymentMethod.Token, Account: req.Data.Customer.Account, Amount: req.Data.Amount.Amount,
		Status: "COMPLETED", Metadata: req.Data.Metadata, Comment: req.Data.Comment, Created: now, Changed: now,
	}
	known := false
	for _, q := range b.qrs {
		known = known || (q.Status == "ACCEPTED" && q.Token == p.Token)
	}
	switch {
	case !known:
		p.Status, p.Reason = "DECLINED", "SUBSCRIPTION_TOKEN_NOT_FOUND"
	case sc == "OK_REJECTED":
		p.Status, p.Reason = "DECLINED", "OPERATION_EXECUTION_REJECTED"
	case sc == "WAITING": // not a bank scenario: lets tests see a payment in progress
		p.Status = "WAITING"
	}
	b.payments[p.UID] = p
	if b.LoseNextCharge {
		b.LoseNextCharge = false
		b.fail(w, 502, "UNDERLYING_SERVICE_UNAVAILABLE", "CONNECTION_BROKEN")
		return
	}
	b.ok(w, b.paymentJSON(p))
}

func (b *Bank) createRefund(w http.ResponseWriter, paymentUID string, body []byte) {
	p := b.payments[paymentUID]
	if p == nil {
		b.fail(w, 404, "ENTITY_NOT_FOUND", "PAYMENT_NOT_FOUND")
		return
	}
	var req struct {
		Data struct {
			RefundUID string `json:"refundUid"`
			Amount    *struct {
				Currency, Amount string
			} `json:"amount"`
			Comment  string `json:"comment"`
			Metadata string `json:"metadata"`
		} `json:"Data"`
	}
	if json.Unmarshal(body, &req) != nil || req.Data.RefundUID == "" {
		b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "VALIDATION_ERROR")
		return
	}
	b.RefundPosts++
	for _, rf := range b.refunds[paymentUID] {
		if rf.UID == req.Data.RefundUID {
			b.fail(w, 400, "REQUEST_VALIDATION_ERROR", "REFUND_ID_ALREADY_TAKEN")
			return
		}
	}
	paid, _ := money.ParseDecimal(p.Amount, money.RUB)
	amt := paid
	if req.Data.Amount != nil {
		amt, _ = money.ParseDecimal(req.Data.Amount.Amount, money.RUB)
	}
	rf := &Refund{UID: req.Data.RefundUID, Amount: amt.Decimal(), Status: "COMPLETED", Metadata: req.Data.Metadata, Created: time.Now().UTC()}
	switch {
	case p.Status != "COMPLETED":
		rf.Status, rf.Reason = "DECLINED", "PAYMENT_NOT_FOUND"
	case amt.Minor+p.Refunded > paid.Minor:
		rf.Status, rf.Reason = "DECLINED", "REFUND_AMOUNT_EXCEEDS_PAYMENT_AMOUNT"
	case scenarioField(req.Data.Comment, "refund") == "OK_REJECTED":
		rf.Status, rf.Reason = "DECLINED", "OPERATION_EXECUTION_REJECTED"
	default:
		p.Refunded += amt.Minor
	}
	b.refunds[paymentUID] = append(b.refunds[paymentUID], rf)
	if b.LoseNextRefund {
		b.LoseNextRefund = false
		b.fail(w, 503, "UNDERLYING_SERVICE_UNAVAILABLE", "CONNECTION_TIMEOUT")
		return
	}
	b.ok(w, refundJSON(rf))
}

// sign signs a notification as the bank does (RS256 JWT, the body of the webhook).
func (b *Bank) sign(claims jwt.MapClaims) []byte {
	s, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(b.bankKey)
	if err != nil {
		panic(err)
	}
	return []byte(s)
}

// PaymentWebhook is a payment-updated notification of a payment.
func (b *Bank) PaymentWebhook(uid string) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sign(jwt.MapClaims{"version": "1.0", "siteUid": Site, "event": tochkapay.EventPaymentUpdated,
		"createdAt": time.Now().UTC().Format(time.RFC3339), "payloadType": "payment", "payload": b.paymentJSON(b.payments[uid])})
}

// TokenWebhook is the tokenization decision of a binding (as the bank sends it, with the token).
func (b *Bank) TokenWebhook(merchantQrcID, site string) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	q := b.qrs[merchantQrcID]
	ev, pl := tochkapay.EventTokenDeclined, map[string]any{"status": "REJECTED", "qrcId": q.QrcID, "merchantQrcId": q.MerchantQrcID, "metadata": q.Metadata}
	if q.Status == "ACCEPTED" {
		ev = tochkapay.EventTokenIssued
		pl["status"], pl["token"], pl["memberId"] = "ACCEPTED", q.Token, q.MemberID
	}
	return b.sign(jwt.MapClaims{"version": "1.0", "siteUid": site, "event": ev,
		"createdAt": time.Now().UTC().Format(time.RFC3339), "payloadType": "sbp-tokenization-decision", "payload": pl})
}

// RefundWebhook is a refund-updated notification.
func (b *Bank) RefundWebhook(paymentUID, refundUID string) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, rf := range b.refunds[paymentUID] {
		if rf.UID == refundUID {
			return b.sign(jwt.MapClaims{"version": "1.0", "siteUid": Site, "paymentUid": paymentUID, "event": tochkapay.EventRefundUpdated,
				"createdAt": time.Now().UTC().Format(time.RFC3339), "payloadType": "refund", "payload": refundJSON(rf)})
		}
	}
	return nil
}

// ForeignSignedWebhook is a valid-looking notification signed by another key.
func ForeignSignedWebhook(t testing.TB) []byte {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"siteUid": Site, "event": tochkapay.EventPaymentUpdated}).SignedString(k)
	return []byte(s)
}
