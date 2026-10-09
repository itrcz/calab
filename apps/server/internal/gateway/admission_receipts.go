package gateway

import (
	"context"
	"errors"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

// A receipt proof is event-local and bound to an exact session. It is never
// inserted into workspaces leases or used to admit protected workspace events.
type admissionReceiptProof struct {
	session, user uuid.UUID
	version       int64
	epoch         uint64
	until         time.Time
}

type receiptPolicyState struct {
	policy, access int64
	epoch          uint64
	until          time.Time
}

func (h *Hub) admissionPolicy(ctx context.Context, ws uuid.UUID) (int64, error) {
	if h.checkAdmissionPolicy != nil {
		return h.checkAdmissionPolicy(ctx, ws)
	}
	p, err := h.db.Q.GetIdentityPolicy(ctx, ws)
	if db.IsNotFound(err) {
		return 0, nil // explicit legacy off default
	}
	if err != nil {
		return 0, err
	}
	if p.Mode != string(identitypolicy.Off) && p.Mode != string(identitypolicy.Optional) {
		return p.Version, identitypolicy.ErrDenied
	}
	return p.Version, nil
}

// Only the existing ADR-0040 guestView qualifies, with no profile or link author.
func ownReceipt(a *v1.RoomAdmission) bool {
	if a == nil || parseID(a.GetRoomId()) == uuid.Nil || parseID(a.GetWorkspaceId()) == uuid.Nil || parseID(a.GetUser().GetId()) == uuid.Nil || a.GetRoomName() == "" || a.GetWorkspaceName() == "" {
		return false
	}
	if a.GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_PENDING && a.GetStatus() != v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED {
		return false
	}
	view := &v1.RoomAdmission{RoomId: a.RoomId, WorkspaceId: a.WorkspaceId, User: &v1.User{Id: a.GetUser().GetId()}, InviteId: a.InviteId, Status: a.Status, RequestedAt: a.RequestedAt, DecidedBy: a.DecidedBy, NoAnswer: a.NoAnswer, RoomName: a.RoomName, WorkspaceName: a.WorkspaceName, DecidedAt: a.DecidedAt}
	return proto.Equal(a, view)
}

// prepareAdmissionReceipts reads current durable policy outside gateway locks.
// Errors and unknown/enforced modes leave no proof. Queueing/replay/socket write
// each check the same bounded proof again, including session and invalidation epoch.
func (s *Session) prepareAdmissionReceipts(ctx context.Context, enc *encEvent) {
	if s.bot || s.principal.Bot || s.principal.Authority != identitypolicy.LocalAccount || !s.sessionLeaseAllows() {
		return
	}
	admissions := enc.ev.GetReady().GetPendingAdmissions()
	if a := enc.ev.GetRoomAdmissionDecided().GetAdmission(); a != nil {
		admissions = []*v1.RoomAdmission{a}
	}
	for _, a := range admissions {
		if !ownReceipt(a) || a.GetUser().GetId() != s.user.String() {
			continue
		}
		ws := parseID(a.GetWorkspaceId())
		if _, ok := enc.receipts[ws]; ok {
			continue
		}

		started := time.Now()
		until := started.Add(identitypolicy.ReadLeaseTTL)
		s.leases.mu.Lock()
		for id, state := range s.leases.receipts {
			if !started.Before(state.until) {
				delete(s.leases.receipts, id)
			}
		}
		if s.leases.receipts == nil {
			s.leases.receipts = map[uuid.UUID]receiptPolicyState{}
		}
		state := s.leases.receipts[ws]
		state.until = until
		s.leases.receipts[ws] = state
		s.leases.mu.Unlock()
		version, err := s.hub.admissionPolicy(ctx, ws)
		s.leases.mu.Lock()
		current := s.leases.receipts[ws]
		if err == nil && current.epoch == state.epoch && version >= current.policy {
			current.policy = version
			s.leases.receipts[ws] = current
		} else {
			err = identitypolicy.ErrDenied
		}
		s.leases.mu.Unlock()
		if err != nil || ctx.Err() != nil || !time.Now().Before(until) {
			continue
		}
		if enc.receipts == nil {
			enc.receipts = map[uuid.UUID]admissionReceiptProof{}
		}
		enc.receipts[ws] = admissionReceiptProof{session: s.asess, user: s.user, version: s.principal.Version, epoch: state.epoch, until: until}
	}
}

// allowsAdmissionReceipt is memory-only, even at the final socket boundary.
func (s *Session) allowsAdmissionReceipt(enc *encEvent, a *v1.RoomAdmission) bool {
	if s.bot || s.principal.Bot || s.principal.Authority != identitypolicy.LocalAccount || !ownReceipt(a) || a.GetUser().GetId() != s.user.String() || !s.sessionLeaseAllows() {
		return false
	}
	ws := parseID(a.GetWorkspaceId())
	p := enc.receipts[ws]
	s.leases.mu.Lock()
	state, ok := s.leases.receipts[ws]
	s.leases.mu.Unlock()
	return ok && p.session == s.asess && p.user == s.user && p.version == s.principal.Version && p.epoch == state.epoch && time.Now().Before(p.until)
}

// Existing viewer checks already chose this recipient. A cold/invalidated
// identity lease defers an attributed event for fresh admission rather than
// losing it. Scope-denied and unknown events never enter preparation.
func (s *Session) deferIdentityEvent(id uuid.UUID, enc *encEvent) {
	if enc == nil || enc.ev == nil {
		return
	}
	var scopes []uuid.UUID
	if enc.workspace != uuid.Nil && knownScopedEvent(enc.ev) {
		scopes = []uuid.UUID{enc.workspace}
	} else if enc.scoped {
		scopes = enc.scopes
	}
	if len(scopes) == 0 {
		return
	}
	if len(scopes) > 128 {
		s.requireIdentityResync()
		return
	}
	for _, ws := range scopes {
		if s.principal.Authority != identitypolicy.LocalAccount && (s.principal.Authority != identitypolicy.WorkspaceSSO || ws == uuid.Nil || ws != s.principal.WorkspaceID) {
			return
		}
	}
	mark := s.pauseEvent(id)
	if mark == nil {
		return
	}
	if !s.hub.prepareAsync(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		s.refreshSessionLease(ctx)
		if !s.sessionLeaseAllows() {
			s.preparationFailed(mark)
			return
		}
		for _, ws := range scopes {
			if ws != uuid.Nil && !s.workspaceLeaseAllows(ws) {
				decision, err := s.refreshWorkspaceLease(ctx, ws)
				if errors.Is(err, identitypolicy.ErrDenied) || (err == nil && !decision.Allowed) {
					// A durable denial consumes this event, not the independent session.
					s.resumeMany(mark, nil)
					return
				}
				if err != nil {
					s.preparationFailed(mark)
					return
				}
			}
		}
		s.resume(mark, id, enc)
	}) {
		s.preparationFailed(mark)
	}
}

// User-channel attribution has completed; refresh only its exact resource leases
// before releasing the ordered pause. This function runs in preparation workers.
func (s *Session) prepareEventLeases(ctx context.Context, enc *encEvent) error {
	if s.bot {
		return nil
	}
	if !s.sessionLeaseAllows() {
		s.refreshSessionLease(ctx)
	}
	if !s.sessionLeaseAllows() {
		return errors.New("session lease unavailable")
	}
	var scopes []uuid.UUID
	if enc.workspace != uuid.Nil {
		scopes = []uuid.UUID{enc.workspace}
	} else {
		scopes = enc.scopes
	}
	for _, ws := range scopes {
		if ws == uuid.Nil || s.workspaceLeaseAllows(ws) {
			continue
		}
		decision, err := s.refreshWorkspaceLease(ctx, ws)
		if s.billingRecoveryEvent(enc.ev, ws) {
			continue // the owner's BILLING_UPDATE under a billing suspension (refreshed just now)
		}
		if errors.Is(err, identitypolicy.ErrDenied) || (err == nil && !decision.Allowed) {
			return identitypolicy.ErrDenied
		}
		if err != nil {
			return err
		}
	}
	return ctx.Err()
}
