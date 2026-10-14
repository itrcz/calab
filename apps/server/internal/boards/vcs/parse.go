package vcs

import (
	"encoding/json"
	"errors"
	"strings"
)

// ErrPayload is returned for a body that is not the JSON of the event it claims to be.
var ErrPayload = errors.New("vcs: malformed payload")

// zeroSHA marks a branch that did not exist before a push (GitLab, Gitea).
const zeroSHA = "0000000000000000000000000000000000000000"

// Parse reads a delivery of provider with event header name. nil, nil = an event that is not
// used (ping, tags, branch deletion, review comments…).
func Parse(provider, name string, body []byte) (*Event, error) {
	switch provider {
	case GitHub:
		switch name {
		case "push":
			return parseHubPush(provider, body)
		case "pull_request":
			return parseHubPR(provider, body)
		}
	case Gitea:
		switch name {
		case "push":
			return parseHubPush(provider, body)
		case "pull_request":
			return parseHubPR(provider, body)
		}
	case GitLab:
		switch name {
		case "Push Hook":
			return parseLabPush(body)
		case "Merge Request Hook":
			return parseLabMR(body)
		}
	}
	return nil, nil
}

// ---- GitHub and Gitea / Forgejo (Gitea's payloads follow GitHub's shape) ----

type hubUser struct {
	Login    string `json:"login"`
	Username string `json:"username"`
	Name     string `json:"name"`
}

func (u hubUser) handle() string {
	for _, s := range []string{u.Login, u.Username, u.Name} {
		if s != "" {
			return s
		}
	}
	return ""
}

type hubRepo struct {
	FullName string `json:"full_name"`
	HTMLURL  string `json:"html_url"`
}

type hubPush struct {
	Ref        string  `json:"ref"`
	Before     string  `json:"before"`
	Created    bool    `json:"created"`
	Deleted    bool    `json:"deleted"`
	Repository hubRepo `json:"repository"`
	Pusher     hubUser `json:"pusher"`
	Sender     hubUser `json:"sender"`
	Commits    []struct {
		ID      string  `json:"id"`
		Message string  `json:"message"`
		URL     string  `json:"url"`
		Author  hubUser `json:"author"`
	} `json:"commits"`
}

func parseHubPush(provider string, body []byte) (*Event, error) {
	var p hubPush
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	branch, ok := strings.CutPrefix(p.Ref, "refs/heads/")
	if !ok || p.Deleted || p.Repository.FullName == "" {
		return nil, nil // tags, deleted branches
	}
	ev := &Event{Provider: provider, Repo: clip(p.Repository.FullName, MaxRepo), RepoURL: p.Repository.HTMLURL, Push: true,
		Branch: branch, BranchCreated: p.Created || p.Before == zeroSHA, Author: p.Pusher.handle()}
	if ev.Author == "" {
		ev.Author = p.Sender.handle()
	}
	for _, c := range p.Commits {
		if c.ID == "" {
			continue
		}
		ev.Commits = append(ev.Commits, Commit{SHA: c.ID, Message: c.Message, URL: c.URL, Author: c.Author.handle()})
	}
	return ev, nil
}

type hubPR struct {
	Action      string  `json:"action"`
	Number      int64   `json:"number"`
	Repository  hubRepo `json:"repository"`
	PullRequest struct {
		Number  int64   `json:"number"`
		Title   string  `json:"title"`
		Body    string  `json:"body"`
		HTMLURL string  `json:"html_url"`
		State   string  `json:"state"`
		Merged  bool    `json:"merged"`
		User    hubUser `json:"user"`
		Head    struct {
			Ref string `json:"ref"`
		} `json:"head"`
	} `json:"pull_request"`
}

func parseHubPR(provider string, body []byte) (*Event, error) {
	var p hubPR
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	pr := p.PullRequest
	if p.Repository.FullName == "" || (pr.Number == 0 && p.Number == 0) {
		return nil, ErrPayload
	}
	n := pr.Number
	if n == 0 {
		n = p.Number
	}
	out := &PullRequest{Number: n, Title: pr.Title, Body: pr.Body, URL: pr.HTMLURL, Branch: pr.Head.Ref, Author: pr.User.handle(),
		State: StateOpen}
	switch {
	case pr.Merged:
		out.State = StateMerged
	case pr.State == "closed":
		out.State = StateClosed
	}
	switch p.Action {
	case "opened", "reopened":
		out.Event = EventPROpened
	case "closed":
		out.Event = EventPRClosed
		if pr.Merged {
			out.Event = EventPRMerged
		}
	case "edited":
	default:
		return nil, nil // synchronize, labeled, review requests…
	}
	return &Event{Provider: provider, Repo: clip(p.Repository.FullName, MaxRepo), RepoURL: p.Repository.HTMLURL, Author: out.Author, PR: out}, nil
}

// ---- GitLab ----

type labProject struct {
	PathWithNamespace string `json:"path_with_namespace"`
	WebURL            string `json:"web_url"`
}

type labPush struct {
	Ref          string     `json:"ref"`
	Before       string     `json:"before"`
	After        string     `json:"after"`
	UserUsername string     `json:"user_username"`
	UserName     string     `json:"user_name"`
	Project      labProject `json:"project"`
	Commits      []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		URL     string `json:"url"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"commits"`
}

func parseLabPush(body []byte) (*Event, error) {
	var p labPush
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	branch, ok := strings.CutPrefix(p.Ref, "refs/heads/")
	if !ok || p.After == zeroSHA || p.Project.PathWithNamespace == "" {
		return nil, nil // tags, deleted branches
	}
	author := p.UserUsername
	if author == "" {
		author = p.UserName
	}
	ev := &Event{Provider: GitLab, Repo: clip(p.Project.PathWithNamespace, MaxRepo), RepoURL: p.Project.WebURL, Push: true,
		Branch: branch, BranchCreated: p.Before == zeroSHA, Author: author}
	for _, c := range p.Commits {
		if c.ID == "" {
			continue
		}
		ev.Commits = append(ev.Commits, Commit{SHA: c.ID, Message: c.Message, URL: c.URL, Author: c.Author.Name})
	}
	return ev, nil
}

type labMR struct {
	User struct {
		Username string `json:"username"`
	} `json:"user"`
	Project          labProject `json:"project"`
	ObjectAttributes struct {
		IID          int64  `json:"iid"`
		Title        string `json:"title"`
		Description  string `json:"description"`
		URL          string `json:"url"`
		State        string `json:"state"`  // opened | closed | merged | locked
		Action       string `json:"action"` // open | reopen | close | merge | update | approved…
		SourceBranch string `json:"source_branch"`
	} `json:"object_attributes"`
}

func parseLabMR(body []byte) (*Event, error) {
	var p labMR
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	a := p.ObjectAttributes
	if p.Project.PathWithNamespace == "" || a.IID == 0 {
		return nil, ErrPayload
	}
	out := &PullRequest{Number: a.IID, Title: a.Title, Body: a.Description, URL: a.URL, Branch: a.SourceBranch,
		Author: p.User.Username, State: StateOpen}
	switch a.State {
	case "merged":
		out.State = StateMerged
	case "closed":
		out.State = StateClosed
	}
	switch a.Action {
	case "open", "reopen":
		out.Event = EventPROpened
	case "merge":
		out.Event, out.State = EventPRMerged, StateMerged
	case "close":
		out.Event, out.State = EventPRClosed, StateClosed
	case "update":
	default:
		return nil, nil
	}
	return &Event{Provider: GitLab, Repo: clip(p.Project.PathWithNamespace, MaxRepo), RepoURL: p.Project.WebURL, Author: out.Author, PR: out}, nil
}
