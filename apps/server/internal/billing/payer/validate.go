package payer

import (
	"strings"
	"unicode"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Reasons of a failed payer check (httpx ApiError.reason with code VALIDATION; the client
// localizes them, field = Problem.Field).
const (
	ReasonRequired        = "PAYER_REQUIRED"         // empty required value
	ReasonFormat          = "PAYER_FORMAT"           // does not match the pattern
	ReasonChecksum        = "PAYER_CHECKSUM"         // the check digit is wrong
	ReasonTooLong         = "PAYER_TOO_LONG"         // longer than max_length
	ReasonCountry         = "PAYER_COUNTRY"          // not an ISO 3166-1 alpha-2 code we know
	ReasonTypeUnavailable = "PAYER_TYPE_UNAVAILABLE" // the country does not offer this payer type
	ReasonEmail           = "PAYER_EMAIL"            // not an e-mail address
)

// Limits of the common fields (billing_payers CHECKs).
const (
	MaxName  = 200
	MaxEmail = 320
)

// Input is a payer as the owner typed it.
type Input struct {
	Type       string // Person | Company | SoleProprietor
	Name       string
	Country    string
	Email      string
	TaxID      string // a client older than the requisites sends only this: taken as the primary field
	Requisites map[string]string
}

// Payer is a checked, normalized payer: Requisites hold only the fields of the country + type
// schema with a value; TaxID is the primary field's value ("" when it has none).
type Payer struct {
	Type       string
	Name       string
	Country    string
	Email      string
	TaxID      string
	Requisites map[string]string
}

// Problem is the first failed check: Field is the API field ("payer.name",
// "payer.requisites.inn"), Reason one of the Reason* codes.
type Problem struct {
	Field  string
	Reason string
}

func (p *Problem) Error() string { return p.Field + ": " + p.Reason }

// Normalize brings a requisite value to its stored form (the client does the same while
// typing): TEXT turns control characters into spaces, trims and collapses whitespace; DIGITS and CODE drop spaces, dashes, dots and
// slashes, CODE also upper-cases and puts the VAT prefix in front (a Greek «GR…» becomes «EL…»).
func Normalize(f Field, country, raw string) string {
	switch f.Input {
	case digits, code:
		var b strings.Builder
		for _, r := range raw {
			if unicode.IsSpace(r) || r == '-' || r == '.' || r == '/' {
				continue
			}
			if f.Input == code {
				r = unicode.ToUpper(r)
			}
			b.WriteRune(r)
		}
		v := b.String()
		if f.Input == code && f.Prefix != "" && v != "" && !strings.HasPrefix(v, f.Prefix) {
			if country != f.Prefix && strings.HasPrefix(v, country) {
				v = v[len(country):]
			}
			v = f.Prefix + v
		}
		return v
	default:
		return normalizeText(raw)
	}
}

// normalizeText turns control characters (C0, DEL, C1: a NUL Postgres refuses, a stray tab or
// bell a 54-FZ receipt should not carry) into spaces, then trims and collapses whitespace.
func normalizeText(raw string) string {
	return strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, raw)), " ")
}

// Check validates one normalized value of a field: "" when it passes (an empty optional value
// passes), else a Reason* code.
func Check(f Field, v string) string {
	if v == "" {
		if f.Required {
			return ReasonRequired
		}
		return ""
	}
	if utf8.RuneCountInString(v) > f.MaxLength {
		return ReasonTooLong
	}
	if f.re != nil && !f.re.MatchString(v) {
		return ReasonFormat
	}
	if !checksum(f.Check, v) {
		return ReasonChecksum
	}
	return ""
}

// Validate normalizes and checks a payer against the schema of its country and type. Values of
// fields outside that schema are dropped (a country switch on the client may leave them).
func Validate(in Input) (Payer, *Problem) {
	out := Payer{Type: in.Type, Requisites: map[string]string{}}
	out.Country = strings.ToUpper(strings.TrimSpace(in.Country))
	if !KnownCountry(out.Country) {
		return out, &Problem{"payer.country", ReasonCountry}
	}
	fields, ok := Fields(out.Country, in.Type)
	if !ok {
		return out, &Problem{"payer.type", ReasonTypeUnavailable}
	}
	out.Name = normalizeText(in.Name)
	switch n := utf8.RuneCountInString(out.Name); {
	case n == 0:
		return out, &Problem{"payer.name", ReasonRequired}
	case n > MaxName:
		return out, &Problem{"payer.name", ReasonTooLong}
	}
	out.Email = strings.TrimSpace(in.Email)
	if !validEmail(out.Email) {
		return out, &Problem{"payer.email", ReasonEmail}
	}
	for _, f := range fields {
		raw := in.Requisites[f.Key]
		if f.Primary && strings.TrimSpace(raw) == "" {
			raw = in.TaxID
		}
		v := Normalize(f, out.Country, raw)
		if r := Check(f, v); r != "" {
			return out, &Problem{"payer.requisites." + f.Key, r}
		}
		if v == "" {
			continue
		}
		out.Requisites[f.Key] = v
		if f.Primary {
			out.TaxID = v
		}
	}
	return out, nil
}

