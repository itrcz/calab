package admin

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Page sizes of the admin lists (?limit=).
const (
	defaultLimit = 50
	maxLimit     = 200
)

// page reads ?limit= and the uuid ?cursor= (the id of the last row of the previous page).
func page(r *http.Request) (int32, *uuid.UUID, error) {
	lim := int32(defaultLimit)
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return 0, nil, httpx.Validation("limit", "limit must be 1..200")
		}
		lim = int32(n) //nolint:gosec // bounded above
	}
	c := r.URL.Query().Get("cursor")
	if c == "" {
		return lim, nil, nil
	}
	id, err := uuid.Parse(c)
	if err != nil {
		return 0, nil, httpx.Validation("cursor", "invalid cursor")
	}
	return lim, &id, nil
}

// optUUID reads an optional uuid query filter.
func optUUID(r *http.Request, name string) (*uuid.UUID, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return nil, nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil, httpx.Validation(name, name+" must be a uuid")
	}
	return &id, nil
}

// oneOf reads an optional enumerated query filter.
func oneOf(r *http.Request, name string, allowed ...string) (string, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return "", nil
	}
	for _, a := range allowed {
		if s == a {
			return s, nil
		}
	}
	return "", httpx.Validation(name, name+" must be one of "+strings.Join(allowed, ", "))
}

func boolParam(r *http.Request, name string) (bool, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return false, nil
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, httpx.Validation(name, name+" must be 1 or 0")
	}
	return v, nil
}

func next(n int, lim int32, last uuid.UUID) string {
	if n < int(lim) {
		return ""
	}
	return last.String()
}

// likePattern escapes LIKE wildcards so the query matches literally.
func likePattern(q string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
}

