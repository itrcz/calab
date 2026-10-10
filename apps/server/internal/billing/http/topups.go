package billinghttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// topup: POST …/billing/topups. Opens a hosted checkout for a manual top-up:
//
//  1. the method is re-validated against the capability matrix for the account and payer
//     (422 BILLING_METHOD_UNAVAILABLE), the amount against its limits (422) and currency;
//  2. under the account lock the checkout row is written first (request_id + body hash: the
//     same request returns the same checkout, another body 409 BILLING_REQUEST_REUSED; one
//     open checkout per account: the same body reuses it, another one is 409
//     BILLING_PAYMENT_PENDING);
//  3. outside any transaction: the provider customer (created once, billing_customers) and
//     the session with idempotency key checkout:{id} (a retry after a lost answer gets the
//     same session);
//  4. the session is stored on the row. Money arrives only through the inbox / pull-sync.
func (s *Service) topup(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	if !s.cfg.Checkouts {
		return billing.ErrDisabled
	}
	var req v1.CreateTopupRequest
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
	payer, err := s.db.Q.GetBillingPayer(ctx, c.acc.ID)
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	opt, ok := s.reg.Method(req.GetMethodId(), c.acc.Market, money.Currency(c.acc.Currency), payer.Type, payer.Country)
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
	if req.GetSaveMethod() && !opt.AutoTopupCapable {
		return billing.ErrAutoTopupUnavailable
	}
	p, ok := s.reg.Provider(opt.Provider)
	if !ok {
		return billing.ErrMethodUnavailable
	}
	hash := bodyHash("topup", &v1.CreateTopupRequest{MethodId: opt.ID, Amount: &v1.Money{Minor: amt.GetMinor(), Currency: c.acc.Currency}, SaveMethod: req.GetSaveMethod()})

	co, err := s.openCheckout(ctx, c, reqID, hash, opt, amt.GetMinor(), req.GetSaveMethod(), payer)
	if err != nil {
		return err
	}
	if co.Status != inbox.CheckoutOpen {
		// A replay of a finished checkout: answer what it was.
		httpx.Write(w, http.StatusOK, &v1.CreateTopupResponse{CheckoutId: co.ID.String(), Url: deref(co.Url)})
		return nil
	}
	if co.ProviderSessionID != nil && co.Url != nil {
		httpx.Write(w, http.StatusOK, &v1.CreateTopupResponse{CheckoutId: co.ID.String(), Url: *co.Url})
		return nil
	}
	sess, err := s.createSession(ctx, c, p, co, opt, payer)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CreateTopupResponse{CheckoutId: co.ID.String(), Url: sess.URL})
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// openCheckout writes (or finds) the checkout row under the account lock.
func (s *Service) openCheckout(ctx context.Context, c caller, reqID uuid.UUID, hash []byte, opt provider.MethodOption,
	amount int64, save bool, payer sqlc.BillingPayer) (sqlc.BillingCheckout, error) {
	var co sqlc.BillingCheckout
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		locked, err := q.LockBillingAccount(ctx, c.acc.ID)
		if err != nil {
			return err
		}
		if locked.Market != c.acc.Market || locked.Currency != c.acc.Currency || locked.Provider != c.acc.Provider {
			// The market moved since the method was validated (ADR-0083: an owner's or
			// superadmin's switch before the first payment): the client reloads its methods.
			return billing.ErrRevisionConflict
		}
		// A first payment opens a market for good (ADR-0083): only while its provider takes
		// new clients. An account fixed by money keeps paying on its provider.
		if locked.Status == core.StatusInactive || locked.Status == core.StatusStopped {
			fixed, err := q.BillingAccountMarketFixed(ctx, locked.ID)
			if err != nil {
				return err
			}
			if !fixed {
				open, err := s.sales.IsOpen(ctx, q, locked.Market)
				if err != nil {
					return err
				}
				if !open {
					return billing.ErrMarketUnavailable
				}
			}
		}
		now, err := s.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		if old, err := q.GetBillingCheckoutByRequest(ctx, sqlc.GetBillingCheckoutByRequestParams{AccountID: c.acc.ID, RequestID: reqID}); err == nil {
			if !bytes.Equal(old.BodyHash, hash) {
				return billing.ErrRequestReused
			}
			co = old
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		if open, err := q.GetOpenBillingCheckout(ctx, c.acc.ID); err == nil {
			switch {
			case open.ExpiresAt != nil && !now.Before(*open.ExpiresAt):
				// Past its expiry: the provider cannot take money on it any more.
				if _, err := q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{Status: inbox.CheckoutExpired, Now: now, ID: open.ID}); err != nil {
					return err
				}
			case bytes.Equal(open.BodyHash, hash):
				co = open // the same top-up asked again with a new request id
				return nil
			default:
				return billing.ErrPaymentPending
			}
		} else if !db.IsNotFound(err) {
			return err
		}
		snap := []byte("{}")
		if payer.AccountID != uuid.Nil {
			snap = payerSnapshot(payer)
		}
		exp := now.Add(s.cfg.CheckoutTTL)
		co, err = q.InsertBillingCheckout(ctx, sqlc.InsertBillingCheckoutParams{
			AccountID: c.acc.ID, RequestID: reqID, BodyHash: hash, Purpose: "topup", MethodID: opt.ID, Provider: string(opt.Provider),
			AmountMinor: amount, Currency: c.acc.Currency, SaveMethod: save, PayerSnapshot: snap, CreatedBy: &c.user, ExpiresAt: &exp,
		})
		if db.UniqueViolation(err) == "billing_checkouts_one_open_idx" {
			return billing.ErrPaymentPending
		}
		return err
	})
	return co, err
}

