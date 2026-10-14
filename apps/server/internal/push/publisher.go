package push

import (
	"context"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/google/uuid"
)

// Publisher preserves every ordinary gateway/web/desktop event contract.
type Publisher struct {
	events.Publisher
	S *Service
}

// User preserves the gateway event before recording a recipient routing intent.
func (p Publisher) User(ctx context.Context, id uuid.UUID, e *v1.DispatchEvent) {
	p.Publisher.User(ctx, id, e)
	p.S.Observe(ctx, id, e)
}

// Workspace records resumable routing separately from workspace gateway publication.
func (p Publisher) Workspace(ctx context.Context, id uuid.UUID, e *v1.DispatchEvent) {
	p.Publisher.Workspace(ctx, id, e)
	p.S.Observe(ctx, uuid.Nil, e)
}

// Workspaces preserves shared gateway identity and records one deduplicated intent.
func (p Publisher) Workspaces(ctx context.Context, ids []uuid.UUID, e *v1.DispatchEvent) {
	p.Publisher.Workspaces(ctx, ids, e)
	p.S.Observe(ctx, uuid.Nil, e)
}

// WorkspaceEvents preserves ordered gateway publication and records each routing intent.
func (p Publisher) WorkspaceEvents(ctx context.Context, id uuid.UUID, evs []*v1.DispatchEvent) {
	p.Publisher.WorkspaceEvents(ctx, id, evs)
	for _, e := range evs {
		p.S.Observe(ctx, uuid.Nil, e)
	}
}
