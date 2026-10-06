package messages

import (
	"reflect"
	"testing"
)

func TestLiteralNicks(t *testing.T) {
	names := func(s string) []string {
		var out []string
		for _, n := range literalNicks(s) {
			if s[n.at] != '@' || s[n.at+1:n.end] == "" {
				t.Fatalf("%q: bad span %+v", s, n)
			}
			out = append(out, n.name)
		}
		return out
	}
	for in, want := range map[string][]string{
		"@ivan hi":                              {"ivan"},
		"hi @Ivan_P, @anna.":                    {"ivan_p", "anna"},
		"(@ivan) [@anna]":                       {"ivan", "anna"},
		"mail@ivan.ru":                          nil, // an address
		"@@ivan":                                nil,
		"x-@ivan":                               nil,
		"`@ivan` ```\n@anna\n```":               nil, // code
		"@ab @1ivan @_ivan":                     nil, // not nicknames
		"@everyone @here":                       nil,
		"@ivanй":                                nil, // runs into a non-ASCII letter
		"@abcdef12-3456-7890-abcd-ef1234567890": nil, // a @<user_id> mention
		"@abcdefghijklmnopqrstuvwxyz0123456":    nil, // 33 characters
		"@ivan @ivan":                           {"ivan", "ivan"},
	} {
		if got := names(in); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}