// payerSnapshot is the payer a checkout was opened under: its version (billing_payer_versions)
// and the values, so the checkout keeps them after the payer is edited.
func payerSnapshot(p sqlc.BillingPayer) []byte {
	b, err := marshalJSON(map[string]any{
		"version": p.Version, "type": p.Type, "name": p.Name, "country": p.Country, "email": p.Email, "tax_id": deref(p.TaxID),
		"requisites": json.RawMessage(p.Requisites),
	})
	if err != nil {
		return []byte("{}")
	}
	return b
}

// createSession talks to the provider (no transaction open) and stores the session.
func (s *Service) createSession(ctx context.Context, c caller, p provider.Provider, co sqlc.BillingCheckout, opt provider.MethodOption,
	payer sqlc.BillingPayer) (provider.CheckoutSession, error) {
	cust, err := s.ensureCustomer(ctx, c, p, payer)
	if err != nil {
		return provider.CheckoutSession{}, err
	}
	email := payer.Email
	if email == "" {
		if u, err := s.db.Q.GetUser(ctx, c.user); err == nil && u.Email != nil {
			email = *u.Email
		}
	}
	ret := returnURL(s.cfg.ReturnURL, co.ID)
	// The provider runs on the wall clock: its expires_at is the row's creation (database now(),
	// real time) + TTL — stable across retries of the same idempotency key — never the billing
	// clock (a dev test clock ahead of time made Stripe refuse the session). The row keeps its
	// billing-clock expiry for our own scheduling.
	exp := co.CreatedAt.Add(s.cfg.CheckoutTTL)
	sess, err := p.CreateCheckout(ctx, provider.CheckoutReq{
		IdemKey: "checkout:" + co.ID.String(), Amount: money.New(co.AmountMinor, money.Currency(co.Currency)), Method: opt.Method,
		Customer: cust, SuccessURL: ret, CancelURL: ret, SaveForOffSession: co.SaveMethod, ExpiresAt: exp,
		Metadata:     provider.Metadata{AccountID: c.acc.ID, CheckoutID: co.ID, Kind: provider.MetadataKindCheckout},
		ReceiptEmail: email, ReceiptName: receiptName(payer),
	})
	if err != nil {
		if !errors.Is(err, provider.ErrUnknownOutcome) {
			// A definite refusal: free the open slot so the owner can try again.
			slog.ErrorContext(ctx, "billing: create checkout refused", "checkout", co.ID, "err", err)
			if _, e := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.BillingCheckout, error) {
				return q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{Status: inbox.CheckoutFailed, Now: s.now(ctx), ID: co.ID})
			}); e != nil && !db.IsNotFound(e) {
				slog.WarnContext(ctx, "billing: fail checkout", "checkout", co.ID, "err", e)
			}
		} else {
			slog.WarnContext(ctx, "billing: create checkout unknown outcome (retry with the same request_id)", "checkout", co.ID, "err", err)
		}
		return sess, billing.ErrProviderUnavailable
	}
	sid, u := sess.ID, sess.URL
	_, err = db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.BillingCheckout, error) {
		return q.SetBillingCheckoutSession(ctx, sqlc.SetBillingCheckoutSessionParams{SessionID: &sid, Url: &u, ExpiresAt: co.ExpiresAt, Now: s.now(ctx), ID: co.ID})
	})
	if db.IsNotFound(err) {
		return sess, billing.ErrPaymentPending // the checkout left 'open' meanwhile (expired / reconciled)
	}
	if err == nil {
		s.inbox.SchedulePoll(ctx, p, co.ID) // providers without failure / expiry webhooks (ADR-0083)
	}
	return sess, err
}

