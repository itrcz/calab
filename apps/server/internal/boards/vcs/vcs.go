// Package vcs reads the webhooks of Git hostings for board Git links (ADR-0060 §4): signature
// checks of GitHub, GitLab and Gitea / Forgejo, their push and pull / merge request events in
// one Event form, and task keys («FNG-12») in branch names, titles, bodies and commit messages.
// It knows nothing of boards or the database.
package vcs

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Providers (the {provider} path segment and the stored value).
const (
	GitHub = "github"
	GitLab = "gitlab"
	Gitea  = "gitea" // Gitea and Forgejo
)

// Valid reports a known provider name.
func Valid(p string) bool { return p == GitHub || p == GitLab || p == Gitea }

// Link kinds and pull request states (task_git_links).
const (
	KindBranch = "branch"
	KindPR     = "pr"
	KindCommit = "commit"

	StateOpen   = "open"
	StateMerged = "merged"
	StateClosed = "closed"
)

// Trigger events (RuleGitEvent names without the prefix).
const (
	EventBranchCreated = "BRANCH_CREATED"
	EventPROpened      = "PR_OPENED"
	EventPRMerged      = "PR_MERGED"
	EventPRClosed      = "PR_CLOSED"
	EventCommitPushed  = "COMMIT_PUSHED"
)

// Bounds of what one delivery may produce.
const (
	MaxBody     = 1 << 20 // bytes of a delivery
	MaxCommits  = 100     // commits of a push looked at
	MaxTasks    = 20      // distinct tasks one delivery may touch
	MaxTitle    = 200
	MaxURL      = 2048
	MaxAuthor   = 100
	MaxRepo     = 300
	MaxRef      = 300
	maxKeysText = 20000 // runes of a text searched for keys
)

// Verify checks the delivery's signature with the board's secret: GitHub X-Hub-Signature-256
// "sha256=<hex HMAC-SHA256(secret, body)>"; Gitea / Forgejo X-Gitea-Signature (or
// X-Forgejo-Signature) "<hex HMAC-SHA256>"; GitLab X-Gitlab-Token equal to the secret. All
// comparisons are constant-time.
func Verify(provider string, h http.Header, body, secret []byte) bool {
	if len(secret) == 0 {
		return false
	}
	switch provider {
	case GitHub:
		sig, ok := strings.CutPrefix(h.Get("X-Hub-Signature-256"), "sha256=")
		return ok && macEqual(sig, body, secret)
	case Gitea:
		sig := h.Get("X-Gitea-Signature")
		if sig == "" {
			sig = h.Get("X-Forgejo-Signature")
		}
		return sig != "" && macEqual(sig, body, secret)
	case GitLab:
		tok := h.Get("X-Gitlab-Token")
		return tok != "" && subtle.ConstantTimeCompare([]byte(tok), secret) == 1
	}
	return false
}

func macEqual(hexSig string, body, secret []byte) bool {
	got, err := hex.DecodeString(strings.TrimSpace(hexSig))
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hmac.Equal(got, m.Sum(nil))
}

