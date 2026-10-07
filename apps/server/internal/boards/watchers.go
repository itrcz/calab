package boards

import (
	"context"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Watchers (ADR-0076): an explicit role on a task, task_subscribers.watcher. A watcher is
// always a subscriber; one who does not see the board sees this task (perm.TaskBits). Only
// someone who may edit the task makes watchers (explicitly or by @mentioning); a watcher is
// removed by such an editor or by themselves.

// MaxWatchers bounds the watchers of one task (mentions beyond it are only notified).
const MaxWatchers = 50

// mayMention reports whether an @mentioned user u becomes a watcher of a task of the board
// (ADR-0076 §5): a human member, not a guest, who may be invited (mayInvite). Bots never.
func mayMention(ctx context.Context, q *sqlc.Queries, res *perm.Resolver, boardID, u uuid.UUID) (bool, error) {
	usr, err := q.GetUser(ctx, u)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if usr.IsBot || usr.IsGuest {
		return false, nil
	}
	return mayInvite(ctx, q, res, boardID, u)
}

// taskWatchers lists the watchers of task id.
func taskWatchers(ctx context.Context, q *sqlc.Queries, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.ListTaskWatchers(ctx, []uuid.UUID{id})
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, len(rows))
	for i, w := range rows {
		out[i] = w.UserID
	}
	return out, nil
}

// addWatchers makes users (already validated by mayInvite / mayMention) watchers of t,
// journals "watchers" and touches the task. Returns those who were not watchers before; users
// beyond MaxWatchers are left out (the insert is idempotent; the REST path holds the row lock).
func addWatchers(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, users []uuid.UUID, c *change) ([]uuid.UUID, error) {
	cur, err := taskWatchers(ctx, q, t.ID)
	if err != nil {
		return nil, err
	}
	var added []uuid.UUID
	for _, u := range users {
		if !slices.Contains(cur, u) && !slices.Contains(added, u) && len(cur)+len(added) < MaxWatchers {
			added = append(added, u)
		}
	}
	if len(added) == 0 {
		return nil, nil
	}
	if err := q.AddTaskWatchers(ctx, sqlc.AddTaskWatchersParams{TaskID: t.ID, UserIds: added}); err != nil {
		return nil, err
	}
	if err := q.TouchTask(ctx, t.ID); err != nil {
		return nil, err
	}
	next := append(slices.Clone(cur), added...)
	return added, c.record(ctx, q, t, actor, "watchers", map[string]any{"user_ids": idsJSON(cur)}, map[string]any{"user_ids": idsJSON(next)})
}

// mentionWatchers (ADR-0076 §5): the members @mentioned by an editor of the task — humans,
// not guests — become its watchers (and subscribers), so those without board access see the
// card. A mention by someone who cannot edit the task makes no watchers (notifyDirect still
// notifies the mentioned who see the task). Returns the new watchers.
func mentionWatchers(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, editor bool, mentioned []uuid.UUID, c *change) ([]uuid.UUID, error) {
	if !editor || len(mentioned) == 0 || t.ArchivedAt != nil {
		return nil, nil
	}
	res := perm.NewResolver(q)
	var ok []uuid.UUID
	for _, u := range mentioned {
		if u == actor {
			continue
		}
		yes, err := mayMention(ctx, q, res, t.BoardID, u)
		if err != nil {
			return nil, err
		}
		if yes {
			ok = append(ok, u)
		}
	}
	return addWatchers(ctx, q, t, actor, ok, c)
}

