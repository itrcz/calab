package autotopup

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// ReconcileRoute is the superadmin route of the restore reconcile (identity scope admin).
const ReconcileRoute = "POST /api/admin/billing/auto-topup/reconcile"

// auditAction of the reconcile in billing_audit (details.marker = the restore marker).
const auditAction = "auto_topup.reconcile"

// Paused reports whether new attempts wait for the restore reconcile: a RestoreMarker is set and
// billing_audit has no reconcile of it yet. Once found it is cached for the process.
func (j *Job) Paused(ctx context.Context) (bool, error) {
	if j.opts.RestoreMarker == "" {
		return false, nil
	}
	j.mu.Lock()
	done := j.reconciled
	j.mu.Unlock()
	if done {
		return false, nil
	}
	ok, err := j.db.Q.BillingAutoTopupReconciled(ctx, j.opts.RestoreMarker)
	if err != nil {
		return true, err
	}
	if ok {
		j.mu.Lock()
		j.reconciled = true
		j.mu.Unlock()
	}
	return !ok, nil
}

// ReconcileResult is what the restore reconcile found.
type ReconcileResult struct {
	Customers int // customers listed
	Payments  int // auto-topup payments seen at the provider
	Credited  int // payments credited now (unknown to the restored database)
	Settled   int // local attempts settled by a payment found
}

// Reconcile lists the auto-topup payments of the last ReconcileWindow of every customer with a
// consent or an attempt, credits the succeeded ones the database does not have (once, through
// the inbox), settles local attempts and pushes not_before to 24 h after the newest payment of
// each account. The first error is returned after every customer was tried.
func (j *Job) Reconcile(ctx context.Context) (ReconcileResult, error) {
	var res ReconcileResult
	now, err := j.clock.Now(ctx, j.db.Q)
	if err != nil {
		return res, err
	}
	since := now.Add(-ReconcileWindow)
	custs, err := j.db.Q.ListBillingAutoTopupReconcileCustomers(ctx, since)
	if err != nil {
		return res, err
	}
	var errs []error
	for _, c := range custs {
		p, ok := j.reg.Provider(provider.ID(c.Provider))
		if !ok || !p.Caps().Has(provider.CapListPayments) {
			errs = append(errs, errors.New("auto-topup reconcile: provider "+c.Provider+" cannot list payments"))
			continue
		}
		res.Customers++
		if err := j.reconcileCustomer(ctx, p, c, billing.ProviderSince(now, ReconcileWindow), &res); err != nil {
			slog.WarnContext(ctx, "billing auto-topup reconcile: customer", "customer", c.ID, "err", err)
			errs = append(errs, err)
		}
	}
	return res, errors.Join(errs...)
}

func (j *Job) reconcileCustomer(ctx context.Context, p provider.Provider, c sqlc.BillingCustomer, since time.Time, res *ReconcileResult) error {
	ref := provider.CustomerRef{Provider: p.ID(), ProviderAccount: c.ProviderAccount, Livemode: c.Livemode, ID: c.CustomerID}
	var newest time.Time
	var errs []error
	cursor := ""
	for range 10 {
		facts, next, err := p.ListPayments(ctx, provider.ListReq{Customer: ref, CreatedAfter: since, Kind: provider.MetadataKindAutoTopup, Cursor: cursor, Limit: 100})
		if err != nil {
			return err
		}
		for _, f := range facts {
			res.Payments++
			if f.Created.After(newest) {
				newest = f.Created
			}
			errs = append(errs, j.reconcilePayment(ctx, p, c, f, res))
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if !newest.IsZero() {
		errs = append(errs, j.db.Tx(ctx, func(q *sqlc.Queries) error {
			if _, err := q.LockBillingAccount(ctx, c.AccountID); err != nil {
				return err
			}
			now, err := j.clock.Now(ctx, q)
			if err != nil {
				return err
			}
			return q.SetBillingAutoTopupNotBefore(ctx, sqlc.SetBillingAutoTopupNotBeforeParams{NotBefore: newest.Add(MinInterval), Now: now, AccountID: c.AccountID})
		}))
	}
	return errors.Join(errs...)
}

func (j *Job) reconcilePayment(ctx context.Context, p provider.Provider, c sqlc.BillingCustomer, f provider.PaymentFact, res *ReconcileResult) error {
	if id := f.Metadata.AttemptID; id != uuid.Nil {
		att, err := j.db.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: id, AccountID: c.AccountID})
		switch {
		case err == nil && att.Status != statusSucceeded:
			t, err := j.targetOf(ctx, att)
			if err != nil {
				return err
			}
			res.Settled++
			before := j.creditedNow(ctx, p, f)
			if err := j.settle(ctx, t, att, f); err != nil {
				return err
			}
			if !before && j.creditedNow(ctx, p, f) {
				res.Credited++
			}
			return nil
		case err != nil && !db.IsNotFound(err):
			return err
		}
	}
	if f.Status != provider.PaymentSucceeded && f.Status != provider.PaymentProcessing {
		return nil
	}
	r, err := j.inbox.ApplyPaymentFact(ctx, p, f)
	if err != nil {
		return err
	}
	if r.Fresh {
		res.Credited++
	}
	return nil
}

