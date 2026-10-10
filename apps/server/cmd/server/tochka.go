package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
)

// tochkaUsage: the operator steps of the Tochka acquirer (ADR-0083, apps/server/README.md
// «Точка»). Reads only the TOCHKA_* env (no database); never prints the token.
const tochkaUsage = `server tochka webhook get            the registered webhook URL of the token's client id
server tochka webhook set <https-url> register (or move) the one webhook URL; the bank sends a
                                     test webhook and keeps the URL only if it answers 200
server tochka webhook test           ask the bank to send a test webhook to the registered URL
server tochka webhook delete         remove the registered webhook
server tochka key                    compare the pinned webhook key with the one the bank publishes`

// tochkaCmd runs `server tochka …` and writes its answer to out.
func tochkaCmd(ctx context.Context, args []string, out io.Writer) error {
	p, err := tochka.New(tochka.Config{
		BaseURL: os.Getenv("TOCHKA_API_URL"), Token: os.Getenv("TOCHKA_API_TOKEN"),
		CustomerCode: os.Getenv("TOCHKA_CUSTOMER_CODE"), MerchantID: os.Getenv("TOCHKA_MERCHANT_ID"),
		WebhookKey: os.Getenv("TOCHKA_WEBHOOK_PUBLIC_KEY"), ClientID: os.Getenv("TOCHKA_CLIENT_ID"),
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	sub := func(i int) string {
		if len(args) > i {
			return args[i]
		}
		return ""
	}
	switch sub(0) + " " + sub(1) {
	case "webhook get":
		w, err := p.GetWebhook(ctx)
		if errors.Is(err, provider.ErrNotFound) {
			_, err = fmt.Fprintln(out, "no webhook registered")
			return err
		}
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "url: %s\ntypes: %v\n", w.URL, w.Types)
		return err
	case "webhook set":
		if sub(2) == "" {
			return errors.New("usage: server tochka webhook set <https-url>")
		}
		w, err := p.SetWebhook(ctx, sub(2))
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "registered: %s %v\n", w.URL, w.Types)
		return err
	case "webhook test":
		if err := p.TestWebhook(ctx); err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, "test webhook requested")
		return err
	case "webhook delete":
		if err := p.DeleteWebhook(ctx); err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, "webhook deleted")
		return err
	case "key ":
		ok, err := p.PublishedKeyMatches(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("the bank publishes another webhook key than the pinned one: set TOCHKA_WEBHOOK_PUBLIC_KEY to [old, new] (JSON array) and redeploy")
		}
		_, err = fmt.Fprintln(out, "pinned webhook key matches the published one")
		return err
	}
	return fmt.Errorf("usage:\n%s", tochkaUsage)
}
