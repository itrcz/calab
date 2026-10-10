package billinghttp

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Charger runs one-click top-ups (autotopup.Job: the same dispatcher, recovery and
// one-charge-per-account rule as auto-topup).
type Charger interface {
	StartManual(ctx context.Context, r autotopup.ManualRequest) (sqlc.BillingAutotopupAttempt, error)
	RefreshManual(ctx context.Context, att sqlc.BillingAutotopupAttempt) (sqlc.BillingAutotopupAttempt, error)
}

// savedTopup: POST …/billing/saved-method-topups (BILLING_SAVED_METHOD_TOPUP_ENABLED). A manual
// top-up charged to a saved card without the hosted page (owner 2026-10-10):
//
//  1. the card must be a saved, attached card of this account whose provider charges saved
//     cards; the amount is checked against the card's matrix row (same limits as a checkout);
//  2. request_id + body hash: the same request answers the same charge, another body 409; one
//     charge of a saved card in flight per account (409 BILLING_PAYMENT_PENDING, also while an
//     auto-topup is in flight);
//  3. the charge is sent at once (Stripe on-session; a 3-D Secure card answers REQUIRES_ACTION
//     with the page to open; Tochka Charge Subscription, attributed by reading the
//     subscription's operations) and the answer is the charge's state. Money arrives through the
//     inbox credit path only.
func (s *Service) savedTopup(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	if !s.cfg.SavedMethodTopups || s.cfg.Charger == nil {
		return billing.ErrDisabled
	}
	var req v1.CreateSavedMethodTopupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	reqID, err := parseRequestID(req.GetRequestId())
	if err != nil {
		return err
	}
	if c.acc.Status == core.StatusClosed {
		return billing.ErrAccountNotFound
	}
	if s.cfg.ChargeLimiter != nil {
		if err := s.cfg.ChargeLimiter.Take(ctx, c.acc.ID.String()); err != nil {
			return err
		}
	}
	pmID, err := uuid.Parse(req.GetPaymentMethodId())
	if err != nil {
		return httpx.Validation("payment_method_id", "unknown payment method")
	}
	m, err := s.db.Q.GetBillingPaymentMethod(ctx, pmID)
	if db.IsNotFound(err) || (err == nil && (m.AccountID != c.acc.ID || m.DetachedAt != nil)) {
		return httpx.Validation("payment_method_id", "unknown payment method")
	}
	if err != nil {
		return err
	}
	payer, err := s.db.Q.GetBillingPayer(ctx, c.acc.ID)
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	opt, ok := s.chargeOption(c.acc, m, payer.Type, payer.Country)
	if !ok {
		return billing.ErrMethodUnavailable
	}
	amt := req.GetAmount()
	if amt.GetCurrency() != c.acc.Currency {
		return billing.ErrCurrencyMismatch
	}
	if amt.GetMinor() < opt.Min || amt.GetMinor() > opt.Max {
		return billing.ErrAmountOutOfRange
	}
	hash := bodyHash("saved_topup", &v1.CreateSavedMethodTopupRequest{PaymentMethodId: m.ID.String(), Amount: &v1.Money{Minor: amt.GetMinor(), Currency: c.acc.Currency}})
	att, err := s.cfg.Charger.StartManual(ctx, autotopup.ManualRequest{
		AccountID: c.acc.ID, UserID: c.user, RequestID: reqID, BodyHash: hash, PmID: m.ID, AmountMinor: amt.GetMinor(), Currency: c.acc.Currency,
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, savedTopupProto(att))
	return nil
}

// savedTopupStatus: GET …/billing/saved-method-topups/{tid}. Re-reads the provider while the
// charge is not final (after the 3-D Secure page, or while the provider's answer is pending).
func (s *Service) savedTopupStatus(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	tid, err := httpx.PathUUID(r, "tid", "top-up")
	if err != nil {
		return err
	}
	att, err := s.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: tid, AccountID: c.acc.ID})
	if db.IsNotFound(err) || (err == nil && att.Kind != autotopup.KindManual) {
		return httpx.NotFound("top-up")
	}
	if err != nil {
		return err
	}
	if s.cfg.Charger != nil {
		if fresh, err := s.cfg.Charger.RefreshManual(ctx, att); err != nil {
			// The poll answers what we know; the recovery resolves it.
			slog.WarnContext(ctx, "billing: refresh one-click top-up", "topup", att.ID, "err", err)
		} else {
			att = fresh
		}
	}
	httpx.Write(w, http.StatusOK, savedTopupProto(att))
	return nil
}

// chargeOption is the matrix row a saved card is charged under: the account's market and
// currency, the card's provider and kind, a provider that charges saved cards.
func (s *Service) chargeOption(acc sqlc.BillingAccount, m sqlc.BillingPaymentMethod, payerType, country string) (provider.MethodOption, bool) {
	if _, ok := s.reg.OffSession(provider.ID(m.Provider)); !ok {
		return provider.MethodOption{}, false
	}
	for _, o := range s.reg.Methods(acc.Market, money.Currency(acc.Currency), payerType, country) {
		if o.Provider == provider.ID(m.Provider) && string(o.Method) == m.Kind {
			return o, true
		}
	}
	return provider.MethodOption{}, false
}

// SavedMethodProto is a saved card with what it can do now on this account (one_click,
// auto_topup_capable); the admin page shows the same.
func SavedMethodProto(reg *provider.Registry, oneClick bool, acc sqlc.BillingAccount, m sqlc.BillingPaymentMethod) *v1.SavedPaymentMethod {
	out := savedMethodProto(m)
	if _, ok := reg.OffSession(provider.ID(m.Provider)); ok {
		for _, o := range reg.Methods(acc.Market, money.Currency(acc.Currency), "", "") {
			if o.Provider == provider.ID(m.Provider) && string(o.Method) == m.Kind {
				out.OneClick = oneClick
				out.AutoTopupCapable = o.AutoTopupCapable
			}
		}
	}
	return out
}

func savedTopupState(status string) v1.SavedMethodTopupState {
	switch status {
	case "requires_action":
		return v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_REQUIRES_ACTION
	case "succeeded":
		return v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED
	case "failed":
		return v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_FAILED
	}
	return v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_PROCESSING
}

func savedTopupProto(a sqlc.BillingAutotopupAttempt) *v1.SavedMethodTopup {
	out := &v1.SavedMethodTopup{
		Id: a.ID.String(), State: savedTopupState(a.Status), Amount: mon(a.AmountMinor, a.Currency),
		// succeeded is set in the credit transaction (AttemptSettled): the money is on the balance.
		Credited: a.Status == "succeeded", PaymentMethodId: a.PmID.String(), CreatedAt: timestamppb.New(a.CreatedAt),
	}
	switch a.Status {
	case "requires_action":
		out.ActionUrl = a.ActionUrl
	case "failed":
		out.FailureCode = a.FailureCode
	}
	return out
}
