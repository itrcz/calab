// Package admin is the superadmin billing API, /api/admin/billing (ADR-0080 v5 §13, T6).
//
// # Access
//
// The app classifies every route as identity scope admin: superadmin (ProductAdmin) and a
// recent local authentication (/api/auth/local/reauth), else 404 / 403 RECENT_AUTH_REQUIRED
// before a handler runs. The handlers additionally answer 404 to bots and non-local
// principals, like plans.Admin.
//
// # Commands
//
// Every mutation takes request_id (uuid) and reason (5..1000 characters) and is idempotent by
// request_id: the same request_id with the same body (action, target ids and the request
// without its preview flag, sha256) answers the same result again (replayed = true); another
// body answers 409 BILLING_REQUEST_REUSED. preview (body field or ?preview=1) answers the
// effect and writes nothing (no audit row either).
//
// Every mutation writes one billing_audit row (request_id UNIQUE, actor, reason, before /
// after summary). Two shapes:
//
//   - Commands of this package (hold, discount, price versions, refunds, refund request
//     decisions) run in one transaction with their audit row; a preview runs the same
//     transaction and rolls it back, so it is exact.
//   - Core commands that own their transaction (EnableAccount, AdminCredit, AdminDebit,
//     ReverseAdminCredit) and reconcile: the audit row is written ahead, under the account
//     lock after the preconditions were checked, with the expected after state; then the
//     command runs (idempotent by request_id / its business key). A retry of the same
//     request_id finishes a command interrupted after its audit row. The ledger (actor,
//     reason, business keys with the request_id) is the record of what moved.
//
// Refunds: the reservation (core.ReserveRefund) commits with the audit row; the provider is
// called after the commit with Idempotency-Key = billing_refunds.idem_key; its answer goes
// through core.ApplyRefundResult (failed / canceled release the reservation). An unknown
// outcome leaves the refund pending for the webhook / reconciliation; a retry of the same
// request_id asks the provider again with the same key.
package admin

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// Reconciler re-reads one account's provider objects (payments, refunds, disputes) and
// applies what is missing (T5). Nil: POST …/reconcile answers 501.
type Reconciler interface {
	ReconcileAccount(ctx context.Context, accountID uuid.UUID) error
}

// Limiter rate-limits a superadmin (redisx.RateLimiter).
type Limiter interface {
	Take(ctx context.Context, key string) error
}

// Deps are the collaborators of the admin API.
type Deps struct {
	DB    *db.DB
	Core  *core.Core
	Clock billing.Clock // the core's clock
	// Providers executes refunds (nil: refunds stay pending until reconciliation).
	Providers *provider.Registry
	// ProviderSpec is BILLING_PROVIDERS: the provider an enabled account of a market gets.
	ProviderSpec string
	Reconciler   Reconciler
	// TestClock is the core's clock when TestClockAllowed; nil: POST …/test-clock is 404.
	TestClock *billing.SwitchClock
	Limiter   Limiter
	// Committed runs after a command of this package committed a change of acc (refund,
	// hold, discount): BILLING_UPDATE to the owner (T5). Core commands notify through
	// core.Hooks.Committed.
	Committed func(ctx context.Context, acc sqlc.BillingAccount)
}

// TestClockAllowed reports whether the test clock endpoint may exist (BILLING_TEST_CLOCK=1, never with live
// Stripe keys or livemode allowed). Wiring creates the core with a billing.SwitchClock then.
func TestClockAllowed(cfg config.Billing) bool {
	return cfg.TestClock && !cfg.StripeLiveKey() && !cfg.StripeLivemodeAllowed
}

// Handlers serves /api/admin/billing.
type Handlers struct {
	d Deps
}

// New creates the admin handlers.
func New(d Deps) *Handlers { return &Handlers{d: d} }

