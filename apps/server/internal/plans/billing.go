package plans

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Billing is the billing side of admission (ADR-0080 v5 §4.1, §8, §12). The hard plan limits
// (Check, KindMembers with bots) stay as they are; billing only adds the paid-seat hook and the
// billing suspension of a workspace.
type Billing struct {
	// Seats: the money hook of every billable membership change; billing.NoSeats while
	// BILLING_ENABLED=false (nil = NoSeats).
	Seats billing.Seats
	// Enabled: BILLING_ENABLED. Off, admission and Workspace payloads are exactly as before
	// billing: no extra query, no Seats call, no Workspace.billing.
	Enabled bool
	// Enforced: BILLING_ENABLED && BILLING_ENFORCEMENT_ENABLED. A workspace whose billing
	// account is suspended takes nobody in (403 WORKSPACE_BILLING_SUSPENDED).
	Enforced bool
}

// SetBilling installs the billing configuration (wiring at startup; tests switch it) and
// drops the cached plans, which carry Workspace.billing.
func (s *Service) SetBilling(b Billing) {
	if b.Seats == nil {
		b.Seats = billing.NoSeats{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bill = b
	s.cache = map[uuid.UUID]cached{}
	s.gen++
}

func (s *Service) billingConf() Billing {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.bill
	if b.Seats == nil {
		b.Seats = billing.NoSeats{}
	}
	return b
}

// BillingChanged is what billing calls after committing a change of a billing account's
// status / plan / debt episode or of workspace_plans (ADR-0080 §12): it drops the cached plan
// on every instance and publishes WORKSPACE_UPDATE with the new Workspace.plan and
// Workspace.billing to the members. A billing suspension needs nothing more: identity leases
// read billing_accounts and close REST / gateway / RTC within their TTL (30 s), and the RTC
// sync resyncs the workspace's devices on this WORKSPACE_UPDATE. q may be the pool's queries.
func (s *Service) BillingChanged(ctx context.Context, q *sqlc.Queries, pub events.Publisher, ws uuid.UUID) error {
	s.Invalidate(ctx, ws)
	row, err := q.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	pw := pbconv.Workspace(row)
	if err := s.Fill(ctx, pw); err != nil {
		return err
	}
	pub.Workspace(ctx, ws, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pw}}})
	return nil
}

// Billable reports whether a membership takes a paid seat: people except guests (bots never).
func Billable(role string, bot bool) bool { return role != "" && role != "guest" && !bot }

// CheckBillingOpen refuses a workspace closed by a billing suspension (enforcement on) with
// 403 WORKSPACE_SUSPENDED / reason WORKSPACE_BILLING_SUSPENDED. Every way into a workspace
// calls it, billable or not (guest room links too). q may be a transaction. nil-safe.
func (s *Service) CheckBillingOpen(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	if s == nil {
		return nil
	}
	return checkOpen(ctx, q, ws, s.billingConf())
}

func checkOpen(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, b Billing) error {
	if !b.Enabled || !b.Enforced {
		return nil
	}
	suspended, err := q.WorkspaceBillingSuspended(ctx, &ws)
	if err != nil {
		return err
	}
	if suspended {
		return billing.ErrWorkspaceBillingSuspended
	}
	return nil
}

// AdmitSeat is the billing hook of a new membership (invite / open join, email invitation,
// registration by invitation): call it in the join's transaction right after the membership
// row is written, so the seat debit and the membership commit or roll back together. role is
// the new membership's role; guests and bots pass without a Seats call. actor is who made
// the change (the joining user, or the inviter adding someone): the seat-funds error says
// «top up» to the owner and «ask the owner» to everyone else. nil-safe.
func (s *Service) AdmitSeat(ctx context.Context, q *sqlc.Queries, ws, user, actor uuid.UUID, role string) error {
	if s == nil {
		return nil
	}
	b := s.billingConf()
	if !b.Enabled {
		return nil
	}
	if err := checkOpen(ctx, q, ws, b); err != nil {
		return err
	}
	// The restricted mode takes nobody in (ADR-0086 amendment), whatever way the membership
	// came: invite links, open join, email invitations, registration by invitation.
	if err := s.CheckActive(ctx, ws, RestrictedInvite); err != nil {
		return err
	}
	if billable, err := billableUser(ctx, q, user, role); err != nil || !billable {
		return err
	}
	return seatError(ctx, q, ws, actor, b.Seats.Admit(ctx, q, ws, user, operationID()))
}

