package billinghttp

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/payer"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Sync warnings of PUT …/payer (PayerProfile.sync_warning): the payer is saved either way.
const (
	syncTaxIDRejected       = "TAX_ID_REJECTED"
	syncProviderUnavailable = "PROVIDER_UNAVAILABLE"
)

// customerSyncTimeout bounds the provider calls of PUT …/payer: the owner waits for them.
const customerSyncTimeout = 8 * time.Second

// payerSchema: GET …/billing/payer-schema — the country requisites the payer form renders
// and checks (internal/billing/payer, ADR-0080 §0.1). The same for every account.
func (s *Service) payerSchema(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.ownerOf(r); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, payer.Schema())
	return nil
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
	httpx.Write(w, http.StatusOK, payer.Proto(p))
	return nil
}

// putPayer: PUT …/billing/payer — checks the payer against the schema of its country and type,
// saves it as a new version (billing_payer_versions, append-only; an unchanged payer keeps its
// version) and brings the provider customer in line (name, e-mail, tax ids). A provider that
// refuses a tax id or does not answer does not undo the save: the answer carries sync_warning.
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
	np, prob := payer.Validate(payer.Input{
		Type: payer.TypeFromProto(in.GetType()), Name: in.GetName(), Country: in.GetCountry(), Email: in.GetEmail(),
		TaxID: in.GetTaxId(), Requisites: in.GetRequisites(),
	})
	if prob != nil {
		e := httpx.Validation(prob.Field, "invalid payer: "+prob.Reason)
		e.Reason = prob.Reason
		return e
	}
	reqs, err := json.Marshal(np.Requisites)
	if err != nil {
		return err
	}
	var taxID *string
	if np.TaxID != "" {
		taxID = &np.TaxID
	}
	ctx := r.Context()
	var saved sqlc.BillingPayer
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, c.acc.ID); err != nil {
			return err
		}
		next := int32(1)
		if cur, err := q.GetBillingPayer(ctx, c.acc.ID); err == nil {
			if samePayer(cur, np) {
				saved = cur
				return nil
			}
			next = cur.Version + 1
		} else if !db.IsNotFound(err) {
			return err
		}
		now := s.now(ctx)
		saved, err = q.SaveBillingPayer(ctx, sqlc.SaveBillingPayerParams{
			AccountID: c.acc.ID, Type: np.Type, Name: np.Name, Country: np.Country, Email: np.Email, TaxID: taxID,
			Requisites: reqs, Version: next, UpdatedBy: &c.user, Now: now,
		})
		if err != nil {
			return err
		}
		return q.InsertBillingPayerVersion(ctx, sqlc.InsertBillingPayerVersionParams{
			AccountID: c.acc.ID, Version: next, Type: np.Type, Name: np.Name, Country: np.Country, Email: np.Email, TaxID: taxID,
			Requisites: reqs, CreatedBy: &c.user, Now: now,
		})
	})
	if err != nil {
		return err
	}
	out := payer.Proto(saved)
	out.SyncWarning = s.syncCustomers(ctx, c.acc.ID, saved)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func samePayer(cur sqlc.BillingPayer, np payer.Payer) bool {
	return cur.Type == np.Type && cur.Name == np.Name && cur.Country == np.Country && cur.Email == np.Email &&
		deref(cur.TaxID) == np.TaxID && maps.Equal(payer.Requisites(cur.Requisites), np.Requisites)
}

// syncCustomers pushes the payer to every provider customer of the account whose provider
// keeps requisites (Stripe). "" when all took it, else a sync warning; never an error.
func (s *Service) syncCustomers(ctx context.Context, account uuid.UUID, p sqlc.BillingPayer) string {
	rows, err := s.db.Q.ListBillingCustomersOfAccount(ctx, account)
	if err != nil {
		slog.WarnContext(ctx, "billing: payer sync: list customers", "account", account, "err", err)
		return syncProviderUnavailable
	}
	warning := ""
	for _, bc := range rows {
		if w := s.syncCustomer(ctx, bc, p); w != "" {
			warning = w
		}
	}
	return warning
}

// syncCustomer pushes the payer to one provider customer ("" = done or nothing to do).
func (s *Service) syncCustomer(ctx context.Context, bc sqlc.BillingCustomer, p sqlc.BillingPayer) string {
	prov, ok := s.reg.Provider(provider.ID(bc.Provider))
	if !ok {
		return ""
	}
	syncer, ok := prov.(provider.CustomerSyncer)
	if !ok {
		return ""
	}
	if lr, ok := prov.(provider.LivemodeReporter); ok && lr.Livemode() != bc.Livemode {
		return "" // a customer of the other mode: not this deployment's
	}
	var ids []provider.CustomerTaxID
	for _, t := range payer.StripeTaxIDs(p.Country, p.Type, payer.Requisites(p.Requisites)) {
		ids = append(ids, provider.CustomerTaxID{Type: t.Type, Value: t.Value})
	}
	ctx, cancel := context.WithTimeout(ctx, customerSyncTimeout)
	defer cancel()
	rejected, err := syncer.SyncCustomer(ctx, provider.CustomerSync{
		Customer: provider.CustomerRef{Provider: prov.ID(), ProviderAccount: bc.ProviderAccount, Livemode: bc.Livemode, ID: bc.CustomerID},
		Name:     p.Name, Email: p.Email, TaxIDs: ids, ManagedTypes: payer.StripeTypes(),
	})
	switch {
	case err != nil:
		slog.WarnContext(ctx, "billing: payer sync", "account", bc.AccountID, "provider", bc.Provider, "err", err)
		return syncProviderUnavailable
	case len(rejected) > 0:
		types := make([]string, 0, len(rejected))
		for _, t := range rejected {
			types = append(types, t.Type)
		}
		slog.InfoContext(ctx, "billing: payer sync: tax ids refused", "account", bc.AccountID, "provider", bc.Provider, "types", types)
		return syncTaxIDRejected
	}
	return ""
}

// receiptName is the buyer named on a 54-FZ receipt for the stored payer.
func receiptName(p sqlc.BillingPayer) string { return payer.ReceiptName(p.Type, p.Name) }
