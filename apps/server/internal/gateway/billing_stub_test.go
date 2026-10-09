package gateway

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// events decodes what the sweep queued for the session.
func queuedEvents(t *testing.T, s *Session) []*v1.DispatchEvent {
	t.Helper()
	var out []*v1.DispatchEvent
	for _, e := range drain(s) {
		if e.enc != nil && e.enc.ev != nil {
			out = append(out, e.enc.ev)
			continue
		}
		var f v1.GatewayFrame
		if err := proto.Unmarshal(e.frame, &f); err != nil {
			t.Fatal(err)
		}
		out = append(out, f.GetDispatch())
	}
	return out
}

// A billing suspension (ADR-0080 §8) closes the workspace's content for the session but keeps
// it as a stub: the sweep sends only the access status (BILLING_SUSPENDED, no WORKSPACE_DELETE),
// READY may carry the content-free stub (and nothing more), and when the membership ends the
// stub is removed like any workspace.
func TestIdentityBillingSuspensionKeepsStub(t *testing.T) {
	ctx := context.Background()
	h := leaseTestHub()
	a := uuid.New()
	h.states[a] = &wsState{}
	s := leasedSession(h, a)
	var suspended atomic.Bool
	original := h.checkWorkspace
	h.checkWorkspace = func(ctx context.Context, id auth.Identity, ws uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		if suspended.Load() {
			return identitypolicy.Decision{Reason: identitypolicy.BillingSuspended}, time.Now(), identitypolicy.ErrDenied
		}
		return original(ctx, id, ws)
	}
	member := true
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) {
		if member {
			return []uuid.UUID{a}, nil
		}
		return nil, nil
	}
	_ = drain(s)

	suspended.Store(true)
	s.leases.mu.Lock()
	l := s.leases.workspaces[a]
	l.until = time.Time{} // re-evaluate in this pass
	s.leases.workspaces[a] = l
	s.leases.mu.Unlock()
	h.EnforceIdentity(ctx)
	evs := queuedEvents(t, s)
	if len(evs) != 1 || evs[0].GetWorkspaceIdentityAccessUpdate().GetAccess().GetReason() != v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_BILLING_SUSPENDED {
		t.Fatalf("suspension events: %v", evs)
	}
	if s.workspaceLeaseAllows(a) || !s.billingStubAllows(a) {
		t.Fatal("lease / stub after the suspension")
	}
	if s.allowsEvent(leaseEvent(a)) {
		t.Fatal("content event of a billing-suspended workspace allowed")
	}

	stub := &v1.WorkspaceSnapshot{Workspace: &v1.Workspace{Id: a.String(), Name: "Paid", Billing: &v1.WorkspaceBillingStatus{State: v1.BillingState_BILLING_STATE_SUSPENDED}}, Role: v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER}
	ready := func(snap *v1.WorkspaceSnapshot) *encEvent {
		return newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{Workspaces: []*v1.WorkspaceSnapshot{snap}}}})
	}
	if !s.allowsEvent(ready(stub)) {
		t.Fatal("READY with the billing stub refused")
	}
	withRooms := proto.Clone(stub).(*v1.WorkspaceSnapshot)
	withRooms.Rooms = []*v1.Room{{Id: uuid.NewString(), WorkspaceId: a.String()}}
	notSuspended := proto.Clone(stub).(*v1.WorkspaceSnapshot)
	notSuspended.Workspace.Billing.State = v1.BillingState_BILLING_STATE_ACTIVE
	for name, snap := range map[string]*v1.WorkspaceSnapshot{"rooms": withRooms, "active": notSuspended} {
		if s.allowsEvent(ready(snap)) {
			t.Fatalf("READY with a %s snapshot of an unleased workspace allowed", name)
		}
	}
	other := leasedSession(h, uuid.New())
	if other.allowsEvent(ready(stub)) {
		t.Fatal("a session without the denial may not hold the stub")
	}

	// Still suspended: further passes say nothing.
	h.EnforceIdentity(ctx)
	if evs := queuedEvents(t, s); len(evs) != 0 {
		t.Fatalf("repeated pass: %v", evs)
	}
	// The membership ends: the stub goes like a workspace.
	member = false
	h.EnforceIdentity(ctx)
	evs = queuedEvents(t, s)
	if len(evs) != 2 || evs[0].GetWorkspaceDelete().GetWorkspaceId() != a.String() || evs[1].GetWorkspaceIdentityAccessUpdate() == nil {
		t.Fatalf("removal: %v", evs)
	}
	if s.billingStubAllows(a) {
		t.Fatal("stub kept after the membership ended")
	}
}