// Handlers maps each admin route pattern (billinghttp.AdminRoutes) to its guarded handler,
// for billinghttp.Handlers.Handlers.
func (h *Handlers) Handlers() map[string]httpx.HandlerFunc {
	m := map[string]httpx.HandlerFunc{
		"GET /api/admin/billing/accounts":                                         h.listAccounts,
		"GET /api/admin/billing/accounts/{id}":                                    h.getAccount,
		"GET /api/admin/billing/accounts/{id}/ledger":                             h.ledger,
		"GET /api/admin/billing/payments":                                         h.payments,
		"GET /api/admin/billing/refunds":                                          h.refunds,
		"GET /api/admin/billing/refund-requests":                                  h.refundRequests,
		"GET /api/admin/billing/disputes":                                         h.disputes,
		"GET /api/admin/billing/events":                                           h.events,
		"POST /api/admin/billing/workspaces/{id}/enable":                          h.enable,
		"POST /api/admin/billing/accounts/{id}/manual-credits":                    h.manualCredit,
		"POST /api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse": h.reverseCredit,
		"POST /api/admin/billing/accounts/{id}/admin-debit":                       h.adminDebit,
		"POST /api/admin/billing/payments/{id}/refunds":                           h.refund,
		"POST /api/admin/billing/refund-requests/{id}/decide":                     h.decideRefundRequest,
		"POST /api/admin/billing/accounts/{id}/hold":                              h.hold,
		"POST /api/admin/billing/accounts/{id}/reconcile":                         h.reconcile,
		"PUT /api/admin/billing/accounts/{id}/discount":                           h.discount,
		"GET /api/admin/billing/prices":                                           h.prices,
		"POST /api/admin/billing/prices":                                          h.createPrice,
		"POST /api/admin/billing/test-clock":                                      h.testClock,
	}
	for p, f := range m {
		m[p] = h.guard(f)
	}
	return m
}

// Register mounts the admin routes on mux behind wrap (auth + identity gate), for a server
// without billinghttp wiring and for tests.
func (h *Handlers) Register(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	for p, f := range h.Handlers() {
		mux.Handle(p, wrap(f))
	}
}

// guard: local superadmin sessions only (the app has checked ProductAdmin and recent auth);
// everyone else gets 404 so the API does not reveal itself. Every request is logged.
func (h *Handlers) guard(next httpx.HandlerFunc) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		id, ok := auth.FromContext(r.Context())
		if !ok || id.IsBot || id.Principal.Authority != identitypolicy.LocalAccount {
			return httpx.NotFound("route")
		}
		if h.d.Limiter != nil {
			if err := h.d.Limiter.Take(r.Context(), id.UserID.String()); err != nil {
				return err
			}
		}
		slog.InfoContext(r.Context(), "admin billing request", "user", id.UserID, "method", r.Method, "path", r.URL.Path,
			"query", r.URL.RawQuery, "request_id", httpx.RequestID(r.Context()))
		return next(w, r)
	}
}

// --- commands -------------------------------------------------------------------------

const (
	minReason = 5
	maxReason = 1000
)

// conflict: the command does not apply to the target in its state.
func conflict(msg string) error { return httpx.Conflict(msg) }

// cmd is one admin mutation request.
type cmd struct {
	action    string
	requestID uuid.UUID
	reason    string
	preview   bool
	actor     uuid.UUID
	hash      []byte
}

// newCmd reads request_id / reason / preview of req (fields of those names) and hashes the
// action, the target ids and req without preview.
func newCmd(r *http.Request, action string, req proto.Message, target ...string) (*cmd, error) {
	c := &cmd{action: action, actor: auth.MustFromContext(r.Context()).UserID}
	m := req.ProtoReflect()
	fields := m.Descriptor().Fields()
	str := func(name protoreflect.Name) string {
		if f := fields.ByName(name); f != nil {
			return m.Get(f).String()
		}
		return ""
	}
	rid, err := uuid.Parse(strings.TrimSpace(str("request_id")))
	if err != nil || rid == uuid.Nil {
		return nil, httpx.Validation("requestId", "request_id must be a uuid")
	}
	c.requestID = rid
	c.reason = strings.TrimSpace(str("reason"))
	if n := utf8.RuneCountInString(c.reason); n < minReason || n > maxReason {
		return nil, httpx.Validation("reason", "reason must be 5..1000 characters")
	}
	if f := fields.ByName("preview"); f != nil {
		c.preview = m.Get(f).Bool()
		clone := proto.Clone(req)
		clone.ProtoReflect().Clear(f)
		req = clone
	}
	if p := r.URL.Query().Get("preview"); p != "" {
		on, err := strconv.ParseBool(p)
		if err != nil {
			return nil, httpx.Validation("preview", "preview must be 1 or 0")
		}
		c.preview = c.preview || on
	}
	body, err := proto.MarshalOptions{Deterministic: true}.Marshal(req)
	if err != nil {
		return nil, err
	}
	sum := sha256.New()
	sum.Write([]byte(action))
	for _, t := range target {
		sum.Write([]byte{0})
		sum.Write([]byte(t))
	}
	sum.Write([]byte{0})
	sum.Write(body)
	c.hash = sum.Sum(nil)
	return c, nil
}

