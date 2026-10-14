// Package searchq parses search queries into tsquery text and finds matching messages with a
// plan that stays fast for absent, rare and frequent words (ADR-0062). It is the shared core of
// GET /api/search and the older room / workspace message and task searches.
package searchq

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits of a parsed query.
const (
	MaxQuery = 200 // characters of q
	MaxTerms = 16  // words and phrases; the rest is ignored
	maxWord  = 64  // characters of one word; longer words are cut
	// minPrefix: the last word becomes a prefix (word:*) from this many characters.
	minPrefix = 2
)

// ErrEmpty means the query has no positive word after removing punctuation (or is too long).
var ErrEmpty = errors.New("searchq: no words")

// Query is a parsed search query.
type Query struct {
	// TS is a to_tsquery input: quoted lexemes of letters and digits only, joined with & | !
	// <-> and parentheses. Safe to pass as a parameter to to_tsquery for any config.
	TS string
	// Words are the positive (not excluded) words in order, lower-cased.
	Words []string
	// Text is Words joined with spaces: the input of trigram similarity / ILIKE on short fields.
	Text string
}

type term struct {
	words []string // >1: a phrase
	neg   bool
	or    bool // joined to the previous term with OR (else AND)
	quote bool
}

// Parse builds a Query from user input like websearch_to_tsquery: words are ANDed, "quoted
// phrases" match adjacent words, -word excludes, OR (any case) between two terms is an
// alternative. The last unquoted, not excluded word of minPrefix+ characters also matches as a
// prefix. Everything that is not a letter, digit or mark separates words, so no tsquery syntax
// can be injected. ErrEmpty when no positive word is left or q is longer than MaxQuery.
func Parse(q string) (Query, error) {
	if utf8.RuneCountInString(q) > MaxQuery || !utf8.ValidString(q) {
		return Query{}, ErrEmpty
	}
	terms := tokenize(q)
	if len(terms) > MaxTerms {
		terms = terms[:MaxTerms]
	}
	var out Query
	for _, t := range terms {
		if !t.neg {
			out.Words = append(out.Words, t.words...)
		}
	}
	if len(out.Words) == 0 {
		return Query{}, ErrEmpty
	}
	out.Text = strings.Join(out.Words, " ")
	last := -1
	for i, t := range terms {
		if !t.neg && !t.quote && len(t.words) == 1 {
			last = i
		}
	}
	if last >= 0 && last != len(terms)-1 {
		last = -1 // only the very last term is being typed
	}
	var b strings.Builder
	for i, t := range terms {
		if i > 0 {
			if t.or {
				b.WriteString(" | ")
			} else {
				b.WriteString(" & ")
			}
		}
		if t.neg {
			b.WriteString("!")
		}
		if len(t.words) > 1 {
			b.WriteString("(")
		}
		for j, w := range t.words {
			if j > 0 {
				b.WriteString(" <-> ")
			}
			b.WriteString(lexeme(w))
			if i == last && utf8.RuneCountInString(w) >= minPrefix {
				b.WriteString(":*")
			}
		}
		if len(t.words) > 1 {
			b.WriteString(")")
		}
	}
	out.TS = b.String()
	return out, nil
}

// Like is an ILIKE pattern finding s anywhere (with % _ \ escaped).
func Like(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
}

// TitleMatch matches a short text column col with typos and inside words: every positive word
// of q is in col as a substring or with a typo (pg_trgm word similarity ≥
// pg_trgm.word_similarity_threshold). Both forms use a gin_trgm_ops index on col; add appends a
// parameter and returns its placeholder.
func TitleMatch(col string, q Query, add func(any) string) string {
	parts := make([]string, 0, len(q.Words))
	for _, w := range q.Words {
		parts = append(parts, "("+add(w)+"::text <% "+col+" OR "+col+" ILIKE "+add(Like(w))+"::text)")
	}
	return "(" + strings.Join(parts, " AND ") + ")"
}

// lexeme quotes a word for to_tsquery. Words hold letters, digits and marks only; quotes and
// backslashes are escaped anyway.
func lexeme(w string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `''`).Replace(w) + "'"
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r)
}

// tokenize splits q into terms. A '-' right before a word at the start of a term excludes it
// (also before a quoted phrase); a lone OR between two terms makes the next one an alternative.
func tokenize(q string) []term {
	var (
		terms   []term
		cur     []rune
		phrase  []string
		inQuote bool
		neg     bool
		or      bool
		prev    = ' '
	)
	flushWord := func() {
		if len(cur) == 0 {
			return
		}
		w := strings.ToLower(string(cur))
		if utf8.RuneCountInString(w) > maxWord {
			w = string([]rune(w)[:maxWord])
		}
		cur = cur[:0]
		if inQuote {
			phrase = append(phrase, w)
			return
		}
		if (w == "or") && !neg && len(terms) > 0 {
			or = true
			return
		}
		terms = append(terms, term{words: []string{w}, neg: neg, or: or})
		neg, or = false, false
	}
	for _, r := range q {
		switch {
		case isWordRune(r):
			cur = append(cur, r)
		case r == '"':
			flushWord()
			if inQuote {
				if len(phrase) > 0 {
					terms = append(terms, term{words: phrase, neg: neg, or: or, quote: true})
				}
				phrase, neg, or = nil, false, false
			}
			inQuote = !inQuote
		case r == '-' && !inQuote && len(cur) == 0 && (unicode.IsSpace(prev) || prev == '"' || prev == '(' || prev == ' '):
			neg = true
		default:
			flushWord()
			if unicode.IsSpace(r) && !inQuote && neg && len(cur) == 0 {
				neg = false // a dash followed by a space excludes nothing
			}
		}
		prev = r
	}
	flushWord()
	if inQuote && len(phrase) > 0 { // an unclosed quote: the phrase up to the end
		terms = append(terms, term{words: phrase, neg: neg, or: or, quote: true})
	}
	// An OR without a following term, or a leading OR, is just ignored above; a term list
	// starting with OR cannot happen (OR needs a previous term).
	return terms
}
