// Package auth implements accounts and sessions: argon2id passwords, short-lived access
// JWTs and rotating refresh tokens with reuse detection (docs/04-data-model.md, "Auth").
package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	netmail "net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Why a session ended (sessions.revoked_reason, ApiError.reason of SESSION_REVOKED, the
// gateway's 4010 close reason). Clients show "reset after a connection loss" for REUSE and
// "ended on another device" for the explicit ones.
const (
	RevokeReuse           = "REUSE"
	RevokeLogout          = "LOGOUT"
	RevokeLogoutAll       = "LOGOUT_ALL"
	RevokeOtherDevice     = "OTHER_DEVICE"
	RevokePasswordChanged = "PASSWORD_CHANGED"
	RevokeAccountDisabled = "ACCOUNT_DISABLED"
	RevokeGuestExpired    = "GUEST_EXPIRED"
	// revokeBotToken: a replaced bot token (only the Redis marker, no session row).
	revokeBotToken = "BOT_TOKEN"
)

// Service implements the auth use cases.
type Service struct {
	// Policy evaluates fresh workspace state from the database.
	Policy       *identitypolicy.Service
	entitlements identitypolicy.EntitlementConfig
	db           *db.DB
	redis        rueidis.Client
	tokens       *Tokens
	events       events.Publisher
	mode         config.RegistrationMode
	emailGate    EmailGate
	refresh      time.Duration
	accessTL     time.Duration
	now          func() time.Time
	used         usedGens

	// Mail sends verification / reset codes (ADR-0023); disabled = no SMTP (addresses are
	// then verified at registration). Set before serving.
	Mail *mail.Service
	// OnEmailVerified runs after an account's address became verified (auto-join of pending
	// email invitations, see workspaces.AcceptEmailInvites) and returns the joined workspaces.
	// Optional.
	OnEmailVerified func(ctx context.Context, u sqlc.User) []uuid.UUID
	// BotLimiter bounds the requests of one bot (ADR-0031, BOT_RATE_PER_SEC); nil = none.
	BotLimiter *redisx.RateLimiter
	// OnBotRequest runs for every authenticated bot request (presence of webhook-only bots).
	// Optional; must not block.
	OnBotRequest func(ctx context.Context, id Identity)
	// CheckSeat refuses joining wsID by an invitation at registration when the workspace plan
	// has no seat left (ADR-0024, plans.Check); called inside the registration transaction.
	// Optional.
	CheckSeat func(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) error
}

// NewService wires the auth service.
func NewService(cfg *config.Config, d *db.DB, r rueidis.Client, ev events.Publisher) *Service {
	return &Service{
		db:           d,
		redis:        r,
		tokens:       NewTokens([]byte(cfg.JWTSecret), cfg.AccessTokenTTL),
		events:       ev,
		mode:         cfg.RegistrationMode,
		emailGate:    NewEmailGate(cfg.EmailVerification),
		refresh:      cfg.RefreshTokenTTL,
		accessTL:     cfg.AccessTokenTTL,
		now:          time.Now,
		Policy:       &identitypolicy.Service{Loader: identitypolicy.NewSQLLoader(d.Q, cfg.IdentityEntitlements())},
		entitlements: cfg.IdentityEntitlements(),
	}
}

// EmailGate is the configured EMAIL_VERIFICATION policy for actions (ADR-0065).
func (s *Service) EmailGate() EmailGate { return s.emailGate }

// Tokens exposes the access-token verifier (used by the gateway for IDENTIFY).
func (s *Service) Tokens() *Tokens { return s.tokens }

// Client describes where a request came from; stored on the session.
type Client struct {
	DeviceName string
	IP         string
	UserAgent  string
	Locale     string // supported mail locale from Accept-Language ("" = none)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// NormalizeEmail trims and validates an email address. Case is kept (citext compares
// case-insensitively).
func NormalizeEmail(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > 254 {
		return "", httpx.Validation("email", "email is too long")
	}
	a, err := netmail.ParseAddress(s)
	if err != nil || a.Address != s || !strings.Contains(s[strings.LastIndexByte(s, '@'):], ".") {
		return "", httpx.Validation("email", "invalid email address")
	}
	return s, nil
}

// ValidateDisplayName trims and checks a display name (1..64 characters).
func ValidateDisplayName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 64 {
		return "", httpx.Validation("displayName", "display name must be 1..64 characters")
	}
	return s, nil
}

