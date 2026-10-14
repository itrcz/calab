package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/profile"
)

// Email codes (ADR-0023): 6 digits, 10 minutes, 5 attempts, a new one at most every 60 s.
const (
	codeTTL      = 10 * time.Minute
	codeAttempts = 5
	codeResend   = 60 * time.Second

	purposeVerify = "verify" // confirm the account email
	purposeChange = "change" // confirm users.pending_email (new login address)
	purposeReset  = "reset"  // password reset
)

var (
	errEmailNotVerified = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "confirm your email address first")
	errCodeExpired      = codeErr(v1.ErrorCode_ERROR_CODE_CODE_EXPIRED, "the code has expired or was used up; request a new one")
	errResetInvalid     = codeErr(v1.ErrorCode_ERROR_CODE_CODE_INVALID, "wrong or expired code")
)

func codeErr(c v1.ErrorCode, msg string) *httpx.Error {
	e := httpx.Coded(http.StatusUnprocessableEntity, c, msg)
	e.Field = "code"
	return e
}

// EmailGate guards the actions ADR-0023 reserved for confirmed addresses (creating
// workspaces, invitations, bots, new DMs, outside meeting attendees). It is a policy about
// what an account may DO, never about whether its address may be TRUSTED: code that relies
// on the address belonging to the user (email invitations, OAuth email claims, superadmin,
// meeting mail) checks email_verified_at itself / RequireVerified, in every mode (ADR-0065).
//
// The zero value requires a confirmed address (EMAIL_VERIFICATION=required), so a handler
// that was not wired stays closed.
type EmailGate struct {
	// Optional: EMAIL_VERIFICATION=optional — an unconfirmed address blocks nothing.
	Optional bool
}

// NewEmailGate maps the configured mode.
func NewEmailGate(m config.EmailVerificationMode) EmailGate {
	return EmailGate{Optional: m == config.EmailVerificationOptional}
}

// Allow applies the gate to u: nil when the mode is optional, else RequireVerified.
func (g EmailGate) Allow(u sqlc.User) error {
	if g.Optional {
		return nil
	}
	return RequireVerified(u)
}

// User loads the user and applies the gate.
func (g EmailGate) User(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (sqlc.User, error) {
	u, err := q.GetUser(ctx, id)
	if err != nil {
		return u, err
	}
	return u, g.Allow(u)
}

// RequireVerified rejects accounts whose email is not verified yet (403
// EMAIL_NOT_VERIFIED) regardless of EMAIL_VERIFICATION: for checks that rely on the
// address (ADR-0027 email invitation codes). Guest accounts have no email and are not
// affected.
func RequireVerified(u sqlc.User) error {
	if u.IsGuest || u.EmailVerifiedAt != nil {
		return nil
	}
	return errEmailNotVerified
}

func (s *Service) mailOn() bool { return s.Mail.Enabled() }

func newCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// normalizeCode strips spaces and dashes users paste along ("123 456").
func normalizeCode(c string) (string, bool) {
	c = strings.NewReplacer(" ", "", "-", "", " ", "").Replace(strings.TrimSpace(c))
	if len(c) != 6 {
		return "", false
	}
	for _, r := range c {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	return c, true
}

func locale(u sqlc.User) string {
	if u.Locale != nil {
		return *u.Locale
	}
	return mail.LocaleEN
}

func retryAfter(wait time.Duration) error {
	e := httpx.RateLimited()
	e.Message = "a code was sent less than a minute ago"
	e.RetryAfter = time.Duration(math.Ceil(max(wait, time.Second).Seconds())) * time.Second
	return e
}

// sendCode replaces u's code for purpose and queues it to addr, in one transaction with
// before (if any). 429 when the previous code of this purpose is younger than 60 s or the
// address's hourly budget is used up.
func (s *Service) sendCode(ctx context.Context, u sqlc.User, purpose, addr string, before func(q *sqlc.Queries) error) error {
	if !s.mailOn() {
		return mail.ErrDisabled
	}
	// Cheap pre-check before hashing (the upsert below re-checks atomically).
	if cur, err := s.db.Q.GetEmailCode(ctx, sqlc.GetEmailCodeParams{UserID: u.ID, Purpose: purpose}); err == nil {
		if wait := codeResend - s.now().Sub(cur.CreatedAt); wait > 0 {
			return retryAfter(wait)
		}
	} else if !db.IsNotFound(err) {
		return err
	}
	code, err := newCode()
	if err != nil {
		return err
	}
	hash, err := HashPassword(ctx, code)
	if err != nil {
		return err
	}
	tmpl := mail.TemplateVerifyCode
	if purpose == purposeReset {
		tmpl = mail.TemplatePasswordReset
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if before != nil {
			if err := before(q); err != nil {
				return err
			}
		}
		_, err := q.PutEmailCode(ctx, sqlc.PutEmailCodeParams{
			UserID: u.ID, Purpose: purpose, CodeHash: hash, ExpiresAt: s.now().Add(codeTTL), ResendBefore: s.now().Add(-codeResend),
		})
		if db.IsNotFound(err) { // a concurrent request sent one just now
			return retryAfter(codeResend)
		}
		if err != nil {
			return err
		}
		return s.Mail.Enqueue(ctx, q, mail.Mail{
			To: addr, Template: tmpl, Locale: locale(u), Priority: mail.PriorityCode, TTL: codeTTL,
			Params: mail.Params{"code": code, "minutes": "10"},
		})
	})
	if err != nil {
		return err
	}
	s.Mail.Wake()
	return nil
}

// checkCode spends one attempt of the user's live code for purpose and compares it.
// Returns errCodeExpired when there is no usable code, errCodeInvalid on a mismatch.
func (s *Service) checkCode(ctx context.Context, userID uuid.UUID, purpose, code string) error {
	row, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.EmailCode, error) {
		return guarded.TakeEmailCodeAttempt(ctx, sqlc.TakeEmailCodeAttemptParams{UserID: userID, Purpose: purpose, MaxAttempts: codeAttempts})
	})
	if db.IsNotFound(err) {
		// Same timing as a compared code: POST /api/auth/password/reset must not tell an
		// existing account without a live code from an unknown address.
		_, _ = VerifyPassword(ctx, code, dummyHash)
		return errCodeExpired
	}
	if err != nil {
		return err
	}
	ok, err := VerifyPassword(ctx, code, row.CodeHash)
	if err != nil && !errors.Is(err, errBadHash) {
		return err
	}
	if ok {
		return nil
	}
	left := codeAttempts - int(row.Attempts)
	if left <= 0 {
		return errCodeExpired
	}
	return codeErr(v1.ErrorCode_ERROR_CODE_CODE_INVALID, fmt.Sprintf("wrong code, %d attempt(s) left", left))
}

