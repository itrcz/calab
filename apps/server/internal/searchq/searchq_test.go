package searchq

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in, ts, text string
	}{
		{"релиз", "'релиз':*", "релиз"},
		{"р", "'р'", "р"}, // one character: no prefix
		{"Кошки бегают", "'кошки' & 'бегают':*", "кошки бегают"},
		{"  deploy  ", "'deploy':*", "deploy"},
		{"deploy-скрипт", "'deploy' & 'скрипт':*", "deploy скрипт"},
		{"кошки -собаки", "'кошки' & !'собаки'", "кошки"},
		{"-собаки кошки", "!'собаки' & 'кошки':*", "кошки"},
		{`"новый релиз" завтра`, "('новый' <-> 'релиз') & 'завтра':*", "новый релиз завтра"},
		{`завтра "новый релиз"`, "'завтра' & ('новый' <-> 'релиз')", "завтра новый релиз"},
		{`-"старый релиз" новый`, "!('старый' <-> 'релиз') & 'новый':*", "новый"},
		{"кошки or собаки", "'кошки' | 'собаки':*", "кошки собаки"},
		{"кошки OR собаки hello", "'кошки' | 'собаки' & 'hello':*", "кошки собаки hello"},
		{"or", "'or':*", "or"},
		{`"незакрытая фраза`, "('незакрытая' <-> 'фраза')", "незакрытая фраза"},
		{"it's", "'it' & 's'", "it s"},
		{"a&b|c!d", "'a' & 'b' & 'c' & 'd'", "a b c d"},
		{"x:*", "'x'", "x"},
		{"(a) <-> b", "'a' & 'b'", "a b"},
		{"ёлка", "'ёлка':*", "ёлка"},
		{"日本語 テスト", "'日本語' & 'テスト':*", "日本語 テスト"},
		{"café", "'café':*", "café"},
		{"café", "'café':*", "café"}, // combining mark stays in the word
		{"ABC-12", "'abc' & '12':*", "abc 12"},
		{"v2.3.1", "'v2' & '3' & '1'", "v2 3 1"},
		{"\\'; DROP TABLE x; --", "'drop' & 'table' & 'x'", "drop table x"},
		{"кошки - собаки", "'кошки' & 'собаки':*", "кошки собаки"}, // a lone dash excludes nothing
	}
	for _, c := range cases {
		q, err := Parse(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if q.TS != c.ts || q.Text != c.text {
			t.Errorf("%q: got %q / %q, want %q / %q", c.in, q.TS, q.Text, c.ts, c.text)
		}
	}
}

func TestParseEmpty(t *testing.T) {
	for _, in := range []string{"", "   ", "!!!", "&|!():*", `""`, "-кошки", "-a -b", "\u0002\u0003", "—", strings.Repeat("а", MaxQuery+1), "\xff\xfe"} {
		if _, err := Parse(in); !errors.Is(err, ErrEmpty) {
			t.Errorf("%q: want ErrEmpty, got %v", in, err)
		}
	}
}

// Every lexeme is a quoted run of letters, digits and marks: no input can inject tsquery syntax.
func TestParseInjectionSafe(t *testing.T) {
	inputs := []string{
		"'", "''", "a'b", `a\'b`, `\`, "a:*b", "a & ! b", "a | b", "a <-> b", "a <2> b", "a:A", "a:*D",
		"'a':* & 'b'", `"a" "b"`, `" - "`, "--", "-'a'", "a\x00b", "a\nb\tc", "%_", "\u202ea\u202c",
	}
	for _, in := range inputs {
		q, err := Parse(in)
		if err != nil {
			continue
		}
		checkTS(t, in, q.TS)
	}
}

func checkTS(t *testing.T, in, ts string) {
	t.Helper()
	rest := ts
	for rest != "" {
		switch {
		case strings.HasPrefix(rest, "'"):
			end := strings.Index(rest[1:], "'")
			if end < 0 {
				t.Fatalf("%q: unterminated lexeme in %q", in, ts)
			}
			for _, r := range rest[1 : 1+end] {
				if !isWordRune(r) {
					t.Fatalf("%q: non-word rune %q in lexeme of %q", in, r, ts)
				}
			}
			rest = rest[2+end:]
			rest = strings.TrimPrefix(rest, ":*")
		case strings.HasPrefix(rest, " & "), strings.HasPrefix(rest, " | "):
			rest = rest[3:]
		case strings.HasPrefix(rest, " <-> "):
			rest = rest[5:]
		case strings.HasPrefix(rest, "!"), strings.HasPrefix(rest, "("), strings.HasPrefix(rest, ")"):
			rest = rest[1:]
		default:
			t.Fatalf("%q: unexpected %q in %q", in, rest, ts)
		}
	}
}

func FuzzParse(f *testing.F) {
	for _, s := range []string{"релиз", `"a b" -c or d`, "'; drop", "日本", "a:*"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		q, err := Parse(in)
		if err != nil {
			return
		}
		if !utf8.ValidString(q.TS) || len(q.Words) == 0 {
			t.Fatalf("%q: %+v", in, q)
		}
		checkTS(t, in, q.TS)
	})
}

func TestParseLimits(t *testing.T) {
	q, err := Parse(strings.Repeat("слово ", 30))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(q.TS, "'слово'"); n != MaxTerms {
		t.Fatalf("terms: %d", n)
	}
	q, err = Parse(strings.Repeat("я", 150))
	if err != nil {
		t.Fatal(err)
	}
	if n := utf8.RuneCountInString(q.Words[0]); n != maxWord {
		t.Fatalf("word length %d", n)
	}
}

func TestLike(t *testing.T) {
	if got := Like(`50%_a\b`); got != `%50\%\_a\\b%` {
		t.Fatal(got)
	}
}
