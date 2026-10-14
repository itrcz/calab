package billing

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Seats is the billing hook of every membership change that adds or removes a paid seat
// (billable = role <> 'guest' AND NOT is_bot; sqlc CountBillableMembers). Admission paths call
// it inside their own transaction, after the membership row is written and before commit, so
// the debit and the membership commit or roll back together:
//
//   - workspaces: invite join and open join (workspaces.go), email invitations (email_invites.go);
//   - auth: register by invite (service.go);
//   - guests → member promotion (UpdateMember role change).
//
// The creator of a workspace is not admitted through Seats (no account exists yet).
//
// Errors are API errors to return as they are: ErrSeatGrowthRequiresFunds (409, a new seat
// beyond the covered capacity and no money for its first day, M22), ErrWorkspaceBillingSuspended
// (403); anything else is internal. A workspace without a live billing account always passes.
type Seats interface {
	// Admit: userID became a billable member of workspaceID (requestID: the idempotency key of
	// the operation, e.g. the HTTP request id; a retry must not charge twice).
	Admit(ctx context.Context, q *sqlc.Queries, workspaceID, userID, requestID uuid.UUID) error
	// Promote: userID changed from guest to a billable role.
	Promote(ctx context.Context, q *sqlc.Queries, workspaceID, userID, requestID uuid.UUID) error
	// Removed: userID stopped being billable (left, kicked, banned, demoted to guest). Never
	// fails for lack of money; the freed seat stays covered until its lot ends (replacement
	// inside the covered capacity is free, M3).
	Removed(ctx context.Context, q *sqlc.Queries, workspaceID, userID uuid.UUID) error
}

// NoSeats is Seats while BILLING_ENABLED=false: every change passes, nothing is charged.
type NoSeats struct{}

var _ Seats = NoSeats{}

// Admit implements Seats.
func (NoSeats) Admit(context.Context, *sqlc.Queries, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return nil
}

// Promote implements Seats.
func (NoSeats) Promote(context.Context, *sqlc.Queries, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return nil
}

// Removed implements Seats.
func (NoSeats) Removed(context.Context, *sqlc.Queries, uuid.UUID, uuid.UUID) error { return nil }
