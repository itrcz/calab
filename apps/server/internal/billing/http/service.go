package billinghttp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/sales"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Config of the owner and public handlers.
type Config struct {
	// Checkouts (BILLING_STRIPE_ENABLED): new top-ups may be opened. Off is the kill switch of
	// new payments; the webhook, pull-sync and reads keep working.
	Checkouts bool
	// ReturnURL (BILLING_PUBLIC_RETURN_URL): success / cancel URL of hosted checkout; the
	// checkout id is appended as ?checkout={id}.
	ReturnURL string
	// AppURL (PUBLIC_APP_URL): the «back to Calab» link of the return page.
	AppURL string
	// CheckoutTTL: lifetime of a hosted page (Stripe: 30 min .. 24 h). Default 35 min: one open
	// checkout per account, so a short page lets the owner change the amount soon.
	CheckoutTTL time.Duration
	// SelfServe (BILLING_SELF_SERVE): an owner without a live account may start billing — GET
	// answers self_serve, a quote with purpose ACTIVATE creates the inactive account (in the
	// chosen open market, ADR-0083) like the superadmin's enable. Off: only a superadmin enables a
	// workspace.
	SelfServe bool
	// PlanLimits are the limits of a plan on this server (plans.Service.PlanLimits) for the plan
	// offers of GET …/billing; nil sends offers without limits.
	PlanLimits func(v1.Plan) *v1.PlanLimits
	// Contact is the «contact us» link of paid plans (config.PlanContact) for the public offers.
	Contact string
	// LandingOrigins (PUBLIC_LANDING_URLS) are the browser origins of the marketing landing, which
	// lives on another host than the app: GET /api/billing/public/offers answers them with CORS
	// (no credentials). Nothing else is opened.
	LandingOrigins []string
	// PublicLimiter rate-limits GET /api/billing/public/offers per client IP (nil: none).
	PublicLimiter interface {
		Take(ctx context.Context, key string) error
	}
	// Committed runs after a self-serve account was created (WORKSPACE_UPDATE with
	// Workspace.billing, BILLING_UPDATE) — core.Hooks.Committed of the wiring.
	Committed func(ctx context.Context, acc sqlc.BillingAccount)
}

// QuoteTTL is how long a quote id is accepted by the actions.
const QuoteTTL = 10 * time.Minute

// Service implements the owner routes (/api/workspaces/{id}/billing) and the public ones
// (webhook, return page). Every money effect goes through core (T1) and inbox (T5).
type Service struct {
	db    *db.DB
	core  *core.Core
	reg   *provider.Registry
	inbox *inbox.Inbox
	clock billing.Clock
	cfg   Config
	sales *sales.Sales
}

// New creates the service.
func New(d *db.DB, c *core.Core, reg *provider.Registry, in *inbox.Inbox, clock billing.Clock, cfg Config) *Service {
	if cfg.CheckoutTTL <= 0 {
		cfg.CheckoutTTL = 35 * time.Minute
	}
	return &Service{db: d, core: c, reg: reg, inbox: in, clock: clock, cfg: cfg, sales: sales.New(reg)}
}

// Owner returns the owner route implementations (Handlers.Owner). The auto-topup routes store
// the consent only; T7 runs the attempts.
func (s *Service) Owner() map[string]httpx.HandlerFunc {
	return map[string]httpx.HandlerFunc{
		"GET /api/workspaces/{id}/billing":                           s.get,
		"POST /api/workspaces/{id}/billing/quote":                    s.quote,
		"POST /api/workspaces/{id}/billing/activate":                 s.activate,
		"POST /api/workspaces/{id}/billing/stop":                     s.stop,
		"POST /api/workspaces/{id}/billing/change-plan":              s.changePlan,
		"POST /api/workspaces/{id}/billing/resume":                   s.resume,
		"GET /api/workspaces/{id}/billing/payer":                     s.getPayer,
		"PUT /api/workspaces/{id}/billing/payer":                     s.putPayer,
		"POST /api/workspaces/{id}/billing/topups":                   s.topup,
		"GET /api/workspaces/{id}/billing/checkouts/{cid}":           s.checkout,
		"GET /api/workspaces/{id}/billing/auto-topup":                s.autoTopup,
		"PUT /api/workspaces/{id}/billing/auto-topup":                s.putAutoTopup,
		"DELETE /api/workspaces/{id}/billing/auto-topup":             s.deleteAutoTopup,
		"GET /api/workspaces/{id}/billing/payment-methods":           s.methods,
		"DELETE /api/workspaces/{id}/billing/payment-methods/{pmId}": s.deleteMethod,
		"GET /api/workspaces/{id}/billing/ledger":                    s.ledger,
		"GET /api/workspaces/{id}/billing/payments":                  s.payments,
		"GET /api/workspaces/{id}/billing/refund-requests":           s.refundRequests,
		"POST /api/workspaces/{id}/billing/refund-requests":          s.createRefundRequest,
	}
}