// PromoteSeat is AdmitSeat for a guest who became a member (POST …/promote): in the same
// transaction, after the role is written.
func (s *Service) PromoteSeat(ctx context.Context, q *sqlc.Queries, ws, user, actor uuid.UUID, role string) error {
	if s == nil {
		return nil
	}
	b := s.billingConf()
	if !b.Enabled {
		return nil
	}
	if err := checkOpen(ctx, q, ws, b); err != nil {
		return err
	}
	if err := s.CheckActive(ctx, ws, RestrictedInvite); err != nil { // guest → member: a new seat
		return err
	}
	if billable, err := billableUser(ctx, q, user, role); err != nil || !billable {
		return err
	}
	return seatError(ctx, q, ws, actor, b.Seats.Promote(ctx, q, ws, user, operationID()))
}

// SeatRemoved is the billing hook of a paid seat freed: a member left, was removed or banned,
// or was demoted to a guest. oldRole is the role before the change; a guest or bot frees
// nothing. Call it in the change's transaction. It never refuses for lack of money.
func (s *Service) SeatRemoved(ctx context.Context, q *sqlc.Queries, ws, user uuid.UUID, oldRole string) error {
	if s == nil {
		return nil
	}
	b := s.billingConf()
	if !b.Enabled {
		return nil
	}
	if billable, err := billableUser(ctx, q, user, oldRole); err != nil || !billable {
		return err
	}
	return b.Seats.Removed(ctx, q, ws, user)
}

// SeatRoleChanged applies a role change of an existing member: guest → billable is a
// promotion, billable → guest frees the seat, anything else is no change.
func (s *Service) SeatRoleChanged(ctx context.Context, q *sqlc.Queries, ws, user, actor uuid.UUID, oldRole, newRole string) error {
	switch was, is := Billable(oldRole, false), Billable(newRole, false); {
	case !was && is:
		return s.PromoteSeat(ctx, q, ws, user, actor, newRole)
	case was && !is:
		return s.SeatRemoved(ctx, q, ws, user, oldRole)
	}
	return nil
}

func billableUser(ctx context.Context, q *sqlc.Queries, user uuid.UUID, role string) (bool, error) {
	if !Billable(role, false) {
		return false, nil
	}
	u, err := q.GetUser(ctx, user)
	if err != nil {
		return false, err
	}
	return !u.IsBot, nil
}

// operationID is the idempotency key handed to Seats. Each admission is its own transaction
// and a retry of a committed one finds the membership and admits nothing, so a fresh id per
// operation is exactly «a retry never charges twice».
func operationID() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.New()
	}
	return id
}

// Seat-funds messages: the client tells them apart by ApiError.reason
// (BILLING_SEAT_GROWTH_REQUIRES_FUNDS) and shows its own text; these are the fallbacks.
const (
	seatFundsOwner  = "adding a paid member needs money on the balance for the first day: top up the balance"
	seatFundsMember = "the workspace cannot take new paid members until its owner tops up the balance"
)

// seatError keeps every Seats error as it is (API errors pass through, the rest is
// internal) and words the seat-funds refusal for the actor.
func seatError(ctx context.Context, q *sqlc.Queries, ws, actor uuid.UUID, err error) error {
	if err == nil || !errors.Is(err, billing.ErrSeatGrowthRequiresFunds) {
		return err
	}
	msg := seatFundsMember
	if w, e := q.GetWorkspace(ctx, ws); e == nil && w.OwnerID == actor {
		msg = seatFundsOwner
	}
	return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, msg).
		WithDetails(billing.ReasonSeatGrowthRequiresFunds, 0, 0)
}

// SeatRefused reports a billing refusal of a paid seat: no money for its first day
// (BILLING_SEAT_GROWTH_REQUIRES_FUNDS) or a workspace suspended for billing. Background joins
// (email invitations after verification) skip such a workspace and keep the invitation.
func SeatRefused(err error) bool {
	var e *httpx.Error
	if !errors.As(err, &e) {
		return false
	}
	return e.Reason == billing.ReasonSeatGrowthRequiresFunds || e.Reason == billing.ReasonWorkspaceBillingSuspended ||
		e.Reason == billing.ReasonWorkspacePlanInactive
}

