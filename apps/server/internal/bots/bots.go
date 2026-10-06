// Package bots implements bots and the Bot API (ADR-0031): creating bots in a workspace,
// their tokens, adding them to other workspaces, the /api/bots/me endpoints of a bot
// (profile, commands, webhook), composer hints (bot commands of a room), blocking bots, and
// webhook delivery through an outbox (webhook.go).
//
// A bot is a user (users.is_bot) with the built-in member role; its rights come from roles
// and room overrides like anyone's. Authentication is auth.Service (bot tokens); which routes
// a bot may call is the app's route table.
package bots

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/webhook"
	"github.com/calaba/calaba/server/internal/workspaces"
)

// Limits.
const (
	MaxDescription = 512
	MaxCommands    = 100
	maxCommandDesc = 256
)

var (
	usernameRe = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)
	commandRe  = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
)

// Avatars stores an uploaded avatar of a user (files.Service): the pipeline of
// POST /api/me/avatar, which also publishes USER_UPDATE.
type Avatars interface {
	UploadAvatar(w http.ResponseWriter, r *http.Request, uid uuid.UUID) (sqlc.User, error)
}

// Service holds the bot use cases and the webhook worker.
type Service struct {
	db      *db.DB
	avatars Avatars
	redis   rueidis.Client
	auth    *auth.Service
	plans   *plans.Service
	events  events.Publisher
	box     *sealbox.Box
	hooks   hookCache
	wh      webhookWorker
}

// New creates the service. SetEvents must be called before serving (the publisher wraps the
// service: see Publisher).
func New(d *db.DB, r rueidis.Client, a *auth.Service, pl *plans.Service, secret []byte, o WebhookOptions) *Service {
	s := &Service{db: d, redis: r, auth: a, plans: pl, box: sealbox.New("calaba/bot-webhook/v1", secret)}
	s.wh = newWebhookWorker(o)
	s.wh.worker = webhook.NewWorker(queue{s}, s.wh.tr, r, lockKey, s.wh.opts)
	return s
}

// SetAuth sets the auth service (token changes); it is built after the publisher.
func (s *Service) SetAuth(a *auth.Service) { s.auth = a }

// SetAvatars sets the avatar store (the files service is built after the bots service).
func (s *Service) SetAvatars(a Avatars) { s.avatars = a }

// SetEvents sets the publisher of the service's own events (BOT_*, membership).
func (s *Service) SetEvents(p events.Publisher) { s.events = p }

// Routes registers the authenticated routes; wrap must apply auth + perm resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	handle := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(f)) }
	handle("POST /api/workspaces/{id}/bots", s.create)
	handle("GET /api/workspaces/{id}/bots", s.list)
	handle("POST /api/workspaces/{id}/bots/add", s.add)
	handle("DELETE /api/workspaces/{id}/bots/{botId}", s.remove)
	handle("POST /api/workspaces/{id}/bots/{botId}/token", s.reissue)
	handle("DELETE /api/workspaces/{id}/bots/{botId}/token", s.revoke)
	handle("POST /api/workspaces/{id}/bots/{botId}/avatar", s.setAvatar)
	handle("DELETE /api/workspaces/{id}/bots/{botId}/avatar", s.clearAvatar)
	handle("GET /api/bots/{ref}", s.profile)
	handle("GET /api/bots/me", s.me)
	handle("PATCH /api/bots/me", s.updateMe)
	handle("PUT /api/bots/me/commands", s.setCommands)
	handle("GET /api/bots/me/webhook", s.getWebhook)
	handle("PUT /api/bots/me/webhook", s.setWebhook)
	handle("DELETE /api/bots/me/webhook", s.deleteWebhook)
	handle("GET /api/rooms/{id}/bot-commands", s.roomCommands)
	handle("GET /api/me/blocked-bots", s.listBlocked)
	handle("POST /api/me/blocked-bots/{id}", s.block)
	handle("DELETE /api/me/blocked-bots/{id}", s.unblock)
}

func identity(r *http.Request) auth.Identity { return auth.MustFromContext(r.Context()) }

// ---- conversion ----

