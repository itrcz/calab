package billinghttp

import (
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log/slog"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/stripe"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
)

func marshalJSON(v any) ([]byte, error) { return json.Marshal(v) }

// ErrBadWebhook means the body is not a valid signed event of the provider (400, nothing stored).
var ErrBadWebhook = httpx.BadRequest("invalid webhook signature")

// stripeWebhook: POST /api/billing/stripe/webhook. Reads the raw body (≤ stripe.MaxWebhookBody),
// verifies it against the endpoint secrets, stores the event (a redelivery is a no-op) and
// answers 200 at once; the inbox worker processes it. A bad signature, a livemode event while
// live mode is off: 400 and nothing stored. Events of any API version are stored (the adapter
// reads only the envelope; objects are re-fetched with the pinned version), so `stripe listen
// --forward-to …/api/billing/stripe/webhook` works with the account default version. Anything
// else: 503 (Stripe redelivers).
func (s *Service) stripeWebhook(w http.ResponseWriter, r *http.Request) error {
	p, ok := s.reg.Provider(provider.Stripe)
	if !ok {
		return billing.ErrDisabled
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, stripe.MaxWebhookBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_PAYLOAD_TOO_LARGE, "webhook body too large")
		}
		return httpx.BadRequest("cannot read body")
	}
	ctx := r.Context()
	ev, dup, err := s.inbox.Receive(ctx, p, r.Header, raw)
	switch {
	case err == nil:
	case errors.Is(err, provider.ErrBadSignature):
		slog.WarnContext(ctx, "billing webhook: bad signature", "err", err)
		return ErrBadWebhook
	case errors.Is(err, provider.ErrLivemodeForbidden):
		slog.ErrorContext(ctx, "billing webhook: livemode event refused (STRIPE_LIVEMODE_ALLOWED=false)", "err", err)
		return httpx.BadRequest("livemode events are not accepted")
	default:
		slog.WarnContext(ctx, "billing webhook: not stored", "err", err)
		return httpx.Unavailable(err)
	}
	slog.InfoContext(ctx, "billing webhook", "event", ev.EventID, "type", ev.Type, "duplicate", dup)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"received":true}`))
	return nil
}

// returnPage: GET /api/billing/return?checkout=… — where hosted checkout sends the payer back
// (system browser). Static text only: the app shows the result by polling the checkout (and the
// webhook credits it); this page has no money logic and reads nothing.
func (s *Service) returnPage(w http.ResponseWriter, r *http.Request) error {
	lang := mail.FromAcceptLanguage(r.Header.Get("Accept-Language"))
	t := returnTexts[mail.LocaleEN]
	if x, ok := returnTexts[lang]; ok {
		t = x
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	return returnTmpl.Execute(w, struct {
		Lang, Title, Line, Link string
		AppURL                  string
	}{Lang: lang, Title: t[0], Line: t[1], Link: t[2], AppURL: s.cfg.AppURL})
}

var returnTexts = map[string][3]string{
	mail.LocaleEN:   {"Payment is being processed", "You can close this tab and return to Calab: the balance updates there by itself.", "Open Calab"},
	mail.LocaleRU:   {"Оплата обрабатывается", "Можно закрыть вкладку и вернуться в Calab — баланс обновится там сам.", "Открыть Calab"},
	mail.LocaleES:   {"El pago se está procesando", "Puedes cerrar esta pestaña y volver a Calab: el saldo se actualiza allí solo.", "Abrir Calab"},
	mail.LocaleZhCN: {"付款处理中", "可以关闭此标签页并返回 Calab，余额会自动更新。", "打开 Calab"},
}

var returnTmpl = template.Must(template.New("return").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{{.Title}} — Calab</title>
<style>
:root{--bg:#f4f4f5;--card:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--card:#1a1a1d;--fg:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2e}}
body{margin:0;padding:48px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:480px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px}
h1{margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600}
p{margin:0 0 20px;color:var(--muted)}
a{color:var(--fg);font-weight:600}
</style></head>
<body><main><p style="margin:0 0 24px;font-weight:700;color:var(--fg)">Calab</p>
<h1>{{.Title}}</h1><p>{{.Line}}</p>{{if .AppURL}}<a href="{{.AppURL}}">{{.Link}}</a>{{end}}</main></body></html>
`))
