// Package fake is a deterministic in-memory payment provider for core, worker and HTTP tests.
// It implements provider.Provider and provider.OffSessionCharger with Stripe-like semantics:
// idempotency keys return the first result, payments move through processing / requires_action
// / succeeded, a lost answer can still have charged (Timeout), and webhooks are signed bodies
// that may be delivered twice or out of order.
//
// Typical use:
//
//	p := fake.New(fake.Options{})
//	p.Queue(fake.OpCharge, fake.Timeout)          // next off-session charge: charged, answer lost
//	sess, _ := p.CreateCheckout(ctx, req)
//	p.CompleteCheckout(sess.ID, fake.Succeed)     // the payer paid on the hosted page
//	for _, w := range p.TakeWebhooks() { … POST w.Body with w.Header … }
package fake

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// ID of the fake provider. Tests that go through the capability matrix register it under
// provider.Stripe with Options.ID.
const ID provider.ID = "fake"

// SignatureHeader carries hex(HMAC-SHA256(secret, body)) of a fake webhook.
const SignatureHeader = "Fake-Signature"

// ErrIdempotencyMismatch is an idempotency key reused with other parameters (Stripe answers 400);
// it is returned wrapped with provider.ErrUnknownOutcome, like the Stripe adapter does.
var ErrIdempotencyMismatch = errors.New("fake: idempotency key reused with other parameters")

// Outcome of the next call of an operation.
type Outcome int

// Outcomes.
const (
	Succeed        Outcome = iota // the operation succeeds
	Decline                       // payment: failed (card_declined); refund: failed
	RequiresAction                // payment: requires_action (authentication needed)
	Processing                    // payment: processing (settle later with SettlePayment)
	Unknown                       // ErrUnknownOutcome, nothing happened at the provider
	Timeout                       // ErrUnknownOutcome, but the operation did happen (answer lost)
)

// Op is an operation whose outcomes can be queued.
type Op string

// Operations with queued outcomes (default Succeed when the queue is empty).
const (
	OpCustomer Op = "customer"
	OpCheckout Op = "checkout"
	OpCharge   Op = "charge" // ChargeOffSession
	OpRefund   Op = "refund"
	OpGet      Op = "get" // GetPayment / GetCheckout / GetRefund: Unknown or Timeout = ErrUnknownOutcome
)

// Options configure a fake provider.
type Options struct {
	ID            provider.ID  // default "fake"
	Account       string       // merchant account, default "acct_fake"
	Livemode      bool         // objects are livemode
	AllowLivemode bool         // else a livemode provider answers ErrLivemodeForbidden
	Secret        []byte       // webhook secret, default "whsec_fake"
	Caps          provider.Cap // default: all capabilities
	Now           func() time.Time
}

// Webhook is a signed delivery.
type Webhook struct {
	Header http.Header
	Body   []byte
	Event  provider.Event
}

type idem struct {
	fingerprint string
	objectID    string
	err         error
}

// Provider is the fake. Safe for concurrent use.
type Provider struct {
	opts      Options
	mu        sync.Mutex
	tag       string // per instance: ids of two fakes never collide in one database
	seq       int
	queues    map[Op][]Outcome
	idem      map[string]idem
	customers map[string]provider.CustomerRef // by id
	checkouts map[string]*checkout
	payments  map[string]*provider.PaymentFact
	order     []string // payment ids in creation order
	refunds   map[string]*provider.RefundFact
	methods   map[string]provider.SavedMethod
	pending   []provider.Event
	calls     map[string]int
}

type checkout struct {
	provider.CheckoutFact
	req provider.CheckoutReq
}

var (
	_ provider.Provider          = (*Provider)(nil)
	_ provider.OffSessionCharger = (*Provider)(nil)
	_ provider.ChargeLister      = (*Provider)(nil)
)

// reconcilable: Tochka-like charges (CapReconcilableCharge without CapIdempotentCharge): no
// key replay, and a charge answer that does not identify the payment.
func (p *Provider) reconcilable() bool {
	c := p.opts.Caps
	return c.Has(provider.CapReconcilableCharge) && !c.Has(provider.CapIdempotentCharge)
}

