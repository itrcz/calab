package tochkapay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Binding statuses of the bank (SbpTokenizationResultResponseDto.status).
const (
	tokenAccepted = "ACCEPTED"
	tokenRejected = "REJECTED"
)

type tokenParams struct {
	TokenizationPurpose string          `json:"tokenizationPurpose"`
	ServiceDetails      *serviceDetails `json:"tokenizationServiceDetails,omitempty"`
}

type serviceDetails struct {
	ServiceName string `json:"serviceName"`
	ServiceID   string `json:"serviceId"`
}

type customerDTO struct {
	Account string `json:"account,omitempty"`
	Email   string `json:"email,omitempty"`
}

type imageParams struct {
	MediaType string `json:"mediaType"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
}

// createQRReq is QRCodeToken of «Создание УПК» (qrcType TOKEN: binding without a payment).
type createQRReq struct {
	QrcType       string       `json:"qrcType"`
	MerchantQrcID string       `json:"merchantQrcId"`
	PaymentToken  tokenParams  `json:"paymentToken"`
	Customer      *customerDTO `json:"customer,omitempty"`
	TTL           int          `json:"ttl,omitempty"` // minutes
	RedirectURL   string       `json:"redirectUrl,omitempty"`
	CallbackURL   string       `json:"callbackUrl,omitempty"`
	Metadata      string       `json:"metadata,omitempty"`
	ImageParams   *imageParams `json:"imageParams,omitempty"`
}

type qrDTO struct {
	QrcID         string `json:"qrcId"`
	MerchantQrcID string `json:"merchantQrcId"`
	Payload       string `json:"payload"`
	Image         *struct {
		MediaType string `json:"mediaType"`
		Content   string `json:"content"`
	} `json:"image"`
	IsTest *bool `json:"isTest"`
}

type tokenizationDTO struct {
	Status        string `json:"status"`
	QrcID         string `json:"qrcId"`
	MerchantQrcID string `json:"merchantQrcId"`
	MemberID      string `json:"memberId"`
	Token         string `json:"token"`
	Metadata      string `json:"metadata"`
}

type wrapped[T any] struct {
	Data T `json:"Data"`
}

// checkMode compares the bank's isTest with the configured mode. Payments and QR codes always
// carry isTest (API 1.0); an answer without it is refused in both modes (fail closed): on a test
// config it may be a production object, on a live config a test object must never be stamped
// livemode. Objects without the field (tokenization result, refunds) are checked through their
// QR code / payment instead.
func (p *Provider) checkMode(op string, isTest *bool) error {
	switch {
	case isTest == nil:
		return fmt.Errorf("tochkapay %s: %w: answer without isTest", op, provider.ErrLivemodeForbidden)
	case !*isTest && !p.live:
		return fmt.Errorf("tochkapay %s: live object while TOCHKA_PAY_LIVE=false: %w", op, provider.ErrLivemodeForbidden)
	case *isTest && p.live:
		return fmt.Errorf("tochkapay %s: %w", op, ErrModeMismatch)
	}
	return nil
}

func metadataJSON(m provider.Metadata) string {
	kv := m.Map()
	if len(kv) == 0 {
		return ""
	}
	b, _ := json.Marshal(kv)
	return string(b)
}

func parseMetadata(s string) provider.Metadata {
	var kv map[string]string
	if s == "" || json.Unmarshal([]byte(s), &kv) != nil {
		return provider.Metadata{}
	}
	return provider.ParseMetadata(kv)
}

// clip cuts s to n runes (the bank counts characters).
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// scenario renders a test scenario field ({"createQrc":"…"}); "" when unset.
func scenario(kv map[string]string) string {
	for k, v := range kv {
		if v == "" {
			delete(kv, k)
		}
	}
	if len(kv) == 0 {
		return ""
	}
	b, _ := json.Marshal(kv)
	return string(b)
}

// CreateBinding registers a TOKEN code: a link the payer opens in their bank app to bind their
// account (no payment). Our binding id is the merchant QR id; the account id travels as
// customer.account, the service id and the metadata. A lost answer is harmless — nothing was
// charged; the caller makes a new binding.
func (p *Provider) CreateBinding(ctx context.Context, req provider.BindingReq) (provider.Binding, error) {
	if req.ID == uuid.Nil || req.Metadata.AccountID == uuid.Nil {
		return provider.Binding{}, fmt.Errorf("%w: binding without an id or account", ErrInvalidRequest)
	}
	ttl := time.Until(req.ExpiresAt)
	if ttl < time.Minute || ttl > MaxBindingTTL {
		return provider.Binding{}, fmt.Errorf("%w: binding expiry must be 1 min .. %s ahead", ErrInvalidRequest, MaxBindingTTL)
	}
	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = DefaultPurpose
	}
	purpose = clip(purpose, 140)
	if s := scenario(map[string]string{"createQrc": p.scenarios.CreateQrc}); s != "" {
		purpose = s // test site: the scenario rides in the tokenization purpose
	}
	name := strings.TrimSpace(req.ServiceName)
	if name == "" {
		name = DefaultServiceName
	}
	body := wrapped[createQRReq]{Data: createQRReq{
		QrcType: "TOKEN", MerchantQrcID: req.ID.String(),
		PaymentToken: tokenParams{TokenizationPurpose: purpose, ServiceDetails: &serviceDetails{
			ServiceName: clip(name, 70), ServiceID: strings.ReplaceAll(req.Metadata.AccountID.String(), "-", ""),
		}},
		Customer: &customerDTO{Account: req.Metadata.AccountID.String()},
		TTL:      int(ttl.Round(time.Minute) / time.Minute), RedirectURL: req.ReturnURL, CallbackURL: p.callback,
		Metadata:    metadataJSON(req.Metadata),
		ImageParams: &imageParams{MediaType: "image/png", Width: 300, Height: 300},
	}}
	var out wrapped[qrDTO]
	if err := p.do(ctx, "create binding", http.MethodPost, p.sitePath("sbp", "qrc"), body, false, &out); err != nil {
		return provider.Binding{}, err
	}
	if err := p.checkMode("create binding", out.Data.IsTest); err != nil {
		return provider.Binding{}, err
	}
	if out.Data.QrcID == "" || !strings.HasPrefix(out.Data.Payload, "https://") {
		return provider.Binding{}, fmt.Errorf("tochkapay create binding: %w: answer without a QR id or link", provider.ErrUnknownOutcome)
	}
	if out.Data.MerchantQrcID != "" && out.Data.MerchantQrcID != req.ID.String() {
		return provider.Binding{}, fmt.Errorf("tochkapay create binding: answer for another merchant QR id: %w", ErrForeign)
	}
	b := provider.Binding{ID: out.Data.QrcID, URL: out.Data.Payload, ExpiresAt: req.ExpiresAt, Livemode: p.live}
	if img := out.Data.Image; img != nil && img.MediaType == "image/png" {
		if png, err := base64.StdEncoding.DecodeString(img.Content); err == nil {
			b.ImagePNG = png
		}
	}
	return b, nil
}

// GetBinding reads the binding result by our binding id. Before the payer's bank decides the
// bank has no result: the code itself is then read to tell «pending» from «no such binding»
// (provider.ErrNotFound). ACCEPTED carries the token (Method.ID) and the payer's bank (Brand).
func (p *Provider) GetBinding(ctx context.Context, bindingID uuid.UUID) (provider.BindingFact, error) {
	id := bindingID.String()
	var out wrapped[tokenizationDTO]
	err := p.do(ctx, "get binding", http.MethodGet, p.sitePath("sbp", "qrc", id, "tokenization", "result")+"?qrcIdType=MERCHANT", nil, false, &out)
	if errors.Is(err, provider.ErrNotFound) {
		var qr wrapped[qrDTO]
		if err := p.do(ctx, "get binding code", http.MethodGet, p.sitePath("sbp", "qrc", id)+"?qrcIdType=MERCHANT", nil, false, &qr); err != nil {
			return provider.BindingFact{}, err
		}
		if err := p.checkMode("get binding code", qr.Data.IsTest); err != nil {
			return provider.BindingFact{}, err
		}
		return provider.BindingFact{ID: id, Status: provider.BindingPending, Livemode: p.live}, nil
	}
	if err != nil {
		return provider.BindingFact{}, err
	}
	d := out.Data
	if d.MerchantQrcID != "" && d.MerchantQrcID != id {
		return provider.BindingFact{}, fmt.Errorf("tochkapay get binding: result of another merchant QR id: %w", ErrForeign)
	}
	fact := provider.BindingFact{ID: id, Livemode: p.live, Metadata: parseMetadata(d.Metadata)}
	switch d.Status {
	case tokenAccepted:
		if d.Token == "" {
			return provider.BindingFact{}, fmt.Errorf("tochkapay get binding: %w: ACCEPTED without a token", provider.ErrUnknownOutcome)
		}
		// The result carries no isTest: the token is released only after its code proves the
		// mode, so a production token never reaches a test config (and the reverse).
		var qr wrapped[qrDTO]
		if err := p.do(ctx, "get binding code", http.MethodGet, p.sitePath("sbp", "qrc", id)+"?qrcIdType=MERCHANT", nil, false, &qr); err != nil {
			return provider.BindingFact{}, err
		}
		if err := p.checkMode("get binding code", qr.Data.IsTest); err != nil {
			return provider.BindingFact{}, err
		}
		fact.Status = provider.BindingAccepted
		fact.Method = provider.SavedMethod{ID: d.Token, CustomerID: fact.Metadata.AccountID.String(), Kind: provider.MethodSBP, Brand: d.MemberID}
		if fact.Metadata.AccountID == uuid.Nil {
			fact.Method.CustomerID = ""
		}
	case tokenRejected:
		fact.Status = provider.BindingRejected
	default:
		fact.Status = provider.BindingPending
	}
	return fact, nil
}
