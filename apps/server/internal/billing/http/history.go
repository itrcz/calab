package billinghttp

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// pageSize of the owner history lists.
const pageSize = 50

// ledger: GET …/billing/ledger?cursor= (cursor = the seq to continue below).
func (s *Service) ledger(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	var before int64
	if cur := r.URL.Query().Get("cursor"); cur != "" {
		if before, err = strconv.ParseInt(cur, 10, 64); err != nil || before < 1 {
			return httpx.Validation("cursor", "malformed cursor")
		}
	}
	rows, err := s.db.Q.ListBillingLedgerPage(r.Context(), sqlc.ListBillingLedgerPageParams{AccountID: c.acc.ID, BeforeSeq: before, Lim: pageSize + 1})
	if err != nil {
		return err
	}
	out := &v1.LedgerPage{}
	for i, e := range rows {
		if i == pageSize {
			out.NextCursor = strconv.FormatInt(rows[i-1].Seq, 10)
			break
		}
		out.Entries = append(out.Entries, ledgerEntry(e, c.acc.Currency))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// payments: GET …/billing/payments?cursor= (cursor = the payment id to continue below).
func (s *Service) payments(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	var before *uuid.UUID
	if cur := r.URL.Query().Get("cursor"); cur != "" {
		id, err := uuid.Parse(cur)
		if err != nil {
			return httpx.Validation("cursor", "malformed cursor")
		}
		before = &id
	}
	rows, err := s.db.Q.ListBillingPayments(r.Context(), sqlc.ListBillingPaymentsParams{AccountID: c.acc.ID, BeforeID: before, Lim: pageSize + 1})
	if err != nil {
		return err
	}
	out := &v1.BillingPaymentPage{}
	for i, p := range rows {
		if i == pageSize {
			out.NextCursor = rows[i-1].ID.String()
			break
		}
		out.Payments = append(out.Payments, PaymentProto(p))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) refundRequests(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListBillingRefundRequests(r.Context(), sqlc.ListBillingRefundRequestsParams{AccountID: c.acc.ID, Lim: 100})
	if err != nil {
		return err
	}
	out := &v1.BillingRefundRequests{}
	for _, rr := range rows {
		out.Requests = append(out.Requests, RefundRequestProto(rr, c.acc.Currency))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// createRefundRequest: POST …/billing/refund-requests. The owner asks for unused money back; a
// superadmin decides (T6) and refunds it to the original payments. The amount may not exceed
// the free advance now; request_id makes a retry return the same request.
func (s *Service) createRefundRequest(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	var req v1.CreateRefundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	reqID, err := parseRequestID(req.GetRequestId())
	if err != nil {
		return err
	}
	amt := req.GetAmount()
	if amt.GetCurrency() != c.acc.Currency {
		return billing.ErrCurrencyMismatch
	}
	if amt.GetMinor() <= 0 {
		return httpx.Validation("amount", "amount must be positive")
	}
	reason := strings.TrimSpace(req.GetReason())
	if len([]rune(reason)) > 1000 {
		return httpx.Validation("reason", "reason is at most 1000 characters")
	}
	ctx := r.Context()
	var rr sqlc.BillingRefundRequest
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, c.acc.ID)
		if err != nil {
			return err
		}
		if old, err := q.GetBillingRefundRequestByRequest(ctx, sqlc.GetBillingRefundRequestByRequestParams{AccountID: acc.ID, RequestID: reqID}); err == nil {
			if old.AmountMinor != amt.GetMinor() || old.Reason != reason {
				return billing.ErrRequestReused
			}
			rr = old
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		if acc.DisputeHold {
			return billing.ErrDisputeHold
		}
		free, err := q.BillingFreeAdvance(ctx, acc.ID)
		if err != nil {
			return err
		}
		if amt.GetMinor() > free {
			return billing.ErrRefundExceedsRefundable
		}
		rr, err = q.InsertBillingRefundRequest(ctx, sqlc.InsertBillingRefundRequestParams{
			AccountID: acc.ID, RequestID: reqID, AmountMinor: amt.GetMinor(), Reason: reason, RequestedBy: &c.user,
		})
		return err
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, RefundRequestProto(rr, c.acc.Currency))
	return nil
}

// methods: GET …/billing/payment-methods (cards saved by checkouts with save_method).
func (s *Service) methods(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListBillingPaymentMethods(r.Context(), c.acc.ID)
	if err != nil {
		return err
	}
	out := &v1.SavedPaymentMethods{}
	for _, m := range rows {
		out.Methods = append(out.Methods, SavedMethodProto(s.reg, s.cfg.SavedMethodTopups, c.acc, m))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// deleteMethod: DELETE …/billing/payment-methods/{pmId}. Our row first (detached, and an
// auto-topup consent on this card revoked: nothing can charge it from now on), then the
// provider detach; a provider failure answers 503 and the retry detaches again. Tochka cannot
// cancel a subscription without a schedule: the card stays bound at the bank but is never
// charged again (ADR-0083 phase 2).
func (s *Service) deleteMethod(w http.ResponseWriter, r *http.Request) error {
	c, err := s.ownerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	id, err := httpx.PathUUID(r, "pmId", "payment method")
	if err != nil {
		return err
	}
	m, err := s.db.Q.GetBillingPaymentMethod(ctx, id)
	if db.IsNotFound(err) || (err == nil && m.AccountID != c.acc.ID) {
		return httpx.NotFound("payment method")
	}
	if err != nil {
		return err
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, c.acc.ID); err != nil {
			return err
		}
		now := s.now(ctx)
		if _, err := q.DetachBillingPaymentMethod(ctx, sqlc.DetachBillingPaymentMethodParams{Now: now, ID: m.ID}); err != nil {
			return err
		}
		_, err := q.RevokeBillingAutoTopupForMethod(ctx, sqlc.RevokeBillingAutoTopupForMethodParams{Now: now, Reason: "method_deleted", PmID: m.ID})
		return err
	})
	if err != nil {
		return err
	}
	charger, ok := s.reg.OffSession(provider.ID(m.Provider))
	if ok {
		if err := charger.DetachMethod(ctx, m.ProviderPmID); err != nil && !errors.Is(err, provider.ErrNotFound) {
			slog.WarnContext(ctx, "billing: detach payment method", "method", m.ID, "err", err)
			return billing.ErrProviderUnavailable
		}
	}
	httpx.NoContent(w)
	return nil
}
