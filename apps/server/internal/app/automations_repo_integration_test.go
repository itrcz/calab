//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards/vcs"
	"github.com/calaba/calaba/server/internal/perm"
)

// Git links of boards (ADR-0060 §4, §7).

// hookPost posts a repository delivery and returns the status.
func hookPost(t *testing.T, path string, hdr map[string]string, body []byte) int {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func prBody(action, title, body string, merged bool) []byte {
	state := "open"
	if action == "closed" {
		state = "closed"
	}
	m := "false"
	if merged {
		m = "true"
	}
	return []byte(`{"action":"` + action + `","number":7,"pull_request":{"number":7,"title":"` + title + `","body":"` + body +
		`","html_url":"https://github.com/acme/app/pull/7","state":"` + state + `","merged":` + m +
		`,"user":{"login":"octocat"},"head":{"ref":"feature"}},"repository":{"full_name":"acme/app","html_url":"https://github.com/acme/app"}}`)
}

func TestBoardGit(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Repo", Key: "REP"}, 201)
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, 0, perm.ViewBoard))
	doing := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	setup := "/api/boards/" + b.GetId() + "/git"

	// Setup: MANAGE_BOARD and MANAGE_INTEGRATIONS, people only; the secret is returned once.
	bob.must(403, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITHUB}, nil)
	setBoardPerms(o, b.GetId(), 200, userOv(bob.id, perm.ManageBoard, 0), userOv(carol.id, 0, perm.ViewBoard))
	bob.must(403, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITHUB}, nil)
	bt := createBot(t, o, wid, "gitbot")
	bt.must(403, "GET", setup, nil, nil)
	o.must(422, "PUT", setup, &v1.SetBoardGitRequest{}, nil)
	o.must(422, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITHUB, Secret: "short"}, nil)
	var gr v1.BoardGitResponse
	o.must(200, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITHUB}, &gr)
	secret := []byte(gr.GetSecret())
	hook := "/api/git/boards/" + b.GetId() + "/github"
	if len(secret) != 43 || !gr.GetGit().GetHasSecret() || !strings.HasSuffix(gr.GetGit().GetUrl(), hook) {
		t.Fatalf("PUT: %v", &gr)
	}
	var got v1.BoardGitResponse
	o.must(200, "GET", setup, nil, &got)
	if got.GetSecret() != "" || strings.Contains(string(o.lastBody), string(secret)) {
		t.Fatal("GET leaks the secret")
	}

	// A rule on PR events.
	createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "PR открыт → в работу",
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: v1.RuleGitEvent_RULE_GIT_EVENT_PR_OPENED}}},
		Actions: []*v1.RuleAction{doStatus(doing)}}, 201)
	createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "PR смержен → готово",
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: v1.RuleGitEvent_RULE_GIT_EVENT_PR_MERGED}}},
		Actions: []*v1.RuleAction{doStatus(done)}}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Вход", Assignees: []*v1.TaskAssigneeInput{{UserId: carol.id}}}, 201)
	key := task.GetKey()

	gb, gc := dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gc.identify(carol.token) // invited on the task only (ADR-0059: no VIEW_BOARD)

	signed := func(body []byte, delivery string) map[string]string {
		return map[string]string{"X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": "sha256=" + vcs.Sign(body, secret)}
	}
	opened := prBody("opened", key+" Login", "Not OTH-1.", false)

	// Signature, provider and board checks.
	if st := hookPost(t, hook, map[string]string{"X-GitHub-Event": "pull_request"}, opened); st != 401 {
		t.Fatalf("unsigned: %d", st)
	}
	bad := signed(opened, "d0")
	bad["X-Hub-Signature-256"] = "sha256=" + vcs.Sign(opened, []byte("another-secret-another-secret"))
	if st := hookPost(t, hook, bad, opened); st != 401 {
		t.Fatalf("wrong secret: %d", st)
	}
	if st := hookPost(t, "/api/git/boards/"+b.GetId()+"/gitlab", signed(opened, "d0"), opened); st != 404 {
		t.Fatalf("other provider: %d", st)
	}
	huge := bytes.Repeat([]byte(" "), vcs.MaxBody+1)
	if st := hookPost(t, hook, signed(huge, "big"), huge); st != 413 {
		t.Fatalf("a body over 1 MB: %d", st)
	}
	if st := hookPost(t, hook, map[string]string{"X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=" + vcs.Sign([]byte(`{}`), secret)}, []byte(`{}`)); st != 204 {
		t.Fatalf("ping: %d", st)
	}

	// PR opened: a link, a journal entry, TASK_GIT_LINKS_UPDATE, the rule moves the task.
	if st := hookPost(t, hook, signed(opened, "d1"), opened); st != 204 {
		t.Fatalf("opened: %d", st)
	}
	full := getTask(t, o, task.GetId()).GetTask()
	if len(full.GetGitLinks()) != 1 || full.GetGitLinksCount() != 1 || full.GetStatusId() != doing {
		t.Fatalf("after PR opened: %v", full)
	}
	l := full.GetGitLinks()[0]
	if l.GetKind() != v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_PR || l.GetState() != v1.TaskGitLinkState_TASK_GIT_LINK_STATE_OPEN || l.GetRef() != "7" ||
		l.GetRepo() != "acme/app" || l.GetAuthor() != "octocat" || l.GetProvider() != v1.GitProvider_GIT_PROVIDER_GITHUB {
		t.Fatalf("link: %v", l)
	}
	for _, g := range []*gw{gb, gc} {
		ev := g.wait("TASK_GIT_LINKS_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetTaskGitLinksUpdate().GetTaskId() == task.GetId() })
		if u := ev.GetTaskGitLinksUpdate(); u.GetCount() != 1 || len(u.GetLinks()) != 1 || u.GetBoardId() != b.GetId() {
			t.Fatalf("event: %v", u)
		}
	}
	countGit := func() int {
		n := 0
		for _, k := range activityKinds(t, o, task.GetId()) {
			if k == "git" {
				n++
			}
		}
		return n
	}
	if n := countGit(); n != 1 {
		t.Fatalf("git entries %d", n)
	}

	// The same delivery again: deduplicated.
	if st := hookPost(t, hook, signed(opened, "d1"), opened); st != 204 || countGit() != 1 {
		t.Fatalf("repeat: %d, %d entries", st, countGit())
	}

	// Merged: the state follows, the rule closes the task.
	merged := prBody("closed", key+" Login", "", true)
	if st := hookPost(t, hook, signed(merged, "d2"), merged); st != 204 {
		t.Fatalf("merged: %d", st)
	}
	full = getTask(t, o, task.GetId()).GetTask()
	if len(full.GetGitLinks()) != 1 || full.GetGitLinks()[0].GetState() != v1.TaskGitLinkState_TASK_GIT_LINK_STATE_MERGED || full.GetStatusId() != done {
		t.Fatalf("after merge: %v", full)
	}
	if n := countGit(); n != 2 {
		t.Fatalf("git entries %d", n)
	}

	// A key of another board is ignored; so is an unknown task number.
	foreign := prBody("opened", "OTH-1 and "+b.GetKey()+"-999", "", false)
	if st := hookPost(t, hook, signed(foreign, "d3"), foreign); st != 204 {
		t.Fatalf("foreign: %d", st)
	}
	var cnt int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM task_git_links g JOIN tasks t ON t.id = g.task_id WHERE t.board_id = $1", b.GetId()).Scan(&cnt); err != nil || cnt != 1 {
		t.Fatalf("links %d (%v)", cnt, err)
	}

	// GitLab: the token; Gitea: the HMAC header.
	o.must(200, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Secret: "gitlab-token-0123456789"}, nil)
	push := []byte(`{"ref":"refs/heads/` + key + `-fix","before":"0000000000000000000000000000000000000000","after":"abc",` +
		`"user_username":"jsmith","project":{"path_with_namespace":"grp/app","web_url":"https://gitlab.example.com/grp/app"},` +
		`"commits":[{"id":"abc123","message":"` + key + ` fix","url":"https://gitlab.example.com/grp/app/-/commit/abc123","author":{"name":"J"}}]}`)
	lab := "/api/git/boards/" + b.GetId() + "/gitlab"
	if st := hookPost(t, lab, map[string]string{"X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": "wrong-token-0123456789"}, push); st != 401 {
		t.Fatalf("gitlab wrong token: %d", st)
	}
	if st := hookPost(t, lab, map[string]string{"X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": "gitlab-token-0123456789"}, push); st != 204 {
		t.Fatalf("gitlab push: %d", st)
	}
	if n := getTask(t, o, task.GetId()).GetTask().GetGitLinksCount(); n != 3 { // the PR, the new branch, the commit
		t.Fatalf("after the push: %d links", n)
	}
	o.must(200, "PUT", setup, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITEA, Secret: "gitea-secret-0123456789"}, nil)
	tea := "/api/git/boards/" + b.GetId() + "/gitea"
	ping := []byte(`{"zen":"x"}`)
	if st := hookPost(t, tea, map[string]string{"X-Gitea-Event": "ping", "X-Gitea-Signature": vcs.Sign(ping, []byte("gitea-secret-0123456789"))}, ping); st != 204 {
		t.Fatalf("gitea ping: %d", st)
	}
	if st := hookPost(t, tea, map[string]string{"X-Gitea-Event": "ping", "X-Gitea-Signature": vcs.Sign(ping, []byte("other"))}, ping); st != 401 {
		t.Fatalf("gitea bad signature: %d", st)
	}
	o.must(200, "GET", setup, nil, &got)
	if got.GetGit().GetEventsCount() < 1 || got.GetGit().GetLastEventAt() == nil {
		t.Fatalf("status: %v", got.GetGit())
	}

	// The board without the setup: 404; the setup is gone after DELETE.
	o.must(204, "DELETE", setup, nil, nil)
	if st := hookPost(t, tea, map[string]string{"X-Gitea-Event": "ping", "X-Gitea-Signature": vcs.Sign(ping, []byte("gitea-secret-0123456789"))}, ping); st != 404 {
		t.Fatalf("after delete: %d", st)
	}
	gc.quiet("nothing more for the invitee", 100*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetBoardRuleUpdate() != nil })
}
