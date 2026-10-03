package achievements

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// requireManage: MANAGE_MEMBERS in the workspace (guests never, ADR-0048).
func requireManage(r *http.Request) (uuid.UUID, error) {
	wsID, bits, role, err := access(r)
	if err != nil {
		return uuid.Nil, err
	}
	if !bits.Has(perm.ManageMembers) || role == perm.RoleGuest {
		return uuid.Nil, httpx.Forbidden("MANAGE_MEMBERS required")
	}
	return wsID, nil
}

// targetUser resolves {userId}; "@me" is the caller.
func targetUser(r *http.Request) (uuid.UUID, error) {
	if strings.EqualFold(r.PathValue("userId"), "@me") {
		return auth.MustFromContext(r.Context()).UserID, nil
	}
	return httpx.PathUUID(r, "userId", "member")
}

// list: GET /api/workspaces/{id}/members/{userId}/achievements — the member's live grants.
func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	if role == perm.RoleGuest { // the profile rule (ADR-0051): only the members visible to the guest
		allowed, err := rooms.GuestVisibleUsers(ctx, s.db.Q, s.voice, wsID, auth.MustFromContext(ctx).UserID)
		if err != nil {
			return err
		}
		if !allowed[target] {
			return httpx.NotFound("member")
		}
	}
	if _, err := s.db.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target}); db.IsNotFound(err) {
		return httpx.NotFound("member")
	} else if err != nil {
		return err
	}
	rows, err := s.db.Q.ListMemberAchievements(ctx, sqlc.ListMemberAchievementsParams{WorkspaceID: wsID, UserID: target})
	if err != nil {
		return err
	}
	out := &v1.ListMemberAchievementsResponse{Items: make([]*v1.MemberAchievement, len(rows))}
	for i, row := range rows {
		out.Items[i] = GrantProto(row.MemberAchievement, row.CardRoomID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// grant: POST /api/workspaces/{id}/members/{userId}/achievements.
func (s *Service) grant(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := requireManage(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	var req v1.GrantAchievementRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	note, err := text("note", req.GetNote(), 1, maxNote)
	if err != nil {
		return err
	}
	achID, err := uuid.Parse(req.GetAchievementId())
	if err != nil {
		return httpx.Validation("achievementId", "unknown achievement")
	}
	me := auth.MustFromContext(ctx).UserID
	if target == me {
		return httpx.Validation("userId", "you cannot grant an achievement to yourself").WithDetails(ReasonSelfGrant, 0, 0)
	}
	u, err := s.db.Q.GetUser(ctx, target)
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	if u.IsBot {
		return httpx.Validation("userId", "bots do not get achievements")
	}
	var (
		g      sqlc.MemberAchievement
		member sqlc.WorkspaceMember
		msg    *sqlc.Message
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
		if db.IsNotFound(err) {
			return httpx.NotFound("member")
		}
		if err != nil {
			return err
		}
		if perm.Role(m.Role) == perm.RoleGuest {
			return httpx.Validation("userId", "guests do not get achievements")
		}
		a, err := q.LockAchievement(ctx, achID)
		if db.IsNotFound(err) || (err == nil && a.WorkspaceID != wsID) { // another workspace's: unknown here
			return httpx.Validation("achievementId", "unknown achievement")
		}
		if err != nil {
			return err
		}
		if a.ArchivedAt != nil {
			return httpx.Validation("achievementId", "the achievement is archived").WithDetails(ReasonArchived, 0, 0)
		}
		if g, err = q.InsertMemberAchievement(ctx, sqlc.InsertMemberAchievementParams{
			WorkspaceID: wsID, UserID: target, AchievementID: achID, GrantedBy: &me, Note: note,
		}); err != nil {
			return err
		}
		if req.GetAnnounce() {
			if msg, err = s.postCard(ctx, q, wsID, g); err != nil {
				return err
			}
			if msg != nil {
				g.MessageID = &msg.ID
			}
		}
		member, err = q.RecountMemberAchievements(ctx, sqlc.RecountMemberAchievementsParams{WorkspaceID: wsID, UserID: target})
		if db.IsNotFound(err) {
			return httpx.NotFound("member")
		}
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "achievement granted", "workspace", wsID, "user", target, "by", me, "achievement", achID,
		"grant", g.ID, "card", msg != nil)
	var room *uuid.UUID
	if msg != nil {
		room = &msg.RoomID
		if err := s.system.Created(ctx, wsID, *msg); err != nil {
			slog.WarnContext(ctx, "achievement card event", "message", msg.ID, "err", err)
		}
	}
	s.memberUpdated(ctx, member, u)
	httpx.Write(w, http.StatusCreated, GrantProto(g, room))
	return nil
}

// postCard writes the grant's card into the announcement room (none: nil), mentioning the
// recipient, inside the grant's transaction.
func (s *Service) postCard(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, g sqlc.MemberAchievement) (*sqlc.Message, error) {
	roomID, err := q.GetAnnouncementRoom(ctx, wsID)
	if db.IsNotFound(err) {
		return nil, nil // no text room: the grant goes without a card
	}
	if err != nil {
		return nil, err
	}
	card := &v1.AchievementCard{AchievementId: g.AchievementID.String(), GrantId: g.ID.String(), Note: g.Note}
	if g.GrantedBy != nil {
		card.GrantedBy = g.GrantedBy.String()
	}
	payload, err := protojson.Marshal(&v1.SystemMessage{Payload: &v1.SystemMessage_Achievement{Achievement: card}})
	if err != nil {
		return nil, err
	}
	m, err := q.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: roomID, AuthorID: g.UserID, Payload: payload})
	if err != nil {
		return nil, err
	}
	if err := q.SetMemberAchievementMessage(ctx, sqlc.SetMemberAchievementMessageParams{ID: g.ID, MessageID: &m.ID}); err != nil {
		return nil, err
	}
	// The card is about the recipient: it reaches them as an @-mention (inbox, counters, push).
	// messages.saveMentions parses text and never mentions the author, so the row is direct.
	if err := q.InsertCardMention(ctx, sqlc.InsertCardMentionParams{
		UserID: g.UserID, MessageID: m.ID, RoomID: m.RoomID, WorkspaceID: wsID,
	}); err != nil {
		return nil, err
	}
	return &m, nil
}

// revoke: DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}.
func (s *Service) revoke(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := requireManage(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	grantID, err := httpx.PathUUID(r, "grantId", "achievement")
	if err != nil {
		return err
	}
	me := auth.MustFromContext(ctx).UserID
	var member sqlc.WorkspaceMember
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.RevokeMemberAchievement(ctx, sqlc.RevokeMemberAchievementParams{
			RevokedBy: &me, ID: grantID, WorkspaceID: wsID, UserID: target,
		}); db.IsNotFound(err) {
			return httpx.NotFound("achievement")
		} else if err != nil {
			return err
		}
		member, err = q.RecountMemberAchievements(ctx, sqlc.RecountMemberAchievementsParams{WorkspaceID: wsID, UserID: target})
		if db.IsNotFound(err) {
			return httpx.NotFound("member")
		}
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "achievement revoked", "workspace", wsID, "user", target, "by", me, "grant", grantID)
	if u, err := s.db.Q.GetUser(ctx, target); err == nil {
		s.memberUpdated(ctx, member, u)
	} else {
		slog.WarnContext(ctx, "achievement revoke event", "user", target, "err", err)
	}
	httpx.NoContent(w)
	return nil
}

// memberUpdated publishes WORKSPACE_MEMBER_UPDATE with the new achievement_count.
func (s *Service) memberUpdated(ctx context.Context, m sqlc.WorkspaceMember, u sqlc.User) {
	ids, err := s.db.Q.ListMemberRoleIDs(ctx, sqlc.ListMemberRoleIDsParams{WorkspaceID: m.WorkspaceID, UserID: m.UserID})
	if err != nil {
		slog.WarnContext(ctx, "achievement member event", "user", m.UserID, "err", err)
		return
	}
	s.events.Workspace(ctx, m.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
		WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pbconv.Member(m, u, ids)}}})
}