// BotPB converts a bot. manage adds what only the bot, its owner and the managers of its home
// workspace see: the webhook state and the token prefix.
func BotPB(b sqlc.Bot, u sqlc.User, cmds []sqlc.BotCommand, manage bool) *v1.Bot {
	out := &v1.Bot{
		User: pbconv.User(u), Username: b.Username, OwnerUserId: b.OwnerUserID.String(), WorkspaceId: b.WorkspaceID.String(),
		Description: b.Description, CreatedAt: timestamppb.New(b.CreatedAt),
		Commands: make([]*v1.BotCommand, 0, len(cmds)),
	}
	if manage {
		out.TokenPrefix = b.TokenPrefix
	}
	if b.RevokedAt != nil {
		out.RevokedAt = timestamppb.New(*b.RevokedAt)
	}
	for _, c := range cmds {
		out.Commands = append(out.Commands, &v1.BotCommand{Name: c.Name, Description: c.Description})
	}
	if manage {
		out.Webhook = webhookPB(b)
	}
	return out
}

func webhookPB(b sqlc.Bot) *v1.BotWebhook {
	w := &v1.BotWebhook{LastError: b.WebhookLastError}
	if b.WebhookUrl != nil {
		w.Url = *b.WebhookUrl
		w.Enabled = b.WebhookDisabledAt == nil
	}
	if b.WebhookDisabledAt != nil {
		w.DisabledAt = timestamppb.New(*b.WebhookDisabledAt)
	}
	if b.WebhookFailingSince != nil {
		w.FailingSince = timestamppb.New(*b.WebhookFailingSince)
	}
	if b.WebhookLastOkAt != nil {
		w.LastOkAt = timestamppb.New(*b.WebhookLastOkAt)
	}
	return w
}

// load returns a bot with its account and commands.
func (s *Service) load(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (sqlc.Bot, sqlc.User, []sqlc.BotCommand, error) {
	row, err := q.GetBotWithUser(ctx, id)
	if err != nil {
		return sqlc.Bot{}, sqlc.User{}, nil, err
	}
	cmds, err := q.ListBotCommands(ctx, []uuid.UUID{id})
	return row.Bot, row.User, cmds, err
}

func (s *Service) pb(ctx context.Context, id uuid.UUID, webhook bool) (*v1.Bot, error) {
	b, u, cmds, err := s.load(ctx, s.db.Q, id)
	if err != nil {
		return nil, err
	}
	return BotPB(b, u, cmds, webhook), nil
}

// publish sends BOT_CREATE / BOT_UPDATE / BOT_DELETE to the workspace (the gateway gives it
// to MANAGE_BOTS members and the bot's owner) and BOT_UPDATE to the owner's devices
// when the owner may not be a member there.
func (s *Service) publish(ctx context.Context, wsID uuid.UUID, ev *v1.DispatchEvent) {
	s.events.Workspace(ctx, wsID, ev)
}

// announce publishes BOT_UPDATE of a bot to every workspace it is a member of and to its
// owner (webhook state changes, token changes, profile).
func (s *Service) announce(ctx context.Context, id uuid.UUID) {
	b, u, cmds, err := s.load(ctx, s.db.Q, id)
	if err != nil {
		return
	}
	wids, err := s.db.Q.ListUserWorkspaceIDs(ctx, id)
	if err != nil {
		return
	}
	for _, w := range wids {
		s.publish(ctx, w, &v1.DispatchEvent{Event: &v1.DispatchEvent_BotUpdate{BotUpdate: &v1.BotUpdate{
			WorkspaceId: w.String(), Bot: BotPB(b, u, cmds, w == b.WorkspaceID),
		}}})
	}
	s.events.User(ctx, b.OwnerUserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BotUpdate{BotUpdate: &v1.BotUpdate{
		WorkspaceId: b.WorkspaceID.String(), Bot: BotPB(b, u, cmds, true),
	}}})
}

// ---- workspace management (people) ----

// manager returns the caller's workspace access; MANAGE_BOTS (ADR-0048) is required unless the
// caller owns bot (ownerOf non-nil).
func manager(r *http.Request, ownerOf *sqlc.Bot) (uuid.UUID, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, identity(r).UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if (bits.Has(perm.ManageBots) && role != perm.RoleGuest) || (ownerOf != nil && ownerOf.OwnerUserID == identity(r).UserID) {
		return wsID, nil
	}
	return uuid.Nil, httpx.Forbidden("MANAGE_BOTS required")
}

