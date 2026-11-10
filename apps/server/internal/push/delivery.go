package push

import (
	"context"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"log/slog"
	"sync"
	"time"
)

// Observe persists only a minimal routing intent. It has its own short budget;
// endpoint locks and fanout must never consume the legacy publication budget.
func (s *Service) Observe(ctx context.Context, userID uuid.UUID, event *v1.DispatchEvent) {
	if len(s.providers) == 0 || event == nil {
		return
	}
	if userID != uuid.Nil && (event.GetReadStateUpdate() != nil || event.GetDmStateUpdate() != nil) {
		s.scheduleBadge(ctx, userID)
		return
	}
	if state := event.GetCallState().GetCall(); state != nil && state.State != v1.CallState_CALL_STATE_RINGING && userID != uuid.Nil {
		if _, ok := s.providers[v1.PushProvider_PUSH_PROVIDER_FCM]; ok {
			if call, err := uuid.Parse(state.Id); err == nil {
				// Detached and bounded: a cancel is best effort (the ring expiry is the fallback)
				// and must not hold the publishing request.
				go s.cancelRing(context.WithoutCancel(ctx), userID, call)
			}
		}
		return
	}
	job, ok := eventJob(event)
	if !ok || (userID == uuid.Nil && (job.Kind != messageKind || job.RoomID == nil)) {
		return
	}
	bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 100*time.Millisecond)
	defer cancel()
	if err := s.enqueueIntent(bounded, optionalID(userID), job); err != nil {
		slog.WarnContext(bounded, "push routing intent unavailable")
	}
}
func eventJob(event *v1.DispatchEvent) (sqlc.PushDelivery, bool) {
	now := time.Now()
	job := sqlc.PushDelivery{ExpiresAt: now.Add(5 * time.Minute)}
	switch {
	case event.GetMessageCreate() != nil:
		message := event.GetMessageCreate().GetMessage()
		if message == nil {
			return job, false
		}
		if card := message.GetSystem().GetCall(); card != nil && card.Outcome != v1.CallOutcome_CALL_OUTCOME_MISSED {
			return job, false
		}
		if message.GetSystem().GetRoomIcon() != nil || message.GetSystem().GetContactShared() != nil { // a room picture change is silent (ADR-0092), so is a contact share (ADR-0100)
			return job, false
		}
		job.Kind = messageKind
		job.ReferenceID, _ = uuid.Parse(message.Id)
		room, _ := uuid.Parse(message.RoomId)
		job.RoomID = optionalID(room)
		job.EventKey = "message:" + job.ReferenceID.String()
	case event.GetCallRing() != nil:
		call := event.GetCallRing().GetCall()
		if call == nil || call.State != v1.CallState_CALL_STATE_RINGING || call.CreatedAt == nil {
			return job, false
		}
		job.Kind = callKind
		job.ReferenceID, _ = uuid.Parse(call.Id)
		room, _ := uuid.Parse(call.DmRoomId)
		job.RoomID = optionalID(room)
		job.ExpiresAt = call.CreatedAt.AsTime().Add(calls.DefaultRingTimeout)
		job.EventKey = "call:" + job.ReferenceID.String()
	default:
		return job, false
	}
	return job, job.ReferenceID != uuid.Nil && job.ExpiresAt.After(now)
}
func (s *Service) queueUser(ctx context.Context, userID uuid.UUID, job sqlc.PushDelivery) error {
	devices, err := s.db.Q.ListPushDevices(ctx, userID)
	if err != nil {
		return err
	}
	for _, candidate := range devices {
		if !deviceEnabled(candidate.Provider, true, true, job.Kind) {
			continue
		}
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			// Share fresh session facts across endpoints while excluding revocation.
			session, err := s.lockDeliverySession(ctx, q, userID, candidate.SessionID, job)
			if err != nil {
				return err
			}
			device, err := q.LockPushDevice(ctx, candidate.ID)
			if err != nil {
				return err
			}
			if device.UserID != userID || device.SessionID != candidate.SessionID || !device.ExpiresAt.After(time.Now()) {
				return nil
			}
			provider, ok := s.providers[v1.PushProvider(device.Provider)]
			if !ok || provider.AppID != device.AppID || provider.Environment != device.Environment || !deviceEnabled(device.Provider, device.NotificationsEnabled, device.CallsEnabled, job.Kind) {
				return nil
			}
			user, err := q.GetUser(ctx, userID)
			if err != nil {
				return err
			}
			allowed, _, err := s.allowed(ctx, q, user, session, job)
			if allowed {
				allowed, err = s.endpointAllows(ctx, q, user.ID, device.MentionsEnabled, device.AllEnabled, job)
			}
			if err != nil || !allowed {
				return err
			}
			if err := q.CleanupPushDeviceDeliveries(ctx, device.ID); err != nil {
				return err
			}
			duplicate, err := q.HasPushDelivery(ctx, sqlc.HasPushDeliveryParams{DeviceID: device.ID, EventKey: job.EventKey})
			if err != nil || duplicate {
				return err
			}
			if job.Kind == messageKind {
				if err := q.TrimCompletedPushMessages(ctx, device.ID); err != nil {
					return err
				}
			}
			if job.Kind == callKind {
				if err := q.DiscardPreviousPushCalls(ctx, sqlc.DiscardPreviousPushCallsParams{DeviceID: device.ID, ReferenceID: job.ReferenceID}); err != nil {
					return err
				}
			}
			n, err := q.QueuePushDelivery(ctx, sqlc.QueuePushDeliveryParams{DeviceID: device.ID, DeviceVersion: device.Version, EventKey: job.EventKey, Kind: job.Kind, ReferenceID: job.ReferenceID, RoomID: job.RoomID, ExpiresAt: job.ExpiresAt, ActorID: job.ActorID, NoticeKind: job.NoticeKind, ContextID: job.ContextID, OccurrenceAt: job.OccurrenceAt, ReminderMinutes: job.ReminderMinutes})
			if err != nil || n > 0 {
				return err
			}
			duplicate, err = q.HasPushDelivery(ctx, sqlc.HasPushDeliveryParams{DeviceID: device.ID, EventKey: job.EventKey})
			if err != nil {
				return err
			}
			if !duplicate {
				return errBackpressure
			}
			return nil
		})
		if err != nil && !db.IsNotFound(err) {
			return err
		}
	}
	return nil
}
func deviceEnabled(provider int16, notifications, calls bool, kind int16) bool {
	if kind == callKind {
		return calls && (provider == int16(v1.PushProvider_PUSH_PROVIDER_VOIP) || provider == int16(v1.PushProvider_PUSH_PROVIDER_FCM))
	}
	return notifications && provider != int16(v1.PushProvider_PUSH_PROVIDER_VOIP)
}

