package tochkapay

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Operation statuses of the bank (ResponseStatusDTO.value) of payments and refunds.
const (
	statusCompleted = "COMPLETED"
	statusDeclined  = "DECLINED"
	statusWaiting   = "WAITING"
)

// uidRe is the bank's pattern of paymentUid / refundUid / merchantQrcId.
var uidRe = regexp.MustCompile(`^[0-9a-zA-Z-]{1,64}$`)

type amountDTO struct {
	Currency string `json:"currency"`
	Amount   string `json:"amount"`
}

type statusDTO struct {
	Value           string `json:"value"`
	ChangedDateTime string `json:"changedDateTime"`
	ReasonSource    string `json:"reasonSource,omitempty"`
	ReasonCode      string `json:"reasonCode,omitempty"`
}

type methodResultDTO struct {
	Type              string `json:"type"`
	QrcID             string `json:"qrcId"`
	NspkTransactionID string `json:"nspkTransactionId"`
}

type paymentDTO struct {
	PaymentUID      string          `json:"paymentUid"`
	CreatedDateTime string          `json:"createdDateTime"`
	Amount          amountDTO       `json:"amount"`
	RefundedAmount  *amountDTO      `json:"refundedAmount"`
	PaymentMethod   methodResultDTO `json:"paymentMethod"`
	Status          statusDTO       `json:"status"`
	Customer        *customerDTO    `json:"customer"`
	IsTest          *bool           `json:"isTest"`
	Metadata        string          `json:"metadata"`
}

type sbpTokenMethod struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type createPaymentReq struct {
	PaymentUID    string         `json:"paymentUid"`
	Amount        amountDTO      `json:"amount"`
	PaymentMethod sbpTokenMethod `json:"paymentMethod"`
	Customer      *customerDTO   `json:"customer,omitempty"`
	CallbackURL   string         `json:"callbackUrl,omitempty"`
	Comment       string         `json:"comment,omitempty"`
	Metadata      string         `json:"metadata,omitempty"`
}

type refundDTO struct {
	RefundUID       string    `json:"refundUid"`
	CreatedDateTime string    `json:"createdDateTime"`
	Amount          amountDTO `json:"amount"`
	Status          statusDTO `json:"status"`
	Metadata        string    `json:"metadata"`
}

