package stripe

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// EnsureCustomer creates the Stripe customer of a billing account. The idempotency key
// ("customer:{account_id}") makes a retry within 24h return the same customer; after that
// the core already has the cus_ id in billing_customers and does not call again.
func (p *Provider) EnsureCustomer(ctx context.Context, req provider.CustomerReq) (provider.CustomerRef, error) {
	if err := requireKey("customer", req.IdemKey); err != nil {
		return provider.CustomerRef{}, err
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.CustomerRef{}, err
	}
	md := req.Metadata
	if md.AccountID == uuid.Nil {
		md.AccountID = req.AccountID
	}
	params := &stripego.CustomerCreateParams{Metadata: md.Map()}
	if req.Email != "" {
		params.Email = stripego.String(req.Email)
	}
	if req.Name != "" {
		params.Name = stripego.String(req.Name)
	}
	params.SetIdempotencyKey(req.IdemKey)
	c, err := p.sc.V1Customers.Create(ctx, params)
	if err != nil {
		return provider.CustomerRef{}, mapErr("create customer", err)
	}
	if err := p.checkLive("create customer", c.Livemode); err != nil {
		return provider.CustomerRef{}, err
	}
	return provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: acct, Livemode: c.Livemode, ID: c.ID}, nil
}

// CreateCheckout opens a hosted Checkout page (mode=payment, card only) for a fixed amount.
// Billing address and tax id are collected by Stripe and saved on the customer; no Stripe
// invoice (receipt only), no automatic tax, no adaptive pricing (the payment stays in the
// account currency).
func (p *Provider) CreateCheckout(ctx context.Context, req provider.CheckoutReq) (provider.CheckoutSession, error) {
	if err := requireKey("checkout", req.IdemKey); err != nil {
		return provider.CheckoutSession{}, err
	}
	if req.Method != "" && req.Method != provider.MethodCard {
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout method %q (card only)", ErrInvalidRequest, req.Method)
	}
	if req.Amount.Minor <= 0 {
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout amount must be positive", ErrInvalidRequest)
	}
	if req.Customer.ID == "" || req.SuccessURL == "" || req.CancelURL == "" {
		return provider.CheckoutSession{}, fmt.Errorf("%w: checkout needs a customer, success and cancel URLs", ErrInvalidRequest)
	}
	if err := p.checkLive("checkout", req.Customer.Livemode); err != nil {
		return provider.CheckoutSession{}, err
	}
	cur, err := stripeCurrency(req.Amount.Currency)
	if err != nil {
		return provider.CheckoutSession{}, err
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.CheckoutSession{}, err
	}
	md := req.Metadata
	if md.Kind == "" {
		md.Kind = provider.MetadataKindCheckout
	}
	meta := md.Map()
	line := req.Description
	if line == "" {
		line = DefaultLineItem
	}
	expires := req.ExpiresAt
	if expires.IsZero() {
		expires = time.Now().Add(DefaultCheckoutTTL)
	}
	pid := &stripego.CheckoutSessionCreatePaymentIntentDataParams{Metadata: meta, Description: stripego.String(line)}
	if req.SaveForOffSession {
		pid.SetupFutureUsage = stripego.String(string(stripego.PaymentIntentSetupFutureUsageOffSession))
	}
	params := &stripego.CheckoutSessionCreateParams{
		Mode:               stripego.String(string(stripego.CheckoutSessionModePayment)),
		Customer:           stripego.String(req.Customer.ID),
		PaymentMethodTypes: stripego.StringSlice([]string{"card"}),
		LineItems: []*stripego.CheckoutSessionCreateLineItemParams{{
			Quantity: stripego.Int64(1),
			PriceData: &stripego.CheckoutSessionCreateLineItemPriceDataParams{
				Currency:    stripego.String(cur),
				UnitAmount:  stripego.Int64(req.Amount.Minor),
				ProductData: &stripego.CheckoutSessionCreateLineItemPriceDataProductDataParams{Name: stripego.String(line)},
			},
		}},
		Metadata:                 meta,
		PaymentIntentData:        pid,
		BillingAddressCollection: stripego.String(string(stripego.CheckoutSessionBillingAddressCollectionRequired)),
		TaxIDCollection:          &stripego.CheckoutSessionCreateTaxIDCollectionParams{Enabled: stripego.Bool(true)},
		CustomerUpdate: &stripego.CheckoutSessionCreateCustomerUpdateParams{
			Name: stripego.String("auto"), Address: stripego.String("auto"),
		},
		AutomaticTax:    &stripego.CheckoutSessionCreateAutomaticTaxParams{Enabled: stripego.Bool(false)},
		AdaptivePricing: &stripego.CheckoutSessionCreateAdaptivePricingParams{Enabled: stripego.Bool(false)},
		SuccessURL:      stripego.String(req.SuccessURL),
		CancelURL:       stripego.String(req.CancelURL),
		ExpiresAt:       stripego.Int64(expires.Unix()),
		Locale:          stripego.String("auto"),
	}
	if req.Metadata.CheckoutID != uuid.Nil {
		params.ClientReferenceID = stripego.String(req.Metadata.CheckoutID.String())
	}
	params.SetIdempotencyKey(req.IdemKey)
	s, err := p.sc.V1CheckoutSessions.Create(ctx, params)
	if err != nil {
		return provider.CheckoutSession{}, mapErr("create checkout", err)
	}
	if err := p.checkLive("create checkout", s.Livemode); err != nil {
		return provider.CheckoutSession{}, err
	}
	return provider.CheckoutSession{
		ID: s.ID, URL: s.URL, ExpiresAt: time.Unix(s.ExpiresAt, 0).UTC(), ProviderAccount: acct, Livemode: s.Livemode,
	}, nil
}

