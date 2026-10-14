package app

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
	"github.com/calaba/calaba/server/internal/config"
)

type countBank struct{ gets atomic.Int32 }

func (c *countBank) GetWebhook(context.Context) (tochka.Webhook, error) {
	c.gets.Add(1)
	return tochka.Webhook{URL: "https://x.test/h", Types: []string{tochka.WebhookTypeAcquiring}}, nil
}

func (c *countBank) SetWebhook(context.Context, string) (tochka.Webhook, error) {
	return tochka.Webhook{}, nil
}

func TestRunAfterListenWebhookJob(t *testing.T) {
	// No TOCHKA_WEBHOOK_URL: the registrar is never built, nothing runs (no bank call possible).
	off := &billingRuntime{cfg: config.Billing{Enabled: true, TochkaEnabled: true}}
	off.RunAfterListen(context.Background())
	if off.webhook != nil {
		t.Fatal("registrar built without TOCHKA_WEBHOOK_URL")
	}

	// Billing disabled: not started even with a registrar.
	bank := &countBank{}
	disabled := &billingRuntime{webhook: tochka.NewRegistrar(bank, "https://x.test/h")}
	disabled.RunAfterListen(context.Background())
	time.Sleep(50 * time.Millisecond)
	if bank.gets.Load() != 0 {
		t.Fatal("job started with billing disabled")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	on := &billingRuntime{cfg: config.Billing{Enabled: true}, webhook: tochka.NewRegistrar(bank, "https://x.test/h")}
	on.RunAfterListen(ctx)
	deadline := time.Now().Add(2 * time.Second)
	for bank.gets.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if bank.gets.Load() == 0 {
		t.Fatal("job did not start")
	}
}