// snapshot is the audit summary of an account.
type snapshot struct {
	Balance     int64      `json:"balance_minor"`
	Currency    string     `json:"currency"`
	Status      string     `json:"status"`
	Plan        string     `json:"plan"`
	HoldUntil   *time.Time `json:"hold_until,omitempty"`
	DiscountBps int32      `json:"discount_bps"`
	DisputeHold bool       `json:"dispute_hold,omitempty"`
	SuspendAt   *time.Time `json:"suspend_at,omitempty"`
	Revision    int64      `json:"revision"`
}

func snap(a sqlc.BillingAccount) *snapshot {
	return &snapshot{Balance: a.BalanceMinor, Currency: a.Currency, Status: a.Status, Plan: a.Plan, HoldUntil: a.HoldUntil,
		DiscountBps: a.DiscountBps, DisputeHold: a.DisputeHold, SuspendAt: a.SuspendAt, Revision: a.Revision}
}

// details is billing_audit.details: references and summaries, never provider payloads.
type details struct {
	Target   map[string]string `json:"target,omitempty"`
	Before   *snapshot         `json:"before,omitempty"`
	After    *snapshot         `json:"after,omitempty"`
	Expected bool              `json:"after_expected,omitempty"` // written ahead of a core command
	Result   json.RawMessage   `json:"result,omitempty"`         // AdminBillingMutationResult without the account
}

// effect is what a command did (or would do) to one account.
type effect struct {
	acc     *sqlc.BillingAccount // after (nil: no account involved)
	before  *sqlc.BillingAccount
	res     *v1.AdminBillingMutationResult
	target  map[string]string
	expectd bool
}

func (e *effect) result(c *cmd) *v1.AdminBillingMutationResult {
	res := e.res
	if res == nil {
		res = &v1.AdminBillingMutationResult{}
	}
	res.Preview, res.Action = c.preview, c.action
	if e.before != nil {
		res.BalanceBefore = money(e.before.BalanceMinor, e.before.Currency)
	}
	if e.acc != nil {
		res.BalanceAfter = money(e.acc.BalanceMinor, e.acc.Currency)
	}
	return res
}