// billingInfo is the Workspace.billing part of Info (no amounts).
type billingInfo struct {
	state     v1.BillingState
	source    v1.PlanSource
	suspendAt *time.Time
	// lapsed: the restricted mode («тариф не активен», ADR-0086 amendment) — state LAPSED;
	// only set while enforcement is on.
	lapsed bool
}

func (b *billingInfo) proto() *v1.WorkspaceBillingStatus {
	if b == nil {
		return nil
	}
	out := &v1.WorkspaceBillingStatus{State: b.state, Source: b.source}
	if b.suspendAt != nil {
		out.SuspendAt = timestamppb.New(*b.suspendAt)
	}
	return out
}

// resolveBilling maps the live account (none: nil, Workspace.billing unset). enforced:
// BILLING_ENFORCEMENT_ENABLED — without it a lapsed account shows and acts as STOPPED (Free).
func resolveBilling(row sqlc.GetWorkspaceBillingStatusRow, enforced bool) *billingInfo {
	if row.AccountStatus == "" {
		return nil
	}
	b := &billingInfo{source: v1.PlanSource_PLAN_SOURCE_MANUAL}
	if row.Source == "billing" {
		b.source = v1.PlanSource_PLAN_SOURCE_BILLING
	}
	switch row.AccountStatus {
	case "inactive":
		b.state = v1.BillingState_BILLING_STATE_INACTIVE
	case "active":
		b.state = v1.BillingState_BILLING_STATE_ACTIVE
		if row.NegativeSince != nil {
			b.state = v1.BillingState_BILLING_STATE_IN_ARREARS
		}
	case "stopped":
		b.state = v1.BillingState_BILLING_STATE_STOPPED
		if row.LapsedAt != nil && enforced {
			b.state, b.lapsed = v1.BillingState_BILLING_STATE_LAPSED, true
		}
	case "suspended":
		b.state = v1.BillingState_BILLING_STATE_SUSPENDED
	}
	if b.state == v1.BillingState_BILLING_STATE_IN_ARREARS || b.state == v1.BillingState_BILLING_STATE_SUSPENDED ||
		b.state == v1.BillingState_BILLING_STATE_STOPPED || b.state == v1.BillingState_BILLING_STATE_LAPSED {
		b.suspendAt = row.SuspendAt
	}
	return b
}

// LapsedRoomMembers is the voice room cap of the restricted mode (owner, 10.10: «не больше чем 2
// человека»). Calls already above it stay connected; new joins are refused.
const LapsedRoomMembers = 2

// Actions the restricted mode refuses: ApiError.message names one of them (logs, bots); the
// client words its own text by ApiError.reason and the action it tried.
const (
	RestrictedSend    = "sending messages"
	RestrictedUpload  = "uploading files"
	RestrictedInvite  = "inviting people"
	RestrictedCreate  = "creating rooms, boards, tasks, bots and stickers"
	RestrictedMedia   = "video and screen sharing"
	RestrictedRecord  = "recording"
	RestrictedConnect = "connecting integrations"
)

// PlanInactiveError is the refusal of the restricted mode (ADR-0086 amendment): 403 FORBIDDEN,
// reason WORKSPACE_PLAN_INACTIVE.
func PlanInactiveError(action string) *httpx.Error {
	return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_FORBIDDEN,
		"the workspace plan is not active: "+action+" is paused until the owner pays for a plan or moves to Free").
		WithDetails(billing.ReasonWorkspacePlanInactive, 0, 0)
}

// Lapsed reports the restricted mode of ws (Info.Lapsed; cached like the plan). nil-safe.
func (s *Service) Lapsed(ctx context.Context, ws uuid.UUID) (bool, error) {
	if s == nil {
		return false, nil
	}
	i, err := s.Info(ctx, ws)
	return i.Lapsed, err
}

// CheckActive refuses action in a workspace in the restricted mode (PlanInactiveError). nil-safe.
func (s *Service) CheckActive(ctx context.Context, ws uuid.UUID, action string) error {
	lapsed, err := s.Lapsed(ctx, ws)
	if err != nil || !lapsed {
		return err
	}
	return PlanInactiveError(action)
}

// BillingEnforced reports BILLING_ENABLED && BILLING_ENFORCEMENT_ENABLED (the restricted mode and the
// suspension apply). nil-safe.
func (s *Service) BillingEnforced() bool {
	if s == nil {
		return false
	}
	b := s.billingConf()
	return b.Enabled && b.Enforced
}
