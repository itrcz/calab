package billinghttp

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// get: GET /api/workspaces/{id}/billing. The owner gets the summary, other members only the
// status (no amounts); a workspace without billing answers the status without a state.
func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	c, err := s.who(r)
	if err != nil {
		return err
	}
	resp, err := s.response(r.Context(), c)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

// response is GET …/billing for the caller.
func (s *Service) response(ctx context.Context, c caller) (*v1.GetBillingResponse, error) {
	source := ""
	if p, err := s.db.Q.GetWorkspacePlan(ctx, c.ws.ID); err == nil {
		source = p.Source
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	var acc *sqlc.BillingAccount
	if c.hasAc {
		acc = &c.acc
	}
	resp := &v1.GetBillingResponse{Status: Status(acc, source)}
	if !c.owner {
		return resp, nil
	}
	if !c.hasAc {
		if !s.canSelfServe(c) {
			return resp, nil
		}
		offers, err := s.offers(ctx, SelfServeMarket, 0, s.now(ctx))
		if err != nil {
			return nil, err
		}
		resp.SelfServe, resp.Offers = true, offers
		return resp, nil
	}
	sum, err := s.summary(ctx, c.acc)
	if err != nil {
		return nil, err
	}
	resp.Summary = sum
	if resp.Offers, err = s.offers(ctx, c.acc.Market, int(c.acc.DiscountBps), s.now(ctx)); err != nil {
		return nil, err
	}
	return resp, nil
}

// summary is the owner's money picture, read in one read-only transaction (no catch-up: the
// worker applies due renewals within a poll, actions catch up themselves).
func (s *Service) summary(ctx context.Context, acc0 sqlc.BillingAccount) (*v1.BillingSummary, error) {
	var out *v1.BillingSummary
	err := s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		q := s.db.Q.WithTx(tx)
		acc, err := q.GetBillingAccount(ctx, acc0.ID)
		if err != nil {
			return err
		}
		qt, err := s.core.QuoteIn(ctx, q, acc, "")
		if err != nil {
			return err
		}
		cur := acc.Currency
		out = &v1.BillingSummary{
			AccountId: acc.ID.String(), Status: accountStatus(acc.Status), Plan: planProto(acc.Plan), Market: acc.Market,
			Balance: mon(acc.BalanceMinor, cur), Debt: mon(qt.DebtMinor, cur), UnitPrice: mon(qt.UnitMinor, cur),
			DiscountBps: uint32(acc.DiscountBps), DailyCost: mon(qt.DailyMinor, cur), //nolint:gosec // 0..10000 (CHECK)
			BillableMembers: uint32(max(qt.Billable, 0)), CoveredSeats: uint32(max(qt.Covered, 0)), //nolint:gosec // non-negative
			NextDueAt: ts(acc.NextDueAt), NegativeSince: ts(acc.NegativeSince), SuspendAt: ts(acc.SuspendAt),
			ForecastDays: -1, Revision: uint64(acc.Revision), //nolint:gosec // revision >= 1 (CHECK)
			Hold: acc.HoldUntil != nil && acc.HoldUntil.After(s.now(ctx)),
		}
		if qt.DailyMinor > 0 {
			out.ForecastDays = int32(min(qt.DaysLeft, 1<<30)) //nolint:gosec // clamped
		}
		payerType, country := "", ""
		if p, err := q.GetBillingPayer(ctx, acc.ID); err == nil {
			out.Payer, payerType, country = payerProto(p), p.Type, p.Country
		} else if !db.IsNotFound(err) {
			return err
		}
		for _, o := range s.reg.Methods(acc.Market, money.Currency(cur), payerType, country) {
			out.Methods = append(out.Methods, methodOption(o))
		}
		if co, err := q.GetOpenBillingCheckout(ctx, acc.ID); err == nil {
			out.OpenCheckoutId = co.ID.String()
		} else if !db.IsNotFound(err) {
			return err
		}
		out.AutoTopup, err = autoTopupSummary(ctx, q, acc, qt)
		return err
	})
	return out, err
}