func validEmail(e string) bool {
	if len(e) < 3 || len(e) > MaxEmail || strings.IndexFunc(e, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return false
	}
	at := strings.LastIndexByte(e, '@')
	return at > 0 && at < len(e)-1
}

// checksum runs the check digit algorithm of a field on a value that matched its pattern.
func checksum(c v1.PayerFieldCheck, v string) bool {
	switch c {
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_INN:
		return ruINN(v)
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_OGRN:
		return ruOGRN(v, 13, 11)
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_RU_OGRNIP:
		return ruOGRN(v, 15, 13)
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_KZ_IIN_BIN:
		return kzIINBIN(v)
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_IN_GSTIN:
		return inGSTIN(v)
	case v1.PayerFieldCheck_PAYER_FIELD_CHECK_CN_USCC:
		return cnUSCC(v)
	}
	return true
}

func allDigits(v string, n int) bool {
	if len(v) != n {
		return false
	}
	for i := range len(v) {
		if v[i] < '0' || v[i] > '9' {
			return false
		}
	}
	return true
}

// weighted is Σ d[i]·w[i] over the first len(w) digits.
func weighted(v string, w []int) int {
	s := 0
	for i, k := range w {
		s += int(v[i]-'0') * k
	}
	return s
}

// ruINN: 10 digits (organization) — one control digit; 12 digits (person, sole proprietor) —
// two (ФНС weights, sum mod 11 mod 10).
func ruINN(v string) bool {
	ctl := func(w []int, at int) bool { return weighted(v, w)%11%10 == int(v[at]-'0') }
	switch {
	case allDigits(v, 10):
		return ctl([]int{2, 4, 10, 3, 5, 9, 4, 6, 8}, 9)
	case allDigits(v, 12):
		return ctl([]int{7, 2, 4, 10, 3, 5, 9, 4, 6, 8}, 10) && ctl([]int{3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8}, 11)
	}
	return false
}

// ruOGRN: ОГРН (13 digits, the first 12 as a number mod 11) and ОГРНИП (15 digits, the first
// 14 mod 13); the remainder's last digit is the control digit.
func ruOGRN(v string, n, mod int) bool {
	if !allDigits(v, n) {
		return false
	}
	r := 0
	for i := range n - 1 {
		r = (r*10 + int(v[i]-'0')) % mod
	}
	return r%10 == int(v[n-1]-'0')
}

// kzIINBIN: 12 digits; weights 1..11 mod 11, on 10 a second round with weights 3..11,1,2; a
// second 10 is never a valid number.
func kzIINBIN(v string) bool {
	if !allDigits(v, 12) {
		return false
	}
	c := weighted(v, []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}) % 11
	if c == 10 {
		c = weighted(v, []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2}) % 11
		if c == 10 {
			return false
		}
	}
	return c == int(v[11]-'0')
}

const base36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// inGSTIN: 15 characters; the last one is the mod-36 check character of the first 14 (factor
// 1, 2 alternating; each product split into quotient + remainder of 36).
func inGSTIN(v string) bool {
	if len(v) != 15 {
		return false
	}
	sum := 0
	for i := range 14 {
		d := strings.IndexByte(base36, v[i])
		if d < 0 {
			return false
		}
		p := d * (1 + i%2)
		sum += p/36 + p%36
	}
	return base36[(36-sum%36)%36] == v[14]
}

// uscc is the alphabet of the unified social credit code (GB 32100-2015: no I, O, Z, S, V).
const uscc = "0123456789ABCDEFGHJKLMNPQRTUWXY"

// cnUSCC: 18 characters; the last one is the mod-31 check character of the first 17.
func cnUSCC(v string) bool {
	if len(v) != 18 {
		return false
	}
	w := []int{1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28}
	sum := 0
	for i, k := range w {
		d := strings.IndexByte(uscc, v[i])
		if d < 0 {
			return false
		}
		sum += d * k
	}
	return uscc[(31-sum%31)%31] == v[17]
}