// ensureCustomer returns the provider customer of the account, creating it once (idempotency
// key customer:{account}; the mapping row is the proof of ownership for every later payment).
func (s *Service) ensureCustomer(ctx context.Context, c caller, p provider.Provider, payer sqlc.BillingPayer) (provider.CustomerRef, error) {
	live := false
	if lr, ok := p.(provider.LivemodeReporter); ok {
		live = lr.Livemode()
	}
	ref := func(bc sqlc.BillingCustomer) provider.CustomerRef {
		return provider.CustomerRef{Provider: p.ID(), ProviderAccount: bc.ProviderAccount, Livemode: bc.Livemode, ID: bc.CustomerID}
	}
	if bc, err := s.db.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: c.acc.ID, Provider: string(p.ID()), Livemode: live}); err == nil {
		return ref(bc), nil
	} else if !db.IsNotFound(err) {
		return provider.CustomerRef{}, err
	}
	email, name := payer.Email, payer.Name
	if email == "" {
		if u, err := s.db.Q.GetUser(ctx, c.user); err == nil && u.Email != nil {
			email = *u.Email
		}
	}
	if name == "" {
		name = c.ws.Name
	}
	cr, err := p.EnsureCustomer(ctx, provider.CustomerReq{
		IdemKey: "customer:" + c.acc.ID.String(), AccountID: c.acc.ID, Email: email, Name: name,
		Metadata: provider.Metadata{AccountID: c.acc.ID},
	})
	if err != nil {
		slog.WarnContext(ctx, "billing: ensure customer", "account", c.acc.ID, "err", err)
		return provider.CustomerRef{}, billing.ErrProviderUnavailable
	}
	bc, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.BillingCustomer, error) {
		return q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{
			AccountID: c.acc.ID, Provider: string(p.ID()), ProviderAccount: cr.ProviderAccount, Livemode: cr.Livemode, CustomerID: cr.ID,
		})
	})
	if db.IsNotFound(err) {
		bc, err = s.db.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: c.acc.ID, Provider: string(p.ID()), Livemode: cr.Livemode})
	} else if err == nil && payer.AccountID != uuid.Nil {
		// A new customer gets the payer's tax ids too (best effort: the checkout goes on).
		s.syncCustomer(ctx, bc, payer)
	}
	if err != nil {
		return provider.CustomerRef{}, err
	}
	return ref(bc), nil
}

func returnURL(base string, checkout uuid.UUID) string {
	u, err := url.Parse(base)
	if err != nil || base == "" {
		return base
	}
	q := u.Query()
	q.Set("checkout", checkout.String())
	u.RawQuery = q.Encode()
	return u.String()
}

// checkout: GET …/billing/checkouts/{cid}. Pulls the provider state while the checkout is open
// or its payment not credited yet (the success redirect lands here through the app) — the same
// path as the webhook, so whichever comes first credits, once.
func (s *Service) checkout(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	cid, err := httpx.PathUUID(r, "cid", "checkout")
	if err != nil {
		return err
	}
	co, err := s.db.Q.GetBillingCheckout(ctx, cid)
	if db.IsNotFound(err) || (err == nil && co.AccountID != c.acc.ID) {
		return httpx.NotFound("checkout")
	}
	if err != nil {
		return err
	}
	credited, pay, err := s.credited(ctx, co)
	if err != nil {
		return err
	}
	if co.Status == inbox.CheckoutOpen || (co.Status == inbox.CheckoutCompleted && !credited) {
		if res, err := s.inbox.SyncCheckout(ctx, co, "pull"); err != nil {
			// The poll answers what we know; the webhook / reconciliation retries.
			slog.WarnContext(ctx, "billing: pull checkout", "checkout", co.ID, "err", err)
		} else {
			co = res.Checkout
			if credited, pay, err = s.credited(ctx, co); err != nil {
				return err
			}
		}
	}
	out := &v1.CheckoutStatus{CheckoutId: co.ID.String(), State: checkoutState(co.Status), Amount: mon(co.AmountMinor, co.Currency),
		Credited: credited, ExpiresAt: ts(co.ExpiresAt)}
	if pay != nil {
		out.PaymentId = pay.ID.String()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// credited: the checkout's payment has its funding lot.
func (s *Service) credited(ctx context.Context, co sqlc.BillingCheckout) (bool, *sqlc.BillingPayment, error) {
	pay, err := s.db.Q.GetBillingPaymentByCheckout(ctx, &co.ID)
	if db.IsNotFound(err) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	if pay.Status != "succeeded" {
		return false, &pay, nil
	}
	_, err = s.db.Q.GetBillingFundingLotByPayment(ctx, &pay.ID)
	if db.IsNotFound(err) {
		return false, &pay, nil
	}
	return err == nil, &pay, err
}