// Sign is the HMAC-SHA256 hex of body (tests and docs: what GitHub / Gitea send).
func Sign(body, secret []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// EventName is the provider's event header: GitHub X-GitHub-Event ("push", "pull_request"),
// GitLab X-Gitlab-Event ("Push Hook", "Merge Request Hook"), Gitea X-Gitea-Event (or
// X-Forgejo-Event).
func EventName(provider string, h http.Header) string {
	switch provider {
	case GitHub:
		return h.Get("X-GitHub-Event")
	case GitLab:
		return h.Get("X-Gitlab-Event")
	case Gitea:
		if v := h.Get("X-Gitea-Event"); v != "" {
			return v
		}
		return h.Get("X-Forgejo-Event")
	}
	return ""
}

// Event is a push or a pull / merge request in a provider-neutral form.
type Event struct {
	Provider string
	Repo     string // owner/name (GitLab: the project path)
	RepoURL  string
	Author   string // who pushed / opened
	// Push.
	Push          bool
	Branch        string
	BranchCreated bool
	Commits       []Commit
	// Pull / merge request.
	PR *PullRequest
}

// Commit of a push.
type Commit struct {
	SHA     string
	Message string
	URL     string
	Author  string
}

// PullRequest is a pull / merge request after the event.
type PullRequest struct {
	Number int64
	Title  string
	Body   string
	URL    string
	State  string // open | merged | closed
	Branch string // the source branch
	Author string
	// Event: EventPROpened / EventPRMerged / EventPRClosed, or "" for an edit (title / body).
	Event string
}

// keyRE: a task key anywhere in a text (ADR-0060 §4).
var keyRE = regexp.MustCompile(`\b([A-Z0-9]{2,6})-(\d+)\b`)

// Keys returns the task numbers of board key boardKey mentioned in text, in order, without
// duplicates. Keys of other boards are ignored.
func Keys(text, boardKey string) []int32 {
	if utf8.RuneCountInString(text) > maxKeysText {
		text = string([]rune(text)[:maxKeysText])
	}
	var out []int32
	for _, m := range keyRE.FindAllStringSubmatch(text, -1) {
		if m[1] != boardKey {
			continue
		}
		n, err := strconv.ParseInt(m[2], 10, 32)
		if err != nil || n < 1 {
			continue
		}
		if !slices.Contains(out, int32(n)) {
			out = append(out, int32(n))
		}
	}
	return out
}

// Link is one task_git_links row a delivery writes for task Number (Event: the rule trigger it
// fires, "" = none).
type Link struct {
	Number int32
	Kind   string
	Ref    string
	Title  string
	URL    string
	State  string
	Author string
	Event  string
}

// Links turns an event into the links of the board's tasks (key boardKey): a new branch whose
// name has a key; each commit whose message has one; a pull request whose title, body or
// source branch has one. At most MaxTasks distinct tasks.
func Links(ev *Event, boardKey string) []Link {
	var out []Link
	tasks := map[int32]bool{}
	add := func(l Link) {
		if !tasks[l.Number] && len(tasks) >= MaxTasks {
			return
		}
		tasks[l.Number] = true
		l.Title, l.Author = clip(l.Title, MaxTitle), clip(l.Author, MaxAuthor)
		l.Ref, l.URL = clip(l.Ref, MaxRef), safeURL(l.URL)
		out = append(out, l)
	}
	switch {
	case ev.PR != nil:
		pr := ev.PR
		keys := Keys(pr.Title+"\n"+pr.Branch+"\n"+pr.Body, boardKey)
		for _, n := range keys {
			add(Link{Number: n, Kind: KindPR, Ref: strconv.FormatInt(pr.Number, 10), Title: pr.Title, URL: pr.URL,
				State: pr.State, Author: pr.Author, Event: pr.Event})
		}
	case ev.Push:
		if ev.BranchCreated {
			for _, n := range Keys(ev.Branch, boardKey) {
				add(Link{Number: n, Kind: KindBranch, Ref: ev.Branch, Title: ev.Branch, URL: branchURL(ev), Author: ev.Author,
					Event: EventBranchCreated})
			}
		}
		for i, c := range ev.Commits {
			if i >= MaxCommits {
				break
			}
			first, _, _ := strings.Cut(strings.TrimSpace(c.Message), "\n")
			for _, n := range Keys(c.Message, boardKey) {
				add(Link{Number: n, Kind: KindCommit, Ref: c.SHA, Title: first, URL: c.URL, Author: c.Author, Event: EventCommitPushed})
			}
		}
	}
	return out
}

func branchURL(ev *Event) string {
	if ev.RepoURL == "" || ev.Branch == "" {
		return ""
	}
	p := "/tree/"
	switch ev.Provider {
	case GitLab:
		p = "/-/tree/"
	case Gitea:
		p = "/src/branch/"
	}
	segs := strings.Split(ev.Branch, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.TrimRight(ev.RepoURL, "/") + p + strings.Join(segs, "/")
}

// safeURL keeps an http(s) address of at most MaxURL characters ("" otherwise).
func safeURL(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > MaxURL {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return s
}

// clip trims s and cuts it to n runes.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
