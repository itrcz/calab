package billinghttp

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
	"github.com/calaba/calaba/server/internal/httpx"
)

// tochkaWebhook: POST /api/billing/tochka/webhook (ADR-0083). The body is a bare RS256 JWT
// (text/plain) signed by the bank: verified against the pinned key, stored in the inbox (a
// redelivery is a no-op) and answered 200 at once; the inbox re-reads the operation before any
// credit. A verified webhook that is not ours to process (another type, the bank's test
// webhooks of another customer code) is stored as ignored and answered 200 — the bank needs 200
// to register the URL and retries anything else 30 times every 10 s. A bad signature: 400,
// nothing stored. Polling of pending checkouts credits the same payment when no webhook comes.
func (s *Service) tochkaWebhook(w http.ResponseWriter, r *http.Request) error {
	p, ok := s.reg.Provider(provider.Tochka)
	if !ok {
		return billing.ErrDisabled
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, tochka.MaxWebhookBody))
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
		slog.WarnContext(ctx, "billing webhook: bad signature", "provider", "tochka", "err", err)
		return ErrBadWebhook
	default:
		slog.WarnContext(ctx, "billing webhook: not stored", "provider", "tochka", "err", err)
		return httpx.Unavailable(err)
	}
	slog.InfoContext(ctx, "billing webhook", "provider", "tochka", "event", ev.EventID, "type", ev.Type, "kind", ev.Kind, "duplicate", dup)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"received":true}`))
	return nil
}

// allowLanding lets the landing origin read the public offers cross-origin: a simple GET, so no
// preflight; credentials are never allowed. The response varies by Origin (shared caches).
func allowLanding(w http.ResponseWriter, r *http.Request, origins []string) {
	w.Header().Add("Vary", "Origin")
	if o := r.Header.Get("Origin"); o != "" && slices.Contains(origins, o) {
		w.Header().Set("Access-Control-Allow-Origin", o)
	}
}

// publicOffers: GET /api/billing/public/offers — what the landing shows (ADR-0083): the sales
// mode for new clients, the per-seat-day prices of the open markets (the Global catalog in
// contact mode) and the contact link. No session, no account data; cacheable for 5 minutes and
// rate-limited per client IP.
func (s *Service) publicOffers(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if s.cfg.PublicLimiter != nil {
		if err := s.cfg.PublicLimiter.Take(ctx, httpx.ClientIP(ctx)); err != nil {
			return err
		}
	}
	nm, err := s.newMarkets(ctx)
	if err != nil {
		return err
	}
	offers, err := s.catalog(ctx, nm.catalog, 0)
	if err != nil {
		return err
	}
	out := &v1.PublicBillingOffers{Mode: nm.mode, Offers: offers, Markets: nm.catalog, Contact: s.cfg.Contact}
	if nm.mode == v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT {
		out.Markets = nil
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	allowLanding(w, r, s.cfg.LandingOrigins)
	httpx.Write(w, http.StatusOK, out)
	return nil
}