// checkPlan refuses one more bot above the plan limits (ADR-0024): the bots limit and, as a
// bot takes a seat, the members limit. Locks bots before members (joins take only the latter).
func (s *Service) checkPlan(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) error {
	if err := s.plans.Check(ctx, q, wsID, plans.KindBots, true); err != nil {
		return err
	}
	return s.plans.Check(ctx, q, wsID, plans.KindMembers, true)
}

func validateUsername(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if !usernameRe.MatchString(s) {
		return "", httpx.Validation("username", "username must be 3..32 characters of a-z, 0-9 and _")
	}
	return s, nil
}

func validateDescription(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > MaxDescription {
		return "", httpx.Validation("description", "description must be at most 512 characters")
	}
	return s, nil
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manager(r, nil)
	if err != nil {
		return err
	}
	me := identity(r).UserID
	if _, err := s.auth.EmailGate().User(r.Context(), s.db.Q, me); err != nil {
		return err
	}
	var req v1.CreateBotRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := auth.ValidateDisplayName(req.GetDisplayName())
	if err != nil {
		return err
	}
	username, err := validateUsername(req.GetUsername())
	if err != nil {
		return err
	}
	desc, err := validateDescription(req.GetDescription())
	if err != nil {
		return err
	}
	settings, err := pbconv.EncodeSettings(pbconv.DefaultSettings())
	if err != nil {
		return err
	}
	var (
		ws    sqlc.Workspace
		m     sqlc.WorkspaceMember
		botID uuid.UUID
		token string
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if ws, err = q.GetWorkspace(r.Context(), wsID); err != nil {
			return err
		}
		if err := s.checkPlan(r.Context(), q, wsID); err != nil {
			return err
		}
		u, err := q.CreateBotUser(r.Context(), sqlc.CreateBotUserParams{DisplayName: name, Settings: settings, Username: username})
		if db.UniqueViolation(err) != "" { // a person's nickname (ADR-0077: one namespace)
			return httpx.Conflict("username is taken")
		}
		if err != nil {
			return err
		}
		botID = u.ID
		tok, hash, prefix, err := auth.NewBotToken(botID)
		if err != nil {
			return err
		}
		token = tok
		tid := uuid.New()
		_, err = q.CreateBot(r.Context(), sqlc.CreateBotParams{
			UserID: botID, OwnerUserID: me, WorkspaceID: wsID, Username: username, Description: desc,
			TokenID: &tid, TokenHash: hash, TokenPrefix: prefix,
		})
		if db.UniqueViolation(err) != "" {
			return httpx.Conflict("username is taken")
		}
		if err != nil {
			return err
		}
		m, err = q.AddMember(r.Context(), sqlc.AddMemberParams{WorkspaceID: wsID, UserID: botID, Role: string(perm.RoleMember)})
		return err
	})
	if err != nil {
		return err
	}
	s.hooks.invalidate()
	workspaces.AnnounceJoin(r.Context(), s.db.Q, s.plans, s.events, ws, m)
	pb, err := s.pb(r.Context(), botID, true)
	if err != nil {
		return err
	}
	s.publish(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BotCreate{BotCreate: &v1.BotCreate{WorkspaceId: wsID.String(), Bot: pb}}})
	httpx.Write(w, http.StatusCreated, &v1.CreateBotResponse{Bot: pb, Token: token})
	return nil
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manager(r, nil)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListWorkspaceBots(r.Context(), wsID)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, row := range rows {
		ids[i] = row.Bot.UserID
	}
	cmds, err := s.db.Q.ListBotCommands(r.Context(), ids)
	if err != nil {
		return err
	}
	by := map[uuid.UUID][]sqlc.BotCommand{}
	for _, c := range cmds {
		by[c.BotUserID] = append(by[c.BotUserID], c)
	}
	out := &v1.ListBotsResponse{Bots: make([]*v1.Bot, 0, len(rows))}
	for _, row := range rows {
		out.Bots = append(out.Bots, BotPB(row.Bot, row.User, by[row.Bot.UserID], row.Bot.WorkspaceID == wsID))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// botInPath loads the {botId} bot; 404 unless it is a member of the workspace {id}.
func (s *Service) botInPath(r *http.Request) (sqlc.Bot, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return sqlc.Bot{}, err
	}
	id, err := httpx.PathUUID(r, "botId", "bot")
	if err != nil {
		return sqlc.Bot{}, err
	}
	b, err := s.db.Q.GetBot(r.Context(), id)
	if db.IsNotFound(err) {
		return b, httpx.NotFound("bot")
	}
	if err != nil {
		return b, err
	}
	if _, err := s.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: id}); db.IsNotFound(err) {
		return b, httpx.NotFound("bot")
	} else if err != nil {
		return b, err
	}
	return b, nil
}