// listAccounts: GET /api/admin/billing/accounts?q=&status=&cursor=&limit= — q: account id,
// workspace id, workspace name or owner email.
func (h *Handlers) listAccounts(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "inactive", "active", "stopped", "suspended", "closed")
	if err != nil {
		return err
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 100 {
		return httpx.Validation("q", "query must be at most 100 characters")
	}
	rows, err := h.d.DB.Q.AdminListBillingAccounts(r.Context(), sqlc.AdminListBillingAccountsParams{Status: status, BeforeID: before, Q: q, Pattern: likePattern(q), Lim: lim})
	if err != nil {
		return err
	}
	out := &v1.AdminBillingAccounts{Accounts: make([]*v1.AdminBillingAccount, 0, len(rows))}
	for _, row := range rows {
		out.Accounts = append(out.Accounts, accountProto(accountRow{acc: row.BillingAccount, wsName: row.WorkspaceName, email: row.OwnerEmail, billable: row.BillableMembers}))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].BillingAccount.ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// getAccount: GET /api/admin/billing/accounts/{id} — account, payer, auto-topup consent, open
// disputes, free advance and pending refunds.
func (h *Handlers) getAccount(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	ctx, q := r.Context(), h.d.DB.Q
	acc, err := h.account(ctx, q, id)
	if err != nil {
		return err
	}
	cur := acc.GetBalance().GetCurrency()
	out := &v1.AdminBillingAccountDetails{Account: acc}
	if p, err := q.GetBillingPayer(ctx, id); err == nil {
		out.Payer = payerProto(p)
	} else if !db.IsNotFound(err) {
		return err
	}
	if a, err := q.GetBillingAutoTopup(ctx, id); err == nil {
		out.AutoTopup = autoTopupProto(a, cur)
	} else if !db.IsNotFound(err) {
		return err
	}
	disputes, err := q.AdminListBillingDisputes(ctx, sqlc.AdminListBillingDisputesParams{AccountID: &id, Status: "open", Lim: maxLimit})
	if err != nil {
		return err
	}
	for _, d := range disputes {
		out.OpenDisputes = append(out.OpenDisputes, disputeProto(d))
	}
	free, err := q.BillingFreeAdvance(ctx, id)
	if err != nil {
		return err
	}
	pending, err := q.AdminBillingPendingRefunds(ctx, id)
	if err != nil {
		return err
	}
	out.FreeAdvance, out.PendingRefunds = money(free, cur), money(pending, cur)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ledger: GET /api/admin/billing/accounts/{id}/ledger?cursor={seq}&limit= — newest first.
func (h *Handlers) ledger(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	lim := int32(defaultLimit)
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return httpx.Validation("limit", "limit must be 1..200")
		}
		lim = int32(n) //nolint:gosec // bounded above
	}
	var before int64
	if s := r.URL.Query().Get("cursor"); s != "" {
		if before, err = strconv.ParseInt(s, 10, 64); err != nil || before < 1 {
			return httpx.Validation("cursor", "invalid cursor")
		}
	}
	ctx := r.Context()
	acc, err := h.d.DB.Q.GetBillingAccount(ctx, id)
	if db.IsNotFound(err) {
		return httpx.NotFound("billing account")
	}
	if err != nil {
		return err
	}
	rows, err := h.d.DB.Q.AdminListBillingLedger(ctx, sqlc.AdminListBillingLedgerParams{AccountID: id, BeforeSeq: before, Lim: lim})
	if err != nil {
		return err
	}
	out := &v1.LedgerPage{Entries: make([]*v1.LedgerEntry, 0, len(rows))}
	for _, row := range rows {
		out.Entries = append(out.Entries, ledgerProto(row, acc.Currency))
	}
	if n := len(rows); n == int(lim) && rows[n-1].BillingLedger.Seq > 1 {
		out.NextCursor = strconv.FormatInt(rows[n-1].BillingLedger.Seq, 10)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// payments: GET /api/admin/billing/payments?account_id=&status=&provider_payment_id=&cursor=&limit=
func (h *Handlers) payments(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	acc, err := optUUID(r, "account_id")
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "processing", "succeeded", "failed", "canceled")
	if err != nil {
		return err
	}
	rows, err := h.d.DB.Q.AdminListBillingPayments(r.Context(), sqlc.AdminListBillingPaymentsParams{
		AccountID: acc, Status: status, ProviderPaymentID: r.URL.Query().Get("provider_payment_id"), BeforeID: before, Lim: lim,
	})
	if err != nil {
		return err
	}
	out := &v1.AdminBillingPayments{Payments: make([]*v1.AdminBillingPayment, 0, len(rows))}
	for _, row := range rows {
		out.Payments = append(out.Payments, paymentProto(row.BillingPayment, row.WorkspaceID))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].BillingPayment.ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// refunds: GET /api/admin/billing/refunds?account_id=&payment_id=&status=&cursor=&limit=
func (h *Handlers) refunds(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	acc, err := optUUID(r, "account_id")
	if err != nil {
		return err
	}
	pay, err := optUUID(r, "payment_id")
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "pending", "requires_action", "succeeded", "failed", "canceled")
	if err != nil {
		return err
	}
	rows, err := h.d.DB.Q.AdminListBillingRefunds(r.Context(), sqlc.AdminListBillingRefundsParams{AccountID: acc, PaymentID: pay, Status: status, BeforeID: before, Lim: lim})
	if err != nil {
		return err
	}
	out := &v1.AdminBillingRefunds{Refunds: make([]*v1.AdminBillingRefund, 0, len(rows))}
	for _, row := range rows {
		out.Refunds = append(out.Refunds, refundProto(row))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// refundRequests: GET /api/admin/billing/refund-requests?account_id=&status=&cursor=&limit=
func (h *Handlers) refundRequests(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	acc, err := optUUID(r, "account_id")
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "requested", "approved", "rejected", "withdrawn")
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := h.d.DB.Q.AdminListBillingRefundRequests(ctx, sqlc.AdminListBillingRefundRequestsParams{AccountID: acc, Status: status, BeforeID: before, Lim: lim})
	if err != nil {
		return err
	}
	currencies := map[uuid.UUID]string{}
	out := &v1.AdminBillingRefundRequests{Requests: make([]*v1.AdminBillingRefundRequest, 0, len(rows))}
	for _, row := range rows {
		rr := row.BillingRefundRequest
		cur, ok := currencies[rr.AccountID]
		if !ok {
			a, err := h.d.DB.Q.GetBillingAccount(ctx, rr.AccountID)
			if err != nil {
				return err
			}
			cur, currencies[rr.AccountID] = a.Currency, a.Currency
		}
		out.Requests = append(out.Requests, refundRequestProto(rr, row.WorkspaceID, cur))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].BillingRefundRequest.ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// disputes: GET /api/admin/billing/disputes?account_id=&status=open|closed&cursor=&limit=
func (h *Handlers) disputes(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	acc, err := optUUID(r, "account_id")
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "open", "closed")
	if err != nil {
		return err
	}
	rows, err := h.d.DB.Q.AdminListBillingDisputes(r.Context(), sqlc.AdminListBillingDisputesParams{AccountID: acc, Status: status, BeforeID: before, Lim: lim})
	if err != nil {
		return err
	}
	out := &v1.AdminBillingDisputes{Disputes: make([]*v1.AdminBillingDispute, 0, len(rows))}
	for _, row := range rows {
		out.Disputes = append(out.Disputes, disputeProto(row))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// events: GET /api/admin/billing/events?errors=1&unprocessed=1&kind=&cursor=&limit= — the
// webhook inbox for operations (failing events with their error and attempts).
func (h *Handlers) events(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	errorsOnly, err := boolParam(r, "errors")
	if err != nil {
		return err
	}
	unprocessed, err := boolParam(r, "unprocessed")
	if err != nil {
		return err
	}
	kind := r.URL.Query().Get("kind")
	if len(kind) > 64 {
		return httpx.Validation("kind", "kind too long")
	}
	rows, err := h.d.DB.Q.AdminListBillingProviderEvents(r.Context(), sqlc.AdminListBillingProviderEventsParams{
		ErrorsOnly: errorsOnly, UnprocessedOnly: unprocessed, Kind: kind, BeforeID: before, Lim: lim,
	})
	if err != nil {
		return err
	}
	out := &v1.AdminProviderEvents{Events: make([]*v1.AdminProviderEvent, 0, len(rows))}
	for _, row := range rows {
		out.Events = append(out.Events, eventProto(row))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