func validatePassword(p string) error {
	if n := utf8.RuneCountInString(p); n < 8 || n > 256 {
		return httpx.Validation("password", "password must be 8..256 characters")
	}
	return nil
}

var (
	errInvalidCredentials = httpx.Coded(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_INVALID_CREDENTIALS, "invalid email or password")
	errInvalidRefresh     = httpx.Coded(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_INVALID_REFRESH_TOKEN, "invalid refresh token")
	errInviteInvalid      = httpx.Coded(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "invite is invalid, expired or used up")
	errRegistrationClosed = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_REGISTRATION_CLOSED, "registration requires an invite")
	// errSimilarAccount rolls back a sign-up that hit the similar-account hint (docs/09 #119).
	errSimilarAccount = errors.New("similar account")
	errInviteEmail    = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH,
		"this invitation was sent to another email address: use that address")
	// errRefreshRace: the previous refresh token was presented while the new one is unused,
	// but the rotation cannot be replayed (it happened before migration 00040: no seal). The session is intact: retry with the current token (web: the cookie
	// already holds it). Must not clear the cookie.
	errRefreshRace = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, "refresh token was just rotated; retry with the current one")
	// errSessionRevoked: the refresh token belongs to an ended session; errRevoked adds the
	// reason. Clears the web cookie like errInvalidRefresh.
	errSessionRevoked = httpx.Coded(http.StatusUnauthorized, v1.ErrorCode_ERROR_CODE_SESSION_REVOKED, "session revoked")
)

// errRevoked is errSessionRevoked with its reason ("" = unknown: a session revoked before
// migration 00040).
func errRevoked(reason string) error {
	if reason == "" {
		return errSessionRevoked
	}
	return errSessionRevoked.WithDetails(reason, 0, 0)
}

// ErrInviteInvalid is shared with the workspaces package.
func ErrInviteInvalid() error { return errInviteInvalid }

// ErrInviteEmailMismatch (403 INVITE_EMAIL_MISMATCH) is shared with the workspaces package.
func ErrInviteEmailMismatch() error { return errInviteEmail }

// Guest accounts (ADR-0016): short sessions renewed by activity; the account is removed
// (anonymised) after GuestInactivity without a refresh.
const (
	GuestSessionTTL = 24 * time.Hour
	GuestInactivity = 7 * 24 * time.Hour
)

// NewGuest creates a guest account named name and its first session inside q.
func (s *Service) NewGuest(ctx context.Context, q *sqlc.Queries, name string, c Client) (sqlc.User, *v1.AuthTokens, error) {
	settings, err := pbconv.EncodeSettings(pbconv.DefaultSettings())
	if err != nil {
		return sqlc.User{}, nil, err
	}
	exp := s.now().Add(GuestInactivity)
	u, err := q.CreateGuestUser(ctx, sqlc.CreateGuestUserParams{DisplayName: name, Settings: settings, GuestExpiresAt: &exp})
	if err != nil {
		return u, nil, err
	}
	tokens, err := s.newSessionTTL(ctx, q, u.ID, c, GuestSessionTTL)
	return u, tokens, err
}

// newSession creates a session row inside q and returns the token pair.
func (s *Service) newSession(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, c Client) (*v1.AuthTokens, error) {
	return s.newSessionTTL(ctx, q, userID, c, s.refresh)
}