// homeBot is botInPath for token and deletion routes of the bot's home workspace: the bot's
// owner or MANAGE_BOTS there.
func (s *Service) homeBot(r *http.Request) (sqlc.Bot, error) {
	b, err := s.botInPath(r)
	if err != nil {
		return b, err
	}
	wsID, err := manager(r, &b)
	if err != nil {
		return b, err
	}
	if wsID != b.WorkspaceID {
		return b, httpx.Forbidden("the bot is managed in the workspace where it was created")
	}
	return b, nil
}

func (s *Service) reissue(w http.ResponseWriter, r *http.Request) error {
	b, err := s.homeBot(r)
	if err != nil {
		return err
	}
	tok, hash, prefix, err := auth.NewBotToken(b.UserID)
	if err != nil {
		return err
	}
	tid := uuid.New()
	var old *uuid.UUID
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetBotForUpdate(r.Context(), b.UserID)
		if err != nil {
			return err
		}
		old = cur.TokenID
		_, err = q.SetBotToken(r.Context(), sqlc.SetBotTokenParams{UserID: b.UserID, TokenID: &tid, TokenHash: hash, TokenPrefix: prefix})
		return err
	})
	if err != nil {
		return err
	}
	s.auth.BotTokenChanged(r.Context(), b.UserID, old)
	s.hooks.invalidate()
	s.announce(r.Context(), b.UserID)
	pb, err := s.pb(r.Context(), b.UserID, true)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ReissueBotTokenResponse{Bot: pb, Token: tok})
	return nil
}

func (s *Service) revoke(w http.ResponseWriter, r *http.Request) error {
	b, err := s.homeBot(r)
	if err != nil {
		return err
	}
	var old *uuid.UUID
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetBotForUpdate(r.Context(), b.UserID)
		if err != nil {
			return err
		}
		old = cur.TokenID
		_, err = q.RevokeBotToken(r.Context(), b.UserID)
		return err
	})
	if err != nil {
		return err
	}
	s.auth.BotTokenChanged(r.Context(), b.UserID, old)
	s.hooks.invalidate()
	s.announce(r.Context(), b.UserID)
	httpx.NoContent(w)
	return nil
}

// setAvatar stores the multipart "file" as the bot's avatar (docs/09 #87); homeBot rules.
func (s *Service) setAvatar(w http.ResponseWriter, r *http.Request) error {
	b, err := s.homeBot(r)
	if err != nil {
		return err
	}
	if _, err := s.avatars.UploadAvatar(w, r, b.UserID); err != nil {
		return err
	}
	return s.avatarChanged(w, r, b.UserID)
}

// clearAvatar removes the bot's avatar; the file is left to the orphan cleanup.
func (s *Service) clearAvatar(w http.ResponseWriter, r *http.Request) error {
	b, err := s.homeBot(r)
	if err != nil {
		return err
	}
	u, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.User, error) {
		return guarded.UpdateUser(r.Context(), sqlc.UpdateUserParams{ID: b.UserID, SetAvatar: true})
	})
	if err != nil {
		return err
	}
	profile.Publish(r.Context(), s.db.Q, s.events, u, true)
	return s.avatarChanged(w, r, b.UserID)
}

// avatarChanged sends BOT_UPDATE (bot lists of the managers) and answers with the bot.
func (s *Service) avatarChanged(w http.ResponseWriter, r *http.Request, id uuid.UUID) error {
	s.announce(r.Context(), id)
	pb, err := s.pb(r.Context(), id, true)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SetBotAvatarResponse{Bot: pb})
	return nil
}

