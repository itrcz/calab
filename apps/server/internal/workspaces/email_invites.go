package workspaces

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Invitations by email (ADR-0023).
const (
	emailInviteTTL    = 7 * 24 * time.Hour
	emailInviteResend = 24 * time.Hour
)

// EmailInvites configures invitations by email.
type EmailInvites struct {
	Mail      *mail.Service
	PublicURL string              // PUBLIC_APP_URL: links are <PublicURL>/join/<code>
	Lookup    *redisx.RateLimiter // lookups per user (20/min)
	Send      *redisx.RateLimiter // direct adds + invitation mails per user
}

// WithEmailInvites enables the email invitation endpoints.
func (h *Handlers) WithEmailInvites(e EmailInvites) *Handlers {
	h.email = e
	return h
}

func (h *Handlers) emailRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("POST /api/workspaces/{id}/invites/lookup", h.lookupInvitee)
	handle("POST /api/workspaces/{id}/members", h.addMember)
	handle("POST /api/workspaces/{id}/invites/email", h.createEmailInvite)
	handle("GET /api/workspaces/{id}/invites/email", h.listEmailInvites)
	handle("DELETE /api/workspaces/{id}/invites/email/{inviteId}", h.deleteEmailInvite)
}

// verifiedAccount: the caller must be a registered (non-guest) account with a verified
// email (403 EMAIL_NOT_VERIFIED) — unless EMAIL_VERIFICATION=optional (ADR-0065): then the
// caller's own address is not checked. Whom it may reach by email is decided by the
// invitee side, which always requires a confirmed address (lookupInvitee, AcceptEmailInvites).
func (h *Handlers) verifiedAccount(r *http.Request) (sqlc.User, error) {
	u, err := h.db.Q.GetUser(r.Context(), uid(r))
	if err != nil {
		return u, err
	}
	if u.IsGuest {
		return u, httpx.Forbidden("not available for guest accounts")
	}
	return u, h.emailGate.Allow(u)
}

// inviter: verified caller with the invite right (INVITE_MEMBERS, ADR-0043) in the path workspace.
func (h *Handlers) inviter(r *http.Request) (sqlc.User, uuid.UUID, perm.Role, error) {
	wsID, role, err := requireInvite(r)
	if err != nil {
		return sqlc.User{}, uuid.Nil, "", err
	}
	u, err := h.verifiedAccount(r)
	return u, wsID, role, err
}

func take(ctx context.Context, l *redisx.RateLimiter, key string) error {
	if l == nil {
		return nil
	}
	return l.Take(ctx, key)
}

// emailRef identifies an address in logs without writing it out.
func emailRef(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(email)))
	return hex.EncodeToString(sum[:6])
}

func (h *Handlers) lookupInvitee(w http.ResponseWriter, r *http.Request) error {
	_, wsID, _, err := h.inviter(r)
	if err != nil {
		return err
	}
	if err := take(r.Context(), h.email.Lookup, uid(r).String()); err != nil {
		return err
	}
	var req v1.InviteLookupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	email, err := auth.NormalizeEmail(req.GetEmail())
	if err != nil {
		return err
	}
	resp := &v1.InviteLookupResponse{}
	u, err := h.db.Q.LookupInvitee(r.Context(), &email)
	switch {
	case err == nil:
		resp.User = pbconv.User(u)
		if _, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: u.ID}); err == nil {
			resp.Member = true
		} else if !db.IsNotFound(err) {
			return err
		}
	case !db.IsNotFound(err):
		return err
	}
	slog.InfoContext(r.Context(), "invite lookup", "workspace_id", wsID, "actor", uid(r), "email_ref", emailRef(email), "found", resp.User != nil)
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

