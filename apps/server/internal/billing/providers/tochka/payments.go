package tochka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Payment statuses of the bank (AcquiringPaymentStatus).
const (
	statusCreated         = "CREATED"
	statusApproved        = "APPROVED"
	statusOnRefund        = "ON-REFUND"
	statusRefunded        = "REFUNDED"
	statusRefundedPartial = "REFUNDED_PARTIALLY"
	statusExpired         = "EXPIRED"
	statusAuthorized      = "AUTHORIZED"
	statusWaitFull        = "WAIT_FULL_PAYMENT"
)

// Payment types (paymentType) the bank reports once a payment is made.
const (
	typeDigitalRuble = "digitalRuble"
)

// decimal is an amount in rubles as the bank sends it: a JSON number (1.0) or a string ("0.33").
// Kept as text and parsed exactly into kopecks.
type decimal string

func (d *decimal) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		*d = ""
		return nil
	}
	if strings.HasPrefix(s, `"`) {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		s = str
	}
	*d = decimal(s)
	return nil
}

func (d decimal) money() (money.Money, error) {
	if d == "" {
		return money.Money{}, fmt.Errorf("tochka: amount missing: %w", provider.ErrUnknownOutcome)
	}
	m, err := money.ParseDecimal(string(d), money.RUB)
	if err != nil {
		return money.Money{}, fmt.Errorf("tochka: amount %q: %w", string(d), err)
	}
	return m, nil
}

// operation is the part of a payment operation we read (AcquiringGetPaymentOperationListItemModel).
type operation struct {
	CustomerCode  string  `json:"customerCode"`
	MerchantID    string  `json:"merchantId"`
	OperationID   string  `json:"operationId"`
	PaymentLink   string  `json:"paymentLink"`
	PaymentLinkID string  `json:"paymentLinkId"`
	ConsumerID    string  `json:"consumerId"`
	Status        string  `json:"status"`
	Amount        decimal `json:"amount"`
	PaymentType   string  `json:"paymentType"`
	PaymentID     string  `json:"paymentId"`
	TransactionID string  `json:"transactionId"`
	CreatedAt     string  `json:"createdAt"`
	PaidAt        string  `json:"paidAt"`
	Order         []order `json:"Order"`
	// CofToken: the card bound to a paid subscription without a schedule (phase 2).
	CofToken *cofToken `json:"CofToken"`
}

// cofToken is the card of a subscription without a schedule (CofTokenModel).
type cofToken struct {
	TokenCardID string `json:"tokenCardId"`
	CardType    string `json:"cardType"`
	MaskedPan   string `json:"maskedPan"`
}

// bound reports whether the operation is a paid subscription with a card bound to it.
func (o operation) bound() bool {
	return o.CofToken != nil && (o.CofToken.TokenCardID != "" || o.CofToken.MaskedPan != "")
}

// order is one operation on a payment: its approval, a refund (Order[]).
type order struct {
	OrderID string  `json:"orderId"`
	Type    string  `json:"type"` // refund | approval | authorized
	Amount  decimal `json:"amount"`
	Time    string  `json:"time"`
}

type operationsAnswer struct {
	Data struct {
		Operation []operation `json:"Operation"`
	} `json:"Data"`
	Meta struct {
		TotalPages int `json:"totalPages"`
	} `json:"Meta"`
}

func parseTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// metadata of an operation: our checkout id travels as paymentLinkId, the billing account id as
// consumerId (the bank keeps no free-form metadata).
func metadata(op operation) provider.Metadata {
	m := provider.Metadata{Kind: provider.MetadataKindCheckout}
	if id, err := uuid.Parse(op.PaymentLinkID); err == nil {
		m.CheckoutID = id
	}
	if id, err := uuid.Parse(op.ConsumerID); err == nil {
		m.AccountID = id
	}
	return m
}

// ours checks that an operation is of our customer code and retail point.
func (p *Provider) ours(op operation) error {
	if op.CustomerCode != "" && op.CustomerCode != p.customer {
		return fmt.Errorf("tochka: operation %s: %w", op.OperationID, ErrForeign)
	}
	if op.MerchantID != "" && op.MerchantID != p.merchant {
		return fmt.Errorf("tochka: operation %s: %w", op.OperationID, ErrForeign)
	}
	return nil
}

