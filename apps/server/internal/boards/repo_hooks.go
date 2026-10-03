package boards

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards/vcs"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sealbox"
)

// Git links (ADR-0060 §4): a board accepts the webhooks of one repository hosting (GitHub,
// GitLab, Gitea / Forgejo) at a public, signed address; task keys of the board in branch names,
// pull / merge requests and commit messages become task_git_links, a journal entry "git" (rule
// trigger `git`, board webhook task.updated) and TASK_GIT_LINKS_UPDATE.

const (
	repoDedupTTL    = 24 * time.Hour
	repoMaxLinks    = 50
	repoMinSecret   = 16
	repoMaxSecret   = 256
	repoPlanFeature = automationsFeature
)

// repoHooks holds the sealed-secret box, the per-board rate limit and the delivery dedup store.
type repoHooks struct {
	box   *sealbox.Box
	redis rueidis.Client
	limit Limiter
}

// EnableGit turns on the Git webhooks of boards: secret seals the hook secrets (JWT_SECRET, like
// the board webhook); r (may be nil in tests) dedups deliveries and rate-limits 60 per minute
// per board.
func (s *Service) EnableGit(r rueidis.Client, secret []byte) {
	h := &repoHooks{box: sealbox.New("calaba/board-git/v1", secret), redis: r}
	if r != nil {
		h.limit = redisx.NewRateLimiter(r, "rl:board-git:", 60, 60)
	}
	s.repo = h
}

func (s *Service) repoRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/boards/{id}/git", s.getRepoHook)
	h("PUT /api/boards/{id}/git", s.setRepoHook)
	h("DELETE /api/boards/{id}/git", s.deleteRepoHook)
	// Public: the hosting authenticates with the signature (like POST /api/rtc/webhook).
	mux.Handle("POST /api/git/boards/{id}/{provider}", httpx.HandlerFunc(s.repoInbound))
}

var providerNames = map[v1.GitProvider]string{
	v1.GitProvider_GIT_PROVIDER_GITHUB: vcs.GitHub,
	v1.GitProvider_GIT_PROVIDER_GITLAB: vcs.GitLab,
	v1.GitProvider_GIT_PROVIDER_GITEA:  vcs.Gitea,
}

func providerProto(s string) v1.GitProvider {
	for k, v := range providerNames {
		if v == s {
			return k
		}
	}
	return v1.GitProvider_GIT_PROVIDER_UNSPECIFIED
}

