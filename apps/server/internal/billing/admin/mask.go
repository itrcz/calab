package admin

import (
	"context"
	"strings"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Saved-card references are charge credentials (ADR-0083 phase 2): a Tochka subscription id can be
// charged with our API token, so no admin API returns one. The binding payment of a saved card
// carries the subscription id as its payment id, its later charges "{subscription}:charge:{order}",
// refunds and webhook events "{subscription}…" too: such ids are shown masked to the last four
// characters of the subscription («…9f8f:charge:9002»), enough to find the operation in the bank by
// amount and date. Other provider ids (payment links, Stripe objects) are shown as they are.

// refMask masks the provider ids among ids that start with a saved card's subscription id.
type refMask map[string]bool

// savedRefs looks up which of the ids' operation parts are saved-card subscriptions.
func savedRefs(ctx context.Context, q *sqlc.Queries, ids []string) (refMask, error) {
	ops := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != "" {
			ops = append(ops, opPart(id))
		}
	}
	if len(ops) == 0 {
		return refMask{}, nil
	}
	refs, err := q.ListBillingSavedMethodRefs(ctx, ops)
	if err != nil {
		return nil, err
	}
	m := refMask{}
	for _, r := range refs {
		m[r] = true
	}
	return m, nil
}

func opPart(id string) string {
	op, _, _ := strings.Cut(id, ":")
	return op
}

// apply returns id, masked when its operation part is a saved-card subscription.
func (m refMask) apply(id string) string {
	op := opPart(id)
	if !m[op] {
		return id
	}
	tail := op
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return "…" + tail + id[len(op):]
}
