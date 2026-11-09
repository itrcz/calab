package push

import (
	"context"
	"errors"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/google/uuid"
)

// badgeCount mirrors READY and the desktop badge: unread DMs plus visible-room mentions.
// It deliberately counts unread state, not notification delivery preferences or receipts.
func (s *Service) badgeCount(ctx context.Context, q *sqlc.Queries, user sqlc.User, session sqlc.Session) (int, error) {
	principal := auth.SessionPrincipal(session)
	if user.DisabledAt != nil || user.IsBot || user.IsGuest || principal.UserID != user.ID ||
		!identitypolicy.CheckGlobal(time.Now(), principal, identitypolicy.GlobalRead, false).Allowed {
		return 0, nil
	}
	count := 0
	if principal.Authority == identitypolicy.LocalAccount {
		personal, err := q.ListDMs(ctx, sqlc.ListDMsParams{UserID: user.ID, Lim: dms.MaxListed})
		if err != nil {
			return 0, err
		}
		for _, dm := range personal {
			count += int(max(dm.UnreadCount, 0))
		}
	}
	workspaces, err := q.ListUserWorkspaces(ctx, user.ID)
	if err != nil {
		return 0, err
	}
	resolver := perm.NewResolver(q)
	var visible []uuid.UUID
	for _, ws := range workspaces {
		if s.Auth == nil || principal.Authority == identitypolicy.WorkspaceSSO && ws.ID != principal.WorkspaceID {
			continue
		}
		decision, err := s.Auth.CheckWorkspaceDecisionInTx(ctx, q, auth.Identity{UserID: user.ID, SessionID: session.ID, Principal: principal}, ws.ID, identitypolicy.WorkspaceRead)
		if errors.Is(err, identitypolicy.ErrDenied) || err == nil && !decision.Allowed {
			continue
		}
		if err != nil {
			return 0, err
		}
		member, err := resolver.Member(ctx, ws.ID, user.ID)
		if errors.Is(err, perm.ErrNotMember) {
			continue
		}
		if err != nil {
			return 0, err
		}
		ids, err := rooms.VisibleIDs(ctx, q, ws, member)
		if err != nil {
			return 0, err
		}
		visible = append(visible, ids...)
	}
	states, err := q.ListReadStates(ctx, sqlc.ListReadStatesParams{UserID: user.ID, RoomIds: visible})
	if err != nil {
		return 0, err
	}
	for _, state := range states {
		count += int(max(state.MentionCount, 0))
	}
	return min(count, 99999), nil
}

// Coalesce read bursts to one worker per user, with at most one pending refresh.
// If capacity is exhausted, the next alert or foreground READY reconciles the badge.
func (s *Service) scheduleBadge(ctx context.Context, userID uuid.UUID) {
	if _, ok := s.providers[v1.PushProvider_PUSH_PROVIDER_APNS]; !ok {
		return
	}
	s.badgeMu.Lock()
	if _, ok := s.badgePending[userID]; ok {
		s.badgePending[userID] = true
		s.badgeMu.Unlock()
		return
	}
	if len(s.badgePending) >= 128 {
		s.badgeMu.Unlock()
		return
	}
	if s.badgePending == nil {
		s.badgePending = make(map[uuid.UUID]bool)
	}
	s.badgePending[userID] = false
	s.badgeMu.Unlock()
	// Do not inherit another device's request write gate. Each endpoint below is
	// authorized from its own fresh persisted session and current identity policy.
	ctx = db.WithoutAdmission(context.WithoutCancel(ctx))
	go func() {
		for {
			s.syncBadge(ctx, userID)
			s.badgeMu.Lock()
			again := s.badgePending[userID]
			if again {
				s.badgePending[userID] = false
			} else {
				delete(s.badgePending, userID)
			}
			s.badgeMu.Unlock()
			if !again {
				return
			}
		}
	}()
}

// syncBadge is a bounded best-effort projection after reading on any device. It uses
// the same endpoint lock as ordinary delivery, and computes AFTER acquiring that lock.
// A missed APNs update is reconciled by the next alert or foreground READY, never a timer.
func (s *Service) syncBadge(parent context.Context, userID uuid.UUID) {
	provider, ok := s.providers[v1.PushProvider_PUSH_PROVIDER_APNS]
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	devices, err := s.db.Q.ListPushDevices(ctx, userID)
	if err != nil {
		return
	}
	for _, candidate := range devices {
		if candidate.Provider != int16(v1.PushProvider_PUSH_PROVIDER_APNS) {
			continue
		}
		_ = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			session, err := s.lockDeliverySession(ctx, q, userID, candidate.SessionID, sqlc.PushDelivery{})
			if err != nil {
				return err
			}
			device, err := q.LockPushDevice(ctx, candidate.ID)
			if err != nil {
				return err
			}
			if device.UserID != userID || device.SessionID != session.ID || device.Version != candidate.Version ||
				device.AppID != provider.AppID || device.Environment != provider.Environment ||
				!device.NotificationsEnabled || !device.ExpiresAt.After(time.Now()) {
				return nil
			}
			user, err := q.GetUser(ctx, userID)
			if err != nil {
				return err
			}
			count, err := s.badgeCount(ctx, q, user, session)
			if err != nil {
				return err
			}
			result := provider.Sender.Send(ctx, Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_APNS, Token: device.Token, AppID: device.AppID, Environment: device.Environment},
				Payload{Version: 1, Kind: "badge", Binding: device.ID.String(), EventID: uuid.NewString(), ReferenceID: userID.String(), ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Badge: &count})
			if result.Invalid {
				_, err = q.DeleteInvalidPushDevice(ctx, sqlc.DeleteInvalidPushDeviceParams{ID: device.ID, Version: device.Version, TokenHash: device.TokenHash, InvalidBefore: result.InvalidBefore})
			}
			return err
		})
	}
}