// getOperation reads one payment operation (Get Payment Operation Info).
func (p *Provider) getOperation(ctx context.Context, op, id string) (operation, error) {
	if id == "" || strings.ContainsAny(id, "/?#") {
		return operation{}, fmt.Errorf("%w: operation id %q", ErrInvalidRequest, id)
	}
	var a operationsAnswer
	if err := p.do(ctx, op, "GET", "/acquiring/v1.0/payments/"+url.PathEscape(id), nil, &a); err != nil {
		return operation{}, err
	}
	if len(a.Data.Operation) == 0 {
		return operation{}, fmt.Errorf("tochka %s: %s: %w", op, id, provider.ErrNotFound)
	}
	o := a.Data.Operation[0]
	if o.OperationID != id {
		return operation{}, fmt.Errorf("tochka %s: answered %s for %s: %w", op, o.OperationID, id, provider.ErrUnknownOutcome)
	}
	if err := p.ours(o); err != nil {
		return operation{}, fmt.Errorf("%w: %w", provider.ErrNotFound, err)
	}
	return o, nil
}

// EnsureCustomer makes no call: the bank has no customer objects. The billing account id is the consumerId of
// every payment link of the account and the customer id of billing_customers (provider account =
// our customer code), so a payment maps back to its account only through our own rows.
func (p *Provider) EnsureCustomer(_ context.Context, req provider.CustomerReq) (provider.CustomerRef, error) {
	if req.AccountID == uuid.Nil {
		return provider.CustomerRef{}, fmt.Errorf("%w: customer needs the account id", ErrInvalidRequest)
	}
	return provider.CustomerRef{Provider: provider.Tochka, ProviderAccount: p.customer, Livemode: p.live, ID: req.AccountID.String()}, nil
}

type receiptItem struct {
	Name          string      `json:"name"`
	Amount        json.Number `json:"amount"`
	Quantity      json.Number `json:"quantity"`
	VatType       string      `json:"vatType"`
	PaymentMethod string      `json:"paymentMethod"`
	PaymentObject string      `json:"paymentObject"`
	Measure       string      `json:"measure"`
}

type createLink struct {
	CustomerCode    string        `json:"customerCode"`
	MerchantID      string        `json:"merchantId"`
	Amount          json.Number   `json:"amount"`
	Purpose         string        `json:"purpose"`
	PaymentMode     []string      `json:"paymentMode"`
	RedirectURL     string        `json:"redirectUrl"`
	FailRedirectURL string        `json:"failRedirectUrl"`
	TTL             int           `json:"ttl"`
	PaymentLinkID   string        `json:"paymentLinkId"`
	ConsumerID      string        `json:"consumerId"`
	TaxSystemCode   string        `json:"taxSystemCode"`
	Client          receiptClient `json:"Client"`
	Items           []receiptItem `json:"Items"`
}

type receiptClient struct {
	Email string `json:"email"`
}

type createAnswer struct {
	Data struct {
		OperationID   string  `json:"operationId"`
		PaymentLink   string  `json:"paymentLink"`
		PaymentLinkID string  `json:"paymentLinkId"`
		Status        string  `json:"status"`
		Amount        decimal `json:"amount"`
	} `json:"Data"`
}

