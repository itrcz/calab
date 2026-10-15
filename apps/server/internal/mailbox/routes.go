// Package mailbox implements ADR-0101: the Bot API routes that let a support bot recover
// the password of a user's mailbox on our mail hosting, and the public one-time redemption
// route behind the /mail-reset/<token> page. The server is only a conduit: the hosting
// generates the password, it lives in Redis under a one-time token (10 minutes) and is
// shown once by the web page. The address is never told to a bot (hosting-check answers
// with the domain and flags only); the password is never logged and never stored in
// Postgres. With MAILHOST_ADMIN_URL empty every route here answers 404.
package mailbox

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Limits (ADR-0101): per reset target and per bot, per hour.
const (
	TargetResetsPerHour = 3
	BotResetsPerHour    = 10
)

// Service holds the mailbox-reset use cases.
type Service struct {
	db      *db.DB
	hosting *Hosting
	store   *Store
	log     *slog.Logger

	// Configuration snapshot (the app sets it once; tests tweak per test).
	Enabled   bool     // MAILHOST_ADMIN_URL set
	Domains   []string // MAILHOST_DOMAINS, lower-cased by config.Validate
	ResetBots []string // MAILHOST_RESET_BOTS usernames; empty = no bot may reset
	PublicURL string   // PUBLIC_APP_URL: the redeem link points there

	perTarget *redisx.RateLimiter
	perBot    *redisx.RateLimiter
}

// New creates the service. Enabled/Domains/ResetBots/PublicURL are set by the caller right
// after (the app from its config, tests per test).
func New(d *db.DB, r rueidis.Client, hosting *Hosting, log *slog.Logger) *Service {
	return &Service{
		db: d, hosting: hosting, store: NewStore(r), log: log,
		perTarget: redisx.NewRateLimiter(r, "rl:mailbox-reset:", TargetResetsPerHour, TargetResetsPerHour),
		perBot:    redisx.NewRateLimiter(r, "rl:mailbox-reset-bot:", BotResetsPerHour, BotResetsPerHour),
	}
}

// Routes registers the two Bot API routes (behind wrap, like every private route) and the
// public redemption route: the token itself is the credential, no session (ADR-0101 §4).
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	private := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(f)) }
	private("POST /api/mailbox/hosting-check", s.hostingCheck)
	private("POST /api/mailbox/password-reset", s.passwordReset)
	mux.Handle("POST /api/mailbox/password/redeem", httpx.HandlerFunc(s.redeem))
}

// off is the feature-off answer (ADR-0101: MAILHOST_ADMIN_URL empty = 404, as if the
// routes did not exist).
func (s *Service) off() error {
	if s.Enabled {
		return nil
	}
	return httpx.NotFound("mailbox password recovery")
}

// callerBot is the bot of the request with its username, for the allowlist check.
func (s *Service) callerBot(ctx context.Context) (sqlc.Bot, error) {
	id := auth.MustFromContext(ctx)
	if err := auth.BotsOnly(ctx); err != nil {
		return sqlc.Bot{}, err
	}
	row, err := s.db.Q.GetBotWithUser(ctx, id.UserID)
	if db.IsNotFound(err) || (err == nil && row.Bot.RevokedAt != nil) {
		return sqlc.Bot{}, auth.ErrBotsOnly
	}
	if err != nil {
		return sqlc.Bot{}, err
	}
	return row.Bot, nil
}

// allowed reports whether this bot username may use the reset routes.
func (s *Service) allowed(username string) bool { return slices.Contains(s.ResetBots, username) }

var errBotNotAllowed = httpx.Forbidden("this bot may not recover mailbox passwords")

// errEmailNotVerified: the reset trusts a confirmed address only (ADR-0065 «Доверие к
// адресу»), so an unverified one is refused — see TestEmailTrustInventory.
var errEmailNotVerified = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "confirm the email address first")

type hostingCheckRequest struct {
	UserID string `json:"userId"`
}

// HostingCheckResponse tells the bot what it may do with the person's mailbox without ever
// revealing the address (ADR-0101 §3): hosted = the domain is on our hosting, verified =
// the user's address is confirmed (an unconfirmed one cannot be recovered).
type HostingCheckResponse struct {
	Hosted   bool   `json:"hosted"`
	Domain   string `json:"domain"`
	Verified bool   `json:"verified"`
}