// addMember: POST /api/workspaces/{id}/members {user_id} — adds a verified account at once.
func (h *Handlers) addMember(w http.ResponseWriter, r *http.Request) error {
	actor, wsID, _, err := h.inviter(r)
	if err != nil {
		return err
	}
	var req v1.AddMemberRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	target, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	if err := take(r.Context(), h.email.Send, uid(r).String()); err != nil {
		return err
	}
	u, err := h.db.Q.GetUser(r.Context(), target)
	if db.IsNotFound(err) || (err == nil && (u.IsGuest || u.DisabledAt != nil || u.EmailVerifiedAt == nil || u.Email == nil)) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	var (
		ws sqlc.Workspace
		m  sqlc.WorkspaceMember
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if ws, err = q.GetWorkspace(r.Context(), wsID); err != nil {
			return err
		}
		if err := moderation.CheckBan(r.Context(), q, wsID, target, u.Email); err != nil {
			return err
		}
		if _, err := q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target}); err == nil {
			return httpx.Conflict("already a member")
		} else if !db.IsNotFound(err) {
			return err
		}
		if err := h.limits.Plans.Check(r.Context(), q, wsID, plans.KindMembers, true); err != nil {
			return err
		}
		m, err = q.AddMember(r.Context(), sqlc.AddMemberParams{WorkspaceID: wsID, UserID: target, Role: string(perm.RoleMember)})
		if db.IsNotFound(err) { // ON CONFLICT DO NOTHING
			return httpx.Conflict("already a member")
		}
		if err != nil {
			return err
		}
		// A pending email invitation of the same address is moot now: revoke its link.
		if ei, err := q.GetPendingEmailInvite(r.Context(), sqlc.GetPendingEmailInviteParams{WorkspaceID: wsID, Email: *u.Email}); err == nil {
			_, err = q.DeleteInvite(r.Context(), sqlc.DeleteInviteParams{ID: ei.InviteID, WorkspaceID: wsID})
			return err
		} else if !db.IsNotFound(err) {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	h.joined(r.Context(), ws, m)
	if h.email.Mail.Enabled() {
		err := h.email.Mail.Enqueue(r.Context(), nil, mail.Mail{
			To: *u.Email, Template: mail.TemplateWorkspaceAdded, Locale: localeOf(u), Priority: mail.PriorityNotice, TTL: mail.MaxRetry,
			Params: mail.Params{"workspace": ws.Name, "inviter": actor.DisplayName, "url": h.email.PublicURL},
		})
		if err != nil { // the member was added; the notice is best-effort
			slog.InfoContext(r.Context(), "workspace_added mail not queued", "user_id", u.ID, "err", err)
		} else {
			h.email.Mail.Wake()
		}
	}
	pb, err := MemberPB(r.Context(), h.db.Q, m, u)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.AddMemberResponse{Member: pb})
	return nil
}

func localeOf(u sqlc.User) string {
	if u.Locale != nil {
		return *u.Locale
	}
	return mail.LocaleEN
}

// mailSender is the inviter's name and language in an invitation mail. A bot (ADR-0051) sends
// as the workspace on its behalf, in the language of its owner.
func mailSender(ctx context.Context, q *sqlc.Queries, actor sqlc.User, ws sqlc.Workspace) (name, locale string) {
	if !actor.IsBot {
		return actor.DisplayName, localeOf(actor)
	}
	locale = mail.LocaleEN
	if b, err := q.GetBot(ctx, actor.ID); err == nil {
		if owner, err := q.GetUser(ctx, b.OwnerUserID); err == nil {
			locale = localeOf(owner)
		}
	}
	return mail.OnBehalfOfBot(locale, ws.Name, actor.DisplayName), locale
}

func emailInvitePB(e sqlc.EmailInvite) *v1.EmailInvite {
	return &v1.EmailInvite{
		Id: e.ID.String(), WorkspaceId: e.WorkspaceID.String(), Email: e.Email, Role: perm.Role(e.Role).Proto(),
		InvitedBy: e.InvitedBy.String(), CreatedAt: timestamppb.New(e.CreatedAt), ExpiresAt: timestamppb.New(e.ExpiresAt),
		LastSentAt: timestamppb.New(e.LastSentAt),
	}
}

