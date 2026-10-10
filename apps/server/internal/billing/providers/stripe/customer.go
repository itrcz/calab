package stripe

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

var _ provider.CustomerSyncer = (*Provider)(nil)

// SyncCustomer brings an existing customer in line with the payer profile (ADR-0080 §0.1): name
// and e-mail, then its tax ids — a managed type's id the payer no longer has is deleted, a new
// one created. A tax id Stripe refuses (400: tax_id_invalid, unsupported type) is returned in
// rejected and does not stop the others.
func (p *Provider) SyncCustomer(ctx context.Context, req provider.CustomerSync) ([]provider.CustomerTaxID, error) {
	if req.Customer.ID == "" {
		return nil, fmt.Errorf("%w: sync customer needs a customer", ErrInvalidRequest)
	}
	if err := p.checkLive("sync customer", req.Customer.Livemode); err != nil {
		return nil, err
	}
	up := &stripego.CustomerUpdateParams{}
	if req.Name != "" {
		up.Name = stripego.String(req.Name)
	}
	if req.Email != "" {
		up.Email = stripego.String(req.Email)
	}
	c, err := p.sc.V1Customers.Update(ctx, req.Customer.ID, up)
	if err != nil {
		return nil, mapErr("update customer", err)
	}
	if err := p.checkLive("update customer", c.Livemode); err != nil {
		return nil, err
	}

	type key struct{ typ, value string }
	have := map[key]string{} // → tax id object id
	list := &stripego.TaxIDListParams{Customer: stripego.String(req.Customer.ID)}
	list.Limit = stripego.Int64(100)
	for t, err := range p.sc.V1TaxIDs.List(ctx, list).All(ctx) {
		if err != nil {
			return nil, mapErr("list tax ids", err)
		}
		have[key{string(t.Type), t.Value}] = t.ID
	}
	want := map[key]bool{}
	for _, t := range req.TaxIDs {
		want[key{t.Type, t.Value}] = true
	}
	for k, id := range have {
		if want[k] || !slices.Contains(req.ManagedTypes, k.typ) {
			continue
		}
		if _, err := p.sc.V1TaxIDs.Delete(ctx, id, &stripego.TaxIDDeleteParams{Customer: stripego.String(req.Customer.ID)}); err != nil {
			if err = mapErr("delete tax id", err); !errors.Is(err, provider.ErrNotFound) {
				return nil, err
			}
		}
	}
	var rejected []provider.CustomerTaxID
	for _, t := range req.TaxIDs {
		if _, ok := have[key{t.Type, t.Value}]; ok {
			continue
		}
		_, err := p.sc.V1TaxIDs.Create(ctx, &stripego.TaxIDCreateParams{
			Customer: stripego.String(req.Customer.ID), Type: stripego.String(t.Type), Value: stripego.String(t.Value),
		})
		if err == nil {
			continue
		}
		err = mapErr("create tax id", err)
		var ae *APIError
		if errors.As(err, &ae) && ae.Status == http.StatusBadRequest {
			rejected = append(rejected, t)
			continue
		}
		return rejected, err
	}
	return rejected, nil
}