// repoBoard resolves the board of a Git settings route: people with MANAGE_BOARD on it and
// MANAGE_INTEGRATIONS of the workspace (the secret and an inbound channel are integrations).
func (s *Service) repoBoard(r *http.Request, write bool) (uuid.UUID, perm.BoardAccess, error) {
	if isBot(r) {
		return uuid.Nil, perm.BoardAccess{}, httpx.Forbidden("bots cannot manage Git webhooks")
	}
	if s.repo == nil {
		return uuid.Nil, perm.BoardAccess{}, httpx.Unavailable(nil)
	}
	id, acc, err := pathBoard(r, !write)
	if err != nil {
		return id, acc, err
	}
	if !acc.Bits.Has(perm.ManageBoard) {
		return id, acc, httpx.Forbidden("MANAGE_BOARD required")
	}
	if !acc.Member.Workspace().Has(perm.ManageIntegrations) {
		return id, acc, httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	if write {
		return id, acc, writable(acc)
	}
	return id, acc, nil
}

func (s *Service) repoPB(g sqlc.BoardGit) *v1.BoardGit {
	return &v1.BoardGit{BoardId: g.BoardID.String(), Provider: providerProto(g.Provider), HasSecret: len(g.SecretEnc) > 0,
		Url:         strings.TrimRight(s.PublicURL, "/") + "/api/git/boards/" + g.BoardID.String() + "/" + g.Provider,
		LastEventAt: tsp(g.LastEventAt), EventsCount: uint32(max(g.EventsCount, 0)), LastError: g.LastError, //nolint:gosec // a count
		CreatedBy: idp(g.CreatedBy), CreatedAt: timestamppb.New(g.CreatedAt)}
}

// getRepoHook: GET /api/boards/{id}/git (never the secret).
func (s *Service) getRepoHook(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.repoBoard(r, false)
	if err != nil {
		return err
	}
	g, err := s.db.Q.GetBoardGit(r.Context(), id)
	if db.IsNotFound(err) {
		httpx.Write(w, http.StatusOK, &v1.BoardGitResponse{})
		return nil
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardGitResponse{Git: s.repoPB(g)})
	return nil
}

// setRepoHook: PUT /api/boards/{id}/git — creates or replaces; the secret is returned once.
func (s *Service) setRepoHook(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := s.repoBoard(r, true)
	if err != nil {
		return err
	}
	if ok, err := s.automationsAllowed(r.Context(), acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(repoPlanFeature)
	}
	var req v1.SetBoardGitRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	provider, ok := providerNames[req.GetProvider()]
	if !ok {
		return httpx.Validation("provider", "provider must be GITHUB, GITLAB or GITEA")
	}
	secret := req.GetSecret()
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		secret = base64.RawURLEncoding.EncodeToString(b)
	} else if n := utf8.RuneCountInString(secret); n < repoMinSecret || n > repoMaxSecret {
		return httpx.Validation("secret", "secret must be 16..256 characters (or empty to generate one)")
	}
	sealed, err := s.repo.box.Seal([]byte(secret))
	if err != nil {
		return err
	}
	me := uid(r)
	var g sqlc.BoardGit
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		g, err = q.UpsertBoardGit(r.Context(), sqlc.UpsertBoardGitParams{BoardID: id, Provider: provider, SecretEnc: sealed, CreatedBy: &me})
		return err
	}); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardGitResponse{Git: s.repoPB(g), Secret: secret})
	return nil
}

// deleteRepoHook: DELETE /api/boards/{id}/git (the links stay).
func (s *Service) deleteRepoHook(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.repoBoard(r, true)
	if err != nil {
		return err
	}
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		n, err := q.DeleteBoardGit(r.Context(), id)
		if err == nil && n == 0 {
			err = httpx.NotFound("git")
		}
		return err
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// repoInbound: POST /api/git/boards/{id}/{provider} — a delivery of the repository hosting.
// Order: the board's setup (404), the body (≤ 1 MB, 413), the signature (401), the rate limit
// (429), the event (204 when unused), the dedup by body hash, then one transaction.
func (s *Service) repoInbound(w http.ResponseWriter, r *http.Request) error {
	if s.repo == nil {
		return httpx.NotFound("git")
	}
	ctx := r.Context()
	id, err := uuid.Parse(r.PathValue("id"))
	provider := r.PathValue("provider")
	if err != nil || !vcs.Valid(provider) {
		return httpx.NotFound("git")
	}
	g, err := s.db.Q.GetBoardGit(ctx, id)
	if db.IsNotFound(err) || (err == nil && g.Provider != provider) {
		return httpx.NotFound("git")
	}
	if err != nil {
		return err
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, vcs.MaxBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_BAD_REQUEST, "the body is larger than 1 MB")
		}
		return httpx.BadRequest("unreadable body")
	}
	secret, err := s.repo.box.Open(g.SecretEnc)
	if err != nil {
		return err
	}
	if !vcs.Verify(provider, r.Header, body, secret) {
		return httpx.Unauthenticated("bad signature")
	}
	if s.repo.limit != nil {
		if err := s.repo.limit.Take(ctx, id.String()); err != nil {
			return err
		}
	}
	ev, err := vcs.Parse(provider, vcs.EventName(provider, r.Header), body)
	if err != nil {
		s.repoStatus(ctx, id, "malformed "+provider+" payload")
		return httpx.BadRequest("malformed payload")
	}
	b, err := s.db.Q.GetBoard(ctx, id)
	if err != nil {
		return err
	}
	if b.ArchivedAt != nil {
		httpx.NoContent(w)
		return nil
	}
	if ok, err := s.automationsAllowed(ctx, b.WorkspaceID); err != nil {
		return err
	} else if !ok {
		s.repoStatus(ctx, id, "the workspace's plan does not include automations")
		httpx.NoContent(w)
		return nil
	}
	if ev == nil {
		s.repoStatus(ctx, id, "") // ping and unused events: the hook works
		httpx.NoContent(w)
		return nil
	}
	key, fresh, err := s.claimDelivery(ctx, id, provider, body)
	if err != nil {
		return err
	}
	if !fresh {
		httpx.NoContent(w)
		return nil
	}
	if err := s.applyRepoEvent(context.WithoutCancel(ctx), b, ev); err != nil {
		s.releaseDelivery(ctx, key)
		return err
	}
	httpx.NoContent(w)
	return nil
}

