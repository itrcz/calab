package core

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// CloseWorkspaceAccount closes the live billing account of a workspace that is being deleted,
// inside the caller's transaction and before DELETE FROM workspaces: status closed (terminal:
// no renewals, no seat charges, no auto-topup), auto-topup consent revoked. Money history stays
// (billing_accounts.workspace_id becomes NULL by ON DELETE SET NULL); an auto-topup payment
// already dispatched is still settled by reconciliation. No live account → nothing to do. It
// does not need billing to be enabled: an account left from an earlier rollout closes too.
//
// Lock order is workspace row → account (as admission): the workspace row is locked first.
func CloseWorkspaceAccount(ctx context.Context, q *sqlc.Queries, workspaceID uuid.UUID) error {
	if _, err := q.LockWorkspaceForBillingClose(ctx, workspaceID); err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	acc, err := q.LockLiveBillingAccountByWorkspace(ctx, &workspaceID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	now, err := billing.DBClock{}.Now(ctx, q)
	if err != nil {
		return err
	}
	if _, err := q.UpdateBillingAccountState(ctx, sqlc.UpdateBillingAccountStateParams{
		Status: StatusClosed, Plan: acc.Plan, NegativeSince: acc.NegativeSince, SuspendAt: acc.SuspendAt,
		NextDueAt: nil, Now: now, ID: acc.ID,
	}); err != nil {
		return err
	}
	_, err = q.RevokeBillingAutoTopup(ctx, sqlc.RevokeBillingAutoTopupParams{Now: now, Reason: "account_closed", AccountID: acc.ID})
	return err
}