// Deliver gives calls independent bounded attempts before ordinary work. Shared
// session read locks allow APNs and VoIP endpoints to coexist; ordinary device
// ownership is held for at most 750ms, including a slow provider.
func (s *Service) Deliver(ctx context.Context) error {
	lease := uuid.New()
	rows, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) ([]sqlc.PushDelivery, error) { return q.ClaimPushDeliveries(ctx, &lease) })
	if err != nil {
		return err
	}
	dispatchGroup := func(calls bool) {
		var work sync.WaitGroup
		for _, row := range rows {
			if (row.Kind == callKind) != calls {
				continue
			}
			work.Add(1)
			go func(job sqlc.PushDelivery) {
				defer work.Done()
				timeout := 750 * time.Millisecond
				if calls {
					timeout = 3 * time.Second
				}
				bounded, cancel := context.WithTimeout(ctx, timeout)
				err := s.dispatch(bounded, job)
				cancel()
				if err != nil {
					// A canceled transaction must not strand the lease for 15s of a 45s ring.
					repair, stop := context.WithTimeout(context.WithoutCancel(ctx), 250*time.Millisecond)
					_, _ = db.GuardValue(repair, s.db, func(q *sqlc.Queries) (int64, error) {
						return q.RetryPushDelivery(repair, sqlc.RetryPushDeliveryParams{ID: job.ID, LeaseID: job.LeaseID, NotBefore: time.Now().Add(time.Second)})
					})
					stop()
				}
			}(row)
		}
		work.Wait()
	}
	dispatchGroup(true)
	dispatchGroup(false)
	return nil
}
func (s *Service) dispatch(ctx context.Context, job sqlc.PushDelivery) error {
	return s.db.Tx(ctx, func(q *sqlc.Queries) error {
		retainMessage := false
		complete := func() error {
			_, err := q.CompletePushDelivery(ctx, sqlc.CompletePushDeliveryParams{ID: job.ID, LeaseID: job.LeaseID, RetainMessage: retainMessage})
			return err
		}
		candidate, err := q.GetPushDevice(ctx, job.DeviceID)
		if db.IsNotFound(err) {
			return complete()
		}
		if err != nil {
			return err
		}
		session, err := s.lockDeliverySession(ctx, q, candidate.UserID, candidate.SessionID, job)
		if err != nil {
			if db.IsNotFound(err) {
				return complete()
			}
			return err
		}
		device, err := q.LockPushDispatch(ctx, sqlc.LockPushDispatchParams{ID: job.ID, LeaseID: job.LeaseID})
		if db.IsNotFound(err) {
			return complete()
		}
		if err != nil {
			return err
		}
		provider, ok := s.providers[v1.PushProvider(device.Provider)]
		if !ok || provider.AppID != device.AppID || provider.Environment != device.Environment || !deviceEnabled(device.Provider, device.NotificationsEnabled, device.CallsEnabled, job.Kind) {
			return complete()
		}
		user, err := q.GetUser(ctx, device.UserID)
		if err != nil {
			return err
		}
		allowed, silent, err := s.allowed(ctx, q, user, session, job)
		if allowed {
			allowed, err = s.endpointAllows(ctx, q, user.ID, device.MentionsEnabled, device.AllEnabled, job)
		}
		if db.IsNotFound(err) {
			return complete()
		}
		if err != nil {
			return err
		}
		if !allowed || !job.ExpiresAt.After(time.Now()) {
			return complete()
		}
		payload := Payload{Version: 1, Binding: device.ID.String(), EventID: job.ID.String(), Kind: kindNames[job.Kind], ReferenceID: job.ReferenceID.String(), ExpiresAt: job.ExpiresAt.UnixMilli(), Silent: silent}
		if job.Kind == messageKind {
			payload.DeliveryExpiresAt = payload.ExpiresAt
			payload.ExpiresAt = job.ExpiresAt.Add(7 * 24 * time.Hour).UnixMilli()
		}
		if job.RoomID != nil {
			payload.RoomID = job.RoomID.String()
		}
		if err := s.presentation(ctx, q, user, job, &payload); err != nil {
			return err
		}
		var badgeAttempt string
		if device.Provider == int16(v1.PushProvider_PUSH_PROVIDER_APNS) {
			count, err := s.badgeCount(ctx, q, user, session)
			if err != nil {
				return err
			}
			// Preserve ordinary alerts during a cache outage, but do not change the
			// icon unless the previous shared count has been invalidated first.
			badgeAttempt, _, err = s.prepareBadge(ctx, device.ID, device.Version, count, false)
			if err == nil {
				payload.Badge = &count
			}
		}
		// Endpoint/version, session and freshly resolved access/settings stay bound in
		// this transaction immediately before dispatch. No detached raw-event fanout.
		result := provider.Sender.Send(ctx, Endpoint{Provider: v1.PushProvider(device.Provider), Token: device.Token, AppID: device.AppID, Environment: device.Environment}, payload)
		if payload.Badge != nil {
			s.finishBadge(ctx, device.ID, device.Version, *payload.Badge, badgeAttempt, result)
		}
		if result.Invalid {
			_, err = q.DeleteInvalidPushDevice(ctx, sqlc.DeleteInvalidPushDeviceParams{ID: device.ID, Version: device.Version, TokenHash: device.TokenHash, InvalidBefore: result.InvalidBefore})
			if err != nil {
				return err
			}
			return complete()
		}
		if result.Retry && job.Attempts < 6 && time.Now().Before(job.ExpiresAt) {
			delay := max(time.Second*time.Duration(1<<job.Attempts), result.RetryAfter)
			_, err = q.RetryPushDelivery(ctx, sqlc.RetryPushDeliveryParams{ID: job.ID, LeaseID: job.LeaseID, NotBefore: time.Now().Add(delay)})
			return err
		}
		retainMessage = result.Accepted && !result.Retry && !result.Invalid
		return complete()
	})
}