// claimDelivery remembers a delivery for 24 h by the hash of its signed body; fresh = not seen
// before (no Valkey: always fresh). Not by the delivery id header: it is outside the signature,
// so a captured delivery replayed with a new id (or none) would apply again; a redelivery by the
// hosting carries the same body and is a repeat too.
func (s *Service) claimDelivery(ctx context.Context, board uuid.UUID, provider string, body []byte) (string, bool, error) {
	if s.repo.redis == nil {
		return "", true, nil
	}
	h := sha256.New()
	h.Write([]byte(provider + "\x00"))
	h.Write(body)
	key := redisx.Key("boards:git:delivery:" + board.String() + ":" + hex.EncodeToString(h.Sum(nil)[:16]))
	err := s.repo.redis.Do(ctx, s.repo.redis.B().Set().Key(key).Value("1").Nx().Ex(repoDedupTTL).Build()).Error()
	if rueidis.IsRedisNil(err) {
		return key, false, nil
	}
	return key, err == nil, err
}

func (s *Service) releaseDelivery(ctx context.Context, key string) {
	if key != "" && s.repo.redis != nil {
		_ = s.repo.redis.Do(context.WithoutCancel(ctx), s.repo.redis.B().Del().Key(key).Build()).Error()
	}
}

// repoStatus records a delivery on the board's setup (last_error "" = fine).
func (s *Service) repoStatus(ctx context.Context, board uuid.UUID, lastErr string) {
	ctx = context.WithoutCancel(ctx)
	if err := s.tx(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		return q.RecordBoardGitEvent(ctx, sqlc.RecordBoardGitEventParams{BoardID: board, LastError: lastErr})
	}); err != nil {
		slog.WarnContext(ctx, "boards: git status", "board", board, "err", err)
	}
}

// applyRepoEvent writes the links of a Git event to the board's tasks in one transaction (with
// their journal entries, the board webhook and the rules) and publishes them.
func (s *Service) applyRepoEvent(ctx context.Context, b sqlc.Board, ev *vcs.Event) error {
	links := vcs.Links(ev, b.Key)
	var order []int32
	by := map[int32][]vcs.Link{}
	for _, l := range links {
		if _, ok := by[l.Number]; !ok {
			order = append(order, l.Number)
		}
		by[l.Number] = append(by[l.Number], l)
	}
	var c change
	var touched []taskRow
	err := s.taskTx(ctx, &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		touched = touched[:0]
		for _, n := range order {
			row, err := q.GetTaskByNumber(ctx, sqlc.GetTaskByNumberParams{WorkspaceID: b.WorkspaceID, Key: b.Key, Number: n})
			if db.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			t, ok, err := taskByID(ctx, tx, row.ID, true)
			if err != nil {
				return err
			}
			if !ok || t.BoardID != b.ID || t.ArchivedAt != nil {
				continue
			}
			changed, err := s.linkTask(ctx, q, t, ev, by[n], &c)
			if err != nil {
				return err
			}
			if changed {
				touched = append(touched, t)
			}
		}
		return q.RecordBoardGitEvent(ctx, sqlc.RecordBoardGitEventParams{BoardID: b.ID, LastError: ""})
	})
	if err != nil {
		return err
	}
	for i, t := range touched {
		ls, err := s.db.Q.ListTaskGitLinks(ctx, t.ID)
		if err != nil {
			continue
		}
		s.ev.Workspace(ctx, t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskGitLinksUpdate{TaskGitLinksUpdate: &v1.TaskGitLinksUpdate{
			WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String(), Links: gitLinks(ls),
			Count: uint32(len(ls))}}}) //nolint:gosec // ≤ 50
		if i == 0 {
			for _, o := range touched[1:] {
				c.tasks = append(c.tasks, o.ID)
			}
			s.publish(ctx, t.ID, &c, false)
		}
	}
	return nil
}