// New returns an empty fake provider.
func New(o Options) *Provider {
	if o.ID == "" {
		o.ID = ID
	}
	if o.Account == "" {
		o.Account = "acct_fake"
	}
	if o.Secret == nil {
		o.Secret = []byte("whsec_fake")
	}
	if o.Caps == 0 {
		o.Caps = provider.CapHostedCheckout | provider.CapSaveMethod | provider.CapOffSession | provider.CapIdempotentCharge |
			provider.CapRefund | provider.CapPartialRefund | provider.CapDisputes | provider.CapReceipts | provider.CapListPayments
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	var tag [4]byte
	_, _ = rand.Read(tag[:])
	return &Provider{
		tag:  hex.EncodeToString(tag[:]),
		opts: o, queues: map[Op][]Outcome{}, idem: map[string]idem{}, customers: map[string]provider.CustomerRef{},
		checkouts: map[string]*checkout{}, payments: map[string]*provider.PaymentFact{}, refunds: map[string]*provider.RefundFact{},
		methods: map[string]provider.SavedMethod{}, calls: map[string]int{},
	}
}

// ID implements provider.Provider.
func (p *Provider) ID() provider.ID { return p.opts.ID }

// Caps implements provider.Provider.
func (p *Provider) Caps() provider.Cap { return p.opts.Caps }

// Queue sets the outcomes of the next calls of op, in order.
func (p *Provider) Queue(op Op, outcomes ...Outcome) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.queues[op] = append(p.queues[op], outcomes...)
}

// Calls counts calls of a method by name ("ChargeOffSession", "Refund", …), retries included.
func (p *Provider) Calls(method string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[method]
}

// Payments returns every payment the provider holds (also ones whose answer was lost).
func (p *Provider) Payments() []provider.PaymentFact {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]provider.PaymentFact, 0, len(p.order))
	for _, id := range p.order {
		out = append(out, *p.payments[id])
	}
	return out
}

func (p *Provider) next(op Op) Outcome {
	q := p.queues[op]
	if len(q) == 0 {
		return Succeed
	}
	p.queues[op] = q[1:]
	return q[0]
}

func (p *Provider) newID(prefix string) string {
	p.seq++
	return prefix + "_fake" + p.tag + "x" + strconv.Itoa(p.seq)
}

func (p *Provider) live() error {
	if p.opts.Livemode && !p.opts.AllowLivemode {
		return provider.ErrLivemodeForbidden
	}
	return nil
}

// begin counts the call, checks livemode and replays an idempotent result: ok = replayed.
func (p *Provider) begin(method, key, fingerprint string) (string, bool, error) {
	p.calls[method]++
	if err := p.live(); err != nil {
		return "", false, err
	}
	if key == "" {
		return "", false, fmt.Errorf("fake: %s without an idempotency key", method)
	}
	if e, ok := p.idem[method+"\x00"+key]; ok {
		if e.fingerprint != fingerprint {
			return "", false, fmt.Errorf("%w: %w", ErrIdempotencyMismatch, provider.ErrUnknownOutcome)
		}
		return e.objectID, true, e.err
	}
	return "", false, nil
}

func (p *Provider) remember(method, key, fingerprint, objectID string, err error) {
	p.idem[method+"\x00"+key] = idem{fingerprint: fingerprint, objectID: objectID, err: err}
}

func (p *Provider) ref(customerID string) provider.CustomerRef {
	return provider.CustomerRef{Provider: p.opts.ID, ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode, ID: customerID}
}

func (p *Provider) checkCustomer(c provider.CustomerRef) error {
	if _, ok := p.customers[c.ID]; !ok || c.ProviderAccount != p.opts.Account || c.Livemode != p.opts.Livemode {
		return fmt.Errorf("fake: customer %q: %w", c.ID, provider.ErrNotFound)
	}
	return nil
}

