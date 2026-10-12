package users

import (
	"context"
	"slices"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// MaxTaskNotifyBots bounds users.task_notify_bots (ADR-0090 §1).
const MaxTaskNotifyBots = 10

// ReasonTaskNotifyBotUnavailable is ApiError.reason of a 422 for a task_notify_bots id that is
// not a bot the user may relay to (unknown, not a bot, revoked, blocked, no shared workspace).
const ReasonTaskNotifyBotUnavailable = "TASK_NOTIFY_BOT_UNAVAILABLE"

const taskNotifyBotsField = "taskNotifyBots.botUserIds"

// parseTaskNotifyBots validates the shape of a requested list: uuids, at most
// MaxTaskNotifyBots distinct ones (duplicates are dropped, the order is kept).
func parseTaskNotifyBots(in []string) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(in))
	for _, s := range in {
		id, err := uuid.Parse(s)
		if err != nil || id == uuid.Nil {
			return nil, httpx.Validation(taskNotifyBotsField, "bot ids must be uuids").WithDetails(ReasonTaskNotifyBotUnavailable, 0, 0)
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) > MaxTaskNotifyBots {
		return nil, httpx.Validation(taskNotifyBotsField, "at most 10 bots").WithDetails(ReasonTaskNotifyBotUnavailable, uint64(len(out)), MaxTaskNotifyBots)
	}
	return out, nil
}

// taskNotifyBots validates a requested list (ADR-0090 §1): every id is a bot with a valid
// token (gateway; a webhook needs one too) that shares a workspace with the user and is not
// blocked by them. Returns the list as stored.
func taskNotifyBots(ctx context.Context, q *sqlc.Queries, user uuid.UUID, in []string) ([]uuid.UUID, error) {
	ids, err := parseTaskNotifyBots(in)
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	ok, err := q.TaskNotifyBotsAvailable(ctx, sqlc.TaskNotifyBotsAvailableParams{BotIds: ids, UserID: user})
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if !slices.Contains(ok, id) {
			return nil, httpx.Validation(taskNotifyBotsField, "not a bot you share a workspace with: "+id.String()).
				WithDetails(ReasonTaskNotifyBotUnavailable, 0, 0)
		}
	}
	return ids, nil
}