func (s *Service) newSessionTTL(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, c Client, ttl time.Duration) (*v1.AuthTokens, error) {
	secret, hash, err := NewRefreshSecret()
	if err != nil {
		return nil, err
	}
	sess, err := q.CreateSession(ctx, sqlc.CreateSessionParams{
		UserID:           userID,
		RefreshTokenHash: hash,
		DeviceName:       clip(c.DeviceName, 64),
		Ip:               clip(c.IP, 64),
		UserAgent:        clip(c.UserAgent, 256),
		ExpiresAt:        s.now().Add(ttl),
	})
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	u, err := q.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !u.IsGuest && !u.IsBot && u.PasswordHash != nil {
		if sess, err = q.RecordLocalAuthentication(ctx, sqlc.RecordLocalAuthenticationParams{SessionID: sess.ID, UserID: userID, AuthenticatedAt: ptrTime(s.now())}); err != nil {
			return nil, err
		}
	}
	return s.tokenPair(sess, secret)
}

func (s *Service) tokenPair(sess sqlc.Session, secret string) (*v1.AuthTokens, error) {
	deadline := sess.ExpiresAt
	if sess.AuthorityKind != string(identitypolicy.LocalAccount) {
		limit := s.now().Add(5 * time.Minute)
		if limit.Before(deadline) {
			deadline = limit
		}
	}
	access, exp, err := s.tokens.IssueUntil(sess.UserID, sess.ID, sess.RefreshGen, deadline)
	if err != nil {
		return nil, err
	}
	return &v1.AuthTokens{
		AccessToken:      access,
		AccessExpiresAt:  timestamppb.New(exp),
		RefreshToken:     FormatRefreshToken(sess.ID, secret),
		RefreshExpiresAt: timestamppb.New(sess.ExpiresAt),
		SessionId:        sess.ID.String(),
		Authority:        pbconv.SessionAuthority(sess),
	}, nil
}