// EnsureCustomer implements provider.Provider.
func (p *Provider) EnsureCustomer(_ context.Context, req provider.CustomerReq) (provider.CustomerRef, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fp := req.AccountID.String()
	if id, ok, err := p.begin("EnsureCustomer", req.IdemKey, fp); ok || err != nil {
		return p.ref(id), err
	}
	switch p.next(OpCustomer) {
	case Unknown:
		return provider.CustomerRef{}, provider.ErrUnknownOutcome
	case Timeout:
		id := p.newID("cus")
		p.customers[id] = p.ref(id)
		p.remember("EnsureCustomer", req.IdemKey, fp, id, nil)
		return provider.CustomerRef{}, provider.ErrUnknownOutcome
	}
	id := p.newID("cus")
	p.customers[id] = p.ref(id)
	p.remember("EnsureCustomer", req.IdemKey, fp, id, nil)
	return p.ref(id), nil
}

// CreateCheckout implements provider.Provider.
func (p *Provider) CreateCheckout(_ context.Context, req provider.CheckoutReq) (provider.CheckoutSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fp := fmt.Sprintf("%v|%s|%s|%t", req.Amount, req.Method, req.Customer.ID, req.SaveForOffSession)
	if id, ok, err := p.begin("CreateCheckout", req.IdemKey, fp); ok || err != nil {
		if err != nil {
			return provider.CheckoutSession{}, err
		}
		return p.session(p.checkouts[id]), nil
	}
	if err := p.checkCustomer(req.Customer); err != nil {
		return provider.CheckoutSession{}, err
	}
	if req.Amount.Minor <= 0 {
		return provider.CheckoutSession{}, errors.New("fake: checkout amount must be positive")
	}
	out := p.next(OpCheckout)
	if out == Unknown {
		return provider.CheckoutSession{}, provider.ErrUnknownOutcome
	}
	exp := req.ExpiresAt
	if exp.IsZero() {
		exp = p.opts.Now().Add(24 * time.Hour)
	}
	c := &checkout{req: req, CheckoutFact: provider.CheckoutFact{
		ID: p.newID("cs"), Status: provider.CheckoutOpen, CustomerID: req.Customer.ID, Amount: req.Amount,
		ExpiresAt: exp, ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode, Metadata: req.Metadata,
	}}
	p.checkouts[c.ID] = c
	p.remember("CreateCheckout", req.IdemKey, fp, c.ID, nil)
	if out == Timeout {
		return provider.CheckoutSession{}, provider.ErrUnknownOutcome
	}
	return p.session(c), nil
}

func (p *Provider) session(c *checkout) provider.CheckoutSession {
	return provider.CheckoutSession{ID: c.ID, URL: "https://pay.fake.test/" + c.ID, ExpiresAt: c.ExpiresAt,
		ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode}
}

// getOutcome applies a queued OpGet outcome.
func (p *Provider) getOutcome() error {
	if o := p.next(OpGet); o == Unknown || o == Timeout {
		return provider.ErrUnknownOutcome
	}
	return nil
}

// GetCheckout implements provider.Provider.
func (p *Provider) GetCheckout(_ context.Context, id string) (provider.CheckoutFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["GetCheckout"]++
	if err := p.live(); err != nil {
		return provider.CheckoutFact{}, err
	}
	if err := p.getOutcome(); err != nil {
		return provider.CheckoutFact{}, err
	}
	c, ok := p.checkouts[id]
	if !ok {
		return provider.CheckoutFact{}, provider.ErrNotFound
	}
	return c.CheckoutFact, nil
}

// GetPayment implements provider.Provider.
func (p *Provider) GetPayment(_ context.Context, id string) (provider.PaymentFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["GetPayment"]++
	if err := p.live(); err != nil {
		return provider.PaymentFact{}, err
	}
	if err := p.getOutcome(); err != nil {
		return provider.PaymentFact{}, err
	}
	pay, ok := p.payments[id]
	if !ok {
		return provider.PaymentFact{}, provider.ErrNotFound
	}
	return *pay, nil
}