// clip shortens s to n runes (purpose ≤ 140, receipt line ≤ 256).
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// CreateCheckout opens a hosted payment link with a receipt (payments_with_receipt): one method
// (card or SBP, the payer chose it in Calab), our checkout id as paymentLinkId, the account id as
// consumerId, one receipt line «Пополнение баланса Calab» as a full prepayment for a service,
// sent by the bank to ReceiptEmail. The link lives until ExpiresAt (ttl in whole minutes).
//
// No idempotency key exists: a create whose answer was lost is retried by the caller with the
// same checkout id; the bank refuses the duplicate paymentLinkId and the existing link is found
// by listing the recent operations.
func (p *Provider) CreateCheckout(ctx context.Context, req provider.CheckoutReq) (provider.CheckoutSession, error) {
	var mode string
	switch req.Method {
	case provider.MethodCard:
		mode = "card"
	case provider.MethodSBP:
		mode = "sbp"
	default:
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout method %q (card or sbp)", ErrInvalidRequest, req.Method)
	}
	if req.Amount.Currency != money.RUB || req.Amount.Minor <= 0 {
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout amount must be positive RUB", ErrInvalidRequest)
	}
	if req.Metadata.CheckoutID == uuid.Nil || req.Customer.ID == "" || req.SuccessURL == "" {
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout needs a checkout id, a customer and a return URL", ErrInvalidRequest)
	}
	if !strings.Contains(req.ReceiptEmail, "@") {
		return provider.CheckoutSession{}, fmt.Errorf("%w: a 54-FZ receipt needs the payer's e-mail", ErrInvalidRequest)
	}
	if req.SaveForOffSession {
		return p.createSubscription(ctx, req)
	}
	ttl := 60
	if !req.ExpiresAt.IsZero() {
		left := time.Until(req.ExpiresAt)
		if left < time.Minute {
			return provider.CheckoutSession{}, fmt.Errorf("%w: checkout expires in less than a minute", ErrInvalidRequest)
		}
		ttl = min(int(left/time.Minute), 44640)
	}
	line := req.Description
	if line == "" {
		line = DefaultLineItem
	}
	fail := req.CancelURL
	if fail == "" {
		fail = req.SuccessURL
	}
	amt := json.Number(req.Amount.Decimal())
	linkID := req.Metadata.CheckoutID.String()
	body := struct {
		Data createLink `json:"Data"`
	}{Data: createLink{
		CustomerCode: p.customer, MerchantID: p.merchant, Amount: amt, Purpose: clip(line, 140), PaymentMode: []string{mode},
		RedirectURL: req.SuccessURL, FailRedirectURL: fail, TTL: ttl, PaymentLinkID: linkID, ConsumerID: req.Customer.ID,
		TaxSystemCode: p.taxSystem, Client: receiptClient{Email: req.ReceiptEmail},
		Items: []receiptItem{{
			Name: clip(line, 256), Amount: amt, Quantity: "1", VatType: p.vatType,
			PaymentMethod: "full_prepayment", PaymentObject: "service", Measure: "шт.",
		}},
	}}
	var a createAnswer
	err := p.do(ctx, "create payment link", "POST", "/acquiring/v1.0/payments_with_receipt", body, &a)
	if errors.Is(err, errDuplicate) {
		// The first create went through and its answer was lost: find that link.
		op, ferr := p.findByLinkID(ctx, linkID, time.Now().Add(-48*time.Hour))
		if ferr != nil {
			return provider.CheckoutSession{}, fmt.Errorf("tochka: payment link %s exists but was not found (%w): %w", linkID, ferr, provider.ErrUnknownOutcome)
		}
		got, aerr := op.Amount.money()
		if aerr != nil || got != req.Amount || op.ConsumerID != req.Customer.ID {
			return provider.CheckoutSession{}, fmt.Errorf("tochka: payment link %s exists with other parameters: %w", linkID, provider.ErrUnknownOutcome)
		}
		return p.session(op.OperationID, op.PaymentLink, req.ExpiresAt), nil
	}
	if err != nil {
		return provider.CheckoutSession{}, err
	}
	if a.Data.OperationID == "" || a.Data.PaymentLink == "" {
		return provider.CheckoutSession{}, fmt.Errorf("tochka create payment link: no operation id or link: %w", provider.ErrUnknownOutcome)
	}
	return p.session(a.Data.OperationID, a.Data.PaymentLink, req.ExpiresAt), nil
}

func (p *Provider) session(opID, link string, expires time.Time) provider.CheckoutSession {
	return provider.CheckoutSession{ID: opID, URL: link, ExpiresAt: expires, ProviderAccount: p.customer, Livemode: p.live}
}

// findByLinkID scans the operations created since `since` for paymentLinkId (the list cannot be
// filtered by it). ErrNotFound when absent.
func (p *Provider) findByLinkID(ctx context.Context, linkID string, since time.Time) (operation, error) {
	page := 1
	for range 50 {
		ops, pages, err := p.listPage(ctx, since, page)
		if err != nil {
			return operation{}, err
		}
		for _, op := range ops {
			if op.PaymentLinkID == linkID && p.ours(op) == nil {
				return op, nil
			}
		}
		if page >= pages {
			break
		}
		page++
	}
	return operation{}, provider.ErrNotFound
}

// listPerPage is the page size of operation lists.
const listPerPage = 100

