package billinghttp

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Auto-topup consent (…/billing/auto-topup). This stores and revokes the owner's consent only;
// the attempts themselves are T7's (billing/autotopup), which re-checks consent, owner, card and
// limit under the account lock at dispatch. A revoke stops new attempts; one already sent to
// the provider is still settled.

// autoTopup: GET …/auto-topup.
func (s *Service) autoTopup(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	return s.writeAutoTopup(w, r, c)
}

func (s *Service) writeAutoTopup(w http.ResponseWriter, r *http.Request, c caller) error {
	ctx := r.Context()
	var out *v1.AutoTopupSettings
	err := s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		q := s.db.Q.WithTx(tx)
		acc, err := q.GetBillingAccount(ctx, c.acc.ID)
		if err != nil {
			return err
		}
		qt, err := s.core.QuoteIn(ctx, q, acc, "")
		if err != nil {
			return err
		}
		out, err = autoTopupSummary(ctx, q, acc, qt)
		return err
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// putAutoTopup: PUT …/auto-topup {payment_method_id, max_amount, consent_version, request_id}.
// The card must be a saved card of this account, the cap within the currency's limits and the
// account's payment method auto-topup capable.
func (s *Service) putAutoTopup(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	var req v1.PutAutoTopupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	reqID, err := parseRequestID(req.GetRequestId())
	if err != nil {
		return err
	}
	if _, ok := autotopup.ConsentTexts[req.GetConsentVersion()]; !ok || req.GetConsentVersion() != autotopup.ConsentVersion {
		return httpx.Validation("consent_version", "consent_version must be the current consent text version")
	}
	pmID, err := uuid.Parse(req.GetPaymentMethodId())
	if err != nil {
		return httpx.Validation("payment_method_id", "unknown payment method")
	}
	_, limit, ok := provider.AutoTopupLimits(money.Currency(c.acc.Currency))
	if !ok {
		return billing.ErrAutoTopupUnavailable
	}
	maxAmt := req.GetMaxAmount()
	if maxAmt.GetCurrency() != c.acc.Currency {
		return billing.ErrCurrencyMismatch
	}
	if maxAmt.GetMinor() <= 0 || maxAmt.GetMinor() > limit {
		return billing.ErrAutoTopupLimit
	}
	m, err := s.db.Q.GetBillingPaymentMethod(ctx, pmID)
	if db.IsNotFound(err) || (err == nil && (m.AccountID != c.acc.ID || m.DetachedAt != nil)) {
		return httpx.Validation("payment_method_id", "unknown payment method")
	}
	if err != nil {
		return err
	}
	if _, ok := s.reg.OffSession(provider.ID(m.Provider)); !ok {
		return billing.ErrAutoTopupUnavailable
	}
	// The method must allow auto-topup in the account's market, and the cap must reach its
	// minimum charge (else no attempt could ever be made).
	capable := false
	for _, o := range s.reg.Methods(c.acc.Market, money.Currency(c.acc.Currency), "", "") {
		if o.Provider == provider.ID(m.Provider) && string(o.Method) == m.Kind && o.AutoTopupCapable {
			capable = true
			if maxAmt.GetMinor() < o.Min {
				return billing.ErrAutoTopupLimit
			}
		}
	}
	if !capable {
		return billing.ErrAutoTopupUnavailable
	}
	hash := bodyHash("auto_topup", &v1.PutAutoTopupRequest{PaymentMethodId: m.ID.String(), MaxAmount: &v1.Money{Minor: maxAmt.GetMinor(), Currency: c.acc.Currency}, ConsentVersion: req.GetConsentVersion()})
	if _, err := s.audit(ctx, c, "owner.auto_topup", reqID, hash); err != nil {
		return err
	}
	if err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, c.acc.ID); err != nil {
			return err
		}
		_, err := q.UpsertBillingAutoTopupConsent(ctx, sqlc.UpsertBillingAutoTopupConsentParams{
			AccountID: c.acc.ID, PmID: m.ID, MaxMinor: maxAmt.GetMinor(), ConsentVersion: int32(min(req.GetConsentVersion(), 1<<30)), //nolint:gosec // clamped
			ConsentBy: &c.user, Now: s.now(ctx),
		})
		return err
	}); err != nil {
		return err
	}
	return s.writeAutoTopup(w, r, c)
}

// deleteAutoTopup: DELETE …/auto-topup revokes the consent at once (no new attempt starts).
func (s *Service) deleteAutoTopup(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, c.acc.ID); err != nil {
			return err
		}
		_, err := q.RevokeBillingAutoTopup(ctx, sqlc.RevokeBillingAutoTopupParams{Now: s.now(ctx), Reason: "owner", AccountID: c.acc.ID})
		return err
	}); err != nil {
		return err
	}
	return s.writeAutoTopup(w, r, c)
}
