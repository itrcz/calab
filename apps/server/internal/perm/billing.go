package perm

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Billing bits (ADR-0087). Bits from 1 << 32 on cannot be proto enum values (int32): they are
// listed in the comment of enum Permission (proto/calaba/v1/permissions.proto), docs/04 and the
// TS mirror (BILLING_BITS). They live on roles like any workspace-level bit but stand apart:
//   - ADMINISTRATOR does not include them (All stops at bit 31): today's admins get no money
//     rights; the workspace owner always has all three;
//   - room and board overrides never touch them (RoomOnly / BoardOnly are within All);
//   - only the owner grants, revokes or assigns them (internal/workspaces roles.go);
//   - guests and bots never have them (BillingOf; the billing routes refuse bots anyway).
const (
	// BillingView: the badge state and the «Тариф» settings: balance, history, plan, receipts.
	BillingView Bits = 1 << 32
	// BillingTopup: manual top-up through a hosted payment page (own card / SBP). Implies View.
	BillingTopup Bits = 1 << 33
	// BillingManage: change / stop / resume the plan, one-click top-up with a saved method,
	// auto-topup, saved methods, payer, refund requests, the market before the first payment.
	// Implies View and Topup.
	BillingManage Bits = 1 << 34

	// Billing are the three billing bits.
	Billing = BillingView | BillingTopup | BillingManage
	// Known are every bit a role may carry.
	Known = All | Billing
)

// BillingOf is the one billing rule (ADR-0087; TS: billingPermissions): the workspace owner has
// all three; a guest (highest built-in role GUEST) nothing; anyone else the billing bits of
// their roles (raw: the plain OR, ADMINISTRATOR not expanded — it gives none), closed under
// the implications MANAGE → TOPUP → VIEW.
func BillingOf(raw Bits, owner, guest bool) Bits {
	switch {
	case owner:
		return Billing
	case guest:
		return 0
	}
	b := raw & Billing
	if b&BillingManage != 0 {
		b |= BillingTopup
	}
	if b&BillingTopup != 0 {
		b |= BillingView
	}
	return b
}

// BillingStore is what LoadBilling needs (sqlc.Queries).
type BillingStore interface {
	GetMemberAccess(ctx context.Context, arg sqlc.GetMemberAccessParams) (sqlc.GetMemberAccessRow, error)
}

// LoadBilling returns the billing bits of user in workspace ws owned by owner; member=false
// (and no bits) for a non-member. The caller refuses bots (the billing routes are people-only).
func LoadBilling(ctx context.Context, s BillingStore, ws, owner, user uuid.UUID) (bits Bits, member bool, err error) {
	row, err := s.GetMemberAccess(ctx, sqlc.GetMemberAccessParams{WorkspaceID: ws, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	m := NewMember(user.String(), Role(row.Role), RoleList(row.RoleIds, row.RolePositions, row.RolePermissions))
	return BillingOf(m.Raw(), user == owner, m.Role == RoleGuest), true, nil
}
