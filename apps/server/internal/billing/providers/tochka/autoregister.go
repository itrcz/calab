package tochka

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Automatic webhook registration (TOCHKA_WEBHOOK_URL). The CLI (`server tochka webhook …`)
// stays; this job does the same once the server is serving, so a deploy needs no manual step.

// WebhookAPI is the part of the adapter the registrar uses.
type WebhookAPI interface {
	GetWebhook(ctx context.Context) (Webhook, error)
	SetWebhook(ctx context.Context, rawURL string) (Webhook, error)
}

// Registrar keeps the bank's one webhook URL equal to URL.
type Registrar struct {
	API WebhookAPI
	URL string
	// Lock takes the cluster-wide right to run one attempt; the returned func releases it.
	// ok=false: another replica is on it. Nil = always ok (single process).
	Lock func(ctx context.Context) (release func(), ok bool)
	// Sleep waits d or until ctx is done (false). Nil = a timer.
	Sleep func(ctx context.Context, d time.Duration) bool
	// Backoff after consecutive failures (the last one repeats); Recheck after a success.
	Backoff []time.Duration
	Recheck time.Duration
	// Busy is the wait when another replica holds the lock.
	Busy time.Duration
}

// NewRegistrar uses the production schedule: 10 s, 30 s, 1 min, 5 min, then every 30 min while
// failing; a re-check every 6 h (someone may have changed it in the bank UI).
func NewRegistrar(api WebhookAPI, url string) *Registrar {
	return &Registrar{
		API: api, URL: url, Recheck: 6 * time.Hour, Busy: 30 * time.Second,
		Backoff: []time.Duration{10 * time.Second, 30 * time.Second, time.Minute, 5 * time.Minute, 30 * time.Minute},
	}
}

// Run loops until ctx is done.
func (r *Registrar) Run(ctx context.Context) {
	fails := 0
	for ctx.Err() == nil {
		wait := r.Recheck
		release, ok := func() (func(), bool) {
			if r.Lock == nil {
				return func() {}, true
			}
			return r.Lock(ctx)
		}()
		if !ok {
			wait = r.Busy
		} else {
			err := r.Ensure(ctx)
			release()
			if err != nil {
				wait = r.Backoff[min(fails, len(r.Backoff)-1)]
				fails++
				slog.WarnContext(ctx, "tochka: webhook registration failed", "err", err, "attempt", fails, "retry_in", wait.String())
			} else {
				fails = 0
			}
		}
		if !r.sleep(ctx, wait) {
			return
		}
	}
}

// Ensure checks the registered webhook and sets it when it differs. The error text carries
// no token (the adapter never puts it in errors).
func (r *Registrar) Ensure(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	w, err := r.API.GetWebhook(ctx)
	switch {
	case err == nil:
		if w.URL == r.URL && slices.Contains(w.Types, WebhookTypeAcquiring) {
			slog.DebugContext(ctx, "tochka: webhook already registered", "url", r.URL)
			return nil
		}
		slog.InfoContext(ctx, "tochka: webhook differs, registering", "registered", w.URL, "url", r.URL)
	case errors.Is(err, provider.ErrNotFound):
		slog.InfoContext(ctx, "tochka: no webhook registered, registering", "url", r.URL)
	default:
		return err
	}
	if _, err := r.API.SetWebhook(ctx, r.URL); err != nil {
		return err
	}
	slog.InfoContext(ctx, "tochka: webhook registered", "url", r.URL)
	return nil
}

func (r *Registrar) sleep(ctx context.Context, d time.Duration) bool {
	if r.Sleep != nil {
		return r.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
