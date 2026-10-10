// Package payer is the payer of a billing account (ADR-0080 §6.4 and its amendment §0.1): the one table of
// country requisites (Schema, served as GET …/billing/payer-schema and rendered by the client),
// their normalization and checks (Validate), and what goes downstream — the Stripe customer's
// tax ids (StripeTaxIDs) and the name on a 54-FZ receipt (ReceiptName).
//
// The client runs the same checks from the served schema (apps/desktop lib/billing/payer.ts);
// both sides are tested against proto/testdata/billing_payer_vectors.json, and the served schema
// is pinned by proto/testdata/billing_payer_schema.json (the client's billing mock reads it).
package payer

import (
	"regexp"
	"slices"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// SchemaVersion grows whenever a field is added, removed or its rules change.
const SchemaVersion = 1

// Payer types (billing_payers.type).
const (
	Person         = provider.PayerPerson
	Company        = provider.PayerCompany
	SoleProprietor = provider.PayerSoleProprietor
)

// Field is one requisite of a country + payer type (v1.PayerFieldSpec plus the server-only
// Stripe tax id type).
type Field struct {
	Key       string
	Required  bool
	Input     v1.PayerFieldInput
	Pattern   string // full match of the normalized value
	MaxLength int
	Check     v1.PayerFieldCheck
	Example   string
	Prefix    string
	Primary   bool
	// StripeType: the Stripe Customer tax id type the value is sent as ("" = not sent).
	StripeType string

	re *regexp.Regexp
}

type typeSchema struct {
	typ    string
	fields []Field
}

type countrySchema struct {
	country string
	types   []typeSchema
}

const (
	txt    = v1.PayerFieldInput_PAYER_FIELD_INPUT_TEXT
	digits = v1.PayerFieldInput_PAYER_FIELD_INPUT_DIGITS
	code   = v1.PayerFieldInput_PAYER_FIELD_INPUT_CODE
)

// Shared fields.
func address(key string, required bool) Field {
	return Field{Key: key, Required: required, Input: txt, MaxLength: 300}
}

func vat(country, prefix, body, example string) Field {
	return Field{
		Key: "vat", Input: code, Prefix: prefix, Pattern: prefix + "(" + body + ")", MaxLength: 16,
		Example: example, Primary: true, StripeType: vatStripeType(country),
	}
}

func vatStripeType(country string) string {
	if country == "GB" {
		return "gb_vat"
	}
	return "eu_vat"
}

// euVAT: VAT ID body after the prefix, per EU member state (VIES formats).
var euVAT = []struct{ country, prefix, body, example string }{
	{"AT", "AT", `U\d{8}`, "ATU12345678"},
	{"BE", "BE", `[01]\d{9}`, "BE0123456789"},
	{"BG", "BG", `\d{9,10}`, "BG123456789"},
	{"CY", "CY", `\d{8}[A-Z]`, "CY12345678X"},
	{"CZ", "CZ", `\d{8,10}`, "CZ12345678"},
	{"DE", "DE", `\d{9}`, "DE123456789"},
	{"DK", "DK", `\d{8}`, "DK12345678"},
	{"EE", "EE", `\d{9}`, "EE123456789"},
	{"ES", "ES", `[A-Z0-9]\d{7}[A-Z0-9]`, "ESB12345678"},
	{"FI", "FI", `\d{8}`, "FI12345678"},
	{"FR", "FR", `[A-HJ-NP-Z0-9]{2}\d{9}`, "FR12345678901"},
	{"GR", "EL", `\d{9}`, "EL123456789"},
	{"HR", "HR", `\d{11}`, "HR12345678901"},
	{"HU", "HU", `\d{8}`, "HU12345678"},
	{"IE", "IE", `\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W]`, "IE1234567T"},
	{"IT", "IT", `\d{11}`, "IT12345678901"},
	{"LT", "LT", `\d{9}|\d{12}`, "LT123456789"},
	{"LU", "LU", `\d{8}`, "LU12345678"},
	{"LV", "LV", `\d{11}`, "LV12345678901"},
	{"MT", "MT", `\d{8}`, "MT12345678"},
	{"NL", "NL", `\d{9}B\d{2}`, "NL123456789B01"},
	{"PL", "PL", `\d{10}`, "PL1234567890"},
	{"PT", "PT", `\d{9}`, "PT123456789"},
	{"RO", "RO", `\d{2,10}`, "RO1234567"},
	{"SE", "SE", `\d{12}`, "SE123456789001"},
	{"SI", "SI", `\d{8}`, "SI12345678"},
	{"SK", "SK", `\d{10}`, "SK1234567890"},
}

func build() []countrySchema {
	ruINN10 := Field{Key: "inn", Required: true, Input: digits, Pattern: `\d{10}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_INN, Example: "7707083893", Primary: true, StripeType: "ru_inn"}
	ruINN12 := Field{Key: "inn", Required: true, Input: digits, Pattern: `\d{12}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_INN, Example: "500100732259", Primary: true, StripeType: "ru_inn"}
	ruPersonINN := ruINN12
	ruPersonINN.Required = false
	kzIIN := Field{Key: "iin", Required: true, Input: digits, Pattern: `\d{12}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_KZ_IIN_BIN, Example: "850101300124", Primary: true}
	kzPersonIIN := kzIIN
	kzPersonIIN.Required = false
	byUNP := Field{Key: "unp", Required: true, Input: digits, Pattern: `\d{9}`, Example: "190000000", Primary: true, StripeType: "by_tin"}
	aePersonTRN := Field{Key: "trn", Input: digits, Pattern: `\d{15}`, Example: "100123456700003", Primary: true, StripeType: "ae_trn"}
	aeTRN := aePersonTRN
	aeTRN.Required = true

	out := []countrySchema{
		{"RU", []typeSchema{
			{Person, []Field{ruPersonINN}},
			{SoleProprietor, []Field{
				ruINN12,
				{Key: "ogrnip", Required: true, Input: digits, Pattern: `\d{15}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_OGRNIP, Example: "304500116000157"},
				address("address", true),
			}},
			{Company, []Field{
				ruINN10,
				// КПП: positions 5–6 may be letters (the reason code).
				{Key: "kpp", Required: true, Input: code, Pattern: `\d{4}[\dA-Z]{2}\d{3}`, Example: "773601001", StripeType: "ru_kpp"},
				{Key: "ogrn", Required: true, Input: digits, Pattern: `\d{13}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_OGRN, Example: "1027700132195"},
				address("legal_address", true),
			}},
		}},
		{"AE", []typeSchema{
			{Person, []Field{aePersonTRN}},
			// Owner 10.10: a company gives its TRN (Stripe ae_trn); a person may.
			{Company, []Field{aeTRN, {Key: "trade_license", Input: txt, MaxLength: 64}, address("legal_address", false)}},
		}},
		{"GB", []typeSchema{
			{Person, nil},
			{Company, []Field{vat("GB", "GB", `\d{9}|\d{12}|GD\d{3}|HA\d{3}`, "GB123456789"), address("legal_address", false)}},
		}},
		{"US", []typeSchema{
			{Person, nil},
			{Company, []Field{
				{Key: "ein", Input: digits, Pattern: `\d{9}`, Example: "12-3456789", Primary: true, StripeType: "us_ein"},
				address("legal_address", false),
			}},
		}},
		{"KZ", []typeSchema{
			{Person, []Field{kzPersonIIN}},
			{SoleProprietor, []Field{kzIIN, address("address", false)}},
			{Company, []Field{
				{Key: "bin", Required: true, Input: digits, Pattern: `\d{12}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_KZ_IIN_BIN, Example: "990740000683", Primary: true, StripeType: "kz_bin"},
				address("legal_address", true),
			}},
		}},
		{"BY", []typeSchema{
			{Person, nil},
			{SoleProprietor, []Field{byUNP, address("address", false)}},
			{Company, []Field{byUNP, address("legal_address", true)}},
		}},
		{"CN", []typeSchema{
			{Person, nil},
			{Company, []Field{
				{Key: "uscc", Required: true, Input: code, Pattern: `[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_CN_USCC, Example: "91350100M000100Y43", Primary: true, StripeType: "cn_tin"},
				address("legal_address", false),
			}},
		}},
		{"IN", []typeSchema{
			{Person, nil},
			{Company, []Field{
				{Key: "gstin", Input: code, Pattern: `\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]`, Check: v1.PayerFieldCheck_PAYER_FIELD_CHECK_IN_GSTIN, Example: "27AAPFU0939F1ZV", Primary: true, StripeType: "in_gst"},
				address("legal_address", false),
			}},
		}},
	}
	for _, e := range euVAT {
		out = append(out, countrySchema{e.country, []typeSchema{
			{Person, nil},
			{Company, []Field{vat(e.country, e.prefix, e.body, e.example), address("legal_address", false)}},
		}})
	}
	slices.SortFunc(out, func(a, b countrySchema) int { return strings.Compare(a.country, b.country) })
	for ci := range out {
		for ti := range out[ci].types {
			for fi := range out[ci].types[ti].fields {
				compile(&out[ci].types[ti].fields[fi])
			}
		}
	}
	return out
}

// fallback: any other country — an optional free-form tax number.
func buildFallback() countrySchema {
	f := Field{Key: "tax_id", Input: txt, MaxLength: 64, Primary: true}
	compile(&f)
	return countrySchema{"", []typeSchema{{Person, []Field{f}}, {Company, []Field{f}}}}
}

func compile(f *Field) {
	if f.Pattern != "" {
		f.re = regexp.MustCompile(`^(?:` + f.Pattern + `)$`)
	}
	if f.MaxLength == 0 {
		f.MaxLength = 64
	}
}

var (
	countries = build()
	fallback  = buildFallback()
)

func lookupCountry(country string) countrySchema {
	for _, c := range countries {
		if c.country == country {
			return c
		}
	}
	return fallback
}

// Types lists the payer types the country offers (person and company everywhere; sole
// proprietor where the country registers it separately).
func Types(country string) []string {
	c := lookupCountry(country)
	out := make([]string, 0, len(c.types))
	for _, t := range c.types {
		out = append(out, t.typ)
	}
	return out
}

// Fields returns the requisites of a country + type; ok = false when the country does not
// offer that type.
func Fields(country, typ string) ([]Field, bool) {
	for _, t := range lookupCountry(country).types {
		if t.typ == typ {
			return t.fields, true
		}
	}
	return nil, false
}

// KnownCountry reports whether c is an ISO 3166-1 alpha-2 code a payer may choose.
func KnownCountry(c string) bool {
	_, ok := slices.BinarySearch(allCountries, c)
	return ok
}

// TypeProto maps billing_payers.type to the API enum.
func TypeProto(t string) v1.PayerType {
	switch t {
	case Person:
		return v1.PayerType_PAYER_TYPE_PERSON
	case Company:
		return v1.PayerType_PAYER_TYPE_COMPANY
	case SoleProprietor:
		return v1.PayerType_PAYER_TYPE_SOLE_PROPRIETOR
	}
	return v1.PayerType_PAYER_TYPE_UNSPECIFIED
}

// TypeFromProto maps the API enum to billing_payers.type ("" for an unknown type).
func TypeFromProto(t v1.PayerType) string {
	switch t {
	case v1.PayerType_PAYER_TYPE_PERSON:
		return Person
	case v1.PayerType_PAYER_TYPE_COMPANY:
		return Company
	case v1.PayerType_PAYER_TYPE_SOLE_PROPRIETOR:
		return SoleProprietor
	}
	return ""
}

func fieldProto(f Field) *v1.PayerFieldSpec {
	return &v1.PayerFieldSpec{
		Key: f.Key, Required: f.Required, Input: f.Input, Pattern: f.Pattern, MaxLength: uint32(f.MaxLength), //nolint:gosec // ≤ 300
		Check: f.Check, Example: f.Example, Prefix: f.Prefix, Primary: f.Primary,
	}
}

func countryProto(c countrySchema) *v1.PayerCountrySchema {
	out := &v1.PayerCountrySchema{Country: c.country}
	for _, t := range c.types {
		ts := &v1.PayerTypeSchema{Type: TypeProto(t.typ)}
		for _, f := range t.fields {
			ts.Fields = append(ts.Fields, fieldProto(f))
		}
		out.Types = append(out.Types, ts)
	}
	return out
}

// Schema is the GET …/billing/payer-schema answer.
func Schema() *v1.PayerSchema {
	out := &v1.PayerSchema{Version: SchemaVersion, Fallback: countryProto(fallback), AllCountries: slices.Clone(allCountries)}
	for _, c := range countries {
		out.Countries = append(out.Countries, countryProto(c))
	}
	return out
}