// Public returns the public route implementations (Handlers.Public).
func (s *Service) Public() map[string]httpx.HandlerFunc {
	return map[string]httpx.HandlerFunc{
		"POST /api/billing/stripe/webhook": s.stripeWebhook,
		"POST /api/billing/tochka/webhook": s.tochkaWebhook,
		"GET /api/billing/public/offers":   s.publicOffers,
		"GET /api/billing/return":          s.returnPage,
	}
}

// caller is the request's workspace, its viewer and the live account.
type caller struct {
	user  uuid.UUID
	ws    sqlc.Workspace
	owner bool
	acc   sqlc.BillingAccount
	hasAc bool
}

// who resolves the workspace of {id} for the caller: 404 for non-members (the identity gate
// already refuses them; this is the second line).
func (s *Service) who(r *http.Request) (caller, error) {
	ctx := r.Context()
	c := caller{user: auth.MustFromContext(ctx).UserID}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return c, err
	}
	if c.ws, err = s.db.Q.GetWorkspace(ctx, wsID); db.IsNotFound(err) {
		return c, httpx.NotFound("workspace")
	} else if err != nil {
		return c, err
	}
	c.owner = c.ws.OwnerID == c.user
	if !c.owner {
		if _, err := s.db.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: c.user}); db.IsNotFound(err) {
			return c, httpx.NotFound("workspace")
		} else if err != nil {
			return c, err
		}
	}
	acc, err := s.db.Q.GetLiveBillingAccountByWorkspace(ctx, &wsID)
	switch {
	case err == nil:
		c.acc, c.hasAc = acc, true
	case !db.IsNotFound(err):
		return c, err
	}
	return c, nil
}

// ownerOf is who for owner-only routes: 403 BILLING_OWNER_REQUIRED for other members, 404
// BILLING_ACCOUNT_NOT_FOUND without a live account.
func (s *Service) ownerOf(r *http.Request) (caller, error) {
	c, err := s.who(r)
	if err != nil {
		return c, err
	}
	if !c.owner {
		return c, billing.ErrOwnerRequired
	}
	if !c.hasAc {
		return c, billing.ErrAccountNotFound
	}
	return c, nil
}

func parseRequestID(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil || id == uuid.Nil {
		return uuid.Nil, httpx.Validation("request_id", "request_id must be a uuid")
	}
	return id, nil
}

// bodyHash is sha256 over action and the deterministic encoding of msg (the request without
// its request_id): a retry with the same id must carry the same body.
func bodyHash(action string, msg proto.Message) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	h := sha256.Sum256(append([]byte(action+"\x00"), b...))
	return h[:]
}

// audit records an owner action under its request_id (billing_audit, append-only). A replay
// with the same body passes (the core commands are idempotent by request id), another body or
// another account is billing.ErrRequestReused.
func (s *Service) audit(ctx context.Context, c caller, action string, requestID uuid.UUID, hash []byte) (replay bool, err error) {
	wsID := c.ws.ID
	row, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.BillingAudit, error) {
		return q.InsertBillingAudit(ctx, sqlc.InsertBillingAuditParams{
			RequestID: requestID, BodyHash: hash, AccountID: &c.acc.ID, WorkspaceID: &wsID, ActorID: &c.user,
			Action: action, Details: []byte("{}"),
		})
	})
	if err == nil {
		_ = row
		return false, nil
	}
	if !db.IsNotFound(err) {
		return false, err
	}
	old, err := s.db.Q.GetBillingAuditByRequest(ctx, requestID)
	if err != nil {
		return false, err
	}
	if old.Action != action || !bytes.Equal(old.BodyHash, hash) || old.AccountID == nil || *old.AccountID != c.acc.ID {
		return false, billing.ErrRequestReused
	}
	return true, nil
}

// quoteID encodes the revision and the expiry of a quote: q1.{revision}.{unix expiry}. It is
// informative (amounts are always recomputed under the account lock); actions refuse an
// expired one.
func quoteID(rev int64, exp time.Time) string {
	return "q1." + strconv.FormatInt(rev, 10) + "." + strconv.FormatInt(exp.Unix(), 10)
}

func checkQuote(id string, now time.Time) error {
	if id == "" {
		return nil
	}
	parts := strings.Split(id, ".")
	if len(parts) != 3 || parts[0] != "q1" {
		return httpx.Validation("quote_id", "malformed quote_id")
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return httpx.Validation("quote_id", "malformed quote_id")
	}
	if now.After(time.Unix(exp, 0)) {
		return billing.ErrQuoteExpired
	}
	return nil
}

func checkRevision(expected uint64, acc sqlc.BillingAccount) error {
	if expected != 0 && expected != uint64(acc.Revision) { //nolint:gosec // revision >= 1 (CHECK)
		return billing.ErrRevisionConflict
	}
	return nil
}

func (s *Service) now(ctx context.Context) time.Time {
	t, err := s.clock.Now(ctx, s.db.Q)
	if err != nil {
		return time.Now().UTC()
	}
	return t
}
