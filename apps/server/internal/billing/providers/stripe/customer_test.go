package stripe

import (
	"errors"
	"net/http"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

func TestSyncCustomer(t *testing.T) {
	m := newMock(t)
	p := m.provider(t)
	cus := provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0001"}
	m.on("POST", "/v1/customers/cus_FIXTURE0001", http.StatusOK, []byte(`{"id":"cus_FIXTURE0001","object":"customer","livemode":false}`))
	// Stripe has the old VAT ID (replaced: deleted), the KPP to keep, a US EIN the profile gave
	// before and no longer has (deleted), a Checkout-collected tax id of a type the profile never
	// gave and a Checkout-collected GB VAT the profile never had (both left alone).
	m.on("GET", "/v1/customers/cus_FIXTURE0001/tax_ids", http.StatusOK, []byte(`{"object":"list","has_more":false,"data":[
		{"id":"txi_OLD","object":"tax_id","type":"eu_vat","value":"DE111111111"},
		{"id":"txi_KPP","object":"tax_id","type":"ru_kpp","value":"773601001"},
		{"id":"txi_EIN","object":"tax_id","type":"us_ein","value":"12-3456789"},
		{"id":"txi_GB","object":"tax_id","type":"gb_vat","value":"GB123456789"},
		{"id":"txi_CH","object":"tax_id","type":"ch_vat","value":"CHE-123.456.789 MWST"}]}`))
	m.on("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_OLD", http.StatusOK, []byte(`{"id":"txi_OLD","object":"tax_id","deleted":true}`))
	m.on("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_EIN", http.StatusOK, []byte(`{"id":"txi_EIN","object":"tax_id","deleted":true}`))
	m.on("POST", "/v1/customers/cus_FIXTURE0001/tax_ids", http.StatusOK, []byte(`{"id":"txi_NEW","object":"tax_id","type":"ru_inn","value":"7707083893"}`))
	m.on("POST", "/v1/customers/cus_FIXTURE0001/tax_ids", http.StatusBadRequest,
		[]byte(`{"error":{"type":"invalid_request_error","code":"tax_id_invalid","param":"value","message":"Invalid value for eu_vat."}}`))

	rejected, err := p.SyncCustomer(ctx, provider.CustomerSync{
		Customer: cus, Name: "ООО «Ромашка»", Email: "billing@romashka.test",
		TaxIDs:   []provider.CustomerTaxID{{Type: "ru_kpp", Value: "773601001"}, {Type: "ru_inn", Value: "7707083893"}, {Type: "eu_vat", Value: "DE123456789"}},
		Previous: []provider.CustomerTaxID{{Type: "us_ein", Value: "12-3456789"}, {Type: "ru_kpp", Value: "773601001"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rejected) != 1 || rejected[0].Type != "eu_vat" {
		t.Fatalf("rejected %v", rejected)
	}
	if f := m.last(t, "POST", "/v1/customers/cus_FIXTURE0001").form; f.Get("name") != "ООО «Ромашка»" || f.Get("email") != "billing@romashka.test" {
		t.Fatalf("update %v", f)
	}
	if n := len(m.requests("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_OLD")); n != 1 {
		t.Fatalf("old VAT ID deleted %d times", n)
	}
	creates := m.requests("POST", "/v1/customers/cus_FIXTURE0001/tax_ids")
	if len(creates) != 2 || creates[0].form.Get("type") != "ru_inn" || creates[1].form.Get("value") != "DE123456789" {
		t.Fatalf("creates %v", creates)
	}
	if n := len(m.requests("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_EIN")); n != 1 {
		t.Fatalf("cleared EIN deleted %d times", n)
	}
	if len(m.requests("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_CH"))+len(m.requests("DELETE", "/v1/customers/cus_FIXTURE0001/tax_ids/txi_GB")) != 0 {
		t.Fatal("a Checkout-collected tax id was deleted")
	}

	if _, err := p.SyncCustomer(ctx, provider.CustomerSync{}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("no customer: %v", err)
	}
	m2 := newMock(t)
	m2.on("POST", "/v1/customers/cus_FIXTURE0001", http.StatusServiceUnavailable, []byte(`{"error":{"type":"api_error","message":"down"}}`))
	if _, err := m2.provider(t).SyncCustomer(ctx, provider.CustomerSync{Customer: cus, Name: "X"}); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("provider down: %v", err)
	}
}