// hostingCheck: POST /api/mailbox/hosting-check {userId} → {hosted, domain, verified}.
func (s *Service) hostingCheck(w http.ResponseWriter, r *http.Request) error {
	if err := s.off(); err != nil {
		return err
	}
	bot, err := s.callerBot(r.Context())
	if err != nil {
		return err
	}
	if !s.allowed(bot.Username) {
		return errBotNotAllowed
	}
	var req hostingCheckRequest
	if err := decodeBody(w, r, &req); err != nil {
		return err
	}
	uid, err := uuid.Parse(strings.TrimSpace(req.UserID))
	if err != nil {
		return httpx.Validation("userId", "userId must be a user id")
	}
	u, err := s.db.Q.GetUser(r.Context(), uid)
	if db.IsNotFound(err) || (err == nil && u.DisabledAt != nil) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	out := HostingCheckResponse{Verified: u.EmailVerifiedAt != nil}
	if u.Email != nil {
		out.Domain = emailDomain(*u.Email)
		out.Hosted = slices.Contains(s.Domains, out.Domain)
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

type passwordResetRequest struct {
	UserID string `json:"userId"`
}

// PasswordResetResponse is the answer the bot turns into a one-time link message.
type PasswordResetResponse struct {
	Token     string `json:"token"`
	RedeemURL string `json:"redeemUrl"`
	ExpiresAt string `json:"expiresAt"` // RFC 3339
}

// passwordReset: POST /api/mailbox/password-reset {userId} → {token, redeemUrl, expiresAt}.
// Check order (ADR-0101 §3): feature → bot → allowlist → target exists → not a guest or a
// bot → shared workspace → address verified → domain hosted → limits → the hosting itself.
func (s *Service) passwordReset(w http.ResponseWriter, r *http.Request) error {
	if err := s.off(); err != nil {
		return err
	}
	bot, err := s.callerBot(r.Context())
	if err != nil {
		return err
	}
	if !s.allowed(bot.Username) {
		return errBotNotAllowed
	}
	var req passwordResetRequest
	if err := decodeBody(w, r, &req); err != nil {
		return err
	}
	uid, err := uuid.Parse(strings.TrimSpace(req.UserID))
	if err != nil {
		return httpx.Validation("userId", "userId must be a user id")
	}
	u, err := s.db.Q.GetUser(r.Context(), uid)
	if db.IsNotFound(err) || (err == nil && u.DisabledAt != nil) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	if u.IsGuest || u.IsBot {
		return httpx.Forbidden("the mailbox password of a guest or a bot cannot be recovered")
	}
	share, err := s.db.Q.ShareWorkspace(r.Context(), sqlc.ShareWorkspaceParams{UserID: bot.UserID, OtherID: uid})
	if err != nil {
		return err
	}
	if !share {
		return dms.ErrBotNoSharedWorkspace
	}
	// The reset trusts a confirmed address only (ADR-0065): an unverified one may belong to
	// someone else, so the hosting must not reset it.
	if u.Email == nil || u.EmailVerifiedAt == nil {
		return errEmailNotVerified
	}
	domain := emailDomain(*u.Email)
	if !slices.Contains(s.Domains, domain) {
		return httpx.Validation("domain", "the mailbox is not on our hosting").WithDetails("DOMAIN_NOT_HOSTED", 0, 0)
	}
	if err := s.perTarget.Take(r.Context(), uid.String()); err != nil {
		return err
	}
	if err := s.perBot.Take(r.Context(), bot.UserID.String()); err != nil {
		return err
	}
	password, err := s.hosting.ResetPassword(r.Context(), *u.Email)
	if err != nil {
		return s.hostingError(r.Context(), err)
	}
	token, err := s.store.Issue(r.Context(), ResetPayload{UserID: uid.String(), Email: strings.ToLower(*u.Email), Password: password})
	if err != nil {
		return httpx.Unavailable(err)
	}
	// Audit (ADR-0101): who asked, whose mailbox, when. Never the address, never the password.
	s.log.InfoContext(r.Context(), "mailbox password reset",
		"bot_id", bot.UserID, "bot_owner", bot.OwnerUserID, "target_user_id", uid, "domain", domain)
	expires := time.Now().Add(ResetTTL)
	writeJSON(w, http.StatusOK, PasswordResetResponse{
		Token:     token,
		RedeemURL: strings.TrimRight(s.PublicURL, "/") + "/mail-reset/" + token,
		ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
	return nil
}

// hostingError maps a hosting failure to the bot's answer: a missing mailbox is 404, the
// hosting's own limit is 429 (with its Retry-After), everything else — including a bad
// admin token and network errors — is 503: not the bot's fault, safe to show as "try later".
func (s *Service) hostingError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	e, ok := AsHostingError(err)
	if !ok {
		return httpx.Unavailable(err)
	}
	switch {
	case e.Status == http.StatusNotFound || e.Code == CodeMailboxNotFound:
		return httpx.NotFound("mailbox")
	case e.Status == http.StatusTooManyRequests:
		out := httpx.RateLimited()
		if e.RetryAfter > 0 {
			out.RetryAfter = e.RetryAfter
		}
		return out
	}
	s.log.ErrorContext(ctx, "mail hosting reset failed", "status", e.Status, "code", e.Code, "err", e.Message)
	return httpx.Unavailable(err)
}

type redeemRequest struct {
	Token string `json:"token"`
}

// RedeemResponse is the one-time answer of the /mail-reset/<token> page.
type RedeemResponse struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// redeem: POST /api/mailbox/password/redeem {token} → {email, password}. No session: the
// token is the credential and dies in this request (GETDEL). A repeat or an expired token
// is 410 — the link has already served its single show.
func (s *Service) redeem(w http.ResponseWriter, r *http.Request) error {
	if err := s.off(); err != nil {
		return err
	}
	var req redeemRequest
	if err := decodeBody(w, r, &req); err != nil {
		return err
	}
	token := strings.TrimSpace(req.Token)
	if token == "" || len(token) > MaxTokenLen {
		return httpx.Validation("token", "token must be 1..128 characters")
	}
	p, err := s.store.Redeem(r.Context(), token)
	if err != nil {
		return httpx.Unavailable(err)
	}
	if p == nil {
		return httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_CODE_EXPIRED, "the link has already been used or has expired")
	}
	writeJSON(w, http.StatusOK, RedeemResponse{Email: p.Email, Password: p.Password})
	return nil
}

// ---- plain JSON (these routes are not in the proto contract; ADR-0101 §2) ----

func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, httpx.MaxJSONBody))
	if err != nil {
		return httpx.BadRequest("cannot read body")
	}
	if len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, v); err != nil {
		return httpx.BadRequest("invalid JSON: " + err.Error())
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("mailbox: marshal response", "err", err)
		http.Error(w, `{"code":"ERROR_CODE_INTERNAL","message":"internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// emailDomain is the lower-cased part after the last '@' (as auth/email.go, local copy to
// keep the package free of auth internals).
func emailDomain(email string) string {
	return strings.ToLower(email[strings.LastIndexByte(email, '@')+1:])
}