// authorEdits reports whether the author of a comment may edit the task (ADR-0076 §4–5: only
// their mentions make watchers): their bits on the task (perm.TaskBits), then canEdit.
func authorEdits(ctx context.Context, q *sqlc.Queries, t taskRow, author uuid.UUID) (bool, error) {
	acc, err := perm.NewResolver(q).Board(ctx, t.BoardID, author)
	if err != nil {
		if err == perm.ErrNoBoard { //nolint:errorlint // sentinel from the resolver
			return false, nil
		}
		return false, err
	}
	if acc.Archived || acc.Suspended || t.ArchivedAt != nil {
		return false, nil
	}
	if !acc.Bits.Has(perm.ViewBoard) {
		inv, err := q.GetTaskInvite(ctx, sqlc.GetTaskInviteParams{TaskID: t.ID, UserID: author})
		if err != nil {
			return false, err
		}
		acc.Bits = perm.TaskBits(acc, inv.Assignee, inv.Approver, inv.Watcher)
	}
	return canEdit(ctx, q, acc, t, author)
}

// addWatcher: PUT /api/tasks/{id}/watchers {user_id} — by whoever may edit the task.
func (s *Service) addWatcher(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetTaskWatcherRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	u, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	me := uid(r)
	var c change
	var taskID uuid.UUID
	err = s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, acc, err := s.loadTask(r, tx, true)
		if err != nil {
			return err
		}
		taskID = t.ID
		if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		// Like an assignee (ADR-0076 §2): a member, not a guest; a bot only one who sees the board.
		ok, err := mayInvite(r.Context(), q, perm.NewResolver(q), t.BoardID, u)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.Validation("userId", "the user does not see this board")
		}
		cur, err := taskWatchers(r.Context(), q, t.ID)
		if err != nil {
			return err
		}
		if !slices.Contains(cur, u) && len(cur) >= MaxWatchers {
			return httpx.Conflict("at most 50 watchers")
		}
		_, err = addWatchers(r.Context(), q, t, me, []uuid.UUID{u}, &c)
		return err
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

// removeWatcher: DELETE /api/tasks/{id}/watchers?user_id= — by whoever may edit the task, or the
// watcher themselves («Перестать наблюдать»). The subscription goes too when the user no longer
// sees the task (ADR-0076 §6).
func (s *Service) removeWatcher(w http.ResponseWriter, r *http.Request) error {
	u, err := uuid.Parse(r.URL.Query().Get("user_id"))
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	me := uid(r)
	var c change
	var taskID uuid.UUID
	err = s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, acc, err := s.loadTask(r, tx, true)
		if err != nil {
			return err
		}
		taskID = t.ID
		if u == me {
			if err := writable(acc); err != nil {
				return err
			}
		} else if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		cur, err := taskWatchers(r.Context(), q, t.ID)
		if err != nil {
			return err
		}
		was, err := q.UnsetTaskWatcher(r.Context(), sqlc.UnsetTaskWatcherParams{TaskID: t.ID, UserID: u})
		if err != nil || !was {
			return err
		}
		still, err := sees(r.Context(), q, t, []uuid.UUID{u})
		if err != nil {
			return err
		}
		if len(still) == 0 {
			if err := q.DeleteTaskSubscription(r.Context(), sqlc.DeleteTaskSubscriptionParams{TaskID: t.ID, UserID: u}); err != nil {
				return err
			}
		}
		if err := q.TouchTask(r.Context(), t.ID); err != nil {
			return err
		}
		next := slices.DeleteFunc(slices.Clone(cur), func(x uuid.UUID) bool { return x == u })
		return c.record(r.Context(), q, t, me, "watchers", map[string]any{"user_ids": idsJSON(cur)}, map[string]any{"user_ids": idsJSON(next)})
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

// taskScopedCount is the number of members who see board b only through its cards (ADR-0076:
// «Позванные по карточкам: N» in the access settings).
func taskScopedCount(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID) (uint32, error) {
	ids, err := q.ListBoardInvitees(ctx, boardID)
	if err != nil {
		return 0, err
	}
	res := perm.NewResolver(q)
	var n uint32
	for _, u := range ids {
		acc, err := res.Board(ctx, boardID, u)
		if err != nil {
			if err == perm.ErrNoBoard { //nolint:errorlint // sentinel from the resolver
				continue
			}
			return 0, err
		}
		if acc.TaskScoped {
			n++
		}
	}
	return n, nil
}
