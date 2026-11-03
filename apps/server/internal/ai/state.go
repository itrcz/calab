package ai

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// The readiness of a workspace's AI (CBF-68, ADR-0118): the last «Проверить» is remembered by
// a fingerprint of the checked provider, base URL, model and key, so a change of any of them
// makes the saved settings unchecked without a reset path to forget.

// fingerprint is an HMAC of the four (the key never leaves the sealed column).
func (s *Service) fingerprint(provider, baseURL, model, key string) []byte {
	m := hmac.New(sha256.New, s.fpKey)
	for _, p := range []string{provider, baseURL, model, key} {
		m.Write([]byte(p))
		m.Write([]byte{0})
	}
	return m.Sum(nil)
}

// stored is the stored settings with the key opened ("" = none).
type stored struct {
	row   sqlc.WorkspaceAi
	key   string
	saved bool
}

func (s *Service) load(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (stored, error) {
	a, ok, err := s.row(ctx, q, wsID)
	if err != nil {
		return stored{}, err
	}
	out := stored{row: a, saved: ok}
	if len(a.KeyEnc) > 0 {
		p, err := s.box.Open(a.KeyEnc)
		if err != nil {
			return stored{}, err
		}
		out.key = string(p)
	}
	return out, nil
}

// stateOf answers the state of the saved settings and their last check (nil = none of them).
func (s *Service) stateOf(ctx context.Context, q *sqlc.Queries, cur stored) (v1.AiState, *sqlc.WorkspaceAiCheck, error) {
	if !cur.saved || cur.key == "" {
		return v1.AiState_AI_STATE_NO_KEY, nil, nil
	}
	c, err := q.GetWorkspaceAiCheck(ctx, cur.row.WorkspaceID)
	if db.IsNotFound(err) {
		return v1.AiState_AI_STATE_UNCHECKED, nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	if !hmac.Equal(c.Fingerprint, s.fingerprint(cur.row.Provider, cur.row.BaseUrl, cur.row.Model, cur.key)) {
		return v1.AiState_AI_STATE_UNCHECKED, nil, nil
	}
	if !c.Ok {
		return v1.AiState_AI_STATE_FAILED, &c, nil
	}
	return v1.AiState_AI_STATE_READY, &c, nil
}

// State reports the readiness of a workspace's AI (smart tasks run only when READY).
func (s *Service) State(ctx context.Context, wsID uuid.UUID) (v1.AiState, error) {
	cur, err := s.load(ctx, s.db.Q, wsID)
	if err != nil {
		return 0, err
	}
	st, _, err := s.stateOf(ctx, s.db.Q, cur)
	return st, err
}

// remember stores the outcome of a check of the form in (with key). A check of another form
// than the saved one does not replace a READY check of the saved settings: trying a new key
// must not switch off what works (it is remembered once saved and checked again).
func (s *Service) remember(ctx context.Context, wsID uuid.UUID, in input, key string, res Result) {
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceAi(ctx, wsID); err != nil {
			return err
		}
		cur, err := s.load(ctx, q, wsID)
		if err != nil {
			return err
		}
		fp := s.fingerprint(in.provider, in.baseURL, in.model, key)
		st, _, err := s.stateOf(ctx, q, cur)
		if err != nil {
			return err
		}
		same := cur.saved && cur.key != "" && hmac.Equal(fp, s.fingerprint(cur.row.Provider, cur.row.BaseUrl, cur.row.Model, cur.key))
		if st == v1.AiState_AI_STATE_READY && !same {
			return nil
		}
		return q.PutWorkspaceAiCheck(ctx, sqlc.PutWorkspaceAiCheckParams{WorkspaceID: wsID, Fingerprint: fp, Ok: res.OK, Error: res.Error})
	})
	if err != nil {
		slog.WarnContext(ctx, "ai: check not remembered", "workspace", wsID, "err", err)
	}
}

// ErrNotReady is Complete's refusal: the workspace's AI is not READY.
var ErrNotReady = errors.New("ai: not ready")

// CallError is a failed model call: Code is one of the Err* codes.
type CallError struct{ Code string }

func (e *CallError) Error() string { return "ai: " + e.Code }

// Complete sends msgs to the workspace's model with its stored key — only when the plan includes
// AI (ErrPlanRequired otherwise) and the saved settings are READY (ErrNotReady otherwise) — and
// returns the answer's text. The key, the messages and the answer are never logged; failures are
// *CallError.
func (s *Service) Complete(ctx context.Context, wsID uuid.UUID, purpose string, msgs []Message) (string, error) {
	if err := s.PlanAllows(ctx, wsID); err != nil {
		return "", err
	}
	cur, err := s.load(ctx, s.db.Q, wsID)
	if err != nil {
		return "", err
	}
	st, _, err := s.stateOf(ctx, s.db.Q, cur)
	if err != nil {
		return "", err
	}
	if st != v1.AiState_AI_STATE_READY {
		return "", ErrNotReady
	}
	chat, base := s.open, cur.row.BaseUrl
	if cur.row.Provider == providerGPTunnel {
		chat, base = s.trusted, s.gptunnelURL
	}
	res := chat.Send(ctx, base, cur.key, cur.row.Model, msgs)
	slog.InfoContext(ctx, "ai: call", "request_id", httpx.RequestID(ctx), "workspace", wsID, "purpose", purpose, "provider", cur.row.Provider, "model", cur.row.Model,
		"ok", res.OK, "error", res.Error, "status", res.Status, "latency_ms", res.Latency.Milliseconds(), "answer_chars", len([]rune(res.Reply)))
	if !res.OK {
		return "", &CallError{Code: res.Error}
	}
	return res.Reply, nil
}

// status: GET /api/workspaces/{id}/ai/status — any member but guests, people only; 409
// AI_PLAN_REQUIRED when the plan does not include AI (CBF-69).
func (s *Service) status(w http.ResponseWriter, r *http.Request) error {
	if auth.MustFromContext(r.Context()).Machine() {
		return auth.ErrBotNotAllowed
	}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	_, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if role == perm.RoleGuest {
		return httpx.Forbidden("not available to guests")
	}
	if err := s.PlanAllows(r.Context(), wsID); err != nil {
		return err
	}
	st, err := s.State(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetAiStatusResponse{State: st})
	return nil
}