// remove: in the bot's home workspace the bot is deleted (token dead, removed from every
// workspace and call, account disabled; its messages stay); elsewhere it only leaves that
// workspace (MANAGE_BOTS there).
func (s *Service) remove(w http.ResponseWriter, r *http.Request) error {
	b, err := s.botInPath(r)
	if err != nil {
		return err
	}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if wsID != b.WorkspaceID {
		// Added elsewhere: that workspace's managers remove it (the owner manages it at home).
		if _, err := manager(r, nil); err != nil {
			return err
		}
		err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
			if _, err := q.RemoveMember(r.Context(), sqlc.RemoveMemberParams{WorkspaceID: wsID, UserID: b.UserID}); err != nil {
				return err
			}
			return q.DeleteUserOverridesInWorkspace(r.Context(), sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: wsID, UserID: b.UserID.String()})
		})
		if err != nil {
			return err
		}
		perm.FromContext(r.Context()).Invalidate()
		s.hooks.invalidate()
		s.left(r.Context(), wsID, b.UserID)
		httpx.NoContent(w)
		return nil
	}
	if _, err := manager(r, &b); err != nil {
		return err
	}
	var (
		wids []uuid.UUID
		old  *uuid.UUID
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetBotForUpdate(r.Context(), b.UserID)
		if err != nil {
			return err
		}
		old = cur.TokenID
		if wids, err = q.RemoveUserEverywhere(r.Context(), b.UserID); err != nil {
			return err
		}
		if err := q.DeleteUserOverridesEverywhere(r.Context(), b.UserID.String()); err != nil {
			return err
		}
		if err := q.DeleteBot(r.Context(), b.UserID); err != nil {
			return err
		}
		if err := q.ClearUsername(r.Context(), b.UserID); err != nil { // frees it (ADR-0077)
			return err
		}
		return q.DisableUser(r.Context(), b.UserID)
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	s.auth.BotTokenChanged(r.Context(), b.UserID, old)
	s.hooks.invalidate()
	for _, wid := range wids {
		s.left(r.Context(), wid, b.UserID)
	}
	httpx.NoContent(w)
	return nil
}

// left publishes that a bot left a workspace: member removal (LiveKit participants are
// removed by rtc.SyncPublisher), WORKSPACE_DELETE to the bot's socket, BOT_DELETE.
func (s *Service) left(ctx context.Context, wsID, bot uuid.UUID) {
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
		WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wsID.String(), UserId: bot.String()},
	}})
	s.events.User(ctx, bot, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
		WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: wsID.String()},
	}})
	s.publish(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BotDelete{BotDelete: &v1.BotDelete{
		WorkspaceId: wsID.String(), BotUserId: bot.String(),
	}}})
}

// findBot resolves a bot by id or username; live bots only.
func (s *Service) findBot(ctx context.Context, ref string) (sqlc.Bot, sqlc.User, error) {
	var (
		row sqlc.GetBotWithUserRow
		err error
	)
	if id, perr := uuid.Parse(ref); perr == nil {
		row, err = s.db.Q.GetBotWithUser(ctx, id)
	} else {
		var r2 sqlc.GetBotByUsernameRow
		r2, err = s.db.Q.GetBotByUsername(ctx, strings.ToLower(strings.TrimSpace(ref)))
		row = sqlc.GetBotWithUserRow(r2)
	}
	if db.IsNotFound(err) || (err == nil && row.User.DisabledAt != nil) {
		return sqlc.Bot{}, sqlc.User{}, httpx.NotFound("bot")
	}
	return row.Bot, row.User, err
}