// cancelRing stops an Android ring that ended early — answered on another device, declined,
// cancelled by the caller or missed (ADR-0071, Android). Only FCM endpoints that a ring of this
// call reached get a data message `kind=call-cancel` with that ring's opaque event ID; it carries
// no authority and the device only removes its own notification. VoIP/CallKit has its own path.
func (s *Service) cancelRing(ctx context.Context, userID, call uuid.UUID) {
	provider, ok := s.providers[v1.PushProvider_PUSH_PROVIDER_FCM]
	if !ok {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rings, err := db.GuardValue(bounded, s.db, func(q *sqlc.Queries) ([]sqlc.ListPushRingCancelsRow, error) {
		return q.ListPushRingCancels(bounded, sqlc.ListPushRingCancelsParams{UserID: userID, ReferenceID: call})
	})
	if err != nil {
		return
	}
	for _, ring := range rings {
		if ring.AppID != provider.AppID || ring.Environment != provider.Environment {
			continue
		}
		payload := Payload{Version: 1, Binding: ring.DeviceID.String(), EventID: ring.EventID.String(), Kind: callCancelKind, ReferenceID: call.String(), ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
		provider.Sender.Send(bounded, Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, Token: ring.Token, AppID: ring.AppID, Environment: ring.Environment}, payload)
	}
}
