package push

import (
	"context"
	"errors"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/google/uuid"
)

const (
	messageKind int16 = 1
	callKind    int16 = 2
)

var kindNames = map[int16]string{messageKind: "message", callKind: "call"}

func dnd(u sqlc.User, now time.Time) bool {
	return u.PresenceStatus != nil && v1.PresenceStatus(*u.PresenceStatus) == v1.PresenceStatus_PRESENCE_STATUS_DND && (u.PresenceUntil == nil || u.PresenceUntil.After(now))
}
func (s *Service) allowed(ctx context.Context, q *sqlc.Queries, u sqlc.User, session sqlc.Session, job sqlc.PushDelivery) (bool, bool, error) {
	return s.allowedPolicy(ctx, q, u, session, job, false)
}

// Resolution may describe an already accepted call for same-device reconciliation.
// Dispatch must still require RINGING; resolution alone never authorizes an accept.
func (s *Service) allowedPolicy(ctx context.Context, q *sqlc.Queries, u sqlc.User, session sqlc.Session, job sqlc.PushDelivery, resolving bool) (bool, bool, error) {
	now := time.Now()
	quiet := dnd(u, now)
	clock, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return false, false, err
	}
	if clock.After(now) {
		now = clock
	}
	principal := auth.SessionPrincipal(session)
	if principal.UserID != u.ID || !identitypolicy.CheckGlobal(now, principal, identitypolicy.GlobalRead, false).Allowed {
		return false, false, nil
	}
	if u.DisabledAt != nil || u.IsBot || u.IsGuest || !job.ExpiresAt.After(now) {
		return false, false, nil
	}
	switch job.Kind {
	case messageKind:
		if quiet {
			return false, false, nil
		}
		msg, err := q.GetMessage(ctx, job.ReferenceID)
		if err != nil {
			return false, false, err
		}
		if msg.DeletedAt != nil || msg.AuthorID == u.ID || job.RoomID == nil || msg.RoomID != *job.RoomID {
			return false, false, nil
		}
		workspace, err := q.GetIdentityRoomParent(ctx, msg.RoomID)
		if err != nil {
			return false, false, err
		}
		if workspace != nil {
			if s.Auth == nil {
				return false, false, nil
			}
			decision, err := s.Auth.CheckWorkspaceDecisionInTx(ctx, q, auth.Identity{UserID: u.ID, SessionID: session.ID, Principal: principal}, *workspace, identitypolicy.WorkspaceRead)
			if errors.Is(err, identitypolicy.ErrDenied) || err == nil && !decision.Allowed {
				return false, false, nil
			}
			if err != nil {
				return false, false, err
			}
		}
		acc, err := perm.NewResolver(q).Room(ctx, msg.RoomID, u.ID)
		if err != nil {
			return false, false, accessError(err)
		}
		if !acc.Bits.Has(perm.ViewRoom) || acc.Task || acc.Notes {
			return false, false, nil
		}
		facts, err := q.PushMessageFacts(ctx, sqlc.PushMessageFactsParams{MessageID: msg.ID, UserID: u.ID, RoomID: msg.RoomID, WorkspaceID: optionalID(acc.WorkspaceID)})
		if err != nil {
			return false, false, err
		}
		return !facts.Blocked && notifications.Notifies(notifications.Facts{DM: acc.DM, Mention: facts.Mentioned, Room: notifications.LevelFromDB(facts.RoomLevel, v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT), Workspace: notifications.LevelFromDB(facts.WorkspaceLevel, v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS), RoomMuted: facts.RoomMuted, WorkspaceMuted: facts.WorkspaceMuted}), false, nil

	case callKind:
		if s.Calls == nil || quiet {
			return false, false, nil
		}
		call, ok, err := s.Calls.Current(ctx, u.ID)
		if err != nil {
			return false, false, err
		}
		stateAllowed := call.State == v1.CallState_CALL_STATE_RINGING || (resolving && call.State == v1.CallState_CALL_STATE_ACTIVE)
		if !ok || call.ID != job.ReferenceID || call.Callee != u.ID || !stateAllowed || job.RoomID == nil || call.DM != *job.RoomID {
			return false, false, nil
		}
		peer, err := q.GetUser(ctx, call.Caller)
		if err != nil {
			return false, false, err
		}
		if peer.DisabledAt != nil || peer.IsBot || peer.IsGuest {
			return false, false, nil
		}
		shared, err := q.ShareWorkspace(ctx, sqlc.ShareWorkspaceParams{UserID: u.ID, OtherID: peer.ID})
		if err != nil || !shared {
			return false, false, err
		}
		acc, err := perm.NewResolver(q).Room(ctx, call.DM, u.ID)
		if err != nil {
			return false, false, accessError(err)
		}
		return acc.DM && !acc.Notes && acc.Bits.Has(perm.ViewRoom), quiet, nil
	}
	return false, false, nil
}
func accessError(err error) error {
	if errors.Is(err, perm.ErrNoRoom) || errors.Is(err, perm.ErrNoBoard) || errors.Is(err, perm.ErrNotMember) || db.IsNotFound(err) {
		return nil
	}
	return err
}
func optionalID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

// Endpoint toggles are the existing renderer notifyMentions/notifyAll policy.
func (s *Service) endpointAllows(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, mentions, all bool, job sqlc.PushDelivery) (bool, error) {
	if job.Kind == callKind {
		return true, nil
	}
	if all {
		return true, nil
	}
	if !mentions || job.RoomID == nil {
		return false, nil
	}
	acc, err := perm.NewResolver(q).Room(ctx, *job.RoomID, userID)
	if err != nil {
		return false, accessError(err)
	}
	facts, err := q.PushMessageFacts(ctx, sqlc.PushMessageFactsParams{MessageID: job.ReferenceID, UserID: userID, RoomID: *job.RoomID, WorkspaceID: optionalID(acc.WorkspaceID)})
	return acc.DM || facts.Mentioned, err
}
