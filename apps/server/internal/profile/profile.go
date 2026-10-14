// Package profile publishes profile changes: the full Me to the user's own devices and the
// public User to every workspace the user is a member of (USER_UPDATE).
package profile

import (
	"context"
	"log/slog"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Publish announces u's current profile. publicChanged=false (settings only) skips the
// workspace broadcast.
func Publish(ctx context.Context, q *sqlc.Queries, pub events.Publisher, u sqlc.User, publicChanged bool) {
	pub.User(ctx, u.ID, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{Me: pbconv.Me(u)}}})
	if !publicChanged {
		return
	}
	wids, err := q.ListUserWorkspaceIDs(ctx, u.ID)
	if err != nil {
		slog.WarnContext(ctx, "profile broadcast", "err", err)
		return
	}
	if len(wids) > 0 {
		pub.Workspaces(ctx, wids, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{User: pbconv.UserEvent(u)}}}) // contacts: stripped by the gateway per workspace and recipient (ADR-0077)
	}
}
