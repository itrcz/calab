package tochkapay_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay/tochkapaytest"
)

var ctx = context.Background()

func keyPEM(t *testing.T, bits int) (string, *rsa.PrivateKey) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), k
}

func TestNewValidates(t *testing.T) {
	good, _ := keyPEM(t, 2048)
	small, _ := keyPEM(t, 1024)
	base := tochkapay.Config{Token: "t", SiteUID: "site-1", SigningKey: good}
	if _, err := tochkapay.New(base); err != nil {
		t.Fatal(err)
	}
	b64 := base
	b64.SigningKey = base64.StdEncoding.EncodeToString([]byte(good))
	if _, err := tochkapay.New(b64); err != nil {
		t.Fatalf("base64 PEM: %v", err)
	}
	for name, mut := range map[string]func(*tochkapay.Config){
		"no token":  func(c *tochkapay.Config) { c.Token = " " },
		"bad site":  func(c *tochkapay.Config) { c.SiteUID = "site/../x" },
		"no key":    func(c *tochkapay.Config) { c.SigningKey = "" },
		"small key": func(c *tochkapay.Config) { c.SigningKey = small },
		"garbage key": func(c *tochkapay.Config) {
			c.SigningKey = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"
		},
		"http url": func(c *tochkapay.Config) { c.BaseURL = "http://enter.tochka.com/uapi/pay" },
		"http cb":  func(c *tochkapay.Config) { c.CallbackURL = "http://app.calab.io/x" },
	} {
		c := base
		mut(&c)
		if _, err := tochkapay.New(c); !errors.Is(err, tochkapay.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSignature(t *testing.T) {
	spec, k := keyPEM(t, 2048)
	key, err := tochkapay.ParseSigningKey(spec)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := tochkapay.PublicKeyBase64(key)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(pub)
	if blk, _ := pem.Decode(raw); blk == nil || blk.Type != "PUBLIC KEY" || strings.Contains(pub, "\n") {
		t.Fatalf("public key form: %q", pub)
	}
	body := []byte(`{"Data":{"paymentUid":"x"}}`)
	sig, err := tochkapay.Sign(key, body)
	if err != nil || strings.ContainsAny(sig, "\n ") || tochkapay.Verify(&k.PublicKey, body, sig) != nil {
		t.Fatalf("sign: %q %v", sig, err)
	}
	if tochkapay.Verify(&k.PublicKey, []byte("hello, world"), sig) == nil {
		t.Fatal("signature of another body verified")
	}
	// The bank's documented check: openssl dgst -sha256 -verify (when openssl is installed).
	openssl, err := exec.LookPath("openssl")
	if err != nil {
		t.Skip("openssl not installed")
	}
	dir := t.TempDir()
	raw, _ = base64.StdEncoding.DecodeString(sig)
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	for name, b := range map[string][]byte{"body": body, "sig": raw, "pub.pem": pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})} {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.CommandContext(ctx, openssl, "dgst", "-sha256", "-verify", filepath.Join(dir, "pub.pem"), "-signature", filepath.Join(dir, "sig"), filepath.Join(dir, "body")) //nolint:gosec // test: fixed program and temp files
	if out, err := cmd.CombinedOutput(); err != nil || !strings.Contains(string(out), "Verified OK") {
		t.Fatalf("openssl: %s %v", out, err)
	}
}

// stub serves fixture files by "METHOD path" and records requests.
type stub struct {
	routes map[string]stubReply
	got    []*http.Request
}

type stubReply struct {
	status int
	file   string
}

func newStub(t *testing.T, routes map[string]stubReply) (*tochkapay.Provider, *stub) {
	t.Helper()
	s := &stub{routes: routes}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.got = append(s.got, r)
		rep, ok := s.routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(599)
			return
		}
		w.WriteHeader(rep.status)
		if rep.file != "" {
			b, err := os.ReadFile("testdata/" + rep.file)
			if err != nil {
				t.Error(err)
			}
			_, _ = w.Write(b)
		}
	}))
	t.Cleanup(srv.Close)
	spec, _ := keyPEM(t, 2048)
	p, err := tochkapay.New(tochkapay.Config{BaseURL: srv.URL, Token: "tok", SiteUID: "tochka-site-00", SigningKey: spec, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p, s
}

const site = "/v1.0/sites/tochka-site-00"

// Fixtures: the documented shapes decode into the facts the core relies on.
func TestDocFixtures(t *testing.T) {
	bindingID := uuid.MustParse("0192a4c0-7e1d-7c3a-9b1e-3f6a2d8c5b10")
	p, _ := newStub(t, map[string]stubReply{
		"POST " + site + "/sbp/qrc": {200, "doc_create_qr_token.json"},
		"GET " + site + "/sbp/qrc/" + bindingID.String() + "/tokenization/result": {200, "doc_tokenization_accepted.json"},
		"GET " + site + "/payments/977639EE70494C67":                              {200, "doc_payment_sbp_token_completed.json"},
		"GET " + site + "/payments/977639EE70494C67/refunds/8H7GSEE7018GC67":      {200, "doc_refund_completed.json"},
	})
	acc := uuid.MustParse("0192a4c0-0000-7000-8000-000000000001")
	b, err := p.CreateBinding(ctx, provider.BindingReq{ID: bindingID, ExpiresAt: time.Now().Add(15 * time.Minute),
		Metadata: provider.Metadata{AccountID: acc, Kind: provider.MetadataKindAutoTopup}})
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != "AS1000670LSS7DN18SJQDNP4B05KLJL2" || !strings.HasPrefix(b.URL, "https://qr.nspk.ru/") || b.Livemode || b.ImagePNG != nil {
		t.Fatalf("binding %+v", b) // the doc's image example is not valid base64: no image, no error
	}
	f, err := p.GetBinding(ctx, bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.BindingAccepted || f.Method.ID != "5B4kFDCZm4mVQzx2DnPWN6LxIta" || f.Method.Kind != provider.MethodSBP ||
		f.Method.Brand != "100000000001" || f.Metadata.AccountID != acc || f.Method.CustomerID != acc.String() {
		t.Fatalf("fact %+v", f)
	}
	pay, err := p.GetPayment(ctx, "977639EE70494C67")
	if err != nil {
		t.Fatal(err)
	}
	if pay.Status != provider.PaymentSucceeded || pay.Amount != money.New(12345, money.RUB) || pay.AmountReceived != pay.Amount ||
		pay.CustomerID != "E268443E43D93DAB7EBEF303BBE9642F" || pay.ChargeID != "A12930013057370100000546241820D7" ||
		pay.ProviderAccount != "tochka-site-00" || pay.Livemode || pay.SucceededAt.IsZero() {
		t.Fatalf("payment %+v", pay)
	}
	rf, err := p.GetRefund(ctx, "977639EE70494C67/8H7GSEE7018GC67")
	if err != nil || rf.Status != provider.RefundSucceeded || rf.Amount != money.New(12345, money.RUB) || rf.PaymentID != "977639EE70494C67" {
		t.Fatalf("refund %+v %v", rf, err)
	}

	p2, _ := newStub(t, map[string]stubReply{
		"GET " + site + "/sbp/qrc/" + bindingID.String() + "/tokenization/result": {200, "doc_tokenization_rejected.json"},
		"GET " + site + "/payments/977639EE70494C67":                              {200, "doc_payment_declined.json"},
	})
	if f, err := p2.GetBinding(ctx, bindingID); err != nil || f.Status != provider.BindingRejected || f.Method.ID != "" {
		t.Fatalf("rejected %+v %v", f, err)
	}
	if pay, err := p2.GetPayment(ctx, "977639EE70494C67"); err != nil || pay.Status != provider.PaymentFailed ||
		pay.FailureCode != "INSUFFICIENT_FUNDS" || !pay.AmountReceived.IsZero() {
		t.Fatalf("declined %+v %v", pay, err)
	}
}

// Error mapping: a wrong site is a configuration error, never «payment not found».
func TestErrors(t *testing.T) {
	p, _ := newStub(t, map[string]stubReply{
		"GET " + site + "/payments/site-missing": {404, "live_site_not_found_404.json"},
		"GET " + site + "/payments/gone":         {404, ""},
		"GET " + site + "/payments/locked":       {423, ""},
		"GET " + site + "/payments/busy":         {503, ""},
		"GET " + site + "/payments/slow":         {429, ""},
		"GET " + site + "/payments/nope":         {501, ""},
		"GET " + site + "/payments/forbid":       {403, "doc_error_403_signature.json"},
		"GET " + site + "/payments/garbage":      {200, ""},
	})
	_, err := p.GetPayment(ctx, "site-missing")
	var ae *tochkapay.APIError
	if !errors.As(err, &ae) || errors.Is(err, provider.ErrNotFound) || ae.Code != "MERCHANT_SITE_NOT_FOUND" || ae.RequestID == "" {
		t.Fatalf("site: %v", err)
	}
	if strings.Contains(err.Error(), "tok") && strings.Contains(err.Error(), "Bearer") {
		t.Fatal("token leaked")
	}
	if _, err := p.GetPayment(ctx, "gone"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("gone: %v", err)
	}
	for _, id := range []string{"locked", "busy", "slow", "garbage"} {
		if _, err := p.GetPayment(ctx, id); !errors.Is(err, provider.ErrUnknownOutcome) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	for _, id := range []string{"nope", "forbid"} {
		if _, err := p.GetPayment(ctx, id); !errors.As(err, &ae) || errors.Is(err, provider.ErrUnknownOutcome) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if ae.Code != "SIGNATURE_VERIFICATION_ERROR" {
		t.Fatalf("403 code %q", ae.Code)
	}
	if _, err := p.GetPayment(ctx, "../x"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("bad id: %v", err)
	}
	for _, f := range []func() error{
		func() error { _, err := p.CreateCheckout(ctx, provider.CheckoutReq{}); return err },
		func() error { _, _, err := p.ListPayments(ctx, provider.ListReq{}); return err },
		func() error { _, err := p.ListMethods(ctx, provider.CustomerRef{}); return err },
		func() error { _, err := p.CancelPayment(ctx, "x"); return err },
	} {
		if err := f(); !errors.Is(err, provider.ErrNotSupported) {
			t.Fatalf("not supported: %v", err)
		}
	}
}

type flow struct {
	t    *testing.T
	bank *tochkapaytest.Bank
	p    *tochkapay.Provider
	acc  uuid.UUID
	cust provider.CustomerRef
}

func newFlow(t *testing.T, sc tochkapay.Scenarios) *flow {
	t.Helper()
	b := tochkapaytest.New(t)
	cfg := b.Config()
	cfg.Scenarios = sc
	p, err := tochkapay.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	acc := uuid.New()
	cust, err := p.EnsureCustomer(ctx, provider.CustomerReq{AccountID: acc})
	if err != nil || cust.ID != acc.String() || cust.ProviderAccount != tochkapaytest.Site || cust.Livemode {
		t.Fatalf("customer %+v %v", cust, err)
	}
	return &flow{t: t, bank: b, p: p, acc: acc, cust: cust}
}

func (f *flow) bind() (uuid.UUID, provider.Binding) {
	f.t.Helper()
	id := uuid.New()
	b, err := f.p.CreateBinding(ctx, provider.BindingReq{ID: id, Customer: f.cust, ExpiresAt: time.Now().Add(15 * time.Minute),
		ReturnURL: "https://app.calab.test/billing", Metadata: provider.Metadata{AccountID: f.acc, Kind: provider.MetadataKindAutoTopup}})
	if err != nil {
		f.t.Fatal(err)
	}
	return id, b
}

func (f *flow) token() string {
	f.t.Helper()
	id, _ := f.bind()
	f.bank.Decide(id.String(), true)
	fact, err := f.p.GetBinding(ctx, id)
	if err != nil || fact.Status != provider.BindingAccepted {
		f.t.Fatalf("%+v %v", fact, err)
	}
	return fact.Method.ID
}

func (f *flow) charge(key, token string, kopecks int64) (provider.PaymentFact, error) {
	return f.p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: key, Customer: f.cust, PaymentMethodID: token,
		Amount: money.New(kopecks, money.RUB), Metadata: provider.Metadata{AccountID: f.acc, AttemptID: uuid.MustParse(key), Kind: provider.MetadataKindAutoTopup}})
}

func TestBindingFlow(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{})
	id, b := f.bind()
	q := f.bank.QR(id.String())
	if q.Account != f.acc.String() || !strings.Contains(q.Metadata, f.acc.String()) || q.Purpose != tochkapay.DefaultPurpose {
		t.Fatalf("sent %+v", q)
	}
	if b.ImagePNG == nil || !strings.HasPrefix(b.URL, "https://qr.nspk.ru/") {
		t.Fatalf("binding %+v", b)
	}
	fact, err := f.p.GetBinding(ctx, id)
	if err != nil || fact.Status != provider.BindingPending {
		t.Fatalf("pending: %+v %v", fact, err)
	}
	f.bank.Decide(id.String(), true)
	fact, err = f.p.GetBinding(ctx, id)
	if err != nil || fact.Status != provider.BindingAccepted || fact.Method.ID == "" || fact.Metadata.AccountID != f.acc {
		t.Fatalf("accepted: %+v %v", fact, err)
	}
	if _, err := f.p.GetBinding(ctx, uuid.New()); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("unknown binding: %v", err)
	}
	// The same binding id twice: the bank refuses, nothing new.
	if _, err := f.p.CreateBinding(ctx, provider.BindingReq{ID: id, ExpiresAt: time.Now().Add(time.Hour), Metadata: provider.Metadata{AccountID: f.acc}}); err == nil {
		t.Fatal("duplicate binding id accepted")
	}
	for name, req := range map[string]provider.BindingReq{
		"no id":      {ExpiresAt: time.Now().Add(time.Hour), Metadata: provider.Metadata{AccountID: f.acc}},
		"no account": {ID: uuid.New(), ExpiresAt: time.Now().Add(time.Hour)},
		"too long":   {ID: uuid.New(), ExpiresAt: time.Now().Add(48 * time.Hour), Metadata: provider.Metadata{AccountID: f.acc}},
	} {
		if _, err := f.p.CreateBinding(ctx, req); !errors.Is(err, tochkapay.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// The bank's test scenarios ride in the tokenization purpose (createQrc).
func TestBindingScenarios(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{CreateQrc: "OK_SUBSCRIPTION_ACCEPTED"})
	id, _ := f.bind()
	if q := f.bank.QR(id.String()); q.Purpose != `{"createQrc":"OK_SUBSCRIPTION_ACCEPTED"}` {
		t.Fatalf("purpose %q", q.Purpose)
	}
	if fact, err := f.p.GetBinding(ctx, id); err != nil || fact.Status != provider.BindingAccepted {
		t.Fatalf("%+v %v", fact, err)
	}
	r := newFlow(t, tochkapay.Scenarios{CreateQrc: "OK_SUBSCRIPTION_REJECTED"})
	id, _ = r.bind()
	if fact, err := r.p.GetBinding(ctx, id); err != nil || fact.Status != provider.BindingRejected {
		t.Fatalf("%+v %v", fact, err)
	}
}

func TestChargeAndNoRepost(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{})
	tok := f.token()
	key := uuid.NewString()
	pay, err := f.charge(key, tok, 150000)
	if err != nil || pay.Status != provider.PaymentSucceeded || pay.ID != key || pay.AmountReceived != money.New(150000, money.RUB) ||
		pay.CustomerID != f.acc.String() || pay.Metadata.AttemptID.String() != key {
		t.Fatalf("%+v %v", pay, err)
	}
	if bp := f.bank.Payment(key); bp.Amount != "1500.00" || bp.Token != tok || bp.Comment != tochkapay.DefaultChargePurpose {
		t.Fatalf("sent %+v", bp)
	}
	// The same attempt again: read, not sent.
	if again, err := f.charge(key, tok, 150000); err != nil || again.ID != key || f.bank.Charges != 1 {
		t.Fatalf("again: %+v %v charges=%d", again, err, f.bank.Charges)
	}
	// Same paymentUid, other amount: refused locally, nothing sent.
	if _, err := f.charge(key, tok, 1000); !errors.Is(err, tochkapay.ErrForeign) || f.bank.Charges != 1 {
		t.Fatalf("other amount: %v", err)
	}

	// The answer is lost: unknown outcome; the payment is found by its paymentUid, the next
	// call reads it and does not send again.
	lost := uuid.NewString()
	f.bank.LoseNextCharge = true
	if _, err := f.charge(lost, tok, 20000); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("lost: %v", err)
	}
	if got, err := f.p.GetPayment(ctx, lost); err != nil || got.Status != provider.PaymentSucceeded {
		t.Fatalf("reconcile: %+v %v", got, err)
	}
	if got, err := f.charge(lost, tok, 20000); err != nil || got.Status != provider.PaymentSucceeded || f.bank.Charges != 2 {
		t.Fatalf("after lost: %+v %v charges=%d", got, err, f.bank.Charges)
	}

	// A token the bank does not know (revoked by the payer): DECLINED with the bank's reason.
	if got, err := f.charge(uuid.NewString(), "revoked-token", 20000); err != nil || got.Status != provider.PaymentFailed ||
		got.FailureCode != "SUBSCRIPTION_TOKEN_NOT_FOUND" {
		t.Fatalf("revoked: %+v %v", got, err)
	}
	for name, req := range map[string]provider.OffSessionReq{
		"bad key":      {IdemKey: "attempt:1", Customer: f.cust, PaymentMethodID: tok, Amount: money.New(100, money.RUB)},
		"usd":          {IdemKey: uuid.NewString(), Customer: f.cust, PaymentMethodID: tok, Amount: money.New(100, money.USD)},
		"no token":     {IdemKey: uuid.NewString(), Customer: f.cust, Amount: money.New(100, money.RUB)},
		"live cust":    {IdemKey: uuid.NewString(), Customer: provider.CustomerRef{ID: "x", Livemode: true}, PaymentMethodID: tok, Amount: money.New(100, money.RUB)},
		"foreign site": {IdemKey: uuid.NewString(), Customer: provider.CustomerRef{ID: "x", ProviderAccount: "other"}, PaymentMethodID: tok, Amount: money.New(100, money.RUB)},
	} {
		if _, err := f.p.ChargeOffSession(ctx, req); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if f.bank.Charges != 3 {
		t.Fatalf("charges %d", f.bank.Charges)
	}
}

func TestChargeScenarios(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{PayWithToken: "OK_REJECTED"})
	tok := f.token()
	key := uuid.NewString()
	if got, err := f.charge(key, tok, 15000); err != nil || got.Status != provider.PaymentFailed || got.FailureCode != "OPERATION_EXECUTION_REJECTED" {
		t.Fatalf("%+v %v", got, err)
	}
	if bp := f.bank.Payment(key); bp.Comment != `{"payWithToken":"OK_REJECTED"}` {
		t.Fatalf("comment %q", bp.Comment)
	}
	e := newFlow(t, tochkapay.Scenarios{PayWithToken: "ERROR"})
	if _, err := e.charge(uuid.NewString(), e.token(), 15000); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("error scenario: %v", err)
	}
	w := newFlow(t, tochkapay.Scenarios{PayWithToken: "WAITING"})
	key = uuid.NewString()
	if got, err := w.charge(key, w.token(), 15000); err != nil || got.Status != provider.PaymentProcessing || !got.AmountReceived.IsZero() {
		t.Fatalf("waiting: %+v %v", got, err)
	}
	w.bank.Settle(key, true, "")
	if got, _ := w.p.GetPayment(ctx, key); got.Status != provider.PaymentSucceeded {
		t.Fatalf("settled %+v", got)
	}
}