var (
	errRollback     = errors.New("billing admin: preview rollback")
	errConcurrent   = errors.New("billing admin: request_id taken concurrently")
	resultMarshal   = protojson.MarshalOptions{}
	resultUnmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// lookup returns the audit row of the request: (row, true) when it is a replay, 409 when the
// request_id was used with another body.
func lookup(ctx context.Context, q *sqlc.Queries, c *cmd) (sqlc.BillingAudit, bool, error) {
	a, err := q.GetBillingAuditByRequest(ctx, c.requestID)
	if db.IsNotFound(err) {
		return a, false, nil
	}
	if err != nil {
		return a, false, err
	}
	if string(a.BodyHash) != string(c.hash) || a.Action != c.action {
		return a, false, billing.ErrRequestReused
	}
	return a, true, nil
}

func (h *Handlers) insertAudit(ctx context.Context, q *sqlc.Queries, c *cmd, e *effect, accountID, workspaceID *uuid.UUID) (sqlc.BillingAudit, error) {
	det := details{Target: e.target, Expected: e.expectd}
	if e.before != nil {
		det.Before = snap(*e.before)
	}
	if e.acc != nil {
		det.After = snap(*e.acc)
	}
	if e.res != nil {
		stored := proto.Clone(e.res).(*v1.AdminBillingMutationResult)
		stored.Account, stored.Preview, stored.AuditId, stored.Replayed = nil, false, "", false
		raw, err := resultMarshal.Marshal(stored)
		if err != nil {
			return sqlc.BillingAudit{}, err
		}
		det.Result = raw
	}
	raw, err := json.Marshal(det)
	if err != nil {
		return sqlc.BillingAudit{}, err
	}
	a, err := q.InsertBillingAudit(ctx, sqlc.InsertBillingAuditParams{
		RequestID: c.requestID, BodyHash: c.hash, AccountID: accountID, WorkspaceID: workspaceID, ActorID: &c.actor,
		Action: c.action, Reason: c.reason, Details: raw,
	})
	if db.IsNotFound(err) {
		return a, errConcurrent
	}
	return a, err
}

// replayed builds the answer of a replayed request from its audit row.
func replayed(a sqlc.BillingAudit, c *cmd) (*v1.AdminBillingMutationResult, error) {
	var det details
	if err := json.Unmarshal(a.Details, &det); err != nil {
		return nil, err
	}
	res := &v1.AdminBillingMutationResult{}
	if len(det.Result) > 0 {
		if err := resultUnmarshal.Unmarshal(det.Result, res); err != nil {
			return nil, err
		}
	}
	res.Replayed, res.AuditId, res.Action, res.Preview = true, a.ID.String(), c.action, false
	return res, nil
}

// inTx runs a command of this package in one transaction with its audit row (preview: rolled
// back). fn locks what it changes and returns the effect. A replay returns the stored result.
func (h *Handlers) inTx(ctx context.Context, c *cmd, fn func(q *sqlc.Queries) (*effect, error)) (*v1.AdminBillingMutationResult, *effect, error) {
	for attempt := 0; ; attempt++ {
		var (
			res *v1.AdminBillingMutationResult
			eff *effect
		)
		err := h.d.DB.Tx(ctx, func(q *sqlc.Queries) error {
			a, replay, err := lookup(ctx, q, c)
			if err != nil {
				return err
			}
			if replay {
				res, err = replayed(a, c)
				return err
			}
			if eff, err = fn(q); err != nil {
				return err
			}
			res = eff.result(c)
			if c.preview {
				if res.Account, err = previewAccount(ctx, q, eff.acc); err != nil {
					return err
				}
				return errRollback
			}
			var accID, wsID *uuid.UUID
			if eff.acc != nil {
				accID, wsID = &eff.acc.ID, eff.acc.WorkspaceID
			}
			row, err := h.insertAudit(ctx, q, c, eff, accID, wsID)
			if err != nil {
				return err
			}
			res.AuditId = row.ID.String()
			return nil
		})
		switch {
		case errors.Is(err, errRollback):
			return res, eff, nil
		case errors.Is(err, errConcurrent) && attempt == 0:
			continue // the other request committed: answer its result
		case err != nil:
			return nil, nil, err
		}
		if eff != nil && eff.acc != nil && h.d.Committed != nil {
			h.d.Committed(ctx, *eff.acc)
		}
		return res, eff, nil
	}
}

// ahead writes the audit row of a core command that owns its transaction. check runs under
// the account lock (accountID nil: no account yet), validates the preconditions and returns
// the expected effect. Returns (result, replay, run): run = false for a preview.
func (h *Handlers) ahead(ctx context.Context, c *cmd, accountID *uuid.UUID, workspaceID *uuid.UUID, check func(q *sqlc.Queries, acc *sqlc.BillingAccount) (*effect, error)) (*v1.AdminBillingMutationResult, bool, error) {
	for attempt := 0; ; attempt++ {
		var (
			res    *v1.AdminBillingMutationResult
			replay bool
		)
		err := h.d.DB.Tx(ctx, func(q *sqlc.Queries) error {
			var acc *sqlc.BillingAccount
			if accountID != nil {
				a, err := q.LockBillingAccount(ctx, *accountID)
				if db.IsNotFound(err) {
					return billing.ErrAccountNotFound
				}
				if err != nil {
					return err
				}
				acc = &a
			}
			a, rep, err := lookup(ctx, q, c)
			if err != nil {
				return err
			}
			if rep {
				replay = true
				res, err = replayed(a, c)
				return err
			}
			eff, err := check(q, acc)
			if err != nil {
				return err
			}
			eff.expectd = true
			res = eff.result(c)
			if c.preview {
				if res.Account, err = previewAccount(ctx, q, eff.acc); err != nil {
					return err
				}
				return errRollback
			}
			ws := workspaceID
			if ws == nil && acc != nil {
				ws = acc.WorkspaceID
			}
			row, err := h.insertAudit(ctx, q, c, eff, accountID, ws)
			if err != nil {
				return err
			}
			res.AuditId = row.ID.String()
			return nil
		})
		switch {
		case errors.Is(err, errRollback):
			return res, false, nil
		case errors.Is(err, errConcurrent) && attempt == 0:
			continue
		case err != nil:
			return nil, false, err
		}
		return res, replay, nil
	}
}

// now is the billing time in a transaction.
func (h *Handlers) now(ctx context.Context, q *sqlc.Queries) (time.Time, error) {
	t, err := h.d.Clock.Now(ctx, q)
	if err != nil {
		return t, err
	}
	return t.UTC(), nil
}

// account loads the admin view of an account.
func (h *Handlers) account(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (*v1.AdminBillingAccount, error) {
	row, err := q.AdminGetBillingAccount(ctx, id)
	if db.IsNotFound(err) {
		return nil, billing.ErrAccountNotFound
	}
	if err != nil {
		return nil, err
	}
	return accountProto(accountRow{acc: row.BillingAccount, wsName: row.WorkspaceName, email: row.OwnerEmail, billable: row.BillableMembers}), nil
}

// previewAccount is the admin view of acc as a preview leaves it (names and members from the
// database; a new account of an enable preview has none yet).
func previewAccount(ctx context.Context, q *sqlc.Queries, acc *sqlc.BillingAccount) (*v1.AdminBillingAccount, error) {
	if acc == nil {
		return nil, nil
	}
	row := accountRow{acc: *acc}
	if acc.ID != uuid.Nil {
		got, err := q.AdminGetBillingAccount(ctx, acc.ID)
		if err != nil {
			return nil, err
		}
		row.wsName, row.email, row.billable = got.WorkspaceName, got.OwnerEmail, got.BillableMembers
	}
	return accountProto(row), nil
}

// respond fills the current account into res (unless a preview set it) and writes it.
func (h *Handlers) respond(w http.ResponseWriter, r *http.Request, res *v1.AdminBillingMutationResult, accountID uuid.UUID) error {
	if accountID != uuid.Nil && res.Account == nil {
		a, err := h.account(r.Context(), h.d.DB.Q, accountID)
		if err != nil {
			return err
		}
		res.Account = a
	}
	httpx.Write(w, http.StatusOK, res)
	return nil
}

func notClosed(acc sqlc.BillingAccount) error {
	if acc.Status == core.StatusClosed {
		return conflict("billing account is closed")
	}
	return nil
}

func checkRevision(acc sqlc.BillingAccount, expected uint64) error {
	if expected != 0 && uint64(acc.Revision) != expected { //nolint:gosec // revision >= 1
		return billing.ErrRevisionConflict
	}
	return nil
}

// amountOf validates a positive amount in the account currency.
func amountOf(m *v1.Money, acc sqlc.BillingAccount) (int64, error) {
	if m == nil || m.GetMinor() <= 0 {
		return 0, httpx.Validation("amount", "amount must be positive")
	}
	if m.GetCurrency() != acc.Currency {
		return 0, billing.ErrCurrencyMismatch
	}
	return m.GetMinor(), nil
}
