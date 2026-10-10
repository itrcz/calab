// Package money is integer money of billing (ADR-0080): int64 minor units of one currency,
// no floats, no FX. Arithmetic refuses mixed currencies and overflow instead of wrapping.
package money

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"strconv"
	"strings"
)

// Currency is an ISO 4217 code of a supported account currency.
type Currency string

// Supported currencies.
const (
	USD Currency = "USD"
	RUB Currency = "RUB"
)

// Errors of money arithmetic.
var (
	ErrCurrencyMismatch = errors.New("money: currency mismatch")
	ErrOverflow         = errors.New("money: overflow")
	ErrUnknownCurrency  = errors.New("money: unknown currency")
	ErrNegative         = errors.New("money: negative operand")
	ErrDivisionByZero   = errors.New("money: division by zero")
)

// ParseCurrency accepts exactly the supported codes.
func ParseCurrency(s string) (Currency, error) {
	switch c := Currency(s); c {
	case USD, RUB:
		return c, nil
	}
	return "", fmt.Errorf("%w: %q", ErrUnknownCurrency, s)
}

// Exponent is the number of minor digits (2 for USD cents and RUB kopecks).
func (c Currency) Exponent() int {
	switch c {
	case USD, RUB:
		return 2
	}
	return 0
}

// Money is an amount in minor units of Currency.
type Money struct {
	Minor    int64
	Currency Currency
}

// New returns minor units of cur.
func New(minor int64, cur Currency) Money { return Money{Minor: minor, Currency: cur} }

// Zero of cur.
func Zero(cur Currency) Money { return Money{Currency: cur} }

// IsZero reports a zero amount.
func (m Money) IsZero() bool { return m.Minor == 0 }

// IsNegative reports an amount below zero.
func (m Money) IsNegative() bool { return m.Minor < 0 }

// Add returns m + o.
func (m Money) Add(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, ErrCurrencyMismatch
	}
	s, err := AddMinor(m.Minor, o.Minor)
	return Money{Minor: s, Currency: m.Currency}, err
}

// Sub returns m - o.
func (m Money) Sub(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, ErrCurrencyMismatch
	}
	if o.Minor == math.MinInt64 {
		return Money{}, ErrOverflow
	}
	s, err := AddMinor(m.Minor, -o.Minor)
	return Money{Minor: s, Currency: m.Currency}, err
}

// Neg returns -m.
func (m Money) Neg() (Money, error) {
	if m.Minor == math.MinInt64 {
		return Money{}, ErrOverflow
	}
	return Money{Minor: -m.Minor, Currency: m.Currency}, nil
}

// Cmp compares amounts of the same currency (-1, 0, 1).
func (m Money) Cmp(o Money) (int, error) {
	if m.Currency != o.Currency {
		return 0, ErrCurrencyMismatch
	}
	switch {
	case m.Minor < o.Minor:
		return -1, nil
	case m.Minor > o.Minor:
		return 1, nil
	}
	return 0, nil
}

// String formats for logs: "USD 12.34", "RUB -0.05".
func (m Money) String() string {
	exp := m.Currency.Exponent()
	if exp == 0 {
		return string(m.Currency) + " " + strconv.FormatInt(m.Minor, 10)
	}
	sign := ""
	v := uint64(m.Minor) //nolint:gosec // two's complement magnitude below
	if m.Minor < 0 {
		sign, v = "-", uint64(-(m.Minor+1))+1 //nolint:gosec // |MinInt64| fits in uint64
	}
	pow := uint64(1)
	for range exp {
		pow *= 10
	}
	return fmt.Sprintf("%s %s%d.%0*d", m.Currency, sign, v/pow, exp, v%pow)
}

// AddMinor adds with overflow detection.
func AddMinor(a, b int64) (int64, error) {
	s := a + b
	if (b > 0 && s < a) || (b < 0 && s > a) {
		return 0, ErrOverflow
	}
	return s, nil
}

// MulMinor multiplies with overflow detection.
func MulMinor(a, b int64) (int64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	p := a * b
	if p/b != a || (a == -1 && b == math.MinInt64) || (b == -1 && a == math.MinInt64) {
		return 0, ErrOverflow
	}
	return p, nil
}

