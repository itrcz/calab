//go:build integration

package billinghttp_test

import (
	"encoding/json"
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
)

func ruCompany() *v1.PutPayerRequest {
	return &v1.PutPayerRequest{Payer: &v1.PayerProfile{
		Type: v1.PayerType_PAYER_TYPE_COMPANY, Name: "ООО «Ромашка»", Country: "RU", Email: "billing@romashka.test",
		Requisites: map[string]string{"inn": "7707 083 893", "kpp": "773601001", "ogrn": "1027700132195", "legal_address": "Москва, ул. Вавилова, 19"},
	}}
}

// The payer form (ADR-0080 §0.1): the served schema, checks with reasons, versions, the
// provider customer kept in line without blocking the save.
func TestPayerRequisites(t *testing.T) {
	e := newEnv(t)
	var schema v1.PayerSchema
	if st, r := e.do(e.owner, "GET", e.base()+"/payer-schema", nil, &schema); st != 200 || len(schema.GetAllCountries()) != 249 || schema.GetFallback() == nil {
		t.Fatalf("schema: %d %s", st, r)
	}
	if !slices.ContainsFunc(schema.GetCountries(), func(c *v1.PayerCountrySchema) bool { return c.GetCountry() == "RU" }) {
		t.Fatal("no RU schema")
	}
	member := e.user()
	e.addMember(member, "member")
	if st, _ := e.do(member, "GET", e.base()+"/payer-schema", nil, nil); st != 403 {
		t.Fatalf("member reads the schema: %d", st)
	}

	// A checked, normalized first version.
	var p v1.PayerProfile
	if st, r := e.do(e.owner, "PUT", e.base()+"/payer", ruCompany(), &p); st != 200 {
		t.Fatalf("put: %d %s", st, r)
	}
	if p.GetVersion() != 1 || p.GetTaxId() != "7707083893" || p.GetRequisites()["inn"] != "7707083893" || p.GetSyncWarning() != "" {
		t.Fatalf("saved %v", &p)
	}
	// The same payer again keeps its version.
	if st, _ := e.do(e.owner, "PUT", e.base()+"/payer", ruCompany(), &p); st != 200 || p.GetVersion() != 1 {
		t.Fatalf("unchanged: %d %v", st, &p)
	}
	for name, c := range map[string]struct {
		edit   func(*v1.PayerProfile)
		reason string
	}{
		"inn checksum":    {func(p *v1.PayerProfile) { p.Requisites["inn"] = "7707083894" }, "PAYER_CHECKSUM"},
		"kpp missing":     {func(p *v1.PayerProfile) { delete(p.Requisites, "kpp") }, "PAYER_REQUIRED"},
		"no such type":    {func(p *v1.PayerProfile) { p.Country, p.Type = "DE", v1.PayerType_PAYER_TYPE_SOLE_PROPRIETOR }, "PAYER_TYPE_UNAVAILABLE"},
		"unknown country": {func(p *v1.PayerProfile) { p.Country = "XX" }, "PAYER_COUNTRY"},
		"bad email":       {func(p *v1.PayerProfile) { p.Email = "nope" }, "PAYER_EMAIL"},
	} {
		req := ruCompany()
		c.edit(req.Payer)
		if st, r := e.do(e.owner, "PUT", e.base()+"/payer", req, nil); st != 422 || r != c.reason {
			t.Errorf("%s: %d %s", name, st, r)
		}
	}

	// A top-up creates the Stripe customer and gives it the payer's tax ids; the checkout keeps
	// the payer version it was opened under.
	cid, _ := e.topup(1000, false)
	var snap struct {
		Version    int               `json:"version"`
		Requisites map[string]string `json:"requisites"`
	}
	co, err := e.d.Q.GetBillingCheckout(ctx, cid)
	if err != nil || json.Unmarshal(co.PayerSnapshot, &snap) != nil || snap.Version != 1 || snap.Requisites["ogrn"] != "1027700132195" {
		t.Fatalf("payer snapshot %s %v", co.PayerSnapshot, err)
	}
	custs, err := e.d.Q.ListBillingCustomersOfAccount(ctx, e.acc)
	if err != nil || len(custs) != 1 {
		t.Fatalf("customers %v %v", custs, err)
	}
	cus := custs[0].CustomerID
	sync, ok := e.fake.Synced(cus)
	if !ok || !slices.Equal(sync.TaxIDs, []provider.CustomerTaxID{{Type: "ru_inn", Value: "7707083893"}, {Type: "ru_kpp", Value: "773601001"}}) || sync.Name != "ООО «Ромашка»" {
		t.Fatalf("customer sync %+v", sync)
	}

	// A new payer: version 2, the customer follows.
	de := &v1.PutPayerRequest{Payer: &v1.PayerProfile{
		Type: v1.PayerType_PAYER_TYPE_COMPANY, Name: "Muster GmbH", Country: "DE", Email: "rechnung@muster.test", Requisites: map[string]string{"vat": "123456789"},
	}}
	if st, r := e.do(e.owner, "PUT", e.base()+"/payer", de, &p); st != 200 || p.GetVersion() != 2 || p.GetTaxId() != "DE123456789" || p.GetSyncWarning() != "" {
		t.Fatalf("DE: %d %s %v", st, r, &p)
	}
	if sync, _ := e.fake.Synced(cus); len(sync.TaxIDs) != 1 || sync.TaxIDs[0] != (provider.CustomerTaxID{Type: "eu_vat", Value: "DE123456789"}) ||
		!slices.Contains(sync.Previous, provider.CustomerTaxID{Type: "ru_inn", Value: "7707083893"}) {
		t.Fatalf("customer sync %+v", sync)
	}
	// Stripe refuses the tax id, then does not answer: saved anyway, with a warning.
	e.fake.Queue(fake.OpSync, fake.Decline, fake.Unknown)
	de.Payer.Requisites["vat"] = "DE987654321"
	if st, _ := e.do(e.owner, "PUT", e.base()+"/payer", de, &p); st != 200 || p.GetVersion() != 3 || p.GetSyncWarning() != "TAX_ID_REJECTED" {
		t.Fatalf("rejected: %d %v", st, &p)
	}
	de.Payer.Name = "Muster AG"
	if st, _ := e.do(e.owner, "PUT", e.base()+"/payer", de, &p); st != 200 || p.GetVersion() != 4 || p.GetSyncWarning() != "PROVIDER_UNAVAILABLE" {
		t.Fatalf("unavailable: %d %v", st, &p)
	}
	var got v1.PayerProfile
	if st, _ := e.do(e.owner, "GET", e.base()+"/payer", nil, &got); st != 200 || got.GetName() != "Muster AG" || got.GetVersion() != 4 || got.GetSyncWarning() != "" {
		t.Fatalf("get %v", &got)
	}
	vs, err := e.d.Q.ListBillingPayerVersions(ctx, e.acc)
	if err != nil || len(vs) != 4 || vs[0].Country != "RU" || vs[3].Name != "Muster AG" {
		t.Fatalf("versions %d %v", len(vs), err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_payer_versions SET name = 'x' WHERE account_id = $1`, e.acc); err == nil {
		t.Fatal("payer versions are not append-only")
	}
}

// A sole proprietor pays like a company (the capability matrix offers it every method).
func TestPayerSoleProprietorMethods(t *testing.T) {
	e := newEnv(t)
	ip := &v1.PutPayerRequest{Payer: &v1.PayerProfile{
		Type: v1.PayerType_PAYER_TYPE_SOLE_PROPRIETOR, Name: "ИП Иванов Иван Иванович", Country: "RU", Email: "ip@ivanov.test",
		Requisites: map[string]string{"inn": "500100732259", "ogrnip": "304500116000157", "address": "Тверь, ул. Советская, 1"},
	}}
	var p v1.PayerProfile
	if st, r := e.do(e.owner, "PUT", e.base()+"/payer", ip, &p); st != 200 || p.GetType() != v1.PayerType_PAYER_TYPE_SOLE_PROPRIETOR {
		t.Fatalf("put: %d %s %v", st, r, &p)
	}
	var b v1.GetBillingResponse
	if st, r := e.do(e.owner, "GET", e.base(), nil, &b); st != 200 || len(b.GetSummary().GetMethods()) == 0 {
		t.Fatalf("methods for a sole proprietor: %d %s %v", st, r, b.GetSummary().GetMethods())
	}
	e.topup(1000, false)
}