// createEmailInvite: POST /api/workspaces/{id}/invites/email {email, role?}.
func (h *Handlers) createEmailInvite(w http.ResponseWriter, r *http.Request) error {
	actor, wsID, actorRole, err := h.inviter(r)
	if err != nil {
		return err
	}
	if !h.email.Mail.Enabled() {
		return mail.ErrDisabled
	}
	var req v1.CreateEmailInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	email, err := auth.NormalizeEmail(req.GetEmail())
	if err != nil {
		return err
	}
	role := perm.RoleMember
	if req.Role != nil {
		switch req.GetRole() {
		case v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER:
		case v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN:
			if actorRole != perm.RoleOwner {
				return httpx.Forbidden("only the owner can invite admins")
			}
			role = perm.RoleAdmin
		default:
			return httpx.Validation("role", "role must be MEMBER or ADMIN")
		}
	}
	var existing uuid.UUID // the address's account, if any
	if u, err := h.db.Q.GetUserByEmail(r.Context(), &email); err == nil {
		existing = u.ID
		if _, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: u.ID}); err == nil {
			return httpx.Conflict("already a member")
		} else if !db.IsNotFound(err) {
			return err
		}
	} else if !db.IsNotFound(err) {
		return err
	}
	// A banned address (or account) is not invited again until the ban is lifted (item 32).
	if err := moderation.CheckBan(r.Context(), h.db.Q, wsID, existing, &email); err != nil {
		return err
	}
	// No seat left: the invitee could not join (ADR-0024). Checked before the mail goes out.
	if err := h.limits.Plans.Check(r.Context(), h.db.Q, wsID, plans.KindMembers, false); err != nil {
		return err
	}
	if err := take(r.Context(), h.email.Send, uid(r).String()); err != nil {
		return err
	}
	code, err := newInviteCode()
	if err != nil {
		return err
	}
	now := time.Now()
	expires := now.Add(emailInviteTTL)
	var out sqlc.EmailInvite
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		ws, err := q.GetWorkspace(r.Context(), wsID)
		if err != nil {
			return err
		}
		prev, err := q.GetPendingEmailInvite(r.Context(), sqlc.GetPendingEmailInviteParams{WorkspaceID: wsID, Email: email})
		found := err == nil
		if err != nil && !db.IsNotFound(err) {
			return err
		}
		if found {
			if wait := emailInviteResend - now.Sub(prev.LastSentAt); wait > 0 {
				e := httpx.RateLimited()
				e.Message = "this address was invited less than 24 hours ago"
				e.RetryAfter = time.Duration(math.Ceil(wait.Seconds())) * time.Second
				return e
			}
		}
		inv, err := q.CreateInvite(r.Context(), sqlc.CreateInviteParams{
			WorkspaceID: wsID, Code: code, CreatedBy: uid(r), MaxUses: 1, ExpiresAt: &expires,
		})
		if err != nil {
			return err
		}
		if found { // a new link replaces the old one (deleting the old invite last: FK cascade)
			if out, err = q.RenewEmailInvite(r.Context(), sqlc.RenewEmailInviteParams{
				ID: prev.ID, InviteID: inv.ID, Role: string(role), InvitedBy: uid(r), ExpiresAt: expires,
			}); err != nil {
				return err
			}
			if _, err := q.DeleteInvite(r.Context(), sqlc.DeleteInviteParams{ID: prev.InviteID, WorkspaceID: wsID}); err != nil {
				return err
			}
		} else {
			out, err = q.CreateEmailInvite(r.Context(), sqlc.CreateEmailInviteParams{
				WorkspaceID: wsID, Email: email, Role: string(role), InvitedBy: uid(r), InviteID: inv.ID, ExpiresAt: expires,
			})
			if db.UniqueViolation(err) != "" {
				return httpx.Conflict("this address is being invited right now")
			}
			if err != nil {
				return err
			}
		}
		inviter, locale := mailSender(r.Context(), q, actor, ws)
		return h.email.Mail.Enqueue(r.Context(), q, mail.Mail{
			// The invitee has no account (or its language is unknown to the inviter's
			// workspace): the inviter's language is the best guess.
			To: email, Template: mail.TemplateWorkspaceInvite, Locale: locale, Priority: mail.PriorityNotice, TTL: mail.MaxRetry,
			Params: mail.Params{
				"workspace": ws.Name, "inviter": inviter, "days": "7", "code": code,
				"url": strings.TrimRight(h.email.PublicURL, "/") + "/join/" + code,
			},
		})
	})
	if err != nil {
		return err
	}
	h.email.Mail.Wake()
	slog.InfoContext(r.Context(), "email invite sent", "workspace_id", wsID, "actor", uid(r), "email_ref", emailRef(email))
	httpx.Write(w, http.StatusCreated, &v1.CreateEmailInviteResponse{Invite: emailInvitePB(out)})
	return nil
}