// GetCheckout reads a Checkout session.
func (p *Provider) GetCheckout(ctx context.Context, sessionID string) (provider.CheckoutFact, error) {
	if sessionID == "" {
		return provider.CheckoutFact{}, fmt.Errorf("%w: empty session id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.CheckoutFact{}, err
	}
	s, err := p.sc.V1CheckoutSessions.Retrieve(ctx, sessionID, &stripego.CheckoutSessionRetrieveParams{})
	if err != nil {
		return provider.CheckoutFact{}, mapErr("get checkout", err)
	}
	if err := p.checkLive("get checkout", s.Livemode); err != nil {
		return provider.CheckoutFact{}, err
	}
	amt, err := moneyOf(s.AmountTotal, s.Currency)
	if err != nil {
		return provider.CheckoutFact{}, err
	}
	f := provider.CheckoutFact{
		ID: s.ID, Amount: amt, ExpiresAt: time.Unix(s.ExpiresAt, 0).UTC(), ProviderAccount: acct,
		Livemode: s.Livemode, Metadata: provider.ParseMetadata(s.Metadata),
	}
	switch s.Status {
	case stripego.CheckoutSessionStatusComplete:
		f.Status = provider.CheckoutComplete
	case stripego.CheckoutSessionStatusExpired:
		f.Status = provider.CheckoutExpired
	default:
		f.Status = provider.CheckoutOpen
	}
	if s.PaymentIntent != nil {
		f.PaymentID = s.PaymentIntent.ID
	}
	if s.Customer != nil {
		f.CustomerID = s.Customer.ID
	}
	return f, nil
}

var paymentExpand = []string{"latest_charge", "payment_method"}

// GetPayment reads a PaymentIntent with its latest charge (charge id, receipt URL) and
// payment method. This is the authoritative fact before any credit.
func (p *Provider) GetPayment(ctx context.Context, paymentID string) (provider.PaymentFact, error) {
	if paymentID == "" {
		return provider.PaymentFact{}, fmt.Errorf("%w: empty payment id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	params := &stripego.PaymentIntentRetrieveParams{}
	params.Expand = stripego.StringSlice(paymentExpand)
	pi, err := p.sc.V1PaymentIntents.Retrieve(ctx, paymentID, params)
	if err != nil {
		return provider.PaymentFact{}, mapErr("get payment", err)
	}
	return p.paymentFact("get payment", acct, pi)
}

// ListPayments lists PaymentIntents of a customer created at or after CreatedAfter, newest
// first, one page per call (Limit default and max 100). Kind filters on metadata kind
// client-side, so a page may hold fewer than Limit facts while the cursor is not empty.
func (p *Provider) ListPayments(ctx context.Context, req provider.ListReq) ([]provider.PaymentFact, string, error) {
	if req.Customer.ID == "" {
		return nil, "", fmt.Errorf("%w: list payments needs a customer", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return nil, "", err
	}
	limit := int64(req.Limit)
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	params := &stripego.PaymentIntentListParams{Customer: stripego.String(req.Customer.ID)}
	params.Limit = stripego.Int64(limit)
	params.Single = true
	params.Expand = stripego.StringSlice([]string{"data.latest_charge", "data.payment_method"})
	if !req.CreatedAfter.IsZero() {
		params.CreatedRange = &stripego.RangeQueryParams{GreaterThanOrEqual: req.CreatedAfter.Unix()}
	}
	if req.Cursor != "" {
		params.StartingAfter = stripego.String(req.Cursor)
	}
	l := p.sc.V1PaymentIntents.List(ctx, params)
	if err := l.Err(); err != nil {
		return nil, "", mapErr("list payments", err)
	}
	data := l.Data()
	out := make([]provider.PaymentFact, 0, len(data))
	for _, pi := range data {
		f, err := p.paymentFact("list payments", acct, pi)
		if err != nil {
			return nil, "", err
		}
		if req.Kind != "" && f.Metadata.Kind != req.Kind {
			continue
		}
		out = append(out, f)
	}
	next := ""
	if l.Meta().HasMore && len(data) > 0 {
		next = data[len(data)-1].ID
	}
	return out, next, nil
}

// Refund refunds part or all of a payment. Reason is a Stripe reason (duplicate, fraudulent,
// requested_by_customer); anything else is sent as requested_by_customer.
func (p *Provider) Refund(ctx context.Context, req provider.RefundReq) (provider.RefundFact, error) {
	if err := requireKey("refund", req.IdemKey); err != nil {
		return provider.RefundFact{}, err
	}
	if req.PaymentID == "" || req.Amount.Minor <= 0 {
		return provider.RefundFact{}, fmt.Errorf("%w: refund needs a payment and a positive amount", ErrInvalidRequest)
	}
	if _, err := stripeCurrency(req.Amount.Currency); err != nil {
		return provider.RefundFact{}, err
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.RefundFact{}, err
	}
	reason := string(stripego.RefundReasonRequestedByCustomer)
	switch req.Reason {
	case string(stripego.RefundReasonDuplicate), string(stripego.RefundReasonFraudulent):
		reason = req.Reason
	}
	params := &stripego.RefundCreateParams{
		PaymentIntent: stripego.String(req.PaymentID),
		Amount:        stripego.Int64(req.Amount.Minor),
		Reason:        stripego.String(reason),
		Metadata:      req.Metadata.Map(),
	}
	params.SetIdempotencyKey(req.IdemKey)
	r, err := p.sc.V1Refunds.Create(ctx, params)
	if err != nil {
		return provider.RefundFact{}, mapErr("create refund", err)
	}
	return p.refundFact(acct, r)
}

// GetRefund reads a refund.
func (p *Provider) GetRefund(ctx context.Context, refundID string) (provider.RefundFact, error) {
	if refundID == "" {
		return provider.RefundFact{}, fmt.Errorf("%w: empty refund id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.RefundFact{}, err
	}
	r, err := p.sc.V1Refunds.Retrieve(ctx, refundID, &stripego.RefundRetrieveParams{})
	if err != nil {
		return provider.RefundFact{}, mapErr("get refund", err)
	}
	return p.refundFact(acct, r)
}

// ListRefunds lists the refunds of a payment (all pages). It resolves a charge.refunded
// event, whose object is the charge, and finds refunds made in the Dashboard.
func (p *Provider) ListRefunds(ctx context.Context, paymentID string) ([]provider.RefundFact, error) {
	if paymentID == "" {
		return nil, fmt.Errorf("%w: empty payment id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return nil, err
	}
	params := &stripego.RefundListParams{PaymentIntent: stripego.String(paymentID)}
	params.Limit = stripego.Int64(100)
	var out []provider.RefundFact
	for r, err := range p.sc.V1Refunds.List(ctx, params).All(ctx) {
		if err != nil {
			return nil, mapErr("list refunds", err)
		}
		f, err := p.refundFact(acct, r)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

// ListMethods lists the saved cards of a customer.
func (p *Provider) ListMethods(ctx context.Context, customer provider.CustomerRef) ([]provider.SavedMethod, error) {
	if customer.ID == "" {
		return nil, fmt.Errorf("%w: list methods needs a customer", ErrInvalidRequest)
	}
	params := &stripego.CustomerListPaymentMethodsParams{Customer: stripego.String(customer.ID), Type: stripego.String("card")}
	params.Limit = stripego.Int64(100)
	var out []provider.SavedMethod
	for pm, err := range p.sc.V1Customers.ListPaymentMethods(ctx, params).All(ctx) {
		if err != nil {
			return nil, mapErr("list methods", err)
		}
		if err := p.checkLive("list methods", pm.Livemode); err != nil {
			return nil, err
		}
		out = append(out, savedMethod(pm))
	}
	return out, nil
}

// GetMethod reads one payment method (brand / last4 / expiry for the owner UI).
func (p *Provider) GetMethod(ctx context.Context, paymentMethodID string) (provider.SavedMethod, error) {
	if paymentMethodID == "" {
		return provider.SavedMethod{}, fmt.Errorf("%w: empty payment method id", ErrInvalidRequest)
	}
	pm, err := p.sc.V1PaymentMethods.Retrieve(ctx, paymentMethodID, &stripego.PaymentMethodRetrieveParams{})
	if err != nil {
		return provider.SavedMethod{}, mapErr("get method", err)
	}
	if err := p.checkLive("get method", pm.Livemode); err != nil {
		return provider.SavedMethod{}, err
	}
	return savedMethod(pm), nil
}

// DetachMethod detaches a saved method from its customer. Detaching an already detached
// method succeeds.
func (p *Provider) DetachMethod(ctx context.Context, paymentMethodID string) error {
	if paymentMethodID == "" {
		return fmt.Errorf("%w: empty payment method id", ErrInvalidRequest)
	}
	_, err := p.sc.V1PaymentMethods.Detach(ctx, paymentMethodID, &stripego.PaymentMethodDetachParams{})
	if err == nil {
		return nil
	}
	mapped := mapErr("detach method", err)
	if se, ok := asStripeError(err); ok && se.HTTPStatusCode == 400 && se.Type == stripego.ErrorTypeInvalidRequest {
		pm, gerr := p.sc.V1PaymentMethods.Retrieve(ctx, paymentMethodID, &stripego.PaymentMethodRetrieveParams{})
		if gerr == nil && pm.Customer == nil {
			return nil
		}
	}
	return mapped
}

// ChargeOffSession charges a saved card without the payer (auto-topup): one PaymentIntent
// created and confirmed with off_session=true under the attempt id as idempotency key.
//
// Outcomes, all with a nil error and a PaymentFact (the core decides on Status):
//   - succeeded: PaymentSucceeded (credit after the usual checks);
//   - the bank asks for authentication (authentication_required): PaymentRequiresAction;
//     the core calls CancelPayment and mails the owner a manual checkout link;
//   - a decline: PaymentFailed with FailureCode = decline code (or error code);
//   - processing: PaymentProcessing (wait for the webhook / poll GetPayment).
//
// A lost answer is ErrUnknownOutcome: retry with the same key within 24h (Stripe replays the
// first answer, decline included), else ListPayments by customer + metadata attempt id.
func (p *Provider) ChargeOffSession(ctx context.Context, req provider.OffSessionReq) (provider.PaymentFact, error) {
	if err := requireKey("off-session charge", req.IdemKey); err != nil {
		return provider.PaymentFact{}, err
	}
	if req.Customer.ID == "" || req.PaymentMethodID == "" || req.Amount.Minor <= 0 {
		return provider.PaymentFact{}, fmt.Errorf("%w: off-session charge needs a customer, a method and a positive amount", ErrInvalidRequest)
	}
	if err := p.checkLive("off-session charge", req.Customer.Livemode); err != nil {
		return provider.PaymentFact{}, err
	}
	cur, err := stripeCurrency(req.Amount.Currency)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	md := req.Metadata
	if md.Kind == "" {
		md.Kind = provider.MetadataKindAutoTopup
	}
	params := &stripego.PaymentIntentCreateParams{
		Amount:             stripego.Int64(req.Amount.Minor),
		Currency:           stripego.String(cur),
		Customer:           stripego.String(req.Customer.ID),
		PaymentMethod:      stripego.String(req.PaymentMethodID),
		PaymentMethodTypes: stripego.StringSlice([]string{"card"}),
		Confirm:            stripego.Bool(true),
		OffSession:         stripego.Bool(true),
		Metadata:           md.Map(),
	}
	if req.Description != "" {
		params.Description = stripego.String(req.Description)
	}
	params.Expand = stripego.StringSlice(paymentExpand)
	params.SetIdempotencyKey(req.IdemKey)
	pi, err := p.sc.V1PaymentIntents.Create(ctx, params)
	if err == nil {
		return p.paymentFact("off-session charge", acct, pi)
	}
	se, ok := asStripeError(err)
	if !ok || se.Type != stripego.ErrorTypeCard || se.PaymentIntent == nil || se.PaymentIntent.ID == "" {
		return provider.PaymentFact{}, mapErr("off-session charge", err)
	}
	// A card error with the PaymentIntent it left behind: a definite outcome.
	f, ferr := p.paymentFact("off-session charge", acct, se.PaymentIntent)
	if ferr != nil {
		return provider.PaymentFact{}, ferr
	}
	f.FailureCode = failureCode(string(se.Code), string(se.DeclineCode))
	if f.Status == provider.PaymentSucceeded || f.Status == provider.PaymentProcessing || f.Status == provider.PaymentCanceled {
		return f, nil
	}
	if isAuthRequired(string(se.Code), string(se.DeclineCode)) {
		f.Status = provider.PaymentRequiresAction
	} else {
		f.Status = provider.PaymentFailed
	}
	return f, nil
}

// CancelPayment cancels a PaymentIntent that did not succeed (off-session requires_action).
// A PaymentIntent already canceled or succeeded is returned as is with a nil error: the
// caller acts on Status.
func (p *Provider) CancelPayment(ctx context.Context, paymentID string) (provider.PaymentFact, error) {
	if paymentID == "" {
		return provider.PaymentFact{}, fmt.Errorf("%w: empty payment id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	params := &stripego.PaymentIntentCancelParams{CancellationReason: stripego.String("abandoned")}
	params.Expand = stripego.StringSlice(paymentExpand)
	pi, err := p.sc.V1PaymentIntents.Cancel(ctx, paymentID, params)
	if err == nil {
		return p.paymentFact("cancel payment", acct, pi)
	}
	mapped := mapErr("cancel payment", err)
	if se, ok := asStripeError(err); ok && se.HTTPStatusCode == 400 {
		f, gerr := p.GetPayment(ctx, paymentID)
		if gerr == nil && (f.Status == provider.PaymentCanceled || f.Status == provider.PaymentSucceeded) {
			return f, nil
		}
	}
	return provider.PaymentFact{}, mapped
}

// paymentFact maps a PaymentIntent. requires_payment_method after a failed attempt is
// PaymentFailed for auto-topup intents (nobody will add a method to them) unless the bank
// asked for authentication, and PaymentRequiresAction otherwise (the payer may retry on the
// hosted page). requires_capture is never used (automatic capture) and maps to processing.
func (p *Provider) paymentFact(op, acct string, pi *stripego.PaymentIntent) (provider.PaymentFact, error) {
	if err := p.checkLive(op, pi.Livemode); err != nil {
		return provider.PaymentFact{}, err
	}
	amt, err := moneyOf(pi.Amount, pi.Currency)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	f := provider.PaymentFact{
		ID: pi.ID, ProviderAccount: acct, Livemode: pi.Livemode, Amount: amt,
		AmountReceived: money.New(pi.AmountReceived, amt.Currency),
		Created:        time.Unix(pi.Created, 0).UTC(), Metadata: provider.ParseMetadata(pi.Metadata),
	}
	if pi.Customer != nil {
		f.CustomerID = pi.Customer.ID
	}
	if pi.PaymentMethod != nil {
		f.PaymentMethodID = pi.PaymentMethod.ID
	}
	if c := pi.LatestCharge; c != nil {
		f.ChargeID = c.ID
		f.ReceiptURL = c.ReceiptURL
		if f.PaymentMethodID == "" {
			f.PaymentMethodID = c.PaymentMethod
		}
	}
	var code, decline string
	if e := pi.LastPaymentError; e != nil {
		code, decline = string(e.Code), string(e.DeclineCode)
		f.FailureCode = failureCode(code, decline)
	}
	switch pi.Status {
	case stripego.PaymentIntentStatusSucceeded:
		f.Status = provider.PaymentSucceeded
		f.FailureCode = ""
		if c := pi.LatestCharge; c != nil && c.Created > 0 {
			f.SucceededAt = time.Unix(c.Created, 0).UTC()
		} else {
			f.SucceededAt = f.Created
		}
	case stripego.PaymentIntentStatusProcessing, stripego.PaymentIntentStatusRequiresCapture:
		f.Status = provider.PaymentProcessing
	case stripego.PaymentIntentStatusCanceled:
		f.Status = provider.PaymentCanceled
	case stripego.PaymentIntentStatusRequiresPaymentMethod:
		if pi.LastPaymentError != nil && f.Metadata.Kind == provider.MetadataKindAutoTopup && !isAuthRequired(code, decline) {
			f.Status = provider.PaymentFailed
		} else {
			f.Status = provider.PaymentRequiresAction
		}
	default: // requires_action, requires_confirmation
		f.Status = provider.PaymentRequiresAction
	}
	return f, nil
}

func (p *Provider) refundFact(acct string, r *stripego.Refund) (provider.RefundFact, error) {
	amt, err := moneyOf(r.Amount, r.Currency)
	if err != nil {
		return provider.RefundFact{}, err
	}
	// Refund objects carry no livemode flag: they live in the key's mode.
	f := provider.RefundFact{
		ID: r.ID, ProviderAccount: acct, Livemode: p.live, Amount: amt, FailureReason: string(r.FailureReason),
		Created: time.Unix(r.Created, 0).UTC(), Metadata: provider.ParseMetadata(r.Metadata),
	}
	if r.PaymentIntent != nil {
		f.PaymentID = r.PaymentIntent.ID
	}
	switch r.Status {
	case stripego.RefundStatusSucceeded:
		f.Status = provider.RefundSucceeded
	case stripego.RefundStatusFailed:
		f.Status = provider.RefundFailed
	case stripego.RefundStatusCanceled:
		f.Status = provider.RefundCanceled
	case stripego.RefundStatusRequiresAction:
		f.Status = provider.RefundRequiresAction
	default:
		f.Status = provider.RefundPending
	}
	return f, nil
}

func savedMethod(pm *stripego.PaymentMethod) provider.SavedMethod {
	m := provider.SavedMethod{ID: pm.ID, Kind: provider.Method(pm.Type)}
	if pm.Customer != nil {
		m.CustomerID = pm.Customer.ID
	}
	if c := pm.Card; c != nil {
		m.Kind = provider.MethodCard
		m.Brand = string(c.Brand)
		m.Last4 = c.Last4
		m.ExpMonth = int(c.ExpMonth)
		m.ExpYear = int(c.ExpYear)
	}
	return m
}

func isAuthRequired(code, decline string) bool {
	return code == string(stripego.ErrorCodeAuthenticationRequired) ||
		decline == string(stripego.DeclineCodeAuthenticationRequired)
}

func failureCode(code, decline string) string {
	if decline != "" {
		return decline
	}
	return code
}

func stripeCurrency(c money.Currency) (string, error) {
	if _, err := money.ParseCurrency(string(c)); err != nil {
		return "", fmt.Errorf("%w: currency %q", ErrInvalidRequest, c)
	}
	return strings.ToLower(string(c)), nil
}

func moneyOf(minor int64, c stripego.Currency) (money.Money, error) {
	cur, err := money.ParseCurrency(strings.ToUpper(string(c)))
	if err != nil {
		return money.Money{}, fmt.Errorf("stripe: unsupported currency %q", c)
	}
	return money.New(minor, cur), nil
}
