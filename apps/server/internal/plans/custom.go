package plans

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/calaba/calaba/server/internal/httpx"
)

// Custom plan name and description (ADR-0086 «Индивидуальный тариф»): what members see instead
// of «Индивидуальный». Checked the same way on the manual plan edit and the billing custom plan.
const (
	MaxCustomName        = 40
	MaxCustomDescription = 140
)

// CleanText trims s and removes control and invisible formatting characters (line breaks, tabs,
// bidi overrides, zero-width marks) so a name renders as typed on one line; runs of spaces become
// one space.
func CleanText(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsSpace(r): // tabs and line breaks too
			space = b.Len() > 0
			continue
		case r == utf8.RuneError || unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r):
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// CustomText cleans a custom plan's name and description and checks their length (422).
func CustomText(name, description string) (string, string, error) {
	name, description = CleanText(name), CleanText(description)
	if utf8.RuneCountInString(name) > MaxCustomName {
		return "", "", httpx.Validation("displayName", "the plan name must be at most 40 characters")
	}
	if utf8.RuneCountInString(description) > MaxCustomDescription {
		return "", "", httpx.Validation("description", "the plan description must be at most 140 characters")
	}
	return name, description, nil
}
