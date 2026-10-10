package payer

import (
	"encoding/json"
	"slices"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// TaxID is one tax id of a Stripe Customer (type as Stripe names it, value in Stripe's form).
type TaxID struct {
	Type  string
	Value string
}

// StripeTaxIDs lists the requisites of a payer that Stripe keeps as Customer tax ids, in schema
// order (RU company: ru_inn, ru_kpp; EU: eu_vat; US: us_ein as «12-3456789»…).
func StripeTaxIDs(country, typ string, requisites map[string]string) []TaxID {
	fields, _ := Fields(country, typ)
	var out []TaxID
	for _, f := range fields {
		v := requisites[f.Key]
		if f.StripeType == "" || v == "" {
			continue
		}
		if f.StripeType == "us_ein" && len(v) == 9 {
			v = v[:2] + "-" + v[2:]
		}
		out = append(out, TaxID{Type: f.StripeType, Value: v})
	}
	return out
}

// HistoryTaxIDs lists, without repeats, the Stripe tax ids the given payer versions gave: what a
// sync may remove from the customer once the payer no longer has it (a tax id only Stripe
// Checkout collected is not among them and stays).
func HistoryTaxIDs(versions []sqlc.BillingPayerVersion) []TaxID {
	var out []TaxID
	for _, v := range versions {
		for _, t := range StripeTaxIDs(v.Country, v.Type, Requisites(v.Requisites)) {
			if !slices.Contains(out, t) {
				out = append(out, t)
			}
		}
	}
	return out
}

// ReceiptName is the buyer name of a 54-FZ receipt (Tochka Client.name): an organization or a
// sole proprietor is named on its receipt, a private person is not (the e-mail is enough).
func ReceiptName(typ, name string) string {
	if typ == Company || typ == SoleProprietor {
		return name
	}
	return ""
}

// Requisites decodes billing_payers.requisites ({} on a malformed value: never trusted for money).
func Requisites(raw []byte) map[string]string {
	out := map[string]string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

// Proto is the API form of a stored payer.
func Proto(p sqlc.BillingPayer) *v1.PayerProfile {
	out := &v1.PayerProfile{
		Type: TypeProto(p.Type), Name: p.Name, Country: p.Country, Email: p.Email,
		Requisites: Requisites(p.Requisites), Version: uint32(max(p.Version, 0)), //nolint:gosec // ≥ 0
	}
	if p.TaxID != nil {
		out.TaxId = *p.TaxID
	}
	return out
}