// Register creates an account and a first session. With REGISTRATION_MODE=invite a valid
// workspace invite is required, except for the very first user of the server (bootstrap).
func (s *Service) Register(ctx context.Context, req *v1.RegisterRequest, c Client) (*v1.RegisterResponse, error) {
	email, err := NormalizeEmail(req.GetEmail())
	if err != nil {
		return nil, err
	}
	name, err := ValidateDisplayName(req.GetDisplayName())
	if err != nil {
		return nil, err
	}
	if err := validatePassword(req.GetPassword()); err != nil {
		return nil, err
	}
	code := strings.TrimSpace(req.GetInviteCode())
	if s.mode == config.RegistrationInvite && code == "" {
		// Cheap pre-check before hashing; re-checked under lock below.
		n, err := s.db.Q.CountUsers(ctx)
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, errRegistrationClosed
		}
	}
	hash, err := HashPassword(ctx, req.GetPassword())
	if err != nil {
		return nil, err
	}
	settings, err := pbconv.EncodeSettings(pbconv.DefaultSettings())
	if err != nil {
		return nil, err
	}

	loc := mail.Supported(req.GetLocale())
	if loc == "" {
		loc = c.Locale
	}
	var locPtr *string
	if loc != "" {
		locPtr = &loc
	}
	// Without SMTP there is nothing to verify with: the address counts as verified.
	var verifiedAt *time.Time
	if !s.mailOn() {
		verifiedAt = ptrTime(s.now())
	}

	var (
		user   sqlc.User
		tokens *v1.AuthTokens
		joined *sqlc.WorkspaceMember
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if s.mode == config.RegistrationInvite && code == "" {
			if err := q.LockRegistration(ctx); err != nil {
				return err
			}
			n, err := q.CountUsers(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				return errRegistrationClosed
			}
		}
		var inv *sqlc.WorkspaceInvite
		role := perm.RoleMember
		// gate: the workspace whose code let this sign-up in — its suspension and bans refuse
		// the sign-up (item 32), also for an emailed code that joins only later (ADR-0027).
		var gate *uuid.UUID
		if code != "" {
			i, err := q.GetInviteByCode(ctx, code)
			if db.IsNotFound(err) {
				return errInviteInvalid
			}
			if err != nil {
				return err
			}
			if _, err := q.LockOAuthWorkspace(ctx, i.WorkspaceID); err != nil {
				return err
			}
			ei, err := q.GetEmailInviteByInvite(ctx, i.ID)
			switch {
			case err == nil:
				// An invitation sent by email (ADR-0027): a valid sign-up code for the invited
				// address only. It is not spent here: the user joins after confirming the
				// address (OnEmailVerified → workspaces.AcceptEmailInvites), so a leaked code
				// alone never yields an account with a verified address.
				if ei.AcceptedAt != nil || !inviteLive(i, s.now()) {
					return errInviteInvalid
				}
				if !strings.EqualFold(ei.Email, email) {
					return errInviteEmail
				}
				if s.mailOn() {
					gate = &i.WorkspaceID
					break
				}
				// No SMTP (the invitation predates turning mail off): nothing can confirm the
				// address later, so the emailed code itself is the proof, as before.
				if err := q.AcceptEmailInvite(ctx, ei.ID); err != nil {
					return err
				}
				if _, err := q.ConsumeInvite(ctx, code); err != nil {
					if db.IsNotFound(err) {
						return errInviteInvalid
					}
					return err
				}
				inv, gate, role = &i, &i.WorkspaceID, perm.Role(ei.Role)
			case db.IsNotFound(err):
				if _, err := q.ConsumeInvite(ctx, code); err != nil {
					if db.IsNotFound(err) {
						return errInviteInvalid
					}
					return err
				}
				inv, gate = &i, &i.WorkspaceID
			default:
				return err
			}
		}
		user, err = q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, PasswordHash: &hash, DisplayName: name, Settings: settings,
			Locale: locPtr, EmailVerifiedAt: verifiedAt})
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("email is already registered")
		}
		if err != nil {
			return err
		}
		if gate != nil {
			// A suspended workspace takes nobody in; a banned address stays out (item 32).
			if err := moderation.CheckSuspended(ctx, q, *gate); err != nil {
				return err
			}
			if err := moderation.CheckBan(ctx, q, *gate, user.ID, &email); err != nil {
				return err
			}
		}
		if inv != nil {
			if s.CheckSeat != nil {
				if err := s.CheckSeat(ctx, q, inv.WorkspaceID); err != nil {
					return err
				}
			}
			m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: inv.WorkspaceID, UserID: user.ID, Role: string(role)})
			if err != nil {
				return err
			}
			joined = &m
		}
		if req.GetCheckSimilarAccount() {
			// Last, once every other check passed (docs/09 #119): the hint answers only a
			// sign-up that would have gone through, at the same cost (password hash, invite,
			// seats, bans), and a miss creates the account — so it is no cheaper oracle than the
			// exact-address 409. A hit rolls everything back.
			similar, err := similarAccount(ctx, q, email, gate)
			if err != nil {
				return err
			}
			if similar {
				return errSimilarAccount
			}
		}
		tokens, err = s.newSession(ctx, q, user.ID, c)
		return err
	})
	if errors.Is(err, errSimilarAccount) {
		return &v1.RegisterResponse{SimilarAccount: true}, nil
	}
	if err != nil {
		return nil, err
	}
	if joined != nil {
		// Role ids come from the member trigger (migration 00021): the built-in role(s).
		ids, err := s.db.Q.ListMemberRoleIDs(ctx, sqlc.ListMemberRoleIDsParams{WorkspaceID: joined.WorkspaceID, UserID: joined.UserID})
		if err == nil {
			s.events.Workspace(ctx, joined.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
				WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pbconv.Member(*joined, user, ids)},
			}})
		}
	}
	// EMAIL_VERIFICATION=optional (ADR-0065): no code unless an email invitation waits for
	// the address (its join needs the confirmation); the user asks for one in the settings.
	vs := s.Verification(ctx, user)
	if user.EmailVerifiedAt == nil && vs.Ask() {
		s.sendVerificationQuietly(ctx, user)
	}
	return &v1.RegisterResponse{Tokens: tokens, Me: pbconv.Me(user),
		EmailVerificationOptional: vs.Optional, EmailInvitePending: vs.InvitePending}, nil
}