// SendVerification (re)sends the code: to the pending new address if there is one, else to
// the account email. Without SMTP there is nothing to verify with: the address is marked
// verified at once (accounts from before SMTP was removed would otherwise stay locked).
func (s *Service) SendVerification(ctx context.Context, userID uuid.UUID) error {
	u, err := s.db.Q.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	if u.IsGuest || u.Email == nil {
		return httpx.Forbidden("guest accounts have no email")
	}
	if !s.mailOn() {
		if u.EmailVerifiedAt == nil {
			if u, err = db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.User, error) { return guarded.SetEmailVerified(ctx, u.ID) }); err != nil {
				return err
			}
			s.verified(ctx, u)
		}
		return nil
	}
	if u.PendingEmail != nil {
		return s.sendCode(ctx, u, purposeChange, *u.PendingEmail, nil)
	}
	if u.EmailVerifiedAt != nil {
		return httpx.Conflict("email is already verified")
	}
	return s.sendCode(ctx, u, purposeVerify, *u.Email, nil)
}

// VerifyEmail confirms the pending new address (if any) or the account email with code.
// It returns the workspaces joined by the confirmation (pending email invitations).
func (s *Service) VerifyEmail(ctx context.Context, userID uuid.UUID, code string) (*v1.Me, []uuid.UUID, error) {
	c, ok := normalizeCode(code)
	if !ok {
		return nil, nil, httpx.Validation("code", "the code is 6 digits")
	}
	u, err := s.db.Q.GetUser(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	if u.IsGuest || u.Email == nil {
		return nil, nil, httpx.Forbidden("guest accounts have no email")
	}
	purpose := purposeVerify
	if u.PendingEmail != nil {
		purpose = purposeChange
	} else if u.EmailVerifiedAt != nil {
		return nil, nil, httpx.Conflict("email is already verified")
	}
	if err := s.checkCode(ctx, userID, purpose, c); err != nil {
		return nil, nil, err
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.DeleteEmailCode(ctx, sqlc.DeleteEmailCodeParams{UserID: userID, Purpose: purpose}); err != nil {
			return err
		}
		var err error
		if purpose == purposeChange {
			u, err = q.ConfirmPendingEmail(ctx, userID)
			if db.UniqueViolation(err) != "" {
				return httpx.Conflict("email is already registered")
			}
			if db.IsNotFound(err) { // the change was canceled meanwhile
				return errCodeExpired
			}
			return err
		}
		u, err = q.SetEmailVerified(ctx, userID)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	joined := s.verified(ctx, u)
	return pbconv.Me(u), joined, nil
}

// verified announces the (newly) verified account to its devices and runs the
// auto-join of pending email invitations.
func (s *Service) verified(ctx context.Context, u sqlc.User) []uuid.UUID {
	// Colleagues see the address and its verified mark (ADR-0077): USER_UPDATE to the workspaces.
	profile.Publish(ctx, s.db.Q, s.events, u, true)
	if s.OnEmailVerified != nil {
		return s.OnEmailVerified(ctx, u)
	}
	return nil
}

// ForgotPassword mails a reset code if email belongs to an account with a password. The
// mail goes out in the background; the answer is the same whether the account exists or not,
// except for the similar-address hint (docs/09 #137): true only when the exact address has no
// account but a sibling-domain one does (kv@gptunnel.ai vs kv@gptunnel.ru, the same lookup as
// the sign-up hint, #119). Both lookups always run, so timing does not tell an existing
// account either. Every stop is logged without the address (domain + hash + client IP) so a
// "the code never came" report can be traced.
func (s *Service) ForgotPassword(ctx context.Context, email, ip string) (similar bool, err error) {
	u, err := s.db.Q.GetUserByEmail(ctx, &email)
	if err != nil && !db.IsNotFound(err) {
		return false, err
	}
	found := err == nil
	similar, err = similarAccount(ctx, s.db.Q, email, nil)
	if err != nil {
		return false, err
	}
	if !found {
		slog.InfoContext(ctx, "password reset: no account",
			"domain", emailDomain(email), "email_hash", emailHash(email), "ip", ip, "similar_account", similar)
		return similar, nil
	}
	if reason := resetIneligible(u); reason != "" {
		slog.InfoContext(ctx, "password reset: account not eligible", "user_id", u.ID, "reason", reason)
		return false, nil
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	go func() {
		defer cancel()
		if err := s.sendCode(bg, u, purposeReset, *u.Email, nil); err != nil {
			slog.InfoContext(bg, "password reset code not sent", "user_id", u.ID, "err", err)
		}
	}()
	return false, nil
}

// resetIneligible names why an existing account gets no reset code ("" = it does).
func resetIneligible(u sqlc.User) string {
	switch {
	case u.IsGuest:
		return "guest"
	case u.DisabledAt != nil:
		return "disabled"
	case u.PasswordHash == nil || u.Email == nil:
		return "no_password"
	}
	return ""
}

// emailDomain is the lower-cased part after the last @ (logs: never the full address).
func emailDomain(email string) string {
	return strings.ToLower(email[strings.LastIndexByte(email, '@')+1:])
}

// emailHash is the first 8 hex digits of sha256 of the trimmed, lower-cased address: enough
// to match a user's report against the logs without storing the address.
func emailHash(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:4])
}

// ResetPassword sets a new password with a reset code, marks the email verified (the code
// proves the mailbox) and revokes every session of the account.
func (s *Service) ResetPassword(ctx context.Context, email, code, password string) error {
	if err := validatePassword(password); err != nil {
		return err
	}
	c, ok := normalizeCode(code)
	if !ok {
		return httpx.Validation("code", "the code is 6 digits")
	}
	email = strings.TrimSpace(email)
	u, err := s.db.Q.GetUserByEmail(ctx, &email)
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	if err != nil || u.IsGuest || u.PasswordHash == nil || u.DisabledAt != nil {
		_, _ = VerifyPassword(ctx, c, dummyHash) // same timing as a wrong code
		return errResetInvalid
	}
	if err := s.checkCode(ctx, u.ID, purposeReset, c); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) && he.Status == http.StatusUnprocessableEntity {
			return errResetInvalid // one answer for unknown / expired / wrong
		}
		return err
	}
	hash, err := HashPassword(ctx, password)
	if err != nil {
		return err
	}
	wasVerified := u.EmailVerifiedAt != nil
	var revoked []uuid.UUID
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.DeleteEmailCode(ctx, sqlc.DeleteEmailCodeParams{UserID: u.ID, Purpose: purposeReset}); err != nil {
			return err
		}
		if err := q.SetPasswordHash(ctx, sqlc.SetPasswordHashParams{ID: u.ID, PasswordHash: &hash}); err != nil {
			return err
		}
		var err error
		if u, err = q.SetEmailVerified(ctx, u.ID); err != nil {
			return err
		}
		revoked, err = q.RevokeAllUserSessions(ctx, sqlc.RevokeAllUserSessionsParams{UserID: u.ID, Reason: RevokePasswordChanged})
		return err
	})
	if err != nil {
		return err
	}
	s.afterRevokeMany(ctx, revoked, RevokePasswordChanged)
	if !wasVerified && s.OnEmailVerified != nil {
		s.OnEmailVerified(ctx, u)
	}
	return nil
}

