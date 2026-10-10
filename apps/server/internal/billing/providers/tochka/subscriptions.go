package tochka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Phase 2 (ADR-0083): a saved card is a subscription without a schedule (recurring:true, no
// Options, no saveCard). The owner's first card top-up with «сохранить карту» opens the
// subscription's payment link instead of a plain one; its payment binds the card
// (CofToken). Later charges are Charge Subscription {amount}: no idempotency key, a boolean
// answer, no payment id. Every charge is an approval in the subscription's Order[]; the core
// takes the approval that appears after its charge (ListCharges before and after the call).
//
// Ids: the saved method id is the subscription's operationId; the binding payment keeps the
// operationId as its payment id (the phase-1 path: GetCheckout, GetPayment, ListPayments see
// the subscription as a payment operation); a later charge is "{operationId}:charge:{orderId}".

const chargeSep = ":charge:"

// A subscription id is a charge credential with our token: it never appears in an error text (errors
// are logged and stored in the inbox). hideRef replaces it, keeping the wrapped sentinels.
type redacted struct {
	msg string
	err error
}

func (r redacted) Error() string { return r.msg }
func (r redacted) Unwrap() error { return r.err }

func hideRef(err error, ref string) error {
	if err == nil || ref == "" || !strings.Contains(err.Error(), ref) {
		return err
	}
	return redacted{msg: strings.ReplaceAll(err.Error(), ref, "[subscription]"), err: err}
}

func chargeID(opID, orderID string) string { return opID + chargeSep + orderID }

func splitChargeID(id string) (string, string, bool) {
	op, ord, ok := strings.Cut(id, chargeSep)
	return op, ord, ok && op != "" && ord != ""
}

type createSubscription struct {
	CustomerCode    string        `json:"customerCode"`
	MerchantID      string        `json:"merchantId"`
	Amount          json.Number   `json:"amount"`
	Purpose         string        `json:"purpose"`
	RedirectURL     string        `json:"redirectUrl"`
	FailRedirectURL string        `json:"failRedirectUrl"`
	ConsumerID      string        `json:"consumerId"`
	Recurring       bool          `json:"recurring"`
	PaymentLinkID   string        `json:"paymentLinkId"`
	TaxSystemCode   string        `json:"taxSystemCode"`
	Client          receiptClient `json:"Client"`
	Items           []receiptItem `json:"Items"`
}

// createSubscription opens the payment link of a subscription without a schedule, with the same
// 54-FZ receipt line as a top-up link (subscriptions_with_receipt): its payment is the top-up
// and binds the card. Card only. The bank has no ttl for subscriptions: the checkout row expires
// on our side, a late payment is still credited (one credit per operation).
func (p *Provider) createSubscription(ctx context.Context, req provider.CheckoutReq) (provider.CheckoutSession, error) {
	if !p.recurring {
		return provider.CheckoutSession{}, fmt.Errorf("%w: saving a card needs TOCHKA_RECURRING_ENABLED", ErrInvalidRequest)
	}
	if req.Method != provider.MethodCard {
		return provider.CheckoutSession{}, fmt.Errorf("%w: only a card can be saved", ErrInvalidRequest)
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
		Data createSubscription `json:"Data"`
	}{Data: createSubscription{
		CustomerCode: p.customer, MerchantID: p.merchant, Amount: amt, Purpose: clip(line, 140),
		RedirectURL: req.SuccessURL, FailRedirectURL: fail, ConsumerID: req.Customer.ID, Recurring: true, PaymentLinkID: linkID,
		TaxSystemCode: p.taxSystem, Client: receiptClient{Name: clip(req.ReceiptName, 256), Email: req.ReceiptEmail},
		Items: []receiptItem{{
			Name: clip(line, 256), Amount: amt, Quantity: "1", VatType: p.vatType,
			PaymentMethod: "full_prepayment", PaymentObject: "service", Measure: "шт.",
		}},
	}}
	var a createAnswer
	err := p.do(ctx, "create subscription", "POST", "/acquiring/v1.0/subscriptions_with_receipt", body, &a)
	if errors.Is(err, errDuplicate) {
		// The subscription is a payment operation too: find it among the recent operations.
		op, ferr := p.findByLinkID(ctx, linkID, time.Now().Add(-48*time.Hour))
		if ferr != nil {
			return provider.CheckoutSession{}, fmt.Errorf("tochka: subscription of checkout %s exists but was not found (%w): %w", linkID, ferr, provider.ErrUnknownOutcome)
		}
		got, aerr := op.Amount.money()
		if aerr != nil || got != req.Amount || op.ConsumerID != req.Customer.ID {
			return provider.CheckoutSession{}, fmt.Errorf("tochka: subscription %s exists with other parameters: %w", linkID, provider.ErrUnknownOutcome)
		}
		return p.session(op.OperationID, op.PaymentLink, req.ExpiresAt), nil
	}
	if err != nil {
		return provider.CheckoutSession{}, err
	}
	if a.Data.OperationID == "" || a.Data.PaymentLink == "" {
		return provider.CheckoutSession{}, fmt.Errorf("tochka create subscription: no operation id or link: %w", provider.ErrUnknownOutcome)
	}
	return p.session(a.Data.OperationID, a.Data.PaymentLink, req.ExpiresAt), nil
}

// approvals of an operation as charge facts, oldest first.
func (p *Provider) approvals(op operation) ([]provider.PaymentFact, error) {
	var out []provider.PaymentFact
	for _, o := range op.Order {
		if o.Type != "approval" || o.OrderID == "" {
			continue
		}
		amt, err := o.Amount.money()
		if err != nil {
			return nil, err
		}
		at := parseTime(o.Time)
		out = append(out, provider.PaymentFact{
			ID: chargeID(op.OperationID, o.OrderID), ProviderAccount: p.customer, Livemode: p.live, CustomerID: op.ConsumerID,
			Status: provider.PaymentSucceeded, Amount: amt, AmountReceived: amt, ChargeID: o.OrderID,
			PaymentMethodID: op.OperationID, Created: at, SucceededAt: at, Metadata: provider.Metadata{AccountID: metadata(op).AccountID},
		})
	}
	slices.SortStableFunc(out, func(a, b provider.PaymentFact) int { return a.Created.Compare(b.Created) })
	return out, nil
}

// getCharge reads one charge of a subscription ("{op}:charge:{orderId}").
func (p *Provider) getCharge(ctx context.Context, opID, orderID string) (provider.PaymentFact, error) {
	op, err := p.getOperation(ctx, "get charge", opID)
	if err != nil {
		return provider.PaymentFact{}, hideRef(err, opID)
	}
	facts, err := p.approvals(op)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	for _, f := range facts {
		if f.ChargeID == orderID {
			return f, nil
		}
	}
	return provider.PaymentFact{}, fmt.Errorf("tochka get charge %s: %w", orderID, provider.ErrNotFound)
}

// ListCharges implements provider.ChargeLister: the charges of the subscription, oldest first —
// the approvals in its Order[] except the first one, which is the binding payment (credited
// under the operation id, like any payment link).
func (p *Provider) ListCharges(ctx context.Context, customer provider.CustomerRef, subscriptionID string) ([]provider.PaymentFact, error) {
	op, err := p.getOperation(ctx, "list charges", subscriptionID)
	if err != nil {
		return nil, hideRef(err, subscriptionID)
	}
	if op.ConsumerID != customer.ID {
		return nil, fmt.Errorf("tochka list charges: the subscription is of another consumer: %w", provider.ErrNotFound)
	}
	facts, err := p.approvals(op)
	if err != nil || len(facts) == 0 {
		return nil, err
	}
	return facts[1:], nil
}

type subscriptionsAnswer struct {
	Data struct {
		Subscription []operation `json:"Subscription"`
	} `json:"Data"`
	Meta struct {
		TotalPages int `json:"totalPages"`
	} `json:"Meta"`
}

// ListMethods implements provider.OffSessionCharger: the paid subscriptions without a schedule of
// the consumer (billing account) with a bound card. The bank filters by customer code only.
func (p *Provider) ListMethods(ctx context.Context, customer provider.CustomerRef) ([]provider.SavedMethod, error) {
	if customer.ID == "" {
		return nil, fmt.Errorf("%w: list methods needs a customer", ErrInvalidRequest)
	}
	var out []provider.SavedMethod
	for page := 1; page <= 50; page++ {
		q := url.Values{}
		q.Set("customerCode", p.customer)
		q.Set("recurring", "true")
		q.Set("page", strconv.Itoa(page))
		q.Set("perPage", strconv.Itoa(listPerPage))
		var a subscriptionsAnswer
		if err := p.do(ctx, "list subscriptions", "GET", "/acquiring/v1.0/subscriptions?"+q.Encode(), nil, &a); err != nil {
			return nil, err
		}
		for _, op := range a.Data.Subscription {
			if op.ConsumerID != customer.ID || p.ours(op) != nil || !op.bound() {
				continue
			}
			out = append(out, savedMethod(op))
		}
		if page >= max(a.Meta.TotalPages, 1) {
			break
		}
	}
	return out, nil
}

func savedMethod(op operation) provider.SavedMethod {
	m := provider.SavedMethod{ID: op.OperationID, CustomerID: op.ConsumerID, Kind: provider.MethodCard}
	if c := op.CofToken; c != nil {
		m.Brand = strings.ToLower(strings.TrimSpace(c.CardType))
		if pan := strings.TrimSpace(c.MaskedPan); len(pan) >= 4 {
			if last := pan[len(pan)-4:]; strings.Trim(last, "0123456789") == "" {
				m.Last4 = last
			}
		}
	}
	return m
}

type chargeAnswer struct {
	Data struct {
		Result bool `json:"result"`
	} `json:"Data"`
}

// ChargeOffSession implements provider.OffSessionCharger: Charge Subscription {amount}. NOT
// idempotent and the answer does not identify the payment:
//   - result true: PaymentProcessing with an empty ID — the core finds the new approval in
//     ListCharges;
//   - result false: PaymentFailed («declined»; the bank gives no reason);
//   - a lost answer: provider.ErrUnknownOutcome — resolved by ListCharges, never sent again;
//   - a refusal (4xx): *APIError, nothing was charged.
//
// No 3-D Secure (merchant-initiated), so OnSession changes nothing. The 54-FZ receipt of a
// charge is the bank's (subscription created with receipt); its form is a live-check item.
func (p *Provider) ChargeOffSession(ctx context.Context, req provider.OffSessionReq) (provider.PaymentFact, error) {
	if !p.recurring {
		return provider.PaymentFact{}, fmt.Errorf("%w: charges need TOCHKA_RECURRING_ENABLED", ErrInvalidRequest)
	}
	if req.PaymentMethodID == "" || strings.ContainsAny(req.PaymentMethodID, "/?#:") || req.Customer.ID == "" ||
		req.Amount.Currency != money.RUB || req.Amount.Minor <= 0 {
		return provider.PaymentFact{}, fmt.Errorf("%w: a charge needs a subscription, a customer and a positive RUB amount", ErrInvalidRequest)
	}
	body := map[string]any{"Data": map[string]any{"amount": json.Number(req.Amount.Decimal())}}
	var a chargeAnswer
	if err := p.do(ctx, "charge subscription", "POST", "/acquiring/v1.0/subscriptions/"+url.PathEscape(req.PaymentMethodID)+"/charge", body, &a); err != nil {
		return provider.PaymentFact{}, hideRef(err, req.PaymentMethodID)
	}
	f := provider.PaymentFact{ProviderAccount: p.customer, Livemode: p.live, CustomerID: req.Customer.ID, Amount: req.Amount,
		AmountReceived: money.Zero(money.RUB), PaymentMethodID: req.PaymentMethodID, Metadata: req.Metadata}
	if a.Data.Result {
		f.Status = provider.PaymentProcessing
	} else {
		f.Status, f.FailureCode = provider.PaymentFailed, "declined"
	}
	return f, nil
}

// CancelPayment is not supported: a charge never waits for the payer (no 3-D Secure).
func (p *Provider) CancelPayment(_ context.Context, paymentID string) (provider.PaymentFact, error) {
	return provider.PaymentFact{}, fmt.Errorf("tochka cancel %s: %w", paymentID, provider.ErrNotSupported)
}

// DetachMethod asks the bank to cancel the subscription. The bank refuses status changes of
// subscriptions without a schedule (424 «Subscription not found», checked live 2026-10-10), so a
// refusal is not an error: the card is detached on our side and never charged again. Only a lost
// answer is returned (the caller retries).
func (p *Provider) DetachMethod(ctx context.Context, subscriptionID string) error {
	if subscriptionID == "" || strings.ContainsAny(subscriptionID, "/?#:") {
		return fmt.Errorf("%w: malformed subscription id", ErrInvalidRequest)
	}
	body := map[string]any{"Data": map[string]any{"status": "Cancelled"}}
	err := p.do(ctx, "cancel subscription", "POST", "/acquiring/v1.0/subscriptions/"+url.PathEscape(subscriptionID)+"/status", body, nil)
	var ae *APIError
	if err == nil || errors.Is(err, provider.ErrNotFound) || (errors.As(err, &ae) && !errors.Is(err, provider.ErrUnknownOutcome)) {
		return nil
	}
	return hideRef(err, subscriptionID)
}