// Login verifies credentials and opens a new session.
func (s *Service) Login(ctx context.Context, req *v1.LoginRequest, c Client) (*v1.LoginResponse, error) {
	email := strings.TrimSpace(req.GetEmail())
	user, err := s.db.Q.GetUserByEmail(ctx, &email)
	if err != nil && !db.IsNotFound(err) {
		return nil, err
	}
	hash := dummyHash
	if err == nil && user.PasswordHash != nil {
		hash = *user.PasswordHash
	}
	ok, verr := VerifyPassword(ctx, req.GetPassword(), hash)
	if verr != nil && !errors.Is(verr, errBadHash) {
		return nil, verr
	}
	if err != nil || !ok || user.PasswordHash == nil || user.DisabledAt != nil {
		return nil, errInvalidCredentials
	}
	// The hash was verified outside any transaction (argon2 takes a while): make sure it is
	// still the current one when the session is created (review 4 L4).
	var tokens *v1.AuthTokens
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.LockPasswordHash(ctx, user.ID)
		if err != nil {
			return err
		}
		if cur == nil || *cur != *user.PasswordHash {
			return errInvalidCredentials
		}
		tokens, err = s.newSession(ctx, q, user.ID, c)
		return err
	})
	if err != nil {
		return nil, err
	}
	// Unverified (e.g. accounts from before ADR-0023): a fresh code with every sign-in,
	// unless one was sent less than 60 s ago — not when nothing asks for it (ADR-0065).
	vs := s.Verification(ctx, user)
	if vs.Ask() {
		s.sendVerificationQuietly(ctx, user)
	}
	me, err := pbconv.LocalMe(ctx, s.db.Q, user)
	if err != nil {
		return nil, err
	}
	return &v1.LoginResponse{Tokens: tokens, Me: me, EmailVerificationOptional: vs.Optional, EmailInvitePending: vs.InvitePending}, nil
}

// Refresh rotates the refresh token of a session. The previous token gets the same new pair
// again while the new token is unused (a lost answer, replay.go); any other stale token —
// the previous one after the new one was used, or an older one — is reuse: the session is
// revoked (401 SESSION_REVOKED, reason REUSE).
func (s *Service) Refresh(ctx context.Context, req *v1.RefreshRequest, c Client) (*v1.RefreshResponse, error) {
	return s.refreshAuthority(ctx, req, c, identitypolicy.LocalAccount, uuid.Nil)
}

