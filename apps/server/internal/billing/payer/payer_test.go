package payer

import (
	"bytes"
	"encoding/json"
	"maps"
	"os"
	"regexp"
	"slices"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

const (
	vectorsPath = "../../../../../proto/testdata/billing_payer_vectors.json"
	schemaPath  = "../../../../../proto/testdata/billing_payer_schema.json"
)

type vectors struct {
	Checks []struct {
		Check string `json:"check"`
		Value string `json:"value"`
		OK    bool   `json:"ok"`
	} `json:"checks"`
	Payers []struct {
		Name string `json:"name"`
		In   struct {
			Type       string            `json:"type"`
			Name       string            `json:"name"`
			Country    string            `json:"country"`
			Email      string            `json:"email"`
			TaxID      string            `json:"taxId"`
			Requisites map[string]string `json:"requisites"`
		} `json:"in"`
		Out *struct {
			Name       string            `json:"name"`
			Country    string            `json:"country"`
			Email      string            `json:"email"`
			TaxID      string            `json:"taxId"`
			Requisites map[string]string `json:"requisites"`
		} `json:"out"`
		Error *Problem `json:"error"`
	} `json:"payers"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestChecksumVectors(t *testing.T) {
	for _, c := range loadVectors(t).Checks {
		check, ok := v1.PayerFieldCheck_value[c.Check]
		if !ok {
			t.Fatalf("unknown check %s", c.Check)
		}
		if got := checksum(v1.PayerFieldCheck(check), c.Value); got != c.OK {
			t.Errorf("%s(%s) = %v, want %v", c.Check, c.Value, got, c.OK)
		}
	}
}

func TestValidateVectors(t *testing.T) {
	for _, c := range loadVectors(t).Payers {
		t.Run(c.Name, func(t *testing.T) {
			in := Input{
				Type: TypeFromProto(v1.PayerType(v1.PayerType_value[c.In.Type])), Name: c.In.Name, Country: c.In.Country,
				Email: c.In.Email, TaxID: c.In.TaxID, Requisites: c.In.Requisites,
			}
			got, p := Validate(in)
			switch {
			case c.Error != nil:
				if p == nil || *p != *c.Error {
					t.Fatalf("problem %v, want %v", p, c.Error)
				}
			case p != nil:
				t.Fatalf("unexpected problem %v", p)
			default:
				o := c.Out
				if got.Name != o.Name || got.Country != o.Country || got.Email != o.Email || got.TaxID != o.TaxID || !maps.Equal(got.Requisites, o.Requisites) {
					t.Fatalf("got %+v, want %+v", got, *o)
				}
			}
		})
	}
}

// The served schema is pinned by proto/testdata/billing_payer_schema.json: the client's tests
// and billing mock read it. UPDATE_GOLDEN=1 rewrites it.
func TestSchemaGolden(t *testing.T) {
	got := Schema()
	if os.Getenv("UPDATE_GOLDEN") != "" {
		raw, err := protojson.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := json.Indent(&buf, raw, "", "  "); err != nil {
			t.Fatal(err)
		}
		buf.WriteByte('\n')
		if err := os.WriteFile(schemaPath, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	var want v1.PayerSchema
	if err := protojson.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(got, &want) {
		t.Fatal("payer schema changed: bump SchemaVersion if a rule changed, then UPDATE_GOLDEN=1 go test ./internal/billing/payer")
	}
}

var euMembers = []string{"AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"}

func TestSchemaInvariants(t *testing.T) {
	if len(allCountries) != 249 || !slices.IsSorted(allCountries) {
		t.Fatalf("allCountries: %d codes, sorted %v", len(allCountries), slices.IsSorted(allCountries))
	}
	for _, c := range euMembers {
		if lookupCountry(c).country != c {
			t.Errorf("EU member %s has no VAT schema", c)
		}
	}
	// ECMAScript-safe patterns: the client compiles the same string with new RegExp.
	jsUnsafe := regexp.MustCompile(`\(\?|\\[pPAzZ]|\[\[:`)
	for _, c := range append(slices.Clone(countries), fallback) {
		if c.country != "" && !KnownCountry(c.country) {
			t.Errorf("schema of unknown country %q", c.country)
		}
		types := Types(c.country)
		if !slices.Contains(types, Person) || !slices.Contains(types, Company) {
			t.Errorf("%q: person and company must be offered, got %v", c.country, types)
		}
		if slices.Contains(types, SoleProprietor) != slices.Contains([]string{"RU", "KZ", "BY"}, c.country) {
			t.Errorf("%q: sole proprietor only in RU / KZ / BY, got %v", c.country, types)
		}
		for _, ts := range c.types {
			keys, primaries := map[string]bool{}, 0
			for _, f := range ts.fields {
				if keys[f.Key] {
					t.Errorf("%q %s: duplicate field %s", c.country, ts.typ, f.Key)
				}
				keys[f.Key] = true
				if f.Primary {
					primaries++
				}
				if jsUnsafe.MatchString(f.Pattern) {
					t.Errorf("%q %s.%s: pattern %q is not ECMAScript-safe", c.country, ts.typ, f.Key, f.Pattern)
				}
				if f.Example != "" {
					if r := Check(f, Normalize(f, c.country, f.Example)); r != "" {
						t.Errorf("%q %s.%s: example %q fails: %s", c.country, ts.typ, f.Key, f.Example, r)
					}
				}
			}
			if primaries > 1 {
				t.Errorf("%q %s: %d primary fields", c.country, ts.typ, primaries)
			}
		}
	}
	if _, ok := Fields("DE", SoleProprietor); ok {
		t.Error("DE offers a sole proprietor")
	}
	if f, _ := Fields("ZW", Company); len(f) != 1 || f[0].Key != "tax_id" || f[0].Required {
		t.Errorf("fallback company fields: %+v", f)
	}
}

func TestNormalize(t *testing.T) {
	vat, _ := Fields("GR", Company)
	cases := []struct {
		f           Field
		country, in string
		want        string
	}{
		{Field{Input: txt}, "", "  a \t b\n c ", "a b c"},
		{Field{Input: digits}, "", " 12-34.56/78 9", "123456789"},
		{Field{Input: code}, "", "7736ab001", "7736AB001"},
		{vat[0], "GR", "123456789", "EL123456789"},
		{vat[0], "GR", "gr 123 456 789", "EL123456789"},
		{vat[0], "GR", "EL123456789", "EL123456789"},
		{Field{Input: code, Prefix: "DE"}, "DE", "", ""},
	}
	for _, c := range cases {
		if got := Normalize(c.f, c.country, c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStripeTaxIDs(t *testing.T) {
	ru := StripeTaxIDs("RU", Company, map[string]string{"inn": "7707083893", "kpp": "773601001", "ogrn": "1027700132195", "legal_address": "Москва"})
	if !slices.Equal(ru, []TaxID{{"ru_inn", "7707083893"}, {"ru_kpp", "773601001"}}) {
		t.Errorf("RU company: %v", ru)
	}
	us := StripeTaxIDs("US", Company, map[string]string{"ein": "123456789"})
	if !slices.Equal(us, []TaxID{{"us_ein", "12-3456789"}}) {
		t.Errorf("US company: %v", us)
	}
	if got := StripeTaxIDs("GR", Company, map[string]string{"vat": "EL123456789"}); !slices.Equal(got, []TaxID{{"eu_vat", "EL123456789"}}) {
		t.Errorf("GR company: %v", got)
	}
	if got := StripeTaxIDs("BR", Company, map[string]string{"tax_id": "123"}); len(got) != 0 {
		t.Errorf("fallback tax id is never sent to Stripe: %v", got)
	}
	if ReceiptName(Person, "Иван") != "" || ReceiptName(Company, "ООО «Ромашка»") != "ООО «Ромашка»" || ReceiptName(SoleProprietor, "ИП Иванов") != "ИП Иванов" {
		t.Error("ReceiptName")
	}
}

func TestTypeProtoRoundTrip(t *testing.T) {
	for _, typ := range []string{Person, Company, SoleProprietor} {
		if TypeFromProto(TypeProto(typ)) != typ {
			t.Errorf("round trip of %s", typ)
		}
	}
	if TypeFromProto(v1.PayerType_PAYER_TYPE_UNSPECIFIED) != "" {
		t.Error("unspecified type must not map")
	}
}
