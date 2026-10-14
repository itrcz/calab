package admin

import (
	"context"
	"net/http"
	"regexp"
	"slices"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/sales"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Audit actions of ADR-0083.
const (
	actionMarket   = "market"
	actionProvider = "provider_accept_new"
)

func (h *Handlers) sales() *sales.Sales { return sales.New(h.d.Providers) }

// changeMarket: POST /api/admin/billing/accounts/{id}/market — moves an account without payments
// to another market (ADR-0083): the same rule as the owner's pre-payment choice
// (core.SwitchMarketIn under the account lock: no ledger entries, payments or open checkout,
// else 409 BILLING_MARKET_FIXED) and the market must be open for new clients (422
// BILLING_MARKET_UNAVAILABLE). Audited with from → to.
func (h *Handlers) changeMarket(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminChangeMarketRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionMarket, &req, accID.String())
	if err != nil {
		return err
	}
	market := req.GetMarket()
	if core.MarketCurrency(market) == "" {
		return httpx.Validation("market", "market must be global or ru")
	}
	ctx := r.Context()
	s := h.sales()
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, accID)
		if err != nil {
			return nil, err
		}
		if err := notClosed(acc); err != nil {
			return nil, err
		}
		if err := checkRevision(acc, req.GetExpectedRevision()); err != nil {
			return nil, err
		}
		if acc.Market != market {
			open, err := s.IsOpen(ctx, q, market)
			if err != nil {
				return nil, err
			}
			if !open {
				return nil, billing.ErrMarketUnavailable
			}
		}
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		after, err := h.d.Core.SwitchMarketIn(ctx, q, acc, market, string(s.ProviderOf(market)), now)
		if err != nil {
			return nil, err
		}
		return &effect{before: &acc, acc: &after, target: map[string]string{
			"account_id": acc.ID.String(), "from": acc.Market + "/" + acc.Currency + "/" + acc.Provider,
			"to": after.Market + "/" + after.Currency + "/" + after.Provider,
		}}, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, accID)
}

// providersView is GET /api/admin/billing/providers: every configured provider, its markets and
// its «принимать новых клиентов» switch, and the resulting mode for new accounts.
func (h *Handlers) providersView(ctx context.Context, q *sqlc.Queries) (*v1.AdminBillingProviders, error) {
	rows, err := q.ListBillingProviderSettings(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]sqlc.BillingProviderSetting{}
	for _, r := range rows {
		byID[r.Provider] = r
	}
	s := h.sales()
	out := &v1.AdminBillingProviders{}
	seen := map[provider.ID]bool{}
	for _, m := range s.Served() {
		id := s.ProviderOf(m)
		if seen[id] {
			for _, p := range out.Providers {
				if p.Id == string(id) {
					p.Markets = append(p.Markets, m)
				}
			}
			continue
		}
		seen[id] = true
		p := &v1.AdminBillingProvider{Id: string(id), Markets: []string{m}, AcceptNew: true}
		if r, ok := byID[string(id)]; ok {
			p.AcceptNew, p.UpdatedAt = r.AcceptNew, timestamppb.New(r.UpdatedAt)
		}
		out.Providers = append(out.Providers, p)
	}
	open, err := s.Open(ctx, q)
	if err != nil {
		return nil, err
	}
	out.Mode = sales.Mode(open)
	return out, nil
}

func (h *Handlers) providers(w http.ResponseWriter, r *http.Request) error {
	out, err := h.providersView(r.Context(), h.d.DB.Q)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

var providerID = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// setProvider: PUT /api/admin/billing/providers/{provider} — opens or closes a configured
// provider for NEW accounts at runtime (ADR-0083). Accounts whose market is fixed by a payment
// keep working on it (top-ups, refunds, webhooks, polling). Closing every provider is allowed:
// new clients then see the Global catalog with «contact us». Audited with from → to.
func (h *Handlers) setProvider(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("provider")
	if !providerID.MatchString(id) {
		return httpx.NotFound("provider")
	}
	s := h.sales()
	if !slices.ContainsFunc(s.Served(), func(m string) bool { return string(s.ProviderOf(m)) == id }) {
		return httpx.NotFound("provider") // not configured / serving no market
	}
	var req v1.AdminSetProviderRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionProvider, &req, id)
	if err != nil {
		return err
	}
	ctx := r.Context()
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		before := true
		if row, err := q.GetBillingProviderSettingForUpdate(ctx, id); err == nil {
			before = row.AcceptNew
		} else if !db.IsNotFound(err) {
			return nil, err
		}
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		if _, err := q.UpsertBillingProviderSetting(ctx, sqlc.UpsertBillingProviderSettingParams{
			Provider: id, AcceptNew: req.GetAcceptNew(), UpdatedBy: &c.actor, Now: now,
		}); err != nil {
			return nil, err
		}
		view, err := h.providersView(ctx, q)
		if err != nil {
			return nil, err
		}
		return &effect{
			target: map[string]string{"provider": id, "from": acceptText(before), "to": acceptText(req.GetAcceptNew())},
			res:    &v1.AdminBillingMutationResult{Providers: view},
		}, nil
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, res)
	return nil
}

func acceptText(open bool) string {
	if open {
		return "accept_new"
	}
	return "closed_for_new"
}