// RefreshWorkspace rotates only the presented workspace session; proof is never renewed.
func (s *Service) RefreshWorkspace(ctx context.Context, ws uuid.UUID, req *v1.RefreshRequest, c Client) (*v1.RefreshResponse, error) {
	if ws == uuid.Nil {
		return nil, errInvalidRefresh
	}
	return s.refreshAuthority(ctx, req, c, identitypolicy.WorkspaceSSO, ws)
}
func (s *Service) refreshAuthority(ctx context.Context, req *v1.RefreshRequest, c Client, authority identitypolicy.Authority, ws uuid.UUID) (*v1.RefreshResponse, error) {
	sid, secret, ok := ParseRefreshToken(req.GetRefreshToken())
	if !ok {
		return nil, errInvalidRefresh
	}
	presented := HashRefreshSecret(secret)
	var (
		tokens  *v1.AuthTokens
		revoked string // reason of a revocation made here
	)
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		// Workspace mutations and RP issuance lock the source row before any session.
		// Take that same boundary before rotating a scoped refresh token.
		if authority == identitypolicy.WorkspaceSSO {
			if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
				return errInvalidRefresh
			}
		}
		before, err := q.GetSession(ctx, sid)
		if err != nil {
			if db.IsNotFound(err) {
				return errInvalidRefresh
			}
			return err
		}
		beforeUser, err := q.GetUser(ctx, before.UserID)
		if err != nil {
			return err
		}
		if beforeUser.IsGuest {
			_, err = q.LockIdentityUserExclusive(ctx, before.UserID)
		} else {
			_, err = q.LockIdentityUserShared(ctx, before.UserID)
		}
		if err != nil {
			return err
		}
		sess, err := q.GetSessionForUpdate(ctx, sid)
		if db.IsNotFound(err) {
			return errInvalidRefresh
		}
		if err != nil {
			return err
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		now := s.now()
		if databaseNow.After(now) {
			now = databaseNow
		}
		p := SessionPrincipal(sess)
		if p.Authority != authority || p.WorkspaceID != ws {
			return errInvalidRefresh
		}

		current := subtle.ConstantTimeCompare(presented, sess.RefreshTokenHash) == 1
		previous := !current && sess.PrevRefreshTokenHash != nil && subtle.ConstantTimeCompare(presented, sess.PrevRefreshTokenHash) == 1
		if sess.RevokedAt != nil {
			// Only a holder of one of its last two tokens learns why the session ended.
			if current || previous {
				return errRevoked(derefStr(sess.RevokedReason))
			}
			return errInvalidRefresh
		}
		if !now.Before(sess.ExpiresAt) {
			return errInvalidRefresh
		}
		replay := "" // the new secret handed out again (lost answer), no rotation
		if !current {
			outcome := replayReuse
			if previous {
				outcome, replay = replayPrevious(sess, secret)
			}
			switch outcome {
			case replaySamePair:
				// The answer to the rotation was lost (or another tab won the race), and the new
				// token has not been used since: the same new refresh token, a fresh access token.
			case replayConflict:
				return errRefreshRace // unused, but not replayable (rotated before 00040): keep the session
			default:
				if _, err := q.RevokeSession(ctx, sqlc.RevokeSessionParams{ID: sess.ID, Reason: RevokeReuse}); err != nil {
					return err
				}
				revoked = RevokeReuse
				return nil // commit the revocation
			}
		}
		if authority == identitypolicy.WorkspaceSSO {
			d, err := s.checkWorkspaceDecision(ctx, q, Identity{UserID: p.UserID, SessionID: p.SessionID, Principal: p}, ws, identitypolicy.WorkspaceRead)
			if err != nil {
				return IdentityError(p, d, err)
			}
		}
		user, err := q.GetUser(ctx, sess.UserID)
		if err != nil {
			return err
		}
		if user.DisabledAt != nil {
			if _, err := q.RevokeSession(ctx, sqlc.RevokeSessionParams{ID: sess.ID, Reason: RevokeAccountDisabled}); err != nil {
				return err
			}
			revoked = RevokeAccountDisabled
			return nil
		}
		if replay != "" {
			tokens, err = s.tokenPair(sess, replay)
			return err
		}
		ttl := s.refresh
		if user.IsGuest && user.GuestExpiresAt != nil { // promoted guests get normal sessions
			ttl = GuestSessionTTL // renewed by activity; the account itself lives 7 days past the last refresh
			if err := q.TouchGuest(ctx, sqlc.TouchGuestParams{ID: user.ID, GuestExpiresAt: ptrTime(now.Add(GuestInactivity))}); err != nil {
				return err
			}
		}
		newSecret, newHash, err := NewRefreshSecret()
		if err != nil {
			return err
		}
		seal, err := sealReplay(sess.ID, secret, newSecret)
		if err != nil {
			return err
		}
		expires := now.Add(ttl)
		if hostUntil := s.now().Add(ttl); hostUntil.Before(expires) {
			expires = hostUntil
		}
		if dbUntil := databaseNow.Add(ttl); dbUntil.Before(expires) {
			expires = dbUntil
		}
		if authority != identitypolicy.LocalAccount && sess.ExpiresAt.Before(expires) {
			expires = sess.ExpiresAt // corporate session has an absolute RP deadline
		}
		sess, err = q.RotateSession(ctx, sqlc.RotateSessionParams{
			ID:               sess.ID,
			RefreshTokenHash: newHash,
			ExpiresAt:        expires,
			Ip:               clip(c.IP, 64),
			UserAgent:        clip(c.UserAgent, 256),
			ReplaySeal:       seal,
		})
		if err != nil {
			return err
		}
		tokens, err = s.tokenPair(sess, newSecret)
		return err
	})
	if err != nil {
		return nil, err
	}
	if revoked != "" {
		if revoked == RevokeReuse {
			slog.WarnContext(ctx, "refresh token reuse: session revoked", "session_id", sid)
		}
		s.afterRevoke(ctx, sid, revoked)
		return nil, errRevoked(revoked)
	}
	return &v1.RefreshResponse{Tokens: tokens}, nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Logout revokes the caller's session, or all of the user's sessions.