// add: POST /api/workspaces/{id}/bots/add — an admin adds an existing bot (member role).
func (s *Service) add(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manager(r, nil)
	if err != nil {
		return err
	}
	var req v1.AddBotRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ref := req.GetBotUserId()
	if ref == "" {
		ref = req.GetUsername()
	}
	b, u, err := s.findBot(r.Context(), ref)
	if err != nil {
		return err
	}
	var (
		ws sqlc.Workspace
		m  sqlc.WorkspaceMember
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if ws, err = q.GetWorkspace(r.Context(), wsID); err != nil {
			return err
		}
		if err := moderation.CheckBan(r.Context(), q, wsID, b.UserID, nil); err != nil {
			return err
		}
		if err := s.checkPlan(r.Context(), q, wsID); err != nil {
			return err
		}
		m, err = q.AddMember(r.Context(), sqlc.AddMemberParams{WorkspaceID: wsID, UserID: b.UserID, Role: string(perm.RoleMember)})
		if db.IsNotFound(err) {
			return httpx.Conflict("the bot is already a member")
		}
		return err
	})
	if err != nil {
		return err
	}
	s.hooks.invalidate()
	workspaces.AnnounceJoin(r.Context(), s.db.Q, s.plans, s.events, ws, m)
	cmds, err := s.db.Q.ListBotCommands(r.Context(), []uuid.UUID{b.UserID})
	if err != nil {
		return err
	}
	pb := BotPB(b, u, cmds, false)
	s.publish(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BotCreate{BotCreate: &v1.BotCreate{WorkspaceId: wsID.String(), Bot: pb}}})
	httpx.Write(w, http.StatusCreated, &v1.AddBotResponse{Bot: pb})
	return nil
}

// profile: GET /api/bots/{ref} (id or username) — the public card of a bot ("Add bot").
func (s *Service) profile(w http.ResponseWriter, r *http.Request) error {
	b, u, err := s.findBot(r.Context(), r.PathValue("ref"))
	if err != nil {
		return err
	}
	cmds, err := s.db.Q.ListBotCommands(r.Context(), []uuid.UUID{b.UserID})
	if err != nil {
		return err
	}
	pb := BotPB(b, u, cmds, false)
	pb.OwnerUserId, pb.WorkspaceId = "", "" // the card does not reveal where the bot lives
	httpx.Write(w, http.StatusOK, &v1.GetBotMeResponse{Bot: pb})
	return nil
}

// ---- the bot itself ----

func (s *Service) me(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	pb, err := s.pb(r.Context(), identity(r).UserID, true)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetBotMeResponse{Bot: pb})
	return nil
}

func (s *Service) updateMe(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	var req v1.UpdateBotMeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var name *string
	if req.DisplayName != nil {
		n, err := auth.ValidateDisplayName(req.GetDisplayName())
		if err != nil {
			return err
		}
		name = &n
	}
	var desc *string
	if req.Description != nil {
		d, err := validateDescription(req.GetDescription())
		if err != nil {
			return err
		}
		desc = &d
	}
	var u sqlc.User
	err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if name != nil {
			if u, err = q.UpdateUser(r.Context(), sqlc.UpdateUserParams{ID: id, DisplayName: name}); err != nil {
				return err
			}
		}
		if desc != nil {
			_, err = q.UpdateBotDescription(r.Context(), sqlc.UpdateBotDescriptionParams{UserID: id, Description: *desc})
		}
		return err
	})
	if err != nil {
		return err
	}
	if name != nil { // the public profile changed: like PATCH /api/me
		if wids, err := s.db.Q.ListUserWorkspaceIDs(r.Context(), id); err == nil && len(wids) > 0 {
			s.events.Workspaces(r.Context(), wids, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{User: pbconv.User(u)}}})
		}
	}
	s.announce(r.Context(), id)
	pb, err := s.pb(r.Context(), id, true)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetBotMeResponse{Bot: pb})
	return nil
}