// A test config never accepts a live site's object and the reverse; scenarios are dropped live.
func TestModes(t *testing.T) {
	b := tochkapaytest.New(t)
	b.Live = true
	p, err := tochkapay.New(b.Config()) // Config carries Live=true
	if err != nil {
		t.Fatal(err)
	}
	cfg := b.Config()
	cfg.Live = false
	pTest, _ := tochkapay.New(cfg)
	req := provider.BindingReq{ID: uuid.New(), ExpiresAt: time.Now().Add(time.Hour), Metadata: provider.Metadata{AccountID: uuid.New()}}
	if _, err := pTest.CreateBinding(ctx, req); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("live on test config: %v", err)
	}
	req.ID = uuid.New()
	if bnd, err := p.CreateBinding(ctx, req); err != nil || !bnd.Livemode || !p.Livemode() {
		t.Fatalf("live: %+v %v", bnd, err)
	}

	tb := tochkapaytest.New(t)
	lcfg := tb.Config()
	lcfg.Live, lcfg.Scenarios = true, tochkapay.Scenarios{CreateQrc: "OK_SUBSCRIPTION_ACCEPTED"}
	pl, _ := tochkapay.New(lcfg)
	req.ID = uuid.New()
	if _, err := pl.CreateBinding(ctx, req); !errors.Is(err, tochkapay.ErrModeMismatch) {
		t.Fatalf("test on live config: %v", err)
	}
	if q := tb.QR(req.ID.String()); q.Purpose != tochkapay.DefaultPurpose {
		t.Fatalf("scenario sent on a live config: %q", q.Purpose)
	}
}