func (s *Service) Logout(ctx context.Context, id Identity, all bool) error {
	if all {
		if err := s.CheckGlobal(ctx, id, identitypolicy.GlobalWrite); err != nil {
			return err
		}
		ids, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]uuid.UUID, error) {
			return guarded.RevokeAllUserSessions(ctx, sqlc.RevokeAllUserSessionsParams{UserID: id.UserID, Reason: RevokeLogoutAll})
		})
		if err != nil {
			return err
		}
		s.afterRevokeMany(ctx, ids, RevokeLogoutAll)
		return nil
	}
	if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeSession(ctx, sqlc.RevokeSessionParams{ID: id.SessionID, Reason: RevokeLogout})
	}); err != nil {
		return err
	}
	s.afterRevoke(ctx, id.SessionID, RevokeLogout)
	return nil
}

// LogoutByRefresh revokes the session a refresh token belongs to (or all of its user's
// sessions). The token must be the session's current one, or — for this session only — the
// previous one while the current is unused (a lost refresh answer); anything else is rejected
// without side effects (no reuse revocation here). "Log out everywhere" needs the current
// token: a stale copy must not end the user's other devices.
func (s *Service) LogoutByRefresh(ctx context.Context, token string, all bool) error {
	sid, secret, ok := ParseRefreshToken(token)
	if !ok {
		return errInvalidRefresh
	}
	sess, err := s.db.Q.GetSession(ctx, sid)
	if db.IsNotFound(err) {
		return errInvalidRefresh
	}
	if err != nil {
		return err
	}
	h := HashRefreshSecret(secret)
	current := subtle.ConstantTimeCompare(h, sess.RefreshTokenHash) == 1
	recent := !all && sess.PrevRefreshTokenHash != nil && sess.RefreshUsedAt == nil &&
		subtle.ConstantTimeCompare(h, sess.PrevRefreshTokenHash) == 1
	if !current && !recent {
		return errInvalidRefresh
	}
	if sess.RevokedAt != nil && !all {
		return nil // already logged out
	}
	return s.Logout(ctx, Identity{UserID: sess.UserID, SessionID: sess.ID}, all)
}

// RevokeSession revokes one of the user's own sessions.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	n, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeUserSession(ctx, sqlc.RevokeUserSessionParams{ID: sessionID, UserID: userID, Reason: RevokeOtherDevice})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("session")
	}
	s.afterRevoke(ctx, sessionID, RevokeOtherDevice)
	return nil
}

// ListSessions returns the user's active sessions.
func (s *Service) ListSessions(ctx context.Context, id Identity) (*v1.ListSessionsResponse, error) {
	rows, err := s.db.Q.ListActiveSessions(ctx, id.UserID)
	if err != nil {
		return nil, err
	}
	out := &v1.ListSessionsResponse{Sessions: make([]*v1.Session, len(rows))}
	for i, r := range rows {
		out.Sessions[i] = pbconv.Session(r, id.SessionID)
	}
	return out, nil
}

// MarkRevoked makes sessions revoked in the DB by someone else (e.g. guest cleanup, with
// its reason) effective immediately: live access tokens are rejected and the gateway drops
// the sockets.
func (s *Service) MarkRevoked(ctx context.Context, reason string, sids ...uuid.UUID) {
	s.afterRevokeMany(ctx, sids, reason)
}

func revokedKey(sid uuid.UUID) string { return redisx.Key("auth:revoked:" + sid.String()) }

// revokeBudget is the Redis time a revocation gets for its markers, and again for its
// socket-close events. It is deliberately not taken from the request's shared post-commit
// budget (events.RequestBudget): "log out everywhere" after a slow reorder or with a
// sluggish Redis must still kill the access tokens now, not leave them alive until they
// expire (≤ ACCESS_TOKEN_TTL).
const revokeBudget = 3 * time.Second