// ListPayments implements provider.Provider: newest first, cursor = offset.
func (p *Provider) ListPayments(_ context.Context, req provider.ListReq) ([]provider.PaymentFact, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["ListPayments"]++
	if err := p.live(); err != nil {
		return nil, "", err
	}
	var all []provider.PaymentFact
	for i := len(p.order) - 1; i >= 0; i-- {
		pay := p.payments[p.order[i]]
		if pay.CustomerID != req.Customer.ID || pay.Created.Before(req.CreatedAfter) || (req.Kind != "" && pay.Metadata.Kind != req.Kind) {
			continue
		}
		all = append(all, *pay)
	}
	off, _ := strconv.Atoi(req.Cursor)
	limit := req.Limit
	if limit <= 0 {
		limit = 100
	}
	if off > len(all) {
		off = len(all)
	}
	end := min(off+limit, len(all))
	next := ""
	if end < len(all) {
		next = strconv.Itoa(end)
	}
	return all[off:end], next, nil
}

// newPayment creates a payment in the state of outcome and queues its events.
func (p *Provider) newPayment(customerID, pmID string, amount money.Money, meta provider.Metadata, out Outcome) *provider.PaymentFact {
	now := p.opts.Now()
	pay := &provider.PaymentFact{
		ID: p.newID("pi"), ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode, CustomerID: customerID,
		Amount: amount, AmountReceived: money.Zero(amount.Currency), PaymentMethodID: pmID, Created: now, Metadata: meta,
	}
	switch out {
	case Decline:
		pay.Status, pay.FailureCode = provider.PaymentFailed, "card_declined"
		p.emit(provider.EventPaymentFailed, "payment_intent.payment_failed", pay.ID, pay.ID, meta)
	case RequiresAction:
		pay.Status, pay.FailureCode = provider.PaymentRequiresAction, "authentication_required"
	case Processing:
		pay.Status = provider.PaymentProcessing
		p.emit(provider.EventPaymentProcessing, "payment_intent.processing", pay.ID, pay.ID, meta)
	default:
		p.succeed(pay)
	}
	p.payments[pay.ID] = pay
	p.order = append(p.order, pay.ID)
	return pay
}

func (p *Provider) succeed(pay *provider.PaymentFact) {
	pay.Status, pay.FailureCode = provider.PaymentSucceeded, ""
	pay.AmountReceived = pay.Amount
	pay.ChargeID = "ch" + pay.ID[2:]
	pay.ReceiptURL = "https://pay.fake.test/receipts/" + pay.ID
	pay.SucceededAt = p.opts.Now()
	p.emit(provider.EventPaymentSucceeded, "payment_intent.succeeded", pay.ID, pay.ID, pay.Metadata)
}

// CompleteCheckout simulates the payer on the hosted page: the session completes and its
// payment ends in the state of outcome (Succeed, Decline, RequiresAction, Processing). A
// session with SaveForOffSession saves a card on success.
func (p *Provider) CompleteCheckout(sessionID string, out Outcome) (provider.PaymentFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c, ok := p.checkouts[sessionID]
	if !ok || c.Status != provider.CheckoutOpen {
		return provider.PaymentFact{}, fmt.Errorf("fake: checkout %q is not open", sessionID)
	}
	pmID := ""
	if c.req.SaveForOffSession && (out == Succeed || out == Processing) {
		pmID = p.newID("pm")
		p.methods[pmID] = provider.SavedMethod{ID: pmID, CustomerID: c.CustomerID, Kind: provider.MethodCard, Brand: "visa", Last4: "4242", ExpMonth: 12, ExpYear: 2030}
		p.emit(provider.EventMethodSaved, "payment_method.attached", pmID, "", c.Metadata)
	}
	pay := p.newPayment(c.CustomerID, pmID, c.Amount, c.Metadata, out)
	c.PaymentID = pay.ID
	if out != Decline && out != RequiresAction {
		c.Status = provider.CheckoutComplete
		p.emit(provider.EventCheckoutCompleted, "checkout.session.completed", c.ID, pay.ID, c.Metadata)
	}
	return *pay, nil
}