// autoTopupSummary: the consent (T7 writes it), the limits of the currency and the amount an
// attempt now would charge (debt + 30 days, capped).
func autoTopupSummary(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, qt core.Quote) (*v1.AutoTopupSettings, error) {
	cur := acc.Currency
	out := &v1.AutoTopupSettings{}
	def, lim, ok := provider.AutoTopupLimits(money.Currency(cur))
	if ok {
		out.DefaultMaxAmount, out.LimitMaxAmount = mon(def, cur), mon(lim, cur)
	}
	capMinor := def
	if a, err := q.GetBillingAutoTopup(ctx, acc.ID); err == nil {
		out.Enabled = a.RevokedAt == nil
		out.PaymentMethodId = a.PmID.String()
		out.MaxAmount = mon(a.MaxMinor, cur)
		out.ConsentVersion = uint32(max(a.ConsentVersion, 0)) //nolint:gosec // >= 1 (CHECK)
		out.ConsentAt, out.NotBefore = timestamppb.New(a.ConsentAt), ts(a.NotBefore)
		capMinor = a.MaxMinor
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	if ok {
		out.NextAmount = mon(min(qt.AutoTopupMinor, capMinor), cur)
	}
	if a, err := q.GetLastBillingAutoTopupAttempt(ctx, acc.ID); err == nil {
		out.LastAttempt = &v1.AutoTopupAttempt{Id: a.ID.String(), Amount: mon(a.AmountMinor, a.Currency), Status: attemptStatus(a.Status),
			FailureCode: a.FailureCode, CreatedAt: timestamppb.New(a.CreatedAt), FinishedAt: ts(a.FinishedAt)}
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	return out, nil
}

// quote: POST …/billing/quote. Applies what is due first (core.Quote), then answers what the
// purpose costs now. Amounts are informative; the actions recompute them under the lock.
//
// Self-serve (Config.SelfServe): the owner's ACTIVATE quote of a workspace without a live
// account first creates its inactive account (selfserve.go).
func (s *Service) quote(w http.ResponseWriter, r *http.Request) error {
	c, err := s.who(r)
	if err != nil {
		return err
	}
	if !c.owner {
		return billing.ErrOwnerRequired
	}
	if !c.hasAc && !s.canSelfServe(c) {
		return billing.ErrAccountNotFound
	}
	var req v1.BillingQuoteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	if !c.hasAc {
		if req.GetPurpose() != v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE {
			return billing.ErrAccountNotFound
		}
		if err := s.startSelfServe(ctx, &c); err != nil {
			return err
		}
	}
	plan := c.acc.Plan
	switch req.GetPurpose() {
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN:
		if plan = planName(req.GetPlan()); plan == "" {
			return httpx.Validation("plan", "plan must be PLAN_TEAM or PLAN_ENTERPRISE")
		}
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE:
		if req.GetPlan() != v1.Plan_PLAN_UNSPECIFIED {
			if plan = planName(req.GetPlan()); plan == "" {
				return httpx.Validation("plan", "plan must be PLAN_TEAM or PLAN_ENTERPRISE")
			}
		}
	}
	qt, err := s.core.Quote(ctx, c.acc.ID, plan)
	if err != nil {
		return err
	}
	acc, err := s.db.Q.GetBillingAccount(ctx, c.acc.ID)
	if err != nil {
		return err
	}
	now := s.now(ctx)
	cur := acc.Currency
	out := &v1.BillingQuote{
		QuoteId: quoteID(acc.Revision, now.Add(QuoteTTL)), Purpose: req.GetPurpose(), Plan: planProto(plan),
		Debt: mon(qt.DebtMinor, cur), Charge: mon(0, cur), Compensation: mon(0, cur), ToPay: mon(0, cur),
		UnitPrice: mon(qt.UnitMinor, cur), ExpiresAt: timestamppb.New(now.Add(QuoteTTL)),
		Revision: uint64(acc.Revision), //nolint:gosec // revision >= 1 (CHECK)
	}
	need := func(charge int64) int64 { return max(0, qt.DebtMinor+charge-qt.FreeMinor) }
	switch req.GetPurpose() {
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_RESUME_PAID:
		out.Seats = uint32(max(qt.Billable-qt.Covered, 0)) //nolint:gosec // non-negative
		out.Charge, out.ToPay = mon(qt.FirstDayMinor, cur), mon(need(qt.FirstDayMinor), cur)
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN:
		comp, err := s.compensation(ctx, acc, now)
		if err != nil {
			return err
		}
		out.Seats = uint32(max(qt.Billable, 0)) //nolint:gosec // non-negative
		out.Compensation, out.Charge = mon(comp, cur), mon(qt.DailyMinor, cur)
		out.ToPay = mon(max(0, qt.DebtMinor+qt.DailyMinor-qt.FreeMinor-comp), cur)
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_RESUME_FREE:
		out.ToPay = mon(qt.DebtMinor, cur)
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP:
		// Running lots stay until their end: nothing is charged or returned.
	default:
		return httpx.Validation("purpose", "unknown purpose")
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// compensation estimates what a plan change returns now: the unused seat-time of the current
// plan's lots, with the core's half-up cumulative rule (amount × canceled seat-time / lot
// seat-time).
func (s *Service) compensation(ctx context.Context, acc sqlc.BillingAccount, now time.Time) (int64, error) {
	lots, err := s.db.Q.ListBillingChargesActiveAt(ctx, sqlc.ListBillingChargesActiveAtParams{AccountID: acc.ID, At: now})
	if err != nil {
		return 0, err
	}
	var total int64
	for _, ch := range lots {
		if ch.Plan != acc.Plan || ch.Qty <= ch.CanceledQty {
			continue
		}
		whole := ch.EndsAt.Sub(ch.StartsAt).Microseconds() * int64(ch.Qty)
		rest := ch.EndsAt.Sub(now).Microseconds() * int64(ch.Qty-ch.CanceledQty)
		cum, err := money.MulDivHalfUp(ch.AmountMinor, min(ch.CanceledSeatUs+rest, whole), whole)
		if err != nil {
			return 0, err
		}
		total += max(0, cum-ch.CompensatedMinor)
	}
	return total, nil
}

// actionRequest is what the four actions share.
type actionRequest struct {
	quoteID, requestID string
	expected           uint64
}

// act runs one owner action: request_id audit (replay / 409), quote expiry, expected
// revision, then the core command; answers the fresh GET …/billing.
func (s *Service) act(w http.ResponseWriter, r *http.Request, action string, body actionRequest, hashOf []byte,
	run func(ctx context.Context, c caller, requestID uuid.UUID) error) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	reqID, err := parseRequestID(body.requestID)
	if err != nil {
		return err
	}
	replay, err := s.audit(ctx, c, action, reqID, hashOf)
	if err != nil {
		return err
	}
	if !replay {
		if err := checkQuote(body.quoteID, s.now(ctx)); err != nil {
			return err
		}
		if err := checkRevision(body.expected, c.acc); err != nil {
			return err
		}
	}
	if err := run(ctx, c, reqID); err != nil {
		return err
	}
	if c.acc, err = s.db.Q.GetBillingAccount(ctx, c.acc.ID); err != nil {
		return err
	}
	resp, err := s.response(ctx, c)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (s *Service) activate(w http.ResponseWriter, r *http.Request) error {
	var req v1.BillingActionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	// The paid plan to start: the request's (the plan screen), else the account's.
	plan := ""
	if req.GetPlan() != v1.Plan_PLAN_UNSPECIFIED {
		if plan = planName(req.GetPlan()); plan == "" {
			return httpx.Validation("plan", "plan must be PLAN_TEAM or PLAN_ENTERPRISE")
		}
	}
	return s.act(w, r, "owner.activate", actionRequest{req.GetQuoteId(), req.GetRequestId(), req.GetExpectedRevision()},
		bodyHash("activate", &v1.BillingActionRequest{Plan: req.GetPlan()}), func(ctx context.Context, c caller, id uuid.UUID) error {
			p := plan
			if p == "" {
				p = c.acc.Plan
			}
			_, err := s.core.Activate(ctx, c.acc.ID, p, id, &c.user)
			return err
		})
}

func (s *Service) stop(w http.ResponseWriter, r *http.Request) error {
	var req v1.BillingActionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	return s.act(w, r, "owner.stop", actionRequest{req.GetQuoteId(), req.GetRequestId(), req.GetExpectedRevision()},
		bodyHash("stop", &v1.BillingActionRequest{}), func(ctx context.Context, c caller, _ uuid.UUID) error {
			_, err := s.core.Stop(ctx, c.acc.ID, &c.user)
			return err
		})
}

func (s *Service) changePlan(w http.ResponseWriter, r *http.Request) error {
	var req v1.ChangeBillingPlanRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	plan := planName(req.GetPlan())
	if plan == "" {
		return httpx.Validation("plan", "plan must be PLAN_TEAM or PLAN_ENTERPRISE")
	}
	return s.act(w, r, "owner.change_plan", actionRequest{req.GetQuoteId(), req.GetRequestId(), req.GetExpectedRevision()},
		bodyHash("change_plan", &v1.ChangeBillingPlanRequest{Plan: req.GetPlan()}), func(ctx context.Context, c caller, id uuid.UUID) error {
			_, err := s.core.ChangePlan(ctx, c.acc.ID, plan, id, &c.user)
			return err
		})
}

func (s *Service) resume(w http.ResponseWriter, r *http.Request) error {
	var req v1.ResumeBillingRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	mode := ""
	switch req.GetMode() {
	case v1.BillingResumeMode_BILLING_RESUME_MODE_FREE:
		mode = core.ResumeFree
	case v1.BillingResumeMode_BILLING_RESUME_MODE_PAID:
		mode = core.ResumePaid
	default:
		return httpx.Validation("mode", "mode must be FREE or PAID")
	}
	return s.act(w, r, "owner.resume", actionRequest{req.GetQuoteId(), req.GetRequestId(), req.GetExpectedRevision()},
		bodyHash("resume", &v1.ResumeBillingRequest{Mode: req.GetMode()}), func(ctx context.Context, c caller, id uuid.UUID) error {
			_, err := s.core.Resume(ctx, c.acc.ID, mode, c.acc.Plan, id, &c.user)
			return err
		})
}

func (s *Service) getPayer(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	p, err := s.db.Q.GetBillingPayer(r.Context(), c.acc.ID)
	if db.IsNotFound(err) {
		httpx.Write(w, http.StatusOK, &v1.PayerProfile{})
		return nil
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, payerProto(p))
	return nil
}

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

func (s *Service) putPayer(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	var req v1.PutPayerRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	in := req.GetPayer()
	typ := ""
	switch in.GetType() {
	case v1.PayerType_PAYER_TYPE_PERSON:
		typ = provider.PayerPerson
	case v1.PayerType_PAYER_TYPE_COMPANY:
		typ = provider.PayerCompany
	default:
		return httpx.Validation("payer.type", "type must be PERSON or COMPANY")
	}
	name := strings.TrimSpace(in.GetName())
	if n := len([]rune(name)); n < 1 || n > 200 {
		return httpx.Validation("payer.name", "name must be 1..200 characters")
	}
	country := strings.ToUpper(strings.TrimSpace(in.GetCountry()))
	if !countryCode.MatchString(country) {
		return httpx.Validation("payer.country", "country must be an ISO 3166-1 alpha-2 code")
	}
	email := strings.TrimSpace(in.GetEmail())
	if len(email) < 3 || len(email) > 320 || !strings.Contains(email, "@") || strings.ContainsAny(email, " \r\n") {
		return httpx.Validation("payer.email", "invalid email")
	}
	var taxID *string
	if t := strings.TrimSpace(in.GetTaxId()); t != "" {
		if len([]rune(t)) > 64 {
			return httpx.Validation("payer.tax_id", "tax id is at most 64 characters")
		}
		taxID = &t
	}
	ctx := r.Context()
	p, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.BillingPayer, error) {
		return q.UpsertBillingPayer(ctx, sqlc.UpsertBillingPayerParams{
			AccountID: c.acc.ID, Type: typ, Name: name, Country: country, Email: email, TaxID: taxID, UpdatedBy: &c.user, Now: s.now(ctx),
		})
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, payerProto(p))
	return nil
}
