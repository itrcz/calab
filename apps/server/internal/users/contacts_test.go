package users

import "testing"

func TestNormalizePhone(t *testing.T) {
	for in, want := range map[string]string{
		"+7 (999) 123-45-67":                "+7 (999) 123-45-67",
		"  +7   999\t123 ":                  "+7 999 123",
		"8-800-555-35-35":                   "8-800-555-35-35",
		"":                                  "",
		"   ":                               "",
		"abc":                               "!",
		"+7+999":                            "!",
		"12":                                "!",
		"999 123 45 67 ext 1":               "!",
		"+1 234 567 890 123 456 789 012 34": "!", // 33 characters
	} {
		got, err := NormalizePhone(in)
		if want == "!" {
			if err == nil {
				t.Errorf("%q: accepted as %q", in, got)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("%q: %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestValidateUsername(t *testing.T) {
	for name, ok := range map[string]bool{
		"ivan": true, "ivan_petrov": true, "a12": true, "abcdefghijklmnopqrstuvwxyz012345": true,
		"ab": false, "1ivan": false, "_ivan": false, "ivan-p": false, "ivan.p": false, "Ivan": false,
		"abcdefghijklmnopqrstuvwxyz0123456": false, "here": false, "everyone": false, "channel": false,
		"all": false, "admin": false, "support": false, "calab": false, "system": false, "bot": false,
	} {
		if err := ValidateUsername(name); (err == nil) != ok {
			t.Errorf("%q: %v, want ok=%v", name, err, ok)
		}
	}
	if got := NormalizeUsername("  @Ivan_P "); got != "ivan_p" {
		t.Errorf("normalize: %q", got)
	}
}