// listPage reads one page of the operations created from the day before `since` to tomorrow
// (dates of the bank's time zone; the window is widened by a day on each side).
func (p *Provider) listPage(ctx context.Context, since time.Time, page int) ([]operation, int, error) {
	q := url.Values{}
	q.Set("customerCode", p.customer)
	if since.IsZero() {
		since = time.Now().Add(-30 * 24 * time.Hour)
	}
	q.Set("fromDate", since.UTC().Add(-24*time.Hour).Format("2006-01-02"))
	q.Set("toDate", time.Now().UTC().Add(24*time.Hour).Format("2006-01-02"))
	q.Set("page", strconv.Itoa(page))
	q.Set("perPage", strconv.Itoa(listPerPage))
	var a operationsAnswer
	if err := p.do(ctx, "list payments", "GET", "/acquiring/v1.0/payments?"+q.Encode(), nil, &a); err != nil {
		return nil, 0, err
	}
	return a.Data.Operation, max(a.Meta.TotalPages, 1), nil
}

// GetCheckout reads the payment link (the same operation as the payment): CREATED and
// AUTHORIZED are open, EXPIRED expired, anything paid complete with PaymentID = the operation.
func (p *Provider) GetCheckout(ctx context.Context, sessionID string) (provider.CheckoutFact, error) {
	op, err := p.getOperation(ctx, "get checkout", sessionID)
	if err != nil {
		return provider.CheckoutFact{}, err
	}
	amt, err := op.Amount.money()
	if err != nil {
		return provider.CheckoutFact{}, err
	}
	f := provider.CheckoutFact{
		ID: op.OperationID, CustomerID: op.ConsumerID, Amount: amt, ProviderAccount: p.customer, Livemode: p.live, Metadata: metadata(op),
	}
	switch op.Status {
	case statusExpired:
		f.Status = provider.CheckoutExpired
	case statusApproved, statusOnRefund, statusRefunded, statusRefundedPartial, statusWaitFull:
		f.Status, f.PaymentID = provider.CheckoutComplete, op.OperationID
	default: // CREATED, AUTHORIZED (never asked for: no preAuthorization)
		f.Status = provider.CheckoutOpen
	}
	return f, nil
}

// GetPayment reads the operation: the authoritative fact before a credit. Paid statuses
// (APPROVED and the refund ones) are succeeded with the full amount received; refunds are
// separate facts (ListRefunds), they never lower AmountReceived. EXPIRED is canceled, CREATED
// requires_action (the payer is still on the page), WAIT_FULL_PAYMENT processing.
func (p *Provider) GetPayment(ctx context.Context, paymentID string) (provider.PaymentFact, error) {
	if opID, orderID, ok := splitChargeID(paymentID); ok {
		return p.getCharge(ctx, opID, orderID)
	}
	op, err := p.getOperation(ctx, "get payment", paymentID)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	return p.paymentFact(op)
}

func (p *Provider) paymentFact(op operation) (provider.PaymentFact, error) {
	amt, err := op.Amount.money()
	if err != nil {
		return provider.PaymentFact{}, err
	}
	f := provider.PaymentFact{
		ID: op.OperationID, ProviderAccount: p.customer, Livemode: p.live, CustomerID: op.ConsumerID, Amount: amt,
		AmountReceived: money.Zero(money.RUB), ChargeID: op.PaymentID, PaymentMethodID: op.PaymentType,
		Created: parseTime(op.CreatedAt), Metadata: metadata(op),
	}
	if op.bound() {
		f.PaymentMethodID = op.OperationID // the saved card is the subscription itself
	}
	switch op.Status {
	case statusApproved, statusOnRefund, statusRefunded, statusRefundedPartial:
		f.Status, f.AmountReceived = provider.PaymentSucceeded, amt
		if f.SucceededAt = parseTime(op.PaidAt); f.SucceededAt.IsZero() {
			f.SucceededAt = f.Created
		}
	case statusWaitFull:
		f.Status = provider.PaymentProcessing
	case statusExpired:
		f.Status, f.FailureCode = provider.PaymentCanceled, "expired"
	default: // CREATED, AUTHORIZED
		f.Status = provider.PaymentRequiresAction
	}
	return f, nil
}

