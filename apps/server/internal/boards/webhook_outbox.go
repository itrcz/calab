package boards

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
)

// The board webhook outbox (ADR-0058 §4): the journal entries a task mutation wrote become,
// in the same transaction, one delivery per changed task on its board, numbered by the
// board's sequence. A rolled-back change leaves no delivery; a committed one always has it.

// webhookJSON: the body encoding — protojson with the proto field names (the ADR-0058
// payload: occurred_at, task_url, is_bot…) and every field present (unset messages as null:
// "actor": null for the server's own changes).
var webhookJSON = protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}

// Event types.
const (
	evTaskCreated  = "task.created"
	evTaskUpdated  = "task.updated"
	evTaskArchived = "task.archived"
	evTaskRestored = "task.restored"
	evTaskMovedOut = "task.moved_out"
	evTaskMovedIn  = "task.moved_in"
	evCommentPfx   = "task.comment."
)

// taskTx is s.tx for task mutations: after fn, in the same transaction, the board's automation
// rules run on the journal entries collected in c (ADR-0060), then every entry — the change's
// and the rules' — is queued for the board webhooks; after the commit the worker is woken and
// what the rules did is published.
func (s *Service) taskTx(ctx context.Context, c *change, fn func(q *sqlc.Queries, tx pgx.Tx) error) error {
	queued := 0
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		c.auto = nil // a retried closure starts clean
		if err := fn(q, tx); err != nil {
			return err
		}
		if err := s.runRules(ctx, q, tx, c); err != nil {
			return err
		}
		if err := s.syncMilestones(ctx, q, tx, c); err != nil { // ADR-0063 §2
			return err
		}
		acts := c.acts
		var rules map[uuid.UUID]string
		if c.auto != nil {
			acts = append(slices.Clip(acts), c.auto.acts...)
			rules = c.auto.ruleNames
		}
		var err error
		queued, err = s.webhookOutbox(ctx, q, tx, acts, rules)
		return err
	})
	if err != nil {
		return err
	}
	if queued > 0 {
		s.hooks.wake()
	}
	s.publishAuto(ctx, c.auto)
	return nil
}

// webhookOutbox queues the journal entries of one transaction: one event per task and author —
// the change itself, and each automation rule that acted (actor null, rule set; names: the rules
// by id) — a move between boards making moved_out to the old board and moved_in to the new one.
// Returns how many deliveries were queued.
func (s *Service) webhookOutbox(ctx context.Context, q *sqlc.Queries, tx sqlc.DBTX, acts []sqlc.TaskActivity, names map[uuid.UUID]string) (int, error) {
	if len(acts) == 0 {
		return 0, nil
	}
	type group struct {
		task uuid.UUID
		rule uuid.UUID // Nil: not a rule
	}
	var order []group
	by := map[group][]sqlc.TaskActivity{}
	for _, a := range acts {
		if isCommentKind(a.Kind) {
			continue // task.comment.* go from the comment hooks, not as task.updated (ADR-0091)
		}
		g := group{task: a.TaskID}
		if a.RuleID != nil {
			g.rule = *a.RuleID
		}
		if _, ok := by[g]; !ok {
			order = append(order, g)
		}
		by[g] = append(by[g], a)
	}
	n := 0
	for _, g := range order {
		as := by[g]
		var rule *v1.BoardWebhookEvent_Rule
		if g.rule != uuid.Nil {
			rule = &v1.BoardWebhookEvent_Rule{Id: g.rule.String(), Name: names[g.rule]}
		}
		for _, e := range taskEvents(as) {
			ok, err := s.enqueueWebhook(ctx, q, tx, e.board, e.typ, as[0].ActorID, g.task, as, nil, rule)
			if err != nil {
				return n, err
			}
			if ok {
				n++
			}
		}
	}
	return n, nil
}

type boardEvent struct {
	board uuid.UUID
	typ   string
}

// taskEvents: which events the journal entries of one task in one transaction make.
func taskEvents(as []sqlc.TaskActivity) []boardEvent {
	typ := evTaskUpdated
	for _, a := range as {
		switch a.Kind {
		case "moved_board":
			var before struct {
				BoardID string `json:"board_id"`
			}
			if json.Unmarshal(a.Before, &before) == nil {
				if src, err := uuid.Parse(before.BoardID); err == nil && src != a.BoardID {
					return []boardEvent{{src, evTaskMovedOut}, {a.BoardID, evTaskMovedIn}}
				}
			}
		case "created":
			typ = evTaskCreated
		case "archived":
			typ = evTaskArchived
		case "restored":
			typ = evTaskRestored
		}
	}
	return []boardEvent{{as[len(as)-1].BoardID, typ}}
}