// afterRevoke makes outstanding access tokens of the session invalid immediately (Redis
// marker living as long as an access token can, holding the reason) and tells the gateway to
// drop the socket (4010 with the reason).
func (s *Service) afterRevoke(ctx context.Context, sid uuid.UUID, reason string) {
	s.afterRevokeMany(ctx, []uuid.UUID{sid}, reason)
}

// afterRevokeMany is afterRevoke for several sessions: all markers in one pipeline, then
// the socket-close events — each step with its own revokeBudget.
func (s *Service) afterRevokeMany(ctx context.Context, sids []uuid.UUID, reason string) {
	if len(sids) == 0 {
		return
	}
	ctx = context.WithoutCancel(ctx)
	ttl := s.accessTL + time.Minute
	cmds := make(rueidis.Commands, len(sids))
	for i, sid := range sids {
		cmds[i] = s.redis.B().Set().Key(revokedKey(sid)).Value(markerValue(reason)).Ex(ttl).Build()
	}
	mctx, done := events.Detached(events.WithBudget(ctx, revokeBudget), revokeBudget)
	res := s.redis.DoMulti(mctx, cmds...)
	for i, sid := range sids {
		if i < len(res) {
			if err := res[i].Error(); err != nil {
				// Access tokens of this session stay valid until expiry (≤ ACCESS_TOKEN_TTL).
				slog.WarnContext(ctx, "mark session revoked failed", "session_id", sid, "err", err)
			}
		}
	}
	done()
	pctx := events.WithBudget(ctx, revokeBudget)
	for _, sid := range sids {
		s.events.SessionRevoked(pctx, sid, reason)
	}
}

// markerValue is the value of the revocation marker: the reason, "1" when unknown.
func markerValue(reason string) string {
	if reason == "" {
		return "1"
	}
	return reason
}

// IsRevoked reports whether the session was revoked while access tokens may still be live.
// Uses rueidis client-side caching: Redis invalidates the cached value on SET.
func (s *Service) IsRevoked(ctx context.Context, sid uuid.UUID) (bool, error) {
	_, revoked, err := s.revokedReason(ctx, sid)
	return revoked, err
}

// revokedReason is IsRevoked with the marker's reason ("" = unknown).
func (s *Service) revokedReason(ctx context.Context, sid uuid.UUID) (string, bool, error) {
	v, err := s.redis.DoCache(ctx, s.redis.B().Get().Key(revokedKey(sid)).Cache(), s.accessTL).ToString()
	if rueidis.IsRedisNil(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if v == "1" {
		v = ""
	}
	return v, true, nil
}

// similarAccount reports another account with the same local part at a sibling domain of the
// same organisation (docs/09 #119, HasSimilarAccount): kv@gptunnel.ai signing up while
// kv@gptunnel.ru exists. ws is the workspace whose invite let the sign-up in (its email
// invitations' domains count as the organisation's). Runs inside the sign-up transaction after
// the account row was inserted, so the exact address is already the usual 409 and the query
// skips it. The other address itself is never returned.
func similarAccount(ctx context.Context, q *sqlc.Queries, email string, ws *uuid.UUID) (bool, error) {
	at := strings.LastIndexByte(email, '@')
	local, domain := email[:at], email[at+1:]
	dot := strings.LastIndexByte(domain, '.')
	if dot <= 0 {
		return false, nil
	}
	return q.HasSimilarAccount(ctx, sqlc.HasSimilarAccountParams{Email: email, Local: local, DomainName: domain[:dot], WorkspaceID: ws})
}

// inviteLive: not expired and not used up.
func inviteLive(i sqlc.WorkspaceInvite, now time.Time) bool {
	return (i.ExpiresAt == nil || now.Before(*i.ExpiresAt)) && (i.MaxUses == 0 || i.Uses < i.MaxUses)
}

func ptrTime(t time.Time) *time.Time { return &t }