// ListPayments lists the operations of one consumer (billing account) created since
// CreatedAfter, one bank page per call (Cursor = page number). The bank filters by date only,
// so a page may hold no fact while the cursor is not empty.
func (p *Provider) ListPayments(ctx context.Context, req provider.ListReq) ([]provider.PaymentFact, string, error) {
	if req.Customer.ID == "" {
		return nil, "", fmt.Errorf("%w: list payments needs a customer", ErrInvalidRequest)
	}
	page := 1
	if req.Cursor != "" {
		n, err := strconv.Atoi(req.Cursor)
		if err != nil || n < 1 {
			return nil, "", fmt.Errorf("%w: cursor %q", ErrInvalidRequest, req.Cursor)
		}
		page = n
	}
	ops, pages, err := p.listPage(ctx, req.CreatedAfter, page)
	if err != nil {
		return nil, "", err
	}
	var out []provider.PaymentFact
	for _, op := range ops {
		if op.ConsumerID != req.Customer.ID || p.ours(op) != nil {
			continue
		}
		if !req.CreatedAfter.IsZero() {
			if c := parseTime(op.CreatedAt); !c.IsZero() && c.Before(req.CreatedAfter) {
				continue
			}
		}
		f, err := p.paymentFact(op)
		if err != nil {
			return nil, "", err
		}
		out = append(out, f)
	}
	next := ""
	if page < pages {
		next = strconv.Itoa(page + 1)
	}
	return out, next, nil
}

type refundAnswer struct {
	Data struct {
		IsRefund    bool    `json:"isRefund"`
		OperationID string  `json:"operationId"`
		Amount      decimal `json:"amount"`
		Date        string  `json:"date"`
		OrderID     string  `json:"orderId"`
	} `json:"Data"`
}

// refundID is the id of a refund: the payment's operation id and the refund's orderId.
func refundID(opID, orderID string) string { return opID + ":" + orderID }

func splitRefundID(id string) (string, string, bool) {
	op, ord, ok := strings.Cut(id, ":")
	return op, ord, ok && op != "" && ord != ""
}

// Refund refunds part or all of a paid payment link (card or SBP). It is NOT idempotent: the
// core sends it at most once (billing_refunds.dispatched_at) and resolves a lost answer through
// ListRefunds. A digital-ruble payment cannot be refunded through the API (only in the bank's
// interface): provider.ErrNotSupported, nothing sent. isRefund=false is a definite refusal
// (RefundFailed). An accepted refund is pending until the payment shows a refunded status.
func (p *Provider) Refund(ctx context.Context, req provider.RefundReq) (provider.RefundFact, error) {
	if req.PaymentID == "" || req.Amount.Minor <= 0 || req.Amount.Currency != money.RUB {
		return provider.RefundFact{}, fmt.Errorf("%w: refund needs a payment and a positive RUB amount", ErrInvalidRequest)
	}
	if _, _, charge := splitChargeID(req.PaymentID); charge {
		return provider.RefundFact{}, fmt.Errorf("tochka refund of %s: subscription payments are refunded in the bank's interface: %w", req.PaymentID, provider.ErrNotSupported)
	}
	op, err := p.getOperation(ctx, "refund (read payment)", req.PaymentID)
	if err != nil {
		return provider.RefundFact{}, err
	}
	if op.bound() {
		return provider.RefundFact{}, fmt.Errorf("tochka refund of %s: subscription payments are refunded in the bank's interface: %w", req.PaymentID, provider.ErrNotSupported)
	}
	if op.PaymentType == typeDigitalRuble {
		return provider.RefundFact{}, fmt.Errorf("tochka refund of %s: digital ruble payments are refunded in the bank's interface: %w", req.PaymentID, provider.ErrNotSupported)
	}
	switch op.Status {
	case statusApproved, statusRefundedPartial, statusOnRefund:
	default:
		return provider.RefundFact{}, &APIError{Op: "refund", Status: 409, Message: "payment status " + op.Status + " cannot be refunded"}
	}
	body := map[string]any{"Data": map[string]any{"amount": json.Number(req.Amount.Decimal())}}
	var a refundAnswer
	if err := p.do(ctx, "refund", "POST", "/acquiring/v1.0/payments/"+url.PathEscape(req.PaymentID)+"/refund", body, &a); err != nil {
		return provider.RefundFact{}, err
	}
	f := provider.RefundFact{
		PaymentID: req.PaymentID, ProviderAccount: p.customer, Livemode: p.live, Amount: req.Amount,
		Status: provider.RefundPending, Created: parseTime(a.Data.Date), Metadata: req.Metadata,
	}
	if !a.Data.IsRefund {
		f.Status, f.FailureReason = provider.RefundFailed, "refused by the bank"
		return f, nil
	}
	if a.Data.OrderID == "" {
		return provider.RefundFact{}, fmt.Errorf("tochka refund: accepted without an order id: %w", provider.ErrUnknownOutcome)
	}
	if got, err := a.Data.Amount.money(); err == nil && got != req.Amount {
		return provider.RefundFact{}, fmt.Errorf("tochka refund: accepted %s for %s: %w", got, req.Amount, provider.ErrUnknownOutcome)
	}
	// The answer's orderId is trusted as the refund id only once the payment lists a refund of
	// that orderId and amount (Order[]). The bank does not document that the two ids agree; a
	// stored id that never appears in Order[] would let the reconciliation import the listed
	// refund a second time as a dashboard refund (double debit). Unconfirmed: no id, pending —
	// the reconciliation matches the listed refund to this Calab refund by payment and amount.
	id := refundID(req.PaymentID, a.Data.OrderID)
	if after, err := p.getOperation(ctx, "refund (confirm)", req.PaymentID); err == nil {
		if facts, err := p.refundFacts(after); err == nil {
			for _, x := range facts {
				if x.ID == id && x.Amount == req.Amount {
					f.ID = id
					break
				}
			}
		}
	}
	return f, nil
}