// ExpireCheckout expires an open session.
func (p *Provider) ExpireCheckout(sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	c, ok := p.checkouts[sessionID]
	if !ok || c.Status != provider.CheckoutOpen {
		return fmt.Errorf("fake: checkout %q is not open", sessionID)
	}
	c.Status = provider.CheckoutExpired
	p.emit(provider.EventCheckoutExpired, "checkout.session.expired", c.ID, c.PaymentID, c.Metadata)
	return nil
}

// SettlePayment finishes a processing payment as Succeed or Decline (late success / failure).
func (p *Provider) SettlePayment(paymentID string, out Outcome) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	pay, ok := p.payments[paymentID]
	if !ok || (pay.Status != provider.PaymentProcessing && pay.Status != provider.PaymentRequiresAction) {
		return fmt.Errorf("fake: payment %q is not pending", paymentID)
	}
	if out == Decline {
		pay.Status, pay.FailureCode = provider.PaymentFailed, "card_declined"
		p.emit(provider.EventPaymentFailed, "payment_intent.payment_failed", pay.ID, pay.ID, pay.Metadata)
		return nil
	}
	p.succeed(pay)
	return nil
}

// Refund implements provider.Provider.
func (p *Provider) Refund(_ context.Context, req provider.RefundReq) (provider.RefundFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fp := fmt.Sprintf("%s|%v", req.PaymentID, req.Amount)
	if id, ok, err := p.begin("Refund", req.IdemKey, fp); ok || err != nil {
		if err != nil {
			return provider.RefundFact{}, err
		}
		return *p.refunds[id], nil
	}
	pay, ok := p.payments[req.PaymentID]
	if !ok || pay.Status != provider.PaymentSucceeded {
		return provider.RefundFact{}, fmt.Errorf("fake: payment %q: %w", req.PaymentID, provider.ErrNotFound)
	}
	if req.Amount.Currency != pay.Amount.Currency || req.Amount.Minor <= 0 || req.Amount.Minor > pay.AmountReceived.Minor-p.refunded(pay.ID) {
		return provider.RefundFact{}, errors.New("fake: refund amount exceeds the refundable amount")
	}
	out := p.next(OpRefund)
	if out == Unknown {
		return provider.RefundFact{}, provider.ErrUnknownOutcome
	}
	r := p.newRefund(pay, req.Amount, req.Metadata, out)
	p.remember("Refund", req.IdemKey, fp, r.ID, nil)
	if out == Timeout {
		return provider.RefundFact{}, provider.ErrUnknownOutcome
	}
	return *r, nil
}

func (p *Provider) refunded(paymentID string) int64 {
	var sum int64
	for _, r := range p.refunds {
		if r.PaymentID == paymentID && r.Status != provider.RefundFailed && r.Status != provider.RefundCanceled {
			sum += r.Amount.Minor
		}
	}
	return sum
}

func (p *Provider) newRefund(pay *provider.PaymentFact, amount money.Money, meta provider.Metadata, out Outcome) *provider.RefundFact {
	r := &provider.RefundFact{ID: p.newID("re"), PaymentID: pay.ID, ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode,
		Amount: amount, Status: provider.RefundSucceeded, Created: p.opts.Now(), Metadata: meta}
	switch out {
	case Decline:
		r.Status, r.FailureReason = provider.RefundFailed, "declined"
	case Processing:
		r.Status = provider.RefundPending
	case RequiresAction:
		r.Status = provider.RefundRequiresAction
	}
	p.refunds[r.ID] = r
	p.emit(provider.EventRefundUpdated, "refund.updated", r.ID, pay.ID, meta)
	return r
}

// DashboardRefund simulates a refund made in the provider dashboard (not through our API).
func (p *Provider) DashboardRefund(paymentID string, amount int64) (provider.RefundFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pay, ok := p.payments[paymentID]
	if !ok || pay.Status != provider.PaymentSucceeded {
		return provider.RefundFact{}, provider.ErrNotFound
	}
	return *p.newRefund(pay, money.New(amount, pay.Amount.Currency), pay.Metadata, Succeed), nil
}