// enqueueWebhook writes one delivery of a task event when the board has a working webhook,
// is not archived and its workspace's plan includes webhooks (else nothing: paused). q / tx
// belong to the transaction of the change. true = queued.
func (s *Service) enqueueWebhook(ctx context.Context, q *sqlc.Queries, tx sqlc.DBTX, board uuid.UUID, typ string,
	actor *uuid.UUID, taskID uuid.UUID, as []sqlc.TaskActivity, comment *v1.BoardWebhookEvent_Comment, rule *v1.BoardWebhookEvent_Rule) (bool, error) {
	wh, err := q.GetBoardWebhook(ctx, board)
	if db.IsNotFound(err) {
		return false, nil // the common case: one index lookup
	}
	if err != nil || wh.DisabledAt != nil {
		return false, err
	}
	b, err := q.GetBoard(ctx, board)
	if err != nil || b.ArchivedAt != nil {
		return false, err // an archived board makes no events; its queue drains
	}
	if ok, err := s.webhooksAllowed(ctx, b.WorkspaceID); err != nil || !ok {
		return false, err // paused by the plan: nothing is queued
	}
	seq, err := q.NextBoardWebhookSeq(ctx, board)
	if db.IsNotFound(err) {
		return false, nil // disabled meanwhile
	}
	if err != nil {
		return false, err
	}
	ev, err := s.webhookEvent(ctx, q, b, typ, seq, actor)
	if err != nil {
		return false, err
	}
	ev.Rule = rule
	if typ == evTaskMovedOut {
		movedOut(ev, board, taskID, as)
		return s.insertWebhook(ctx, q, board, seq, typ, ev)
	}
	t, ok, err := taskByID(ctx, tx, taskID, false)
	if err != nil || !ok {
		return false, err
	}
	pbs, err := tasksProto(ctx, q, []taskRow{t}, uuid.Nil)
	if err != nil {
		return false, err
	}
	ev.Task = pbs[0]
	if s.PublicURL != "" {
		ev.TaskUrl = strings.TrimRight(s.PublicURL, "/") + "/t/" + pbs[0].GetKey()
	}
	for _, a := range as {
		// The other task of a relation / parent by id only: it may be on a board the webhook's
		// board does not show (ADR-0059).
		ev.Changes = append(ev.Changes, &v1.BoardWebhookEvent_Change{Field: a.Kind,
			Before: jsonStruct(withoutTaskRef(a.Kind, a.Before)), After: jsonStruct(withoutTaskRef(a.Kind, a.After))})
	}
	ev.Comment = comment
	return s.insertWebhook(ctx, q, board, seq, typ, ev)
}

// insertWebhook gives the event its delivery id and writes the delivery row.
func (s *Service) insertWebhook(ctx context.Context, q *sqlc.Queries, board uuid.UUID, seq int64, typ string, ev *v1.BoardWebhookEvent) (bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	ev.Id = id.String()
	body, err := webhookJSON.Marshal(ev)
	if err != nil {
		return false, err
	}
	err = q.EnqueueBoardWebhookDelivery(ctx, sqlc.EnqueueBoardWebhookDeliveryParams{ID: id, BoardID: board, Seq: seq, EventType: typ, Payload: body})
	return err == nil, err
}

// movedOut fills task.moved_out for the source board: only what that board knew — the task id,
// its old key and the source board — and the move itself without its destination. The task as
// it is now (new key, the destination's statuses, labels, maybe a private board) and the other
// changes of the transaction belong to the destination's task.moved_in.
func movedOut(ev *v1.BoardWebhookEvent, src, taskID uuid.UUID, as []sqlc.TaskActivity) {
	ev.Task = &v1.Task{Id: taskID.String(), BoardId: src.String()}
	for _, a := range as {
		if a.Kind != "moved_board" {
			continue
		}
		var before struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(a.Before, &before) == nil {
			ev.Task.Key = before.Key
		}
		ev.Changes = []*v1.BoardWebhookEvent_Change{{Field: a.Kind, Before: jsonStruct(a.Before)}}
	}
}

// webhookEvent: the common part of an event (no id, task or changes yet).
func (s *Service) webhookEvent(ctx context.Context, q *sqlc.Queries, b sqlc.Board, typ string, seq int64, actor *uuid.UUID) (*v1.BoardWebhookEvent, error) {
	ev := &v1.BoardWebhookEvent{
		Version: webhookVersion, Type: typ, Sequence: uint32(seq), //nolint:gosec // per board, far below 2^32
		OccurredAt: timestamppb.New(s.Now()), WorkspaceId: b.WorkspaceID.String(),
		Board: &v1.BoardWebhookEvent_BoardRef{Id: b.ID.String(), Key: b.Key, Name: b.Name},
	}
	if actor != nil {
		u, err := q.GetUser(ctx, *actor)
		if err != nil && !db.IsNotFound(err) {
			return nil, err
		}
		ev.Actor = &v1.BoardWebhookEvent_Actor{Id: actor.String(), Name: u.DisplayName, IsBot: u.IsBot}
	}
	return ev, nil
}

