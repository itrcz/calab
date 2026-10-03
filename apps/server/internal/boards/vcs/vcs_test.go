package vcs

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files of testdata")

// Golden fixtures: each provider payload in testdata/<name>.json is parsed and turned into the
// links of board FNG; the result must equal testdata/<name>.golden.json (go test -update
// rewrites them after a deliberate change).
func TestParseGolden(t *testing.T) {
	cases := []struct {
		name, provider, event string
	}{
		{"github_push", GitHub, "push"},
		{"github_pr_opened", GitHub, "pull_request"},
		{"github_pr_merged", GitHub, "pull_request"},
		{"github_pr_synchronize", GitHub, "pull_request"},
		{"github_push_tag", GitHub, "push"},
		{"gitlab_push", GitLab, "Push Hook"},
		{"gitlab_mr_merged", GitLab, "Merge Request Hook"},
		{"gitea_pr_opened", Gitea, "pull_request"},
		{"gitea_push", Gitea, "push"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join("testdata", c.name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			ev, err := Parse(c.provider, c.event, body)
			if err != nil {
				t.Fatal(err)
			}
			out := struct {
				Event *Event
				Links []Link
			}{Event: ev}
			if ev != nil {
				out.Links = Links(ev, "FNG")
			}
			got, err := json.MarshalIndent(out, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			golden := filepath.Join("testdata", c.name+".golden.json")
			if *update {
				if err := os.WriteFile(golden, append(got, '\n'), 0o600); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(golden) //nolint:gosec // a fixed testdata path
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got)) {
				t.Errorf("%s differs from the golden file:\n%s", c.name, got)
			}
		})
	}
}

func TestParseMalformed(t *testing.T) {
	for _, c := range []struct{ provider, event string }{{GitHub, "push"}, {GitHub, "pull_request"}, {GitLab, "Push Hook"},
		{GitLab, "Merge Request Hook"}, {Gitea, "pull_request"}} {
		if _, err := Parse(c.provider, c.event, []byte("{not json")); err == nil {
			t.Errorf("%s %s: malformed JSON accepted", c.provider, c.event)
		}
	}
	if ev, err := Parse(GitHub, "ping", []byte(`{}`)); ev != nil || err != nil {
		t.Errorf("ping: %v %v", ev, err)
	}
	if ev, err := Parse(GitHub, "pull_request", []byte(`{"action":"opened","pull_request":{"title":"x"}}`)); ev != nil || err == nil {
		t.Errorf("a pull request without a repository: %v %v", ev, err)
	}
}

func TestVerify(t *testing.T) {
	body, secret := []byte(`{"a":1}`), []byte("s3cret-s3cret-s3cret")
	sig := Sign(body, secret)
	h := func(k, v string) http.Header { x := http.Header{}; x.Set(k, v); return x }
	cases := []struct {
		name     string
		provider string
		h        http.Header
		body     []byte
		want     bool
	}{
		{"github ok", GitHub, h("X-Hub-Signature-256", "sha256="+sig), body, true},
		{"github no prefix", GitHub, h("X-Hub-Signature-256", sig), body, false},
		{"github other body", GitHub, h("X-Hub-Signature-256", "sha256="+sig), []byte(`{"a":2}`), false},
		{"github sha1 header only", GitHub, h("X-Hub-Signature", "sha1="+sig), body, false},
		{"github bad hex", GitHub, h("X-Hub-Signature-256", "sha256=zz"), body, false},
		{"gitea ok", Gitea, h("X-Gitea-Signature", sig), body, true},
		{"forgejo ok", Gitea, h("X-Forgejo-Signature", sig), body, true},
		{"gitea missing", Gitea, http.Header{}, body, false},
		{"gitlab ok", GitLab, h("X-Gitlab-Token", string(secret)), body, true},
		{"gitlab wrong", GitLab, h("X-Gitlab-Token", "s3cret-s3cret-s3creT"), body, false},
		{"gitlab empty", GitLab, http.Header{}, body, false},
		{"unknown provider", "bitbucket", h("X-Hub-Signature-256", "sha256="+sig), body, false},
	}
	for _, c := range cases {
		if got := Verify(c.provider, c.h, c.body, secret); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if Verify(GitHub, h("X-Hub-Signature-256", "sha256="+Sign(body, nil)), body, nil) {
		t.Error("an empty secret verifies")
	}
}

func TestKeys(t *testing.T) {
	cases := []struct {
		text string
		want []int32
	}{
		{"FNG-12 and FNG-7, again FNG-12", []int32{12, 7}},
		{"fng-12 lower case", nil},
		{"XFNG-12 is another board, FNG-0 is no task", nil},
		{"feature/FNG-3-login", []int32{3}},
		{"(FNG-4)", []int32{4}},
		{"OPS-3 BAR-1", nil},
		{"FNG-99999999999", nil},
		{"FNG-5x", nil},
	}
	for _, c := range cases {
		if got := Keys(c.text, "FNG"); !slices.Equal(got, c.want) {
			t.Errorf("%q: %v, want %v", c.text, got, c.want)
		}
	}
}

func TestLinksBounds(t *testing.T) {
	ev := &Event{Provider: GitHub, Repo: "a/b", Push: true, Branch: "main"}
	for i := range 150 {
		ev.Commits = append(ev.Commits, Commit{SHA: string(rune('a'+i%26)) + "sha", Message: "FNG-" + itoa(i+1), URL: "javascript:alert(1)"})
	}
	ls := Links(ev, "FNG")
	if len(ls) != MaxTasks {
		t.Fatalf("%d links, want %d (distinct tasks bound)", len(ls), MaxTasks)
	}
	for _, l := range ls {
		if l.URL != "" {
			t.Fatalf("an unsafe URL kept: %q", l.URL)
		}
	}
	long := &Event{Provider: GitHub, Repo: "a/b", PR: &PullRequest{Number: 1, Title: string(bytes.Repeat([]byte("я"), 300)) + " FNG-1",
		URL: "https://x.example/" + string(bytes.Repeat([]byte("a"), 3000))}}
	l := Links(long, "FNG")
	if len(l) != 1 || len([]rune(l[0].Title)) != MaxTitle || l[0].URL != "" {
		t.Fatalf("clipping: %d %d %q", len(l), len([]rune(l[0].Title)), l[0].URL)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