// creditedNow: the payment is recorded as succeeded (for the reconcile report).
func (j *Job) creditedNow(ctx context.Context, p provider.Provider, f provider.PaymentFact) bool {
	pay, err := j.db.Q.GetBillingPaymentByProviderID(ctx, sqlc.GetBillingPaymentByProviderIDParams{
		Provider: string(p.ID()), ProviderAccount: f.ProviderAccount, Livemode: f.Livemode, ProviderPaymentID: f.ID,
	})
	return err == nil && pay.Status == "succeeded"
}

// ReconcileHandler serves ReconcileRoute: {reason, request_id} (v1.AdminReconcileRequest).
// The app has checked superadmin + recent local auth (identity scope admin); bots and
// non-local principals get 404 like the rest of /api/admin/billing. A retry of request_id
// answers replayed without listing again; the marker is recorded only after a clean run.
func (j *Job) ReconcileHandler() httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		ctx := r.Context()
		id, ok := auth.FromContext(ctx)
		if !ok || id.IsBot || id.Principal.Authority != identitypolicy.LocalAccount {
			return httpx.NotFound("route")
		}
		var req v1.AdminReconcileRequest
		if err := httpx.DecodeStrict(w, r, &req); err != nil {
			return err
		}
		reason := req.GetReason()
		if n := utf8.RuneCountInString(reason); n < 5 || n > 1000 {
			return httpx.Validation("reason", "reason must be 5..1000 characters")
		}
		reqID, err := uuid.Parse(req.GetRequestId())
		if err != nil || reqID == uuid.Nil {
			return httpx.Validation("request_id", "request_id must be a uuid")
		}
		h := sha256.Sum256([]byte(auditAction + "\x00" + j.opts.RestoreMarker + "\x00" + reason))
		if old, err := j.db.Q.GetBillingAuditByRequest(ctx, reqID); err == nil {
			if old.Action != auditAction || string(old.BodyHash) != string(h[:]) {
				return billing.ErrRequestReused
			}
			httpx.Write(w, http.StatusOK, &v1.AdminBillingMutationResult{Action: auditAction, AuditId: old.ID.String(), Replayed: true})
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		res, err := j.Reconcile(ctx)
		slog.InfoContext(ctx, "billing auto-topup reconcile", "user", id.UserID, "marker", j.opts.RestoreMarker,
			"customers", res.Customers, "payments", res.Payments, "credited", res.Credited, "settled", res.Settled, "err", err)
		if err != nil {
			return billing.ErrProviderUnavailable
		}
		details, _ := json.Marshal(map[string]any{ //nolint:errchkjson // plain values
			"marker": j.opts.RestoreMarker, "customers": res.Customers, "payments": res.Payments,
			"credited": res.Credited, "settled": res.Settled,
		})
		row, err := db.GuardValue(ctx, j.db, func(q *sqlc.Queries) (sqlc.BillingAudit, error) {
			return q.InsertBillingAudit(ctx, sqlc.InsertBillingAuditParams{
				RequestID: reqID, BodyHash: h[:], ActorID: &id.UserID, Action: auditAction, Reason: reason, Details: details,
			})
		})
		if db.IsNotFound(err) {
			return billing.ErrRequestReused // a concurrent request with the same id
		}
		if err != nil {
			return err
		}
		j.mu.Lock()
		j.reconciled = j.opts.RestoreMarker != ""
		j.mu.Unlock()
		httpx.Write(w, http.StatusOK, &v1.AdminBillingMutationResult{Action: auditAction, AuditId: row.ID.String()})
		return nil
	}
}