// VerificationState is what the client needs to decide whether to ask u to confirm its
// address (Ready / LoginResponse / RegisterResponse, ADR-0065).
type VerificationState struct {
	// Optional: EMAIL_VERIFICATION=optional — an unconfirmed address blocks nothing.
	Optional bool
	// InvitePending: with Optional, an email invitation waits for u's unconfirmed address. It
	// joins only after the confirmation (ADR-0027), so its invitee is still asked. A failed
	// lookup counts as pending: the client asks rather than hides the reason to.
	InvitePending bool
}

// Ask reports whether u should be asked for (and mailed) a confirmation code unprompted.
func (v VerificationState) Ask() bool { return !v.Optional || v.InvitePending }

// Verification returns u's VerificationState.
func (s *Service) Verification(ctx context.Context, u sqlc.User) VerificationState {
	v := VerificationState{Optional: s.emailGate.Optional}
	if !v.Optional || !s.mailOn() || u.IsGuest || u.Email == nil || u.EmailVerifiedAt != nil {
		return v
	}
	pending, err := s.db.Q.HasPendingEmailInvite(ctx, *u.Email)
	if err != nil {
		slog.WarnContext(ctx, "email invite lookup failed", "user_id", u.ID, "err", err)
		pending = true
	}
	v.InvitePending = pending
	return v
}