func TestRefunds(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{})
	tok := f.token()
	key := uuid.NewString()
	if _, err := f.charge(key, tok, 100000); err != nil {
		t.Fatal(err)
	}
	rid := uuid.New()
	req := provider.RefundReq{IdemKey: "refund:" + rid.String(), PaymentID: key, Amount: money.New(30000, money.RUB), Metadata: provider.Metadata{RefundID: rid}}
	rf, err := f.p.Refund(ctx, req)
	if err != nil || rf.Status != provider.RefundSucceeded || rf.ID != key+"/"+rid.String() || rf.Amount != money.New(30000, money.RUB) {
		t.Fatalf("%+v %v", rf, err)
	}
	// Again: read, not sent.
	if again, err := f.p.Refund(ctx, req); err != nil || again.ID != rf.ID || f.bank.RefundPosts != 1 {
		t.Fatalf("again %+v %v posts=%d", again, err, f.bank.RefundPosts)
	}
	// More than what is left: declined by the bank.
	over := uuid.New()
	if rf, err := f.p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + over.String(), PaymentID: key, Amount: money.New(80000, money.RUB)}); err != nil ||
		rf.Status != provider.RefundFailed || rf.FailureReason != "REFUND_AMOUNT_EXCEEDS_PAYMENT_AMOUNT" {
		t.Fatalf("over: %+v %v", rf, err)
	}
	// Lost answer: unknown; GetRefund finds it.
	lost := uuid.New()
	f.bank.LoseNextRefund = true
	if _, err := f.p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + lost.String(), PaymentID: key, Amount: money.New(10000, money.RUB)}); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("lost: %v", err)
	}
	if got, err := f.p.GetRefund(ctx, key+"/"+lost.String()); err != nil || got.Status != provider.RefundSucceeded {
		t.Fatalf("reconcile %+v %v", got, err)
	}
	list, err := f.p.ListRefunds(ctx, key)
	if err != nil || len(list) != 3 {
		t.Fatalf("list %d %v", len(list), err)
	}
	if _, err := f.p.GetRefund(ctx, "no-slash"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("bad id: %v", err)
	}
	if _, err := f.p.Refund(ctx, provider.RefundReq{IdemKey: "refund:x:y", PaymentID: key, Amount: money.New(1, money.RUB)}); !errors.Is(err, tochkapay.ErrInvalidRequest) {
		t.Fatalf("bad refund id: %v", err)
	}
}

