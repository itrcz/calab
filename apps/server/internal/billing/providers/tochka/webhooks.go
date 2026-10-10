package tochka

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Webhook registration (an operator step, `server tochka webhook …`, never automatic on start):
// one URL per client_id of the JWT key. Creating or editing it makes the bank send one test
// webhook per type to the URL and keep the change only if every one is answered 200, so the
// server behind the URL must run with BILLING_TOCHKA_ENABLED first.

// Webhook is the registered webhook of the client id.
type Webhook struct {
	URL   string   `json:"url"`
	Types []string `json:"webhooksList"`
}

type webhookAnswer struct {
	Data Webhook `json:"Data"`
}

func (p *Provider) webhookPath() (string, error) {
	if p.clientID == "" {
		return "", fmt.Errorf("%w: no client id (TOCHKA_CLIENT_ID or the token's iss claim)", ErrInvalidRequest)
	}
	return "/webhook/v1.0/" + url.PathEscape(p.clientID), nil
}

// GetWebhook returns the registered webhook; provider.ErrNotFound when there is none.
func (p *Provider) GetWebhook(ctx context.Context) (Webhook, error) {
	path, err := p.webhookPath()
	if err != nil {
		return Webhook{}, err
	}
	var a webhookAnswer
	if err := p.do(ctx, "get webhook", "GET", path, nil, &a); err != nil {
		return Webhook{}, err
	}
	return a.Data, nil
}

// SetWebhook registers rawURL for acquiringInternetPayment: creates the webhook, or edits the
// existing one. The URL must be https on port 443 (the bank's rule).
func (p *Provider) SetWebhook(ctx context.Context, rawURL string) (Webhook, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || (u.Port() != "" && u.Port() != "443") {
		return Webhook{}, fmt.Errorf("%w: webhook URL must be https on port 443", ErrInvalidRequest)
	}
	path, err := p.webhookPath()
	if err != nil {
		return Webhook{}, err
	}
	body := Webhook{URL: rawURL, Types: []string{WebhookTypeAcquiring}}
	method := "PUT" // create
	if _, err := p.GetWebhook(ctx); err == nil {
		method = "POST" // edit
	} else if !errors.Is(err, provider.ErrNotFound) {
		return Webhook{}, err
	}
	var a webhookAnswer
	if err := p.do(ctx, "set webhook", method, path, body, &a); err != nil {
		return Webhook{}, err
	}
	return a.Data, nil
}

// DeleteWebhook removes the registered webhook (none registered is not an error).
func (p *Provider) DeleteWebhook(ctx context.Context) error {
	path, err := p.webhookPath()
	if err != nil {
		return err
	}
	err = p.do(ctx, "delete webhook", "DELETE", path, nil, nil)
	if errors.Is(err, provider.ErrNotFound) {
		return nil
	}
	return err
}

// TestWebhook asks the bank to send a test acquiringInternetPayment webhook to the registered URL.
func (p *Provider) TestWebhook(ctx context.Context) error {
	path, err := p.webhookPath()
	if err != nil {
		return err
	}
	return p.do(ctx, "test webhook", "POST", path+"/test_send", map[string]string{"webhookType": WebhookTypeAcquiring}, nil)
}

// PublishedKeyMatches fetches the key the bank publishes (PublicKeyURL) and reports whether the
// pinned key set contains it (`server tochka key`: run it periodically or when webhooks start
// failing with a bad signature; a rotation is an env change, never an automatic fetch).
func (p *Provider) PublishedKeyMatches(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", PublicKeyURL, nil)
	if err != nil {
		return false, err
	}
	resp, err := p.hc.Do(req)
	if err != nil {
		return false, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("tochka key: %s answered %d", PublicKeyURL, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return false, err
	}
	keys, err := ParseKeys(strings.TrimSpace(string(raw)))
	if err != nil {
		return false, err
	}
	for _, k := range keys {
		for _, pinned := range p.webhookKey {
			if pk, ok := pinned.(*rsa.PublicKey); ok && pk.Equal(k) {
				return true, nil
			}
		}
	}
	return false, nil
}
