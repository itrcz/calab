package tochka

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Startup check of the configuration (2026-10-10: TOCHKA_CUSTOMER_CODE named the owner's
// personal account instead of the company; payment links failed, the billing_customers row kept
// the wrong code). Read-only: the bank's customers visible to the token and the retail points
// of our customer code. Nothing is created or changed.

// ErrMisconfigured means the bank says the configured customer code / merchant id cannot take
// payments with this token. The message names what to fix; it carries no token.
var ErrMisconfigured = errors.New("tochka: configuration does not match the bank")

// Retailer is one internet-acquiring retail point of a customer (GET /acquiring/v1.0/retailers).
type Retailer struct {
	MerchantID   string   `json:"merchantId"`
	TerminalID   string   `json:"terminalId"`
	Name         string   `json:"name"`
	Status       string   `json:"status"` // REG: registered
	IsActive     bool     `json:"isActive"`
	PaymentModes []string `json:"paymentModes"`
}

// Customer is one client of the bank the token sees (GET /open-banking/v1.0/customers).
type Customer struct {
	CustomerCode string `json:"customerCode"`
	CustomerType string `json:"customerType"` // Business | Personal
	ShortName    string `json:"shortName"`
}

// Verification is what the bank answered.
type Verification struct {
	CustomerCode, MerchantID string
	Retailer                 Retailer   // ours (zero if not found)
	Customers                []Customer // nil if the token cannot read them (only a hint)
	// Warnings: the configuration works but is suspicious (inactive point, personal account).
	Warnings []string
}

// Customers lists the bank's clients the token sees.
func (p *Provider) Customers(ctx context.Context) ([]Customer, error) {
	var a struct {
		Data struct {
			Customer []Customer `json:"Customer"`
		} `json:"Data"`
	}
	if err := p.do(ctx, "list customers", http.MethodGet, "/open-banking/v1.0/customers", nil, &a); err != nil {
		return nil, err
	}
	return a.Data.Customer, nil
}

// Retailers lists the retail points of a customer. A token whose consent does not cover the
// customer's acquiring gets 403 «Forbidden by consent» (*APIError).
func (p *Provider) Retailers(ctx context.Context, customerCode string) ([]Retailer, error) {
	var a struct {
		Data struct {
			Retailer []Retailer `json:"Retailer"`
		} `json:"Data"`
	}
	q := url.Values{"customerCode": {customerCode}}
	if err := p.do(ctx, "list retailers", http.MethodGet, "/acquiring/v1.0/retailers?"+q.Encode(), nil, &a); err != nil {
		return nil, err
	}
	return a.Data.Retailer, nil
}

// VerifyConfig checks that the token's consent covers acquiring for TOCHKA_CUSTOMER_CODE and
// that TOCHKA_MERCHANT_ID is one of its retail points. Errors: ErrMisconfigured (a definite
// answer of the bank: fix the env), provider.ErrUnknownOutcome (the bank did not answer: try
// later), other errors as the client returns them.
func (p *Provider) VerifyConfig(ctx context.Context) (Verification, error) {
	v := Verification{CustomerCode: p.customer, MerchantID: p.merchant}
	custs, cerr := p.Customers(ctx)
	if cerr == nil {
		v.Customers = custs
	}
	hint := func() string {
		var biz []string
		for _, c := range v.Customers {
			if c.CustomerType == "Business" {
				biz = append(biz, c.CustomerCode+" ("+c.ShortName+")")
			}
		}
		if len(biz) == 0 {
			return ""
		}
		return "; business customers of the token: " + strings.Join(biz, ", ")
	}
	rs, err := p.Retailers(ctx, p.customer)
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) && !errors.Is(err, provider.ErrUnknownOutcome) && (ae.Status == http.StatusForbidden || ae.Status == http.StatusUnauthorized) {
			return v, fmt.Errorf("%w: the token's consent does not cover acquiring for TOCHKA_CUSTOMER_CODE %s (%d %s)%s",
				ErrMisconfigured, p.customer, ae.Status, ae.Message, hint())
		}
		if errors.Is(err, provider.ErrNotFound) {
			return v, fmt.Errorf("%w: no acquiring for TOCHKA_CUSTOMER_CODE %s%s", ErrMisconfigured, p.customer, hint())
		}
		return v, err
	}
	i := slices.IndexFunc(rs, func(r Retailer) bool { return r.MerchantID == p.merchant })
	if i < 0 {
		ids := make([]string, 0, len(rs))
		for _, r := range rs {
			ids = append(ids, r.MerchantID)
		}
		return v, fmt.Errorf("%w: TOCHKA_MERCHANT_ID %s is not a retail point of customer %s (its points: %s)",
			ErrMisconfigured, p.merchant, p.customer, strings.Join(ids, ", "))
	}
	v.Retailer = rs[i]
	if !v.Retailer.IsActive || v.Retailer.Status != "REG" {
		v.Warnings = append(v.Warnings, fmt.Sprintf("retail point %s is not active (status %s, active %t)", p.merchant, v.Retailer.Status, v.Retailer.IsActive))
	}
	for _, c := range v.Customers {
		if c.CustomerCode == p.customer && c.CustomerType != "" && c.CustomerType != "Business" {
			v.Warnings = append(v.Warnings, fmt.Sprintf("customer %s is a %s account%s", p.customer, c.CustomerType, hint()))
		}
	}
	return v, nil
}

// LogConfig logs the customer code and merchant id in use and the result of VerifyConfig: INFO
// when the bank confirms them, ERROR when it contradicts them (the server keeps running: the
// operator fixes the env; checkouts would fail), WARN while the bank does not answer (retried
// with backoff, then given up). Never crashes, never logs the token.
func (p *Provider) LogConfig(ctx context.Context, backoff ...time.Duration) {
	if backoff == nil {
		backoff = []time.Duration{10 * time.Second, 30 * time.Second, time.Minute, 5 * time.Minute}
	}
	slog.InfoContext(ctx, "tochka: acquiring config", "customer_code", p.customer, "merchant_id", p.merchant, "livemode", p.live, "api", p.base)
	for attempt := 0; ; attempt++ {
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		v, err := p.VerifyConfig(cctx)
		cancel()
		switch {
		case err == nil:
			slog.InfoContext(ctx, "tochka: acquiring config verified", "customer_code", p.customer, "merchant_id", p.merchant,
				"retailer", v.Retailer.Name, "terminal_id", v.Retailer.TerminalID, "payment_modes", v.Retailer.PaymentModes)
			for _, w := range v.Warnings {
				slog.WarnContext(ctx, "tochka: acquiring config: "+w, "customer_code", p.customer, "merchant_id", p.merchant)
			}
			return
		case errors.Is(err, ErrMisconfigured):
			slog.ErrorContext(ctx, "tochka: acquiring config does not match the bank: payments will fail until TOCHKA_CUSTOMER_CODE / TOCHKA_MERCHANT_ID are fixed",
				"customer_code", p.customer, "merchant_id", p.merchant, "err", err)
			return
		case ctx.Err() != nil:
			return
		case !errors.Is(err, provider.ErrUnknownOutcome) || attempt >= len(backoff):
			slog.WarnContext(ctx, "tochka: acquiring config not verified", "customer_code", p.customer, "merchant_id", p.merchant, "err", err)
			return
		}
		slog.WarnContext(ctx, "tochka: acquiring config not verified yet", "customer_code", p.customer, "merchant_id", p.merchant,
			"err", err, "retry_in", backoff[attempt].String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff[attempt]):
		}
	}
}