func TestWebhooks(t *testing.T) {
	f := newFlow(t, tochkapay.Scenarios{})
	id, _ := f.bind()
	f.bank.Decide(id.String(), true)
	tok, _ := f.p.GetBinding(ctx, id)

	raw := f.bank.TokenWebhook(id.String(), tochkapaytest.Site)
	ev, err := f.p.ParseWebhook(ctx, http.Header{}, raw)
	if err != nil || ev.Kind != provider.EventMethodSaved || ev.ObjectID != id.String() || ev.Provider != provider.TochkaPay ||
		ev.Metadata.AccountID != f.acc || !strings.HasPrefix(ev.EventID, "tpw_") {
		t.Fatalf("token: %+v %v", ev, err)
	}
	if strings.Contains(ev.EventID+ev.Type+ev.ObjectID, tok.Method.ID) {
		t.Fatal("token in the event")
	}
	again, _ := f.p.ParseWebhook(ctx, nil, raw)
	if again.EventID != ev.EventID {
		t.Fatal("redelivery is not one event")
	}
	if ev, err := f.p.ParseWebhook(ctx, nil, f.bank.TokenWebhook(id.String(), "other-site")); err != nil || ev.Kind != provider.EventIgnored {
		t.Fatalf("foreign site: %+v %v", ev, err)
	}

	key := uuid.NewString()
	if _, err := f.charge(key, tok.Method.ID, 15000); err != nil {
		t.Fatal(err)
	}
	ev, err = f.p.ParseWebhook(ctx, nil, f.bank.PaymentWebhook(key))
	if err != nil || ev.Kind != provider.EventPaymentSucceeded || ev.PaymentID != key || ev.Metadata.AttemptID.String() != key || ev.Type != "payment-updated.completed" {
		t.Fatalf("payment: %+v %v", ev, err)
	}
	rid := uuid.New()
	if _, err := f.p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + rid.String(), PaymentID: key, Amount: money.New(15000, money.RUB)}); err != nil {
		t.Fatal(err)
	}
	ev, err = f.p.ParseWebhook(ctx, nil, f.bank.RefundWebhook(key, rid.String()))
	if err != nil || ev.Kind != provider.EventRefundUpdated || ev.ObjectID != key+"/"+rid.String() || ev.PaymentID != key {
		t.Fatalf("refund: %+v %v", ev, err)
	}
	for _, bad := range [][]byte{[]byte("not a jwt"), tochkapaytest.ForeignSignedWebhook(t), {}} {
		if _, err := f.p.ParseWebhook(ctx, nil, bad); !errors.Is(err, provider.ErrBadSignature) {
			t.Fatalf("bad: %v", err)
		}
	}

	// A live payment pushed to a test config: refused (400), like Stripe's livemode events.
	f.bank.Live = true
	if _, err := f.p.ParseWebhook(ctx, nil, f.bank.PaymentWebhook(key)); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("live on test: %v", err)
	}
}