func (s *Service) setCommands(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	var req v1.SetBotCommandsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if len(req.GetCommands()) > MaxCommands {
		return httpx.Validation("commands", "at most 100 commands")
	}
	p := sqlc.InsertBotCommandsParams{BotUserID: id}
	seen := map[string]bool{}
	for i, c := range req.GetCommands() {
		name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(c.GetName()), "/"))
		if !commandRe.MatchString(name) || seen[name] {
			return httpx.Validation("commands", "command names must be unique, 1..32 characters of a-z, 0-9 and _")
		}
		desc := strings.TrimSpace(c.GetDescription())
		if utf8.RuneCountInString(desc) > maxCommandDesc {
			return httpx.Validation("commands", "command descriptions must be at most 256 characters")
		}
		seen[name] = true
		p.Names = append(p.Names, name)
		p.Descriptions = append(p.Descriptions, desc)
		p.Positions = append(p.Positions, int16(i)) //nolint:gosec // ≤ 100
	}
	err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.DeleteBotCommands(r.Context(), id); err != nil {
			return err
		}
		if len(p.Names) == 0 {
			return nil
		}
		return q.InsertBotCommands(r.Context(), p)
	})
	if err != nil {
		return err
	}
	cmds, err := s.db.Q.ListBotCommands(r.Context(), []uuid.UUID{id})
	if err != nil {
		return err
	}
	s.announce(r.Context(), id)
	out := &v1.SetBotCommandsResponse{Commands: make([]*v1.BotCommand, 0, len(cmds))}
	for _, c := range cmds {
		out.Commands = append(out.Commands, &v1.BotCommand{Name: c.Name, Description: c.Description})
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// roomCommands: GET /api/rooms/{id}/bot-commands (VIEW_ROOM) — commands of the bots that
// can view the room (DM: the other participant, if it is a bot).
func (s *Service) roomCommands(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	type cand struct {
		id       uuid.UUID
		username string
	}
	var cands []cand
	if acc.DM {
		for _, u := range acc.Members {
			if u == identity(r).UserID {
				continue
			}
			if b, err := s.db.Q.GetBot(r.Context(), u); err == nil && b.TokenHash != nil {
				cands = append(cands, cand{b.UserID, b.Username})
			} else if err != nil && !db.IsNotFound(err) {
				return err
			}
		}
	} else {
		rows, err := s.db.Q.ListWorkspaceBotIDs(r.Context(), acc.WorkspaceID)
		if err != nil {
			return err
		}
		res := perm.NewResolver(s.db.Q)
		for _, row := range rows {
			if a, err := res.Room(r.Context(), roomID, row.UserID); err == nil && a.Bits.Has(perm.ViewRoom) {
				cands = append(cands, cand{row.UserID, row.Username})
			}
		}
	}
	ids := make([]uuid.UUID, len(cands))
	for i, c := range cands {
		ids[i] = c.id
	}
	cmds, err := s.db.Q.ListBotCommands(r.Context(), ids)
	if err != nil {
		return err
	}
	by := map[uuid.UUID][]*v1.BotCommand{}
	for _, c := range cmds {
		by[c.BotUserID] = append(by[c.BotUserID], &v1.BotCommand{Name: c.Name, Description: c.Description})
	}
	out := &v1.ListRoomBotCommandsResponse{Bots: []*v1.RoomBotCommands{}}
	for _, c := range cands {
		if len(by[c.id]) > 0 {
			out.Bots = append(out.Bots, &v1.RoomBotCommands{BotUserId: c.id.String(), Username: c.username, Commands: by[c.id]})
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ---- blocking (people) ----

func (s *Service) listBlocked(w http.ResponseWriter, r *http.Request) error {
	ids, err := s.db.Q.ListBlockedBots(r.Context(), identity(r).UserID)
	if err != nil {
		return err
	}
	out := &v1.ListBlockedBotsResponse{BotUserIds: make([]string, len(ids))}
	for i, id := range ids {
		out.BotUserIds[i] = id.String()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) block(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "bot")
	if err != nil {
		return err
	}
	u, err := s.db.Q.GetUser(r.Context(), id)
	if db.IsNotFound(err) || (err == nil && !u.IsBot) {
		return httpx.NotFound("bot")
	}
	if err != nil {
		return err
	}
	if err := db.GuardExec(r.Context(), s.db, func(guarded *sqlc.Queries) error {
		return guarded.BlockBot(r.Context(), sqlc.BlockBotParams{UserID: identity(r).UserID, BotUserID: id})
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) unblock(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "bot")
	if err != nil {
		return err
	}
	if err := db.GuardExec(r.Context(), s.db, func(guarded *sqlc.Queries) error {
		return guarded.UnblockBot(r.Context(), sqlc.UnblockBotParams{UserID: identity(r).UserID, BotUserID: id})
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// now is a seam for tests of the webhook worker.
var now = time.Now
