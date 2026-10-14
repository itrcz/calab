package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
)

// tochkapayUsage: operator steps of the Tochka Pay Gateway (ADR-0083 phase 3, apps/server/README.md
// «Точка: СБП-привязка»). Reads only the TOCHKA_* env; never prints the token, the key or a
// binding token.
const tochkapayUsage = `server tochkapay pubkey   print the public half of TOCHKA_PAY_SIGNING_KEY as the bank asks for it
                          (PEM, base64 on one line) — hand it to the bank at onboarding
server tochkapay smoke    test site only (TOCHKA_PAY_LIVE unset): bind (scenario
                          OK_SUBSCRIPTION_ACCEPTED), charge 1 ₽ by the token, refund it; prints
                          every status — the contract check of the adapter against the bank`

func tochkapayConfig() tochkapay.Config {
	token := os.Getenv("TOCHKA_PAY_API_TOKEN")
	if token == "" {
		token = os.Getenv("TOCHKA_API_TOKEN")
	}
	return tochkapay.Config{
		BaseURL: os.Getenv("TOCHKA_PAY_API_URL"), Token: token, SiteUID: os.Getenv("TOCHKA_PAY_SITE_UID"),
		SigningKey: os.Getenv("TOCHKA_PAY_SIGNING_KEY"), Live: os.Getenv("TOCHKA_PAY_LIVE") == "true",
		WebhookKey: os.Getenv("TOCHKA_WEBHOOK_PUBLIC_KEY"), CallbackURL: os.Getenv("TOCHKA_PAY_CALLBACK_URL"),
	}
}

// tochkapayCmd runs `server tochkapay …` and writes its answer to out.
func tochkapayCmd(ctx context.Context, args []string, out io.Writer) error {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "pubkey":
		key, err := tochkapay.ParseSigningKey(os.Getenv("TOCHKA_PAY_SIGNING_KEY"))
		if err != nil {
			return err
		}
		pub, err := tochkapay.PublicKeyBase64(key)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, pub)
		return err
	case "smoke":
		ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		return tochkapaySmoke(ctx, tochkapayConfig(), out)
	}
	return fmt.Errorf("usage:\n%s", tochkapayUsage)
}

// tochkapaySmoke plays the documented test scenarios once against the test site.
func tochkapaySmoke(ctx context.Context, cfg tochkapay.Config, out io.Writer) error {
	if cfg.Live {
		return errors.New("tochkapay smoke runs on a test site only (unset TOCHKA_PAY_LIVE)")
	}
	cfg.Scenarios = tochkapay.Scenarios{CreateQrc: "OK_SUBSCRIPTION_ACCEPTED", PayWithToken: "OK", Refund: "OK_ACCEPTED"}
	p, err := tochkapay.New(cfg)
	if err != nil {
		return err
	}
	say := func(format string, a ...any) { _, _ = fmt.Fprintf(out, format+"\n", a...) }
	acc := uuid.New()
	cust, _ := p.EnsureCustomer(ctx, provider.CustomerReq{AccountID: acc})
	bindingID := uuid.New()
	b, err := p.CreateBinding(ctx, provider.BindingReq{ID: bindingID, Customer: cust, ExpiresAt: time.Now().Add(15 * time.Minute),
		Metadata: provider.Metadata{AccountID: acc, Kind: provider.MetadataKindAutoTopup}})
	if err != nil {
		return fmt.Errorf("create binding: %w", err)
	}
	say("binding: qrc %s, link host ok, image %d bytes", b.ID, len(b.ImagePNG))
	var fact provider.BindingFact
	for i := 0; ; i++ {
		fact, err = p.GetBinding(ctx, bindingID)
		if err != nil {
			return fmt.Errorf("get binding: %w", err)
		}
		say("binding result: %s", fact.Status)
		if fact.Status != provider.BindingPending || i >= 12 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	if fact.Status != provider.BindingAccepted {
		return fmt.Errorf("binding not accepted: %s", fact.Status)
	}
	say("binding: bank %s, metadata account matches: %t", fact.Method.Brand, fact.Metadata.AccountID == acc)
	attempt := uuid.New()
	pay, err := p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: attempt.String(), Customer: cust, PaymentMethodID: fact.Method.ID,
		Amount: money.New(100, money.RUB), Metadata: provider.Metadata{AccountID: acc, AttemptID: attempt, Kind: provider.MetadataKindAutoTopup}})
	if err != nil {
		return fmt.Errorf("charge: %w", err)
	}
	say("charge 1.00 RUB: %s %s, customer matches: %t", pay.Status, pay.FailureCode, pay.CustomerID == acc.String())
	again, err := p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: attempt.String(), Customer: cust, PaymentMethodID: fact.Method.ID,
		Amount: money.New(100, money.RUB)})
	say("charge again (read, not sent): %s %v", again.Status, err)
	if pay.Status != provider.PaymentSucceeded {
		return nil
	}
	rid := uuid.New()
	rf, err := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + rid.String(), PaymentID: pay.ID, Amount: money.New(100, money.RUB), Metadata: provider.Metadata{RefundID: rid}})
	if err != nil {
		return fmt.Errorf("refund: %w", err)
	}
	say("refund: %s %s", rf.Status, rf.FailureReason)
	return nil
}