func TestRegistryBinder(t *testing.T) {
	b := tochkapaytest.New(t)
	tp, err := tochkapay.New(b.Config())
	if err != nil {
		t.Fatal(err)
	}
	tochka := stubProvider{id: provider.Tochka, caps: provider.CapHostedCheckout | provider.CapReconcilableCharge}
	rows := append(provider.DefaultMatrix(), provider.SBPBindingRow())
	r, err := provider.NewRegistry("stripe:global,tochka:ru", rows, tochka, tp)
	if err != nil {
		t.Fatal(err)
	}
	id, binder, ok := r.Binder(provider.MarketRU, money.RUB, provider.MethodSBP)
	if !ok || id != provider.TochkaPay || binder == nil {
		t.Fatal("no SBP binder for ru")
	}
	if _, _, ok := r.Binder(provider.MarketRU, money.RUB, provider.MethodCard); ok {
		t.Fatal("card binder")
	}
	// Manual top-up options are unchanged: the gateway has no hosted checkout.
	got := r.Methods(provider.MarketRU, money.RUB, provider.PayerPerson, "RU")
	if len(got) != 2 || got[0].ID != "tochka:card" || got[1].ID != "tochka:sbp" {
		t.Fatalf("methods %+v", got)
	}
	// Off-session waits for the no-repost dispatch (CapIdempotentCharge is not claimed).
	if _, ok := r.OffSession(provider.TochkaPay); ok {
		t.Fatal("tochkapay admitted to off-session")
	}
	if tp.Caps().SafeRetry() || !tp.Caps().Has(provider.CapOffSession|provider.CapReconcilableCharge) {
		t.Fatal("caps")
	}
	// RU not served: no binder.
	r2, _ := provider.NewRegistry("stripe:global", rows, tochka, tp)
	if _, _, ok := r2.Binder(provider.MarketRU, money.RUB, provider.MethodSBP); ok {
		t.Fatal("binder while ru is not served")
	}
	// Flag off: no row, no binder.
	r3, _ := provider.NewRegistry("stripe:global,tochka:ru", provider.DefaultMatrix(), tochka, tp)
	if _, _, ok := r3.Binder(provider.MarketRU, money.RUB, provider.MethodSBP); ok {
		t.Fatal("binder without the row")
	}
}

// stubProvider is a Provider with only an id and caps (registry tests).
type stubProvider struct {
	provider.Provider
	id   provider.ID
	caps provider.Cap
}

func (s stubProvider) ID() provider.ID    { return s.id }
func (s stubProvider) Caps() provider.Cap { return s.caps }