func (h *Handlers) listEmailInvites(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireInvite(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListEmailInvites(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListEmailInvitesResponse{Invites: make([]*v1.EmailInvite, len(rows))}
	for i, e := range rows {
		out.Invites[i] = emailInvitePB(e)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (h *Handlers) deleteEmailInvite(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireInvite(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "inviteId", "invite")
	if err != nil {
		return err
	}
	e, err := h.db.Q.GetEmailInvite(r.Context(), sqlc.GetEmailInviteParams{ID: id, WorkspaceID: wsID})
	if db.IsNotFound(err) || (err == nil && e.AcceptedAt != nil) {
		return httpx.NotFound("invite")
	}
	if err != nil {
		return err
	}
	// Deleting the link cascades to the email invitation.
	if _, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteInvite(r.Context(), sqlc.DeleteInviteParams{ID: e.InviteID, WorkspaceID: wsID})
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// boundInvite applies an email invitation's binding to a join by code (ADR-0027): the
// caller's address must be the invited one (403 INVITE_EMAIL_MISMATCH) and confirmed (403
// EMAIL_NOT_VERIFIED: confirming it joins automatically). Returns the role to join with
// (member for plain links).
func boundInvite(ctx context.Context, q *sqlc.Queries, inv sqlc.WorkspaceInvite, u sqlc.User) (perm.Role, error) {
	ei, err := q.GetEmailInviteByInvite(ctx, inv.ID)
	if db.IsNotFound(err) {
		return perm.RoleMember, nil
	}
	if err != nil {
		return "", err
	}
	if u.Email == nil || !strings.EqualFold(*u.Email, ei.Email) {
		return "", auth.ErrInviteEmailMismatch()
	}
	if ei.AcceptedAt != nil {
		return "", auth.ErrInviteInvalid()
	}
	if err := auth.RequireVerified(u); err != nil {
		return "", err
	}
	if err := q.AcceptEmailInvite(ctx, ei.ID); err != nil {
		return "", err
	}
	return perm.Role(ei.Role), nil
}

// AcceptEmailInvites joins a user with a verified address to every workspace that has a
// live email invitation for it (ADR-0023: registering with an invited address and
// verifying it is enough, the link is not needed). Idempotent; errors are logged. Returns
// the joined workspaces.
func AcceptEmailInvites(ctx context.Context, d *db.DB, pl *plans.Service, pub events.Publisher, u sqlc.User) []uuid.UUID {
	// This is a separate, proof-free membership bootstrap after verification; it
	// acquires sorted workspace locks before user state, never the parent request's
	// already admitted global-user boundary.
	ctx = db.WithoutAdmission(ctx)
	if u.Email == nil || u.EmailVerifiedAt == nil || u.IsGuest {
		return nil
	}
	type join struct {
		ws sqlc.Workspace
		m  sqlc.WorkspaceMember
	}
	var joins []join
	err := d.Tx(ctx, func(q *sqlc.Queries) error {
		joins = joins[:0]
		rows, err := q.PendingEmailInvitesFor(ctx, *u.Email)
		if err != nil {
			return err
		}
		workspaceIDs := make([]uuid.UUID, 0, len(rows))
		for _, ei := range rows {
			workspaceIDs = append(workspaceIDs, ei.WorkspaceID)
		}
		slices.SortFunc(workspaceIDs, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
		for _, ws := range slices.Compact(workspaceIDs) {
			if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
				return err
			}
		}
		if _, err := q.LockIdentityUserShared(ctx, u.ID); err != nil {
			return err
		}
		current, err := q.GetUser(ctx, u.ID)
		if err != nil {
			return err
		}
		if current.DisabledAt != nil || current.IsGuest || current.IsBot || current.Email == nil || current.EmailVerifiedAt == nil || !strings.EqualFold(*current.Email, *u.Email) {
			return nil
		}
		u = current
		for _, ei := range rows {
			// Banned meanwhile (the ban revokes pending invitations, but an account can carry
			// another address) or suspended: the invitation stays unused.
			if err := moderation.CheckBan(ctx, q, ei.WorkspaceID, u.ID, u.Email); err != nil {
				if errors.Is(err, moderation.ErrBanned) {
					continue
				}
				return err
			}
			if err := moderation.CheckSuspended(ctx, q, ei.WorkspaceID); err != nil {
				if errors.Is(err, moderation.ErrSuspended) {
					continue
				}
				return err
			}
			// The plan has no seat left: the invitation stays pending (the link still works
			// once a seat frees up, and joining by it explains the limit).
			if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ei.WorkspaceID, UserID: u.ID}); db.IsNotFound(err) {
				if err := pl.Check(ctx, q, ei.WorkspaceID, plans.KindMembers, true); err != nil {
					if httpx.IsPlanLimit(err) {
						continue
					}
					return err
				}
			} else if err != nil {
				return err
			}
			if err := q.AcceptEmailInvite(ctx, ei.ID); err != nil {
				return err
			}
			if err := q.UseInvite(ctx, ei.InviteID); err != nil {
				return err
			}
			m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ei.WorkspaceID, UserID: u.ID, Role: ei.Role})
			if db.IsNotFound(err) {
				continue // already a member
			}
			if err != nil {
				return err
			}
			ws, err := q.GetWorkspace(ctx, ei.WorkspaceID)
			if err != nil {
				return err
			}
			joins = append(joins, join{ws, m})
		}
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "accept email invites", "user_id", u.ID, "err", err)
		return nil
	}
	ids := make([]uuid.UUID, 0, len(joins))
	for _, j := range joins {
		AnnounceJoin(ctx, d.Q, pl, pub, j.ws, j.m)
		ids = append(ids, j.ws.ID)
	}
	return ids
}