// MulDivHalfUp returns round_half_up(amount × num / den) for non-negative operands, exact in
// 128-bit intermediate arithmetic. It is the one rounding rule of billing: proration
// (M18: 10 × 6h / 24h = 2.5 → 3 cents) and discounts both use it.
func MulDivHalfUp(amount, num, den int64) (int64, error) {
	if amount < 0 || num < 0 || den < 0 {
		return 0, ErrNegative
	}
	if den == 0 {
		return 0, ErrDivisionByZero
	}
	hi, lo := bits.Mul64(uint64(amount), uint64(num)) //nolint:gosec // non-negative, checked above
	d := uint64(den)                                  //nolint:gosec // positive, checked above
	if hi >= d {
		return 0, ErrOverflow
	}
	q, r := bits.Div64(hi, lo, d)
	// Half up: round when 2r >= d (r < d, so 2r cannot overflow uint64 beyond 2^64 - 2).
	if r >= d-r {
		q++
	}
	if q > math.MaxInt64 {
		return 0, ErrOverflow
	}
	return int64(q), nil
}

// BasisPoints in a whole: 10000 bps = 100 %.
const BasisPoints = 10000

// ApplyDiscountBps returns the unit price after a discount of bps (0..10000), half up
// (M8: 10 cents − 10 % = 9).
func ApplyDiscountBps(unit int64, bps int) (int64, error) {
	if bps < 0 || bps > BasisPoints {
		return 0, fmt.Errorf("money: discount %d bps out of 0..%d", bps, BasisPoints)
	}
	return MulDivHalfUp(unit, int64(BasisPoints-bps), BasisPoints)
}

// Prorate returns the share part/whole of amount, half up: the price of a seat for a partial
// interval (part and whole in the same unit, e.g. seconds of a 24 h day).
func Prorate(amount, part, whole int64) (int64, error) {
	if part > whole {
		return 0, fmt.Errorf("money: part %d exceeds whole %d", part, whole)
	}
	return MulDivHalfUp(amount, part, whole)
}

// ErrBadDecimal is a decimal amount that is not a plain number of major units with at most the
// currency's minor digits.
var ErrBadDecimal = errors.New("money: bad decimal amount")

// ParseDecimal reads a decimal amount in major units ("150", "150.5", "150.50", the JSON
// number 1.0 of a provider API) into minor units, exactly (no floats). More fractional digits
// than the currency has are accepted only when they are zeros ("1.000"); a plus sign, an
// exponent or anything else is ErrBadDecimal.
func ParseDecimal(s string, cur Currency) (Money, error) {
	if _, err := ParseCurrency(string(cur)); err != nil {
		return Money{}, err
	}
	exp := cur.Exponent()
	neg := false
	if rest, ok := strings.CutPrefix(s, "-"); ok {
		neg, s = true, rest
	}
	whole, frac, dot := strings.Cut(s, ".")
	if whole == "" || (dot && frac == "") || !digits(whole) || !digits(frac) {
		return Money{}, fmt.Errorf("%w: %q", ErrBadDecimal, s)
	}
	if len(frac) > exp {
		if strings.Trim(frac[exp:], "0") != "" {
			return Money{}, fmt.Errorf("%w: %q has more than %d fractional digits", ErrBadDecimal, s, exp)
		}
		frac = frac[:exp]
	}
	frac += strings.Repeat("0", exp-len(frac))
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return Money{}, fmt.Errorf("%w: %q", ErrOverflow, s)
	}
	pow := int64(1)
	for range exp {
		pow *= 10
	}
	minor, err := MulMinor(w, pow)
	if err != nil {
		return Money{}, err
	}
	if frac != "" {
		f, err := strconv.ParseInt(frac, 10, 64)
		if err != nil {
			return Money{}, fmt.Errorf("%w: %q", ErrBadDecimal, s)
		}
		if minor, err = AddMinor(minor, f); err != nil {
			return Money{}, err
		}
	}
	if neg {
		minor = -minor
	}
	return Money{Minor: minor, Currency: cur}, nil
}

func digits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Decimal formats the amount in major units with exactly the currency's minor digits
// ("150.00", "-0.05"): the request form of provider APIs that take decimal major units.
func (m Money) Decimal() string {
	_, num, _ := strings.Cut(m.String(), " ")
	return num
}