// linkTask upserts the links of one task and journals what changed: one "git" entry per new
// branch / changed pull request, one per push for the new commits. Reports whether anything
// changed.
func (s *Service) linkTask(ctx context.Context, q *sqlc.Queries, t taskRow, ev *vcs.Event, ls []vcs.Link, c *change) (bool, error) {
	changed := false
	var commits []any
	for _, l := range ls {
		prev, err := q.GetTaskGitLink(ctx, sqlc.GetTaskGitLinkParams{TaskID: t.ID, Kind: l.Kind, Provider: ev.Provider, Repo: ev.Repo, Ref: l.Ref})
		existed := err == nil
		if err != nil && !db.IsNotFound(err) {
			return false, err
		}
		if existed && prev.State == l.State && prev.Title == l.Title && prev.Url == l.URL {
			continue // a repeat (or a commit seen on another branch)
		}
		link, err := q.UpsertTaskGitLink(ctx, sqlc.UpsertTaskGitLinkParams{TaskID: t.ID, Kind: l.Kind, Provider: ev.Provider, Repo: ev.Repo,
			Ref: l.Ref, Title: l.Title, Url: l.URL, State: l.State, Author: l.Author})
		if err != nil {
			return false, err
		}
		changed = true
		if l.Kind == vcs.KindCommit {
			if !existed {
				commits = append(commits, map[string]any{"sha": link.Ref, "title": link.Title, "url": link.Url})
			}
			continue
		}
		event := l.Event
		if existed && event == vcs.EventBranchCreated {
			event = ""
		}
		var before map[string]any
		if existed {
			before = map[string]any{"state": prev.State, "title": prev.Title}
		}
		if err := c.recordAs(ctx, q, t, nil, "git", before, map[string]any{"event": event, "kind": link.Kind, "provider": link.Provider,
			"repo": link.Repo, "ref": link.Ref, "title": link.Title, "url": link.Url, "state": link.State}); err != nil {
			return false, err
		}
	}
	if len(commits) > 0 {
		if err := c.recordAs(ctx, q, t, nil, "git", nil, map[string]any{"event": vcs.EventCommitPushed, "kind": vcs.KindCommit,
			"provider": ev.Provider, "repo": ev.Repo, "ref": ev.Branch, "commits": commits}); err != nil {
			return false, err
		}
	}
	if !changed {
		return false, nil
	}
	if _, err := q.TrimTaskGitLinks(ctx, t.ID); err != nil {
		return false, err
	}
	return true, q.TouchTask(ctx, t.ID)
}

var linkKinds = map[string]v1.TaskGitLinkKind{
	vcs.KindBranch: v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_BRANCH,
	vcs.KindPR:     v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_PR,
	vcs.KindCommit: v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_COMMIT,
}

var linkStates = map[string]v1.TaskGitLinkState{
	vcs.StateOpen:   v1.TaskGitLinkState_TASK_GIT_LINK_STATE_OPEN,
	vcs.StateMerged: v1.TaskGitLinkState_TASK_GIT_LINK_STATE_MERGED,
	vcs.StateClosed: v1.TaskGitLinkState_TASK_GIT_LINK_STATE_CLOSED,
}

func gitLinks(ls []sqlc.TaskGitLink) []*v1.TaskGitLink {
	out := make([]*v1.TaskGitLink, len(ls))
	for i, l := range ls {
		out[i] = &v1.TaskGitLink{Id: l.ID.String(), TaskId: l.TaskID.String(), Kind: linkKinds[l.Kind], Provider: providerProto(l.Provider),
			Repo: l.Repo, Ref: l.Ref, Title: l.Title, Url: l.Url, State: linkStates[l.State], Author: l.Author,
			CreatedAt: timestamppb.New(l.CreatedAt), UpdatedAt: timestamppb.New(l.UpdatedAt)}
	}
	return out
}