// GetRefund implements provider.Provider.
func (p *Provider) GetRefund(_ context.Context, id string) (provider.RefundFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["GetRefund"]++
	if err := p.live(); err != nil {
		return provider.RefundFact{}, err
	}
	if err := p.getOutcome(); err != nil {
		return provider.RefundFact{}, err
	}
	r, ok := p.refunds[id]
	if !ok {
		return provider.RefundFact{}, provider.ErrNotFound
	}
	return *r, nil
}

// ListRefunds implements provider.RefundLister: the refunds of a payment, oldest first.
func (p *Provider) ListRefunds(_ context.Context, paymentID string) ([]provider.RefundFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["ListRefunds"]++
	if err := p.live(); err != nil {
		return nil, err
	}
	if err := p.getOutcome(); err != nil {
		return nil, err
	}
	out := []provider.RefundFact{}
	for _, r := range p.refunds {
		if r.PaymentID == paymentID {
			out = append(out, *r)
		}
	}
	slices.SortFunc(out, func(a, b provider.RefundFact) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// OpenDispute / CloseDispute queue dispute events of a payment (id "dp_…" is returned).
func (p *Provider) OpenDispute(paymentID string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pay, ok := p.payments[paymentID]
	if !ok {
		return "", provider.ErrNotFound
	}
	id := p.newID("dp")
	p.emit(provider.EventDisputeOpened, "charge.dispute.created", id, pay.ID, pay.Metadata)
	return id, nil
}

// CloseDispute queues the closing event of a dispute of a payment.
func (p *Provider) CloseDispute(disputeID, paymentID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	meta := provider.Metadata{}
	if pay, ok := p.payments[paymentID]; ok {
		meta = pay.Metadata
	}
	p.emit(provider.EventDisputeClosed, "charge.dispute.closed", disputeID, paymentID, meta)
}

// ListMethods implements provider.OffSessionCharger.
func (p *Provider) ListMethods(_ context.Context, c provider.CustomerRef) ([]provider.SavedMethod, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["ListMethods"]++
	if err := p.live(); err != nil {
		return nil, err
	}
	var out []provider.SavedMethod
	for _, m := range p.methods {
		if m.CustomerID == c.ID {
			out = append(out, m)
		}
	}
	slices.SortFunc(out, func(a, b provider.SavedMethod) int {
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	return out, nil
}

// AddMethod saves a card for a customer directly (setup outside a checkout).
func (p *Provider) AddMethod(customerID string) provider.SavedMethod {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := p.newID("pm")
	m := provider.SavedMethod{ID: id, CustomerID: customerID, Kind: provider.MethodCard, Brand: "visa", Last4: "4242", ExpMonth: 12, ExpYear: 2030}
	p.methods[id] = m
	return m
}

// AddCharge records a succeeded charge of a saved method that no ChargeOffSession answer
// reported (a reconcilable bank's approval that appears late, e.g. after «declined»). The
// metadata carries only the account, like a bank without metadata.
func (p *Provider) AddCharge(customerID, pmID string, amount money.Money, md provider.Metadata) provider.PaymentFact {
	p.mu.Lock()
	defer p.mu.Unlock()
	return *p.newPayment(customerID, pmID, amount, provider.Metadata{AccountID: md.AccountID}, Succeed)
}

// ChargeOffSession implements provider.OffSessionCharger. The idempotency key (attempt id)
// returns the first payment: a retry after Timeout finds the payment that was charged.
//
// A reconcilable fake (CapReconcilableCharge without CapIdempotentCharge) behaves like Tochka:
// every call charges again (no key), and an accepted charge answers PaymentProcessing without
// an id (a decline PaymentFailed): the caller finds the payment through ListCharges. An
// on-session RequiresAction carries a NextActionURL; SettlePayment finishes it.
func (p *Provider) ChargeOffSession(_ context.Context, req provider.OffSessionReq) (provider.PaymentFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reconcilable() {
		return p.chargeReconcilable(req)
	}
	fp := fmt.Sprintf("%v|%s|%s", req.Amount, req.Customer.ID, req.PaymentMethodID)
	if id, ok, err := p.begin("ChargeOffSession", req.IdemKey, fp); ok || err != nil {
		if err != nil {
			return provider.PaymentFact{}, err
		}
		return *p.payments[id], nil
	}
	if err := p.checkCustomer(req.Customer); err != nil {
		return provider.PaymentFact{}, err
	}
	if m, ok := p.methods[req.PaymentMethodID]; !ok || m.CustomerID != req.Customer.ID {
		return provider.PaymentFact{}, fmt.Errorf("fake: payment method %q: %w", req.PaymentMethodID, provider.ErrNotFound)
	}
	out := p.next(OpCharge)
	if out == Unknown {
		return provider.PaymentFact{}, provider.ErrUnknownOutcome
	}
	created := Succeed
	if out != Timeout {
		created = out
	}
	pay := p.newPayment(req.Customer.ID, req.PaymentMethodID, req.Amount, req.Metadata, created)
	if pay.Status == provider.PaymentRequiresAction && req.OnSession {
		pay.NextActionURL = "https://pay.fake.test/3ds/" + pay.ID
	}
	p.remember("ChargeOffSession", req.IdemKey, fp, pay.ID, nil)
	if out == Timeout {
		return provider.PaymentFact{}, provider.ErrUnknownOutcome
	}
	return *pay, nil
}

func (p *Provider) chargeReconcilable(req provider.OffSessionReq) (provider.PaymentFact, error) {
	p.calls["ChargeOffSession"]++
	if err := p.live(); err != nil {
		return provider.PaymentFact{}, err
	}
	if err := p.checkCustomer(req.Customer); err != nil {
		return provider.PaymentFact{}, err
	}
	if m, ok := p.methods[req.PaymentMethodID]; !ok || m.CustomerID != req.Customer.ID {
		return provider.PaymentFact{}, fmt.Errorf("fake: payment method %q: %w", req.PaymentMethodID, provider.ErrNotFound)
	}
	out := p.next(OpCharge)
	switch out {
	case Unknown:
		return provider.PaymentFact{}, provider.ErrUnknownOutcome
	case Decline:
		return provider.PaymentFact{Status: provider.PaymentFailed, FailureCode: "declined", Amount: req.Amount,
			AmountReceived: money.Zero(req.Amount.Currency), CustomerID: req.Customer.ID}, nil
	}
	// The bank keeps no metadata: the charge is seen only as a new approval of the method.
	p.newPayment(req.Customer.ID, req.PaymentMethodID, req.Amount, provider.Metadata{AccountID: req.Metadata.AccountID}, Succeed)
	if out == Timeout {
		return provider.PaymentFact{}, provider.ErrUnknownOutcome
	}
	return provider.PaymentFact{Status: provider.PaymentProcessing, Amount: req.Amount,
		AmountReceived: money.Zero(req.Amount.Currency), CustomerID: req.Customer.ID}, nil
}

// ListCharges implements provider.ChargeLister: the payments of a saved method, oldest first.
func (p *Provider) ListCharges(_ context.Context, c provider.CustomerRef, pmID string) ([]provider.PaymentFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["ListCharges"]++
	if err := p.live(); err != nil {
		return nil, err
	}
	if err := p.getOutcome(); err != nil {
		return nil, err
	}
	var out []provider.PaymentFact
	for _, id := range p.order {
		if pay := p.payments[id]; pay.CustomerID == c.ID && pay.PaymentMethodID == pmID {
			out = append(out, *pay)
		}
	}
	return out, nil
}

// CancelPayment implements provider.OffSessionCharger.
func (p *Provider) CancelPayment(_ context.Context, paymentID string) (provider.PaymentFact, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["CancelPayment"]++
	if err := p.live(); err != nil {
		return provider.PaymentFact{}, err
	}
	pay, ok := p.payments[paymentID]
	if !ok {
		return provider.PaymentFact{}, provider.ErrNotFound
	}
	switch pay.Status {
	case provider.PaymentSucceeded:
		return *pay, errors.New("fake: a succeeded payment cannot be canceled")
	case provider.PaymentCanceled:
		return *pay, nil
	}
	pay.Status = provider.PaymentCanceled
	return *pay, nil
}

// DetachMethod implements provider.OffSessionCharger.
func (p *Provider) DetachMethod(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls["DetachMethod"]++
	if err := p.live(); err != nil {
		return err
	}
	if _, ok := p.methods[id]; !ok {
		return provider.ErrNotFound
	}
	delete(p.methods, id)
	p.emit(provider.EventMethodDetached, "payment_method.detached", id, "", provider.Metadata{})
	return nil
}

func (p *Provider) emit(kind provider.EventKind, typ, objectID, paymentID string, meta provider.Metadata) {
	p.pending = append(p.pending, provider.Event{
		Provider: p.opts.ID, ProviderAccount: p.opts.Account, Livemode: p.opts.Livemode, EventID: p.newID("evt"),
		Kind: kind, Type: typ, ObjectID: objectID, PaymentID: paymentID, Created: p.opts.Now(), Metadata: meta,
	})
}

// wire is the JSON body of a fake webhook.
type wire struct {
	ID       string            `json:"id"`
	Account  string            `json:"account"`
	Livemode bool              `json:"livemode"`
	Kind     string            `json:"kind"`
	Type     string            `json:"type"`
	Object   string            `json:"object"`
	Payment  string            `json:"payment,omitempty"`
	Created  int64             `json:"created"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// TakeWebhooks returns the events emitted since the last call as signed deliveries, in order.
// Deliver them twice or reversed to test inbox dedup and ordering.
func (p *Provider) TakeWebhooks() []Webhook {
	p.mu.Lock()
	evs := p.pending
	p.pending = nil
	p.mu.Unlock()
	out := make([]Webhook, 0, len(evs))
	for _, ev := range evs {
		out = append(out, p.Sign(ev))
	}
	return out
}

// Sign renders an event as a signed delivery.
func (p *Provider) Sign(ev provider.Event) Webhook {
	body, _ := json.Marshal(wire{ //nolint:errchkjson // plain struct
		ID: ev.EventID, Account: ev.ProviderAccount, Livemode: ev.Livemode, Kind: string(ev.Kind), Type: ev.Type,
		Object: ev.ObjectID, Payment: ev.PaymentID, Created: ev.Created.Unix(), Metadata: ev.Metadata.Map(),
	})
	h := http.Header{}
	h.Set(SignatureHeader, p.signature(body))
	h.Set("Content-Type", "application/json")
	return Webhook{Header: h, Body: body, Event: ev}
}

func (p *Provider) signature(body []byte) string {
	m := hmac.New(sha256.New, p.opts.Secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// ParseWebhook implements provider.Provider: HMAC over the raw body, constant-time compare.
func (p *Provider) ParseWebhook(_ context.Context, h http.Header, raw []byte) (provider.Event, error) {
	got, err := hex.DecodeString(h.Get(SignatureHeader))
	want, _ := hex.DecodeString(p.signature(raw))
	if err != nil || !hmac.Equal(got, want) {
		return provider.Event{}, provider.ErrBadSignature
	}
	var w wire
	if err := json.Unmarshal(raw, &w); err != nil {
		return provider.Event{}, fmt.Errorf("fake: webhook body: %w", err)
	}
	if w.Livemode && !p.opts.AllowLivemode {
		return provider.Event{}, provider.ErrLivemodeForbidden
	}
	return provider.Event{
		Provider: p.opts.ID, ProviderAccount: w.Account, Livemode: w.Livemode, EventID: w.ID,
		Kind: provider.EventKind(w.Kind), Type: w.Type, ObjectID: w.Object, PaymentID: w.Payment,
		Created: time.Unix(w.Created, 0).UTC(), Metadata: provider.ParseMetadata(w.Metadata),
	}, nil
}