// commentWebhook queues task.comment.<kind> ("created", "updated", "deleted") of a comment of
// task t in the transaction of q / tx; files: its attachments. A deleted comment goes without
// its text and attachments. true = queued.
func (s *Service) commentWebhook(ctx context.Context, q *sqlc.Queries, tx sqlc.DBTX, t taskRow, kind string, msg sqlc.Message,
	files []sqlc.ListAttachmentsRow, actor uuid.UUID) (bool, error) {
	c := &v1.BoardWebhookEvent_Comment{Id: msg.ID.String(), AuthorId: msg.AuthorID.String(),
		CreatedAt: timestamppb.New(msg.CreatedAt), EditedAt: tsp(msg.EditedAt), Attachments: []*v1.BoardWebhookEvent_CommentAttachment{}}
	if kind != "deleted" {
		c.Text = msg.Content
		for _, r := range files {
			c.Attachments = append(c.Attachments, &v1.BoardWebhookEvent_CommentAttachment{
				Name: r.File.Name, Size: uint64(max(r.File.Size, 0)), Mime: r.File.Mime}) //nolint:gosec // a size
		}
	}
	return s.enqueueWebhook(ctx, q, tx, t.BoardID, evCommentPfx+kind, &actor, t.ID, nil, c, nil)
}

// commentCreated queues task.comment.created after TaskHook committed (its own transaction: the
// window between the commits is accepted, ADR-0058 §4).
func (s *Service) commentCreated(ctx context.Context, acc perm.RoomAccess, msg sqlc.Message, files []sqlc.ListAttachmentsRow) {
	queued := false
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, ok, err := taskByID(ctx, tx, acc.TaskID, false)
		if err != nil || !ok {
			return err
		}
		queued, err = s.commentWebhook(ctx, q, tx, t, "created", msg, files, msg.AuthorID)
		return err
	})
	if err != nil {
		slog.WarnContext(ctx, "boards: comment webhook", "task", acc.TaskID, "err", err)
		return
	}
	if queued {
		s.hooks.wake()
	}
}

// TaskCommentHook runs after an edit or a deletion of a task comment committed
// (messages.Handlers.TaskCommentHook): one transaction journals it — comment_edit with the text
// before and after (merged per comment, ADR-0081 / ADR-0091; an edit that changed no text makes
// none), comment_delete with the comment as it was and its author — and queues
// task.comment.updated / deleted (ADR-0058 §4). The entry goes out as TASK_ACTIVITY.
func (s *Service) TaskCommentHook(ctx context.Context, acc perm.RoomAccess, ch messages.TaskCommentChange) {
	if !acc.Task {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	var c change
	queued := false
	err := s.taskTx(ctx, &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		c.acts, c.journal = nil, nil // a retried closure starts clean
		// Locked like any task write: a merge of edits (ADR-0081) reads and replaces the entry.
		t, ok, err := taskByID(ctx, tx, acc.TaskID, true)
		if err != nil || !ok {
			return err
		}
		switch ch.Kind {
		case "updated":
			rows, err := q.ListAttachments(ctx, []uuid.UUID{ch.Msg.ID})
			if err != nil {
				return err
			}
			if ch.Before != ch.Msg.Content { // the files of a comment do not change on an edit
				files := attachmentsSnap(rows)
				prev := ch.Msg
				prev.Content = ch.Before
				if err := c.record(ctx, q, t, ch.Actor, kindCommentEdit, commentSnap(prev, files), commentSnap(ch.Msg, files)); err != nil {
					return err
				}
			}
			queued, err = s.commentWebhook(ctx, q, tx, t, ch.Kind, ch.Msg, rows, ch.Actor)
			return err
		case "deleted":
			before := commentSnap(ch.Msg, attachmentsSnap(ch.Files))
			before["author_id"] = ch.Msg.AuthorID.String()
			if err := c.record(ctx, q, t, ch.Actor, kindCommentDelete, before, nil); err != nil {
				return err
			}
			queued, err = s.commentWebhook(ctx, q, tx, t, ch.Kind, ch.Msg, nil, ch.Actor)
			return err
		}
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "boards: comment hook", "task", acc.TaskID, "kind", ch.Kind, "err", err)
		return
	}
	if queued {
		s.hooks.wake()
	}
	s.publishJournal(ctx, c.journal)
}