// refundStatus of a payment's refund: the bank reports one status per payment, so a refund is
// succeeded once the payment is REFUNDED / REFUNDED_PARTIALLY and pending while it is ON-REFUND
// or still APPROVED.
func refundStatus(paymentStatus string) provider.RefundStatus {
	switch paymentStatus {
	case statusRefunded, statusRefundedPartial:
		return provider.RefundSucceeded
	}
	return provider.RefundPending
}

func (p *Provider) refundFacts(op operation) ([]provider.RefundFact, error) {
	var out []provider.RefundFact
	for _, o := range op.Order {
		if o.Type != "refund" || o.OrderID == "" {
			continue
		}
		amt, err := o.Amount.money()
		if err != nil {
			return nil, err
		}
		out = append(out, provider.RefundFact{
			ID: refundID(op.OperationID, o.OrderID), PaymentID: op.OperationID, ProviderAccount: p.customer, Livemode: p.live,
			Amount: amt, Status: refundStatus(op.Status), Created: parseTime(o.Time),
		})
	}
	return out, nil
}

// GetRefund reads the refund from its payment's operations (Order[]).
func (p *Provider) GetRefund(ctx context.Context, id string) (provider.RefundFact, error) {
	opID, _, ok := splitRefundID(id)
	if !ok {
		return provider.RefundFact{}, fmt.Errorf("%w: refund id %q", ErrInvalidRequest, id)
	}
	op, err := p.getOperation(ctx, "get refund", opID)
	if err != nil {
		return provider.RefundFact{}, err
	}
	facts, err := p.refundFacts(op)
	if err != nil {
		return provider.RefundFact{}, err
	}
	for _, f := range facts {
		if f.ID == id {
			return f, nil
		}
	}
	// Accepted but not listed yet: still pending (the reservation stays).
	return provider.RefundFact{ID: id, PaymentID: opID, ProviderAccount: p.customer, Livemode: p.live,
		Amount: money.Zero(money.RUB), Status: provider.RefundPending}, nil
}

// ListRefunds lists the refunds of a payment (Order[] of type refund), including those an
// operator made in the bank's interface.
func (p *Provider) ListRefunds(ctx context.Context, paymentID string) ([]provider.RefundFact, error) {
	if _, _, charge := splitChargeID(paymentID); charge {
		// A subscription's refunds are listed on the subscription and cannot be told apart per
		// charge: an operator resolves a refund of a charge (ADR-0083 phase 2).
		return nil, nil
	}
	op, err := p.getOperation(ctx, "list refunds", paymentID)
	if err != nil {
		return nil, err
	}
	return p.refundFacts(op)
}
