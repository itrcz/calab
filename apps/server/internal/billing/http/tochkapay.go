package billinghttp

import (
	"errors"
	"io"
	"log/slog"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
	"github.com/calaba/calaba/server/internal/httpx"
)

// tochkapayWebhook: POST /api/billing/tochkapay/webhook (ADR-0083 phase 3, Tochka Pay Gateway).
// The body is a bare RS256 JWT signed with the bank's webhook key: verified, stored in the inbox
// (a redelivery is a no-op) and answered 200; the inbox re-reads the payment / refund before
// acting. A binding decision is stored as method_saved without the token (the token is read by
// GetBinding only). Bad signature: 400, nothing stored; a live event while TOCHKA_PAY_LIVE=false:
// 400. 501 while BILLING_TOCHKA_SBP_BINDING_ENABLED is off.
func (s *Service) tochkapayWebhook(w http.ResponseWriter, r *http.Request) error {
	p, ok := s.reg.Provider(provider.TochkaPay)
	if !ok {
		return billing.ErrDisabled
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, tochkapay.MaxWebhookBody))
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
		slog.WarnContext(ctx, "billing webhook: bad signature", "provider", "tochkapay", "err", err)
		return ErrBadWebhook
	case errors.Is(err, provider.ErrLivemodeForbidden):
		slog.ErrorContext(ctx, "billing webhook: live event refused (TOCHKA_PAY_LIVE=false)", "provider", "tochkapay", "err", err)
		return httpx.BadRequest("livemode events are not accepted")
	default:
		slog.WarnContext(ctx, "billing webhook: not stored", "provider", "tochkapay", "err", err)
		return httpx.Unavailable(err)
	}
	slog.InfoContext(ctx, "billing webhook", "provider", "tochkapay", "event", ev.EventID, "type", ev.Type, "kind", ev.Kind, "duplicate", dup)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"received":true}`))
	return nil
}