type createRefundReq struct {
	RefundUID   string     `json:"refundUid"`
	Amount      *amountDTO `json:"amount,omitempty"`
	CallbackURL string     `json:"callbackUrl,omitempty"`
	Comment     string     `json:"comment,omitempty"`
	Metadata    string     `json:"metadata,omitempty"`
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

func rub(a amountDTO, op string) (money.Money, error) {
	if a.Currency != string(money.RUB) {
		return money.Money{}, fmt.Errorf("tochkapay %s: %w: currency %q", op, provider.ErrUnknownOutcome, a.Currency)
	}
	m, err := money.ParseDecimal(a.Amount, money.RUB)
	if err != nil {
		return money.Money{}, fmt.Errorf("tochkapay %s: %w: amount: %w", op, provider.ErrUnknownOutcome, err)
	}
	return m, nil
}

// paymentFact maps PaymentResponseDTO. Only COMPLETED credits (AmountReceived = amount);
// WAITING is processing, DECLINED is failed with the bank's reason code.
func (p *Provider) paymentFact(d paymentDTO) (provider.PaymentFact, error) {
	if err := p.checkMode("payment", d.IsTest); err != nil {
		return provider.PaymentFact{}, err
	}
	amt, err := rub(d.Amount, "payment")
	if err != nil {
		return provider.PaymentFact{}, err
	}
	f := provider.PaymentFact{
		ID: d.PaymentUID, ProviderAccount: p.site, Livemode: p.live, Amount: amt, AmountReceived: money.Zero(money.RUB),
		ChargeID: d.PaymentMethod.NspkTransactionID, Created: parseTime(d.CreatedDateTime), Metadata: parseMetadata(d.Metadata),
	}
	if d.Customer != nil {
		f.CustomerID = d.Customer.Account
	}
	switch d.Status.Value {
	case statusCompleted:
		f.Status, f.AmountReceived, f.SucceededAt = provider.PaymentSucceeded, amt, parseTime(d.Status.ChangedDateTime)
	case statusDeclined:
		f.Status, f.FailureCode = provider.PaymentFailed, d.Status.ReasonCode
	default: // WAITING, or a status this adapter does not know: never credited
		f.Status = provider.PaymentProcessing
	}
	return f, nil
}

// GetPayment reads a payment by its paymentUid (our attempt id).
func (p *Provider) GetPayment(ctx context.Context, paymentID string) (provider.PaymentFact, error) {
	if !uidRe.MatchString(paymentID) {
		return provider.PaymentFact{}, fmt.Errorf("%w: payment id %q", provider.ErrNotFound, clip(paymentID, 70))
	}
	var out wrapped[paymentDTO]
	if err := p.do(ctx, "get payment", http.MethodGet, p.sitePath("payments", paymentID), nil, false, &out); err != nil {
		return provider.PaymentFact{}, err
	}
	if out.Data.PaymentUID != paymentID {
		return provider.PaymentFact{}, fmt.Errorf("tochkapay get payment: answer for another payment: %w", ErrForeign)
	}
	return p.paymentFact(out.Data)
}

// ChargeOffSession charges an SBP binding (paymentMethod SBP_TOKEN, no payer action, no 3DS).
// paymentUid = IdemKey (the auto-topup attempt id). The bank's payment is read first: if it
// exists already (an earlier send whose answer was lost) it is returned and nothing is sent.
// A send that may have reached the bank is provider.ErrUnknownOutcome; the caller resolves it
// by GetPayment(IdemKey), never by sending again. A definite refusal of the create is re-read
// once (a concurrent create of the same paymentUid) and else returned as *APIError.
func (p *Provider) ChargeOffSession(ctx context.Context, req provider.OffSessionReq) (provider.PaymentFact, error) {
	if !uidRe.MatchString(req.IdemKey) {
		return provider.PaymentFact{}, fmt.Errorf("%w: idempotency key must match the bank's paymentUid pattern", ErrInvalidRequest)
	}
	if req.Amount.Currency != money.RUB || req.Amount.Minor <= 0 {
		return provider.PaymentFact{}, fmt.Errorf("%w: SBP charge must be a positive RUB amount", ErrInvalidRequest)
	}
	if strings.TrimSpace(req.PaymentMethodID) == "" || req.Customer.ID == "" {
		return provider.PaymentFact{}, fmt.Errorf("%w: SBP charge without a binding token or customer", ErrInvalidRequest)
	}
	if (req.Customer.ProviderAccount != "" && req.Customer.ProviderAccount != p.site) || req.Customer.Livemode != p.live {
		return provider.PaymentFact{}, fmt.Errorf("tochkapay charge: customer of another site or mode: %w", ErrForeign)
	}
	same := func(f provider.PaymentFact) error {
		if f.CustomerID != req.Customer.ID || f.Amount != req.Amount {
			return fmt.Errorf("%w: paymentUid %s exists for another customer or amount", ErrForeign, req.IdemKey)
		}
		return nil
	}
	f, err := p.GetPayment(ctx, req.IdemKey)
	switch {
	case err == nil:
		return f, same(f)
	case !errors.Is(err, provider.ErrNotFound):
		return provider.PaymentFact{}, err // unknown or a definite site error: nothing sent
	}
	comment := clip(strings.TrimSpace(req.Description), 255)
	if comment == "" {
		comment = DefaultChargePurpose
	}
	if s := scenario(map[string]string{"payWithToken": p.scenarios.PayWithToken}); s != "" {
		comment = s
	}
	body := wrapped[createPaymentReq]{Data: createPaymentReq{
		PaymentUID: req.IdemKey, Amount: amountDTO{Currency: string(money.RUB), Amount: req.Amount.Decimal()},
		PaymentMethod: sbpTokenMethod{Type: "SBP_TOKEN", Token: req.PaymentMethodID},
		Customer:      &customerDTO{Account: req.Customer.ID}, CallbackURL: p.callback, Comment: comment,
		Metadata: metadataJSON(req.Metadata),
	}}
	var out wrapped[paymentDTO]
	err = p.do(ctx, "charge", http.MethodPost, p.sitePath("payments"), body, true, &out)
	var ae *APIError
	if errors.As(err, &ae) && !errors.Is(err, provider.ErrUnknownOutcome) && !siteCodes[ae.Code] && ae.Status != http.StatusUnauthorized && ae.Status != http.StatusForbidden {
		if f, rerr := p.GetPayment(ctx, req.IdemKey); rerr == nil {
			return f, same(f)
		}
	}
	if err != nil {
		return provider.PaymentFact{}, err
	}
	if out.Data.PaymentUID != req.IdemKey {
		return provider.PaymentFact{}, fmt.Errorf("tochkapay charge: %w: answer for another paymentUid", provider.ErrUnknownOutcome)
	}
	f, err = p.paymentFact(out.Data)
	if err != nil {
		return provider.PaymentFact{}, err
	}
	return f, same(f)
}

// ListMethods is not supported: the bank keeps no list of a payer's bindings; the core stores a binding's token
// when GetBinding reports it accepted (billing_payment_methods).
func (p *Provider) ListMethods(context.Context, provider.CustomerRef) ([]provider.SavedMethod, error) {
	return nil, fmt.Errorf("tochkapay: list bindings: %w", provider.ErrNotSupported)
}

// CancelPayment is not supported: an SBP token payment never waits for the payer (no 3DS, no requires_action).
func (p *Provider) CancelPayment(context.Context, string) (provider.PaymentFact, error) {
	return provider.PaymentFact{}, fmt.Errorf("tochkapay: cancel payment: %w", provider.ErrNotSupported)
}

// DetachMethod calls nothing: the gateway has no call to revoke a binding (the payer revokes it in their bank
// app). Detaching is the core forgetting the token, which is never sent again; nothing to call.
func (p *Provider) DetachMethod(context.Context, string) error { return nil }

// refundUID is the bank's refundUid of a refund request: our refund id (metadata), else the
// idempotency key without its "refund:" prefix.
func refundUID(req provider.RefundReq) string {
	if req.Metadata.RefundID != uuid.Nil {
		return req.Metadata.RefundID.String()
	}
	return strings.TrimPrefix(req.IdemKey, "refund:")
}

func (p *Provider) refundFact(paymentID string, d refundDTO) (provider.RefundFact, error) {
	amt, err := rub(d.Amount, "refund")
	if err != nil {
		return provider.RefundFact{}, err
	}
	f := provider.RefundFact{
		ID: paymentID + "/" + d.RefundUID, PaymentID: paymentID, ProviderAccount: p.site, Livemode: p.live,
		Amount: amt, Created: parseTime(d.CreatedDateTime), Metadata: parseMetadata(d.Metadata),
	}
	switch d.Status.Value {
	case statusCompleted:
		f.Status = provider.RefundSucceeded
	case statusDeclined:
		f.Status, f.FailureReason = provider.RefundFailed, d.Status.ReasonCode
	default:
		f.Status = provider.RefundPending
	}
	return f, nil
}

// Refund returns part or all of a payment (signed). refundUid is our refund id, kept unique by
// the bank: a refund the bank already has is read and returned, nothing is sent again. A send
// that may have reached the bank is provider.ErrUnknownOutcome (read GetRefund later).
func (p *Provider) Refund(ctx context.Context, req provider.RefundReq) (provider.RefundFact, error) {
	ruid := refundUID(req)
	if !uidRe.MatchString(req.PaymentID) || !uidRe.MatchString(ruid) {
		return provider.RefundFact{}, fmt.Errorf("%w: refund of payment %q with refund id %q", ErrInvalidRequest, clip(req.PaymentID, 70), clip(ruid, 70))
	}
	if req.Amount.Currency != money.RUB || req.Amount.Minor <= 0 {
		return provider.RefundFact{}, fmt.Errorf("%w: refund must be a positive RUB amount", ErrInvalidRequest)
	}
	id := req.PaymentID + "/" + ruid
	if f, err := p.GetRefund(ctx, id); err == nil {
		if f.Amount != req.Amount {
			return provider.RefundFact{}, fmt.Errorf("%w: refundUid %s exists with another amount", ErrForeign, ruid)
		}
		return f, nil
	} else if !errors.Is(err, provider.ErrNotFound) {
		return provider.RefundFact{}, err
	}
	comment := clip(strings.TrimSpace(req.Reason), 255)
	if s := scenario(map[string]string{"refund": p.scenarios.Refund}); s != "" {
		comment = s
	}
	body := wrapped[createRefundReq]{Data: createRefundReq{
		RefundUID: ruid, Amount: &amountDTO{Currency: string(money.RUB), Amount: req.Amount.Decimal()},
		CallbackURL: p.callback, Comment: comment, Metadata: metadataJSON(req.Metadata),
	}}
	var out wrapped[refundDTO]
	if err := p.do(ctx, "refund", http.MethodPost, p.sitePath("payments", req.PaymentID, "refunds"), body, true, &out); err != nil {
		return provider.RefundFact{}, err
	}
	if out.Data.RefundUID != ruid {
		return provider.RefundFact{}, fmt.Errorf("tochkapay refund: %w: answer for another refundUid", provider.ErrUnknownOutcome)
	}
	return p.refundFact(req.PaymentID, out.Data)
}

// GetRefund reads a refund by "{paymentUid}/{refundUid}".
func (p *Provider) GetRefund(ctx context.Context, refundID string) (provider.RefundFact, error) {
	pid, rid, ok := strings.Cut(refundID, "/")
	if !ok || !uidRe.MatchString(pid) || !uidRe.MatchString(rid) {
		return provider.RefundFact{}, fmt.Errorf("%w: refund id %q", provider.ErrNotFound, clip(refundID, 140))
	}
	var out wrapped[refundDTO]
	if err := p.do(ctx, "get refund", http.MethodGet, p.sitePath("payments", pid, "refunds", rid), nil, false, &out); err != nil {
		return provider.RefundFact{}, err
	}
	if out.Data.RefundUID != rid {
		return provider.RefundFact{}, fmt.Errorf("tochkapay get refund: answer for another refund: %w", ErrForeign)
	}
	return p.refundFact(pid, out.Data)
}

// ListRefunds lists the refunds of a payment (provider.RefundLister).
func (p *Provider) ListRefunds(ctx context.Context, paymentID string) ([]provider.RefundFact, error) {
	if !uidRe.MatchString(paymentID) {
		return nil, fmt.Errorf("%w: payment id %q", provider.ErrNotFound, clip(paymentID, 70))
	}
	var out wrapped[[]refundDTO]
	if err := p.do(ctx, "list refunds", http.MethodGet, p.sitePath("payments", paymentID, "refunds"), nil, false, &out); err != nil {
		return nil, err
	}
	facts := make([]provider.RefundFact, 0, len(out.Data))
	for _, d := range out.Data {
		f, err := p.refundFact(paymentID, d)
		if err != nil {
			return nil, err
		}
		facts = append(facts, f)
	}
	return facts, nil
}
