package autotopup

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Prepare and Dispatch expose the two phases to the tests (a «restore» between them).
func (j *Job) Prepare(ctx context.Context, accountID uuid.UUID) (*sqlc.BillingAutotopupAttempt, error) {
	return j.prepare(ctx, accountID)
}

func (j *Job) Dispatch(ctx context.Context, att sqlc.BillingAutotopupAttempt) (bool, error) {
	return j.dispatch(ctx, att)
}