// sendVerificationQuietly queues a verification code after registration / login of an
// unverified account; failures (e.g. a code sent < 60 s ago) are only logged.
func (s *Service) sendVerificationQuietly(ctx context.Context, u sqlc.User) {
	if !s.mailOn() || u.IsGuest || u.Email == nil || u.EmailVerifiedAt != nil {
		return
	}
	addr, purpose := *u.Email, purposeVerify
	if u.PendingEmail != nil {
		addr, purpose = *u.PendingEmail, purposeChange
	}
	if err := s.sendCode(ctx, u, purpose, addr, nil); err != nil {
		slog.InfoContext(ctx, "verification code not sent", "user_id", u.ID, "err", err)
	}
}

// ---- handlers ----

func (h *Handlers) sendVerification(w http.ResponseWriter, r *http.Request) error {
	if err := h.svc.SendVerification(r.Context(), MustFromContext(r.Context()).UserID); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) verifyEmail(w http.ResponseWriter, r *http.Request) error {
	var req v1.VerifyEmailRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me, joined, err := h.svc.VerifyEmail(r.Context(), MustFromContext(r.Context()).UserID, req.GetCode())
	if err != nil {
		return err
	}
	resp := &v1.VerifyEmailResponse{Me: me, JoinedWorkspaceIds: make([]string, len(joined))}
	for i, id := range joined {
		resp.JoinedWorkspaceIds[i] = id.String()
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) forgotPassword(w http.ResponseWriter, r *http.Request) error {
	if err := h.rateLimit(r, "forgot"); err != nil {
		return err
	}
	var req v1.ForgotPasswordRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	email, err := NormalizeEmail(req.GetEmail())
	if err != nil {
		return err
	}
	if !h.svc.mailOn() {
		return mail.ErrDisabled
	}
	similar, err := h.svc.ForgotPassword(r.Context(), email, httpx.ClientIP(r.Context()))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ForgotPasswordResponse{SimilarAccount: similar})
	return nil
}

func (h *Handlers) resetPassword(w http.ResponseWriter, r *http.Request) error {
	if err := h.rateLimit(r, "reset"); err != nil {
		return err
	}
	var req v1.ResetPasswordRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := validatePassword(req.GetPassword()); err != nil {
		return err
	}
	// Per-account bucket as for login: guessing from many IPs.
	if err := h.account.Take(r.Context(), "reset:"+strings.ToLower(strings.TrimSpace(req.GetEmail()))); err != nil {
		return err
	}
	if err := h.svc.ResetPassword(r.Context(), req.GetEmail(), req.GetCode(), req.GetPassword()); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
