-- Task boards (ADR-0042). Task lists with filters are built dynamically in internal/boards
-- (TaskFilter → SQL); everything else is here.

-- name: GetBoardAccess :one
-- Everything needed to compute a user's board bits, in one round trip: the membership (role
-- NULL = not a member), the member's roles lowest position first with each role's board
-- override (0/0 = none), the user's own override, the disabled board features (ADR-0058 §3:
-- COMMENTS off makes the task rooms read-only) and whether the user is invited on a task.
SELECT b.workspace_id,
       b.is_private,
       b.restricted,
       (b.archived_at IS NOT NULL)::boolean AS archived,
       m.role,
       coalesce(mr.ids, '{}')::uuid[] AS role_ids,
       coalesce(mr.positions, '{}')::integer[] AS role_positions,
       coalesce(mr.perms, '{}')::bigint[] AS role_permissions,
       coalesce(mr.allows, '{}')::bigint[] AS role_allows,
       coalesce(mr.denies, '{}')::bigint[] AS role_denies,
       uo.allow AS user_allow, uo.deny AS user_deny,
       (w.suspended_at IS NOT NULL)::boolean AS suspended,
       b.disabled_features,
       -- ADR-0059 / ADR-0076: the user (a human) is an assignee, an approver or a watcher of a
       -- live task of the board.
       (NOT coalesce(u.is_bot, true) AND (
           EXISTS (SELECT 1 FROM task_assignees x JOIN tasks t ON t.id = x.task_id
                   WHERE x.user_id = sqlc.arg('user_id')::uuid AND t.board_id = b.id AND t.archived_at IS NULL)
        OR EXISTS (SELECT 1 FROM task_approvers x JOIN tasks t ON t.id = x.task_id
                   WHERE x.user_id = sqlc.arg('user_id')::uuid AND t.board_id = b.id AND t.archived_at IS NULL)
        OR EXISTS (SELECT 1 FROM task_subscribers x JOIN tasks t ON t.id = x.task_id
                   WHERE x.user_id = sqlc.arg('user_id')::uuid AND x.watcher AND t.board_id = b.id AND t.archived_at IS NULL)
       ))::boolean AS invited
FROM boards b
JOIN workspaces w ON w.id = b.workspace_id
LEFT JOIN users u ON u.id = sqlc.arg('user_id')::uuid
LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = sqlc.arg('user_id')
LEFT JOIN LATERAL (
    SELECT array_agg(wr.id ORDER BY wr.position) AS ids,
           array_agg(wr.position ORDER BY wr.position) AS positions,
           array_agg(wr.permissions ORDER BY wr.position) AS perms,
           array_agg(coalesce(bo.allow, 0) ORDER BY wr.position) AS allows,
           array_agg(coalesce(bo.deny, 0) ORDER BY wr.position) AS denies
    FROM member_roles x
    JOIN workspace_roles wr ON wr.id = x.role_id
    LEFT JOIN board_permissions bo ON bo.board_id = b.id AND bo.target_type = 'role' AND bo.target_id = wr.id::text
    WHERE x.workspace_id = m.workspace_id AND x.user_id = m.user_id
) mr ON true
LEFT JOIN board_permissions uo ON uo.board_id = b.id AND uo.target_type = 'user' AND uo.target_id = sqlc.arg('user_id')::text
WHERE b.id = sqlc.arg('board_id');

-- name: GetTaskRoomRef :one
-- The task and board of a task room and whether the user is its assignee / approver / watcher
-- (perm.Resolver: RoomAccess.Task, ADR-0059, ADR-0076).
SELECT t.id AS task_id, t.board_id, (t.archived_at IS NOT NULL)::boolean AS task_archived,
       EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = sqlc.arg('user_id'))::boolean AS assignee,
       EXISTS (SELECT 1 FROM task_approvers x WHERE x.task_id = t.id AND x.user_id = sqlc.arg('user_id'))::boolean AS approver,
       EXISTS (SELECT 1 FROM task_subscribers x WHERE x.task_id = t.id AND x.user_id = sqlc.arg('user_id') AND x.watcher)::boolean AS watcher
FROM tasks t WHERE t.room_id = sqlc.arg('room_id');

-- name: GetTaskInvite :one
-- Whether the user is an assignee / approver / watcher of a task (ADR-0059, ADR-0076:
-- perm.TaskBits).
SELECT EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = sqlc.arg('task_id') AND x.user_id = sqlc.arg('user_id'))::boolean AS assignee,
       EXISTS (SELECT 1 FROM task_approvers x WHERE x.task_id = sqlc.arg('task_id') AND x.user_id = sqlc.arg('user_id'))::boolean AS approver,
       EXISTS (SELECT 1 FROM task_subscribers x WHERE x.task_id = sqlc.arg('task_id') AND x.user_id = sqlc.arg('user_id') AND x.watcher)::boolean AS watcher;

-- name: ListTaskInvites :many
-- The tasks among ids where the user is an assignee, an approver or a watcher (ADR-0059,
-- ADR-0076).
SELECT x.task_id FROM task_assignees x WHERE x.task_id = ANY(sqlc.arg('ids')::uuid[]) AND x.user_id = sqlc.arg('user_id')
UNION
SELECT a.task_id FROM task_approvers a WHERE a.task_id = ANY(sqlc.arg('ids')::uuid[]) AND a.user_id = sqlc.arg('user_id')
UNION
SELECT w.task_id FROM task_subscribers w WHERE w.task_id = ANY(sqlc.arg('ids')::uuid[]) AND w.user_id = sqlc.arg('user_id') AND w.watcher;

-- name: ListInvitedTasks :many
-- The live tasks on live boards of a workspace where the user (a human) is an assignee, an
-- approver or a watcher: the task-scoped boards of ADR-0059 (restricted ones too, ADR-0076).
SELECT t.id, t.board_id
FROM tasks t JOIN boards b ON b.id = t.board_id
WHERE b.workspace_id = sqlc.arg('workspace_id') AND b.archived_at IS NULL AND t.archived_at IS NULL
  AND t.id IN (SELECT x.task_id FROM task_assignees x WHERE x.user_id = sqlc.arg('user_id')
               UNION SELECT a.task_id FROM task_approvers a WHERE a.user_id = sqlc.arg('user_id')
               UNION SELECT w.task_id FROM task_subscribers w WHERE w.user_id = sqlc.arg('user_id') AND w.watcher)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg('user_id') AND u.is_bot);

-- name: ListWorkspaceTaskInvitees :many
-- The assignees, approvers and watchers (humans) of the live tasks on live boards of a
-- workspace: the gateway's invited map (ADR-0059, ADR-0076). how: 1 assignee, 2 approver,
-- 3 watcher.
SELECT t.id AS task_id, t.board_id, x.user_id,
       bool_or(x.how = 1)::boolean AS assignee, bool_or(x.how = 2)::boolean AS approver, bool_or(x.how = 3)::boolean AS watcher
FROM tasks t
JOIN boards b ON b.id = t.board_id
JOIN (SELECT a.task_id, a.user_id, 1 AS how FROM task_assignees a
      UNION ALL SELECT p.task_id, p.user_id, 2 AS how FROM task_approvers p
      UNION ALL SELECT w.task_id, w.user_id, 3 AS how FROM task_subscribers w WHERE w.watcher) x ON x.task_id = t.id
JOIN users u ON u.id = x.user_id AND NOT u.is_bot
WHERE b.workspace_id = $1 AND b.archived_at IS NULL AND t.archived_at IS NULL
GROUP BY t.id, t.board_id, x.user_id;

-- name: ListWorkspaceTaskRooms :many
-- The comment rooms of the tasks on live boards of a workspace (the gateway's task room map).
SELECT t.id, t.room_id, t.board_id, (t.archived_at IS NOT NULL)::boolean AS archived
FROM tasks t JOIN boards b ON b.id = t.board_id
WHERE b.workspace_id = $1 AND b.archived_at IS NULL;

-- name: ListBoards :many
SELECT * FROM boards WHERE workspace_id = $1 AND (archived_at IS NOT NULL) = sqlc.arg('archived')::boolean
ORDER BY position, id;

-- name: GetBoard :one
SELECT * FROM boards WHERE id = $1;

-- name: GetBoardForUpdate :one
SELECT * FROM boards WHERE id = $1 FOR UPDATE;

-- name: LockBoards :exec
-- Serializes board creation / ordering of one workspace (count limit, positions).
SELECT pg_advisory_xact_lock(hashtext('calaba.boards:' || sqlc.arg('workspace_id')::text));

-- name: CountBoards :one
SELECT count(*)::integer FROM boards WHERE workspace_id = $1 AND archived_at IS NULL;

-- name: CountAllBoards :one
-- Live and archived: the hard cap of 50 (ADR-0042 §6).
SELECT count(*)::integer FROM boards WHERE workspace_id = $1;

-- name: CreateBoard :one
INSERT INTO boards (workspace_id, name, key, emoji, icon_file_id, description, is_private, position, created_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('name'), sqlc.arg('key'), sqlc.arg('emoji'), sqlc.narg('icon_file_id'),
        sqlc.arg('description'), sqlc.arg('is_private'),
        (SELECT coalesce(max(position) + 1, 0) FROM boards WHERE workspace_id = sqlc.arg('workspace_id')),
        sqlc.arg('created_by'))
RETURNING *;

-- name: BoardKeyTaken :one
SELECT EXISTS (SELECT 1 FROM boards WHERE workspace_id = $1 AND key = $2)::boolean;

-- name: UpdateBoard :one
UPDATE boards SET
    name              = coalesce(sqlc.narg('name'), name),
    key               = coalesce(sqlc.narg('key'), key),
    emoji             = coalesce(sqlc.narg('emoji'), emoji),
    icon_file_id      = CASE WHEN sqlc.arg('set_icon')::boolean THEN sqlc.narg('icon_file_id')::uuid ELSE icon_file_id END,
    description       = coalesce(sqlc.narg('description'), description),
    is_private        = coalesce(sqlc.narg('is_private'), is_private),
    auto_archive_days = coalesce(sqlc.narg('auto_archive_days'), auto_archive_days),
    default_view_id   = CASE WHEN sqlc.arg('set_default_view')::boolean THEN sqlc.narg('default_view_id')::uuid ELSE default_view_id END,
    restricted        = coalesce(sqlc.narg('restricted'), restricted),
    approval_notify_delay_seconds = coalesce(sqlc.narg('approval_notify_delay_seconds'), approval_notify_delay_seconds)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetBoardFeatures :one
-- Board features (ADR-0058 §3): the disabled BoardFeature bit mask and the estimate scale.
UPDATE boards SET
    disabled_features = coalesce(sqlc.narg('disabled_features'), disabled_features),
    estimate_scale    = coalesce(sqlc.narg('estimate_scale'), estimate_scale)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetBoardPosition :exec
UPDATE boards SET position = $2 WHERE id = $1;

-- name: SetBoardArchived :one
UPDATE boards SET archived_at = CASE WHEN sqlc.arg('archived')::boolean THEN now() ELSE NULL END
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: NextTaskNumber :one
-- Takes the next task number of a board (the row lock serializes concurrent creates).
UPDATE boards SET next_number = next_number + 1 WHERE id = $1 RETURNING next_number - 1;

-- name: DeleteBoardTaskRooms :exec
-- Purge: the comment rooms of the board's tasks (their messages cascade). Called after the
-- board (and so its tasks) is deleted, with the room ids read before.
DELETE FROM rooms WHERE id = ANY(sqlc.arg('ids')::uuid[]) AND type = 'task';

-- name: BoardTaskRoomIDs :many
SELECT room_id FROM tasks WHERE board_id = $1;

-- name: DeleteBoard :execrows
DELETE FROM boards WHERE id = $1;

-- name: ListBoardOverrides :many
SELECT * FROM board_permissions WHERE board_id = $1 ORDER BY target_type, target_id;

-- name: ListWorkspaceBoardOverrides :many
SELECT bp.* FROM board_permissions bp JOIN boards b ON b.id = bp.board_id
WHERE b.workspace_id = $1
ORDER BY bp.board_id, bp.target_type, bp.target_id;

-- name: DeleteBoardOverrides :exec
DELETE FROM board_permissions WHERE board_id = $1;

-- name: InsertBoardOverride :exec
INSERT INTO board_permissions (board_id, target_type, target_id, allow, deny)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (board_id, target_type, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny;

-- name: GrantBoardUserOverride :exec
-- A personal allow on a board (the caller who restricts it, ADR-0048): added to an existing
-- override, never lifting its denies.
INSERT INTO board_permissions (board_id, target_type, target_id, allow, deny)
VALUES (sqlc.arg('board_id'), 'user', sqlc.arg('user_id')::text, sqlc.arg('allow'), 0)
ON CONFLICT (board_id, target_type, target_id) DO UPDATE
    SET allow = board_permissions.allow | (EXCLUDED.allow & ~board_permissions.deny);

-- name: DeleteBoardOverride :exec
DELETE FROM board_permissions WHERE board_id = $1 AND target_type = $2 AND target_id = $3;

-- name: BoardOpenCounts :many
-- Live tasks not in a finished status per board, and of them assigned to the user.
SELECT t.board_id, count(*)::integer AS open,
    (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = sqlc.arg('user_id')::uuid)))::integer AS mine
FROM tasks t JOIN board_statuses st ON st.id = t.status_id
WHERE t.board_id = ANY(sqlc.arg('board_ids')::uuid[]) AND t.archived_at IS NULL AND st.type NOT IN ('completed', 'cancelled')
GROUP BY t.board_id;

-- ---- statuses, labels, milestones ----

-- name: ListBoardStatuses :many
SELECT * FROM board_statuses WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[]) ORDER BY board_id, position, id;

-- name: CreateBoardStatus :one
INSERT INTO board_statuses (board_id, name, type, color, position, is_default)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateBoardStatus :one
UPDATE board_statuses SET
    name  = coalesce(sqlc.narg('name'), name),
    type  = coalesce(sqlc.narg('type'), type),
    color = coalesce(sqlc.narg('color'), color)
WHERE id = sqlc.arg('id') AND board_id = sqlc.arg('board_id')
RETURNING *;

-- name: SetBoardStatusPosition :exec
UPDATE board_statuses SET position = $2 WHERE id = $1;

-- name: SetDefaultBoardStatus :exec
-- Call ClearDefaultBoardStatus first (the partial unique index allows one default per board).
UPDATE board_statuses SET is_default = true WHERE id = $1 AND board_id = $2;

-- name: ClearDefaultBoardStatus :exec
UPDATE board_statuses SET is_default = false WHERE board_id = $1 AND is_default;

-- name: MoveStatusTasks :many
-- Moves every task of a status (archived ones too) to another status of the board, at the end.
UPDATE tasks t SET status_id = sqlc.arg('to_id'), updated_at = now(),
    position = coalesce((SELECT max(x.position) FROM tasks x WHERE x.status_id = sqlc.arg('to_id')), 0) + 1024 * t.number
WHERE t.status_id = sqlc.arg('from_id')
RETURNING t.id;

-- name: DeleteBoardStatus :execrows
DELETE FROM board_statuses WHERE id = $1 AND board_id = $2;

-- name: ListBoardLabels :many
SELECT * FROM board_labels WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[]) ORDER BY board_id, position, id;

-- name: CreateBoardLabel :one
INSERT INTO board_labels (board_id, name, color, position) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: UpdateBoardLabel :one
UPDATE board_labels SET
    name  = coalesce(sqlc.narg('name'), name),
    color = coalesce(sqlc.narg('color'), color)
WHERE id = sqlc.arg('id') AND board_id = sqlc.arg('board_id')
RETURNING *;

-- name: SetBoardLabelPosition :exec
UPDATE board_labels SET position = $2 WHERE id = $1;

-- name: DeleteBoardLabel :execrows
DELETE FROM board_labels WHERE id = $1 AND board_id = $2;

-- name: ListBoardMilestones :many
SELECT * FROM board_milestones WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[]) ORDER BY board_id, position, id;

-- name: CreateBoardMilestone :one
INSERT INTO board_milestones (board_id, name, due_on, position) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: UpdateBoardMilestone :one
UPDATE board_milestones SET
    name   = coalesce(sqlc.narg('name'), name),
    due_on = CASE WHEN sqlc.arg('set_due')::boolean THEN sqlc.narg('due_on')::date ELSE due_on END
WHERE id = sqlc.arg('id') AND board_id = sqlc.arg('board_id')
RETURNING *;

-- name: SetBoardMilestonePosition :exec
UPDATE board_milestones SET position = $2 WHERE id = $1;

-- name: DeleteBoardMilestone :execrows
DELETE FROM board_milestones WHERE id = $1 AND board_id = $2;

-- ---- views ----

-- name: ListBoardViews :many
-- Shared views of the boards and the user's own (user_id NULL: shared only).
SELECT * FROM board_views
WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[])
  AND (shared OR created_by = sqlc.narg('user_id')::uuid)
ORDER BY board_id, position, id;

-- name: GetBoardView :one
SELECT * FROM board_views WHERE id = $1 AND board_id = $2;

-- name: CountBoardViews :one
SELECT count(*)::integer FROM board_views WHERE board_id = $1;

-- name: CreateBoardView :one
INSERT INTO board_views (board_id, name, kind, filter, group_by, sort, shared, created_by, position)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        coalesce(sqlc.narg('position')::integer, (SELECT coalesce(max(position) + 1, 0) FROM board_views WHERE board_id = $1)))
RETURNING *;

-- name: UpdateBoardView :one
UPDATE board_views SET
    name     = coalesce(sqlc.narg('name'), name),
    kind     = coalesce(sqlc.narg('kind'), kind),
    filter   = coalesce(sqlc.narg('filter'), filter),
    group_by = coalesce(sqlc.narg('group_by'), group_by),
    sort     = coalesce(sqlc.narg('sort'), sort),
    shared   = coalesce(sqlc.narg('shared'), shared),
    position = coalesce(sqlc.narg('position'), position)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteBoardView :execrows
DELETE FROM board_views WHERE id = $1 AND board_id = $2;

-- ---- tasks ----

-- name: CountLiveTasks :one
SELECT count(*)::integer FROM tasks WHERE board_id = $1 AND archived_at IS NULL;

-- name: CountLiveSubtasks :one
SELECT count(*)::integer FROM tasks WHERE parent_id = $1 AND archived_at IS NULL;

-- name: BoardHasTasks :one
SELECT (next_number > 1)::boolean FROM boards WHERE id = $1;

-- name: CreateTaskRoom :one
INSERT INTO rooms (workspace_id, type, name, position) VALUES ($1, 'task', $2, 0) RETURNING id;

-- name: InsertTask :one
INSERT INTO tasks (board_id, number, title, description, status_id, priority, created_by, estimate,
                   start_on, due_on, parent_id, milestone_id, position, room_id, started_at, completed_at, completed_by,
                   approval_required)
VALUES (sqlc.arg('board_id'), sqlc.arg('number'), sqlc.arg('title'), sqlc.arg('description'), sqlc.arg('status_id'),
        sqlc.arg('priority'), sqlc.arg('created_by'), sqlc.narg('estimate'), sqlc.narg('start_on'), sqlc.narg('due_on'),
        sqlc.narg('parent_id'), sqlc.narg('milestone_id'), sqlc.arg('position'), sqlc.arg('room_id'),
        sqlc.narg('started_at'), sqlc.narg('completed_at'), sqlc.narg('completed_by'), sqlc.arg('approval_required'))
RETURNING id;

-- name: GetTaskRow :one
SELECT * FROM tasks WHERE id = $1;

-- name: GetTaskRowForUpdate :one
SELECT * FROM tasks WHERE id = $1 FOR UPDATE;

-- name: GetTaskByNumber :one
SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id
WHERE b.workspace_id = $1 AND b.key = $2 AND t.number = $3 AND b.archived_at IS NULL;

-- name: UpdateTaskFields :exec
-- Writes the whole mutable row (internal/boards computes the new values).
UPDATE tasks SET
    title = sqlc.arg('title'), description = sqlc.arg('description'), status_id = sqlc.arg('status_id'),
    priority = sqlc.arg('priority'), estimate = sqlc.narg('estimate'), start_on = sqlc.narg('start_on'),
    due_on = sqlc.narg('due_on'), parent_id = sqlc.narg('parent_id'), milestone_id = sqlc.narg('milestone_id'),
    task_milestone_id = sqlc.narg('task_milestone_id'), position = sqlc.arg('position'),
    started_at = sqlc.narg('started_at'), completed_at = sqlc.narg('completed_at'), completed_by = sqlc.narg('completed_by'), updated_at = now()
WHERE id = sqlc.arg('id');

-- name: MoveTaskToBoard :exec
UPDATE tasks SET board_id = sqlc.arg('board_id'), number = sqlc.arg('number'), status_id = sqlc.arg('status_id'),
    milestone_id = NULL, parent_id = NULL, task_milestone_id = NULL, position = sqlc.arg('position'), updated_at = now()
WHERE id = sqlc.arg('id');

-- name: DetachSubtasks :exec
-- The subtasks lose their parent and its milestone (ADR-0063).
UPDATE tasks SET parent_id = NULL, task_milestone_id = NULL, updated_at = now() WHERE parent_id = $1;

-- name: TouchTask :exec
UPDATE tasks SET updated_at = now() WHERE id = $1;

-- name: SetTaskArchived :exec
UPDATE tasks SET archived_at = CASE WHEN sqlc.arg('archived')::boolean THEN now() ELSE NULL END, updated_at = now()
WHERE id = sqlc.arg('id');

-- name: StatusPositions :many
-- Live tasks of a status by position (the neighbours of a kanban move, renormalisation).
SELECT id, position FROM tasks WHERE status_id = $1 AND archived_at IS NULL ORDER BY position, id;

-- name: MaxStatusPosition :one
SELECT coalesce(max(position), 0)::double precision FROM tasks WHERE status_id = $1 AND archived_at IS NULL;

-- name: SetTaskPosition :exec
UPDATE tasks SET position = $2 WHERE id = $1;

-- name: ListTaskAssignees :many
SELECT * FROM task_assignees WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[])
ORDER BY task_id, is_lead DESC, assigned_at, user_id;

-- name: DeleteTaskAssignees :exec
DELETE FROM task_assignees WHERE task_id = $1;

-- name: InsertTaskAssignee :exec
INSERT INTO task_assignees (task_id, user_id, is_lead, note, assigned_by, assigned_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: ListTaskLabelIDs :many
SELECT task_id, label_id FROM task_labels WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[]);

-- name: DeleteTaskLabels :exec
DELETE FROM task_labels WHERE task_id = $1;

-- name: InsertTaskLabels :exec
INSERT INTO task_labels (task_id, label_id) SELECT sqlc.arg('task_id'), unnest(sqlc.arg('label_ids')::uuid[]);

-- name: ListTaskRelations :many
SELECT task_id, related_id, kind FROM task_relations
WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[]) OR related_id = ANY(sqlc.arg('task_ids')::uuid[]);

-- name: InsertTaskRelation :execrows
INSERT INTO task_relations (task_id, related_id, kind, created_by) VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: DeleteTaskRelation :execrows
-- relates / duplicates read both ways: either direction is removed.
DELETE FROM task_relations
WHERE kind = sqlc.arg('kind') AND ((task_id = sqlc.arg('a') AND related_id = sqlc.arg('b'))
    OR (kind <> 'blocks' AND task_id = sqlc.arg('b') AND related_id = sqlc.arg('a')));

-- name: TaskCounts :many
-- Per task: live subtasks and finished ones, live comments, attachments, checklist items and
-- done ones (ADR-0058 §2), Git links (ADR-0060).
SELECT t.id,
    (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.archived_at IS NULL)::integer AS subtasks,
    (SELECT count(*) FROM tasks s JOIN board_statuses st ON st.id = s.status_id
        WHERE s.parent_id = t.id AND s.archived_at IS NULL AND st.type IN ('completed', 'cancelled'))::integer AS subtasks_done,
    (SELECT count(*) FROM messages m WHERE m.room_id = t.room_id AND m.deleted_at IS NULL)::integer AS comments,
    (SELECT count(*) FROM task_attachments a WHERE a.task_id = t.id)::integer AS attachments,
    (SELECT count(*) FROM task_checklist_items ci WHERE ci.task_id = t.id)::integer AS checklist_total,
    (SELECT count(*) FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.done)::integer AS checklist_done,
    (SELECT count(*) FROM task_git_links g WHERE g.task_id = t.id)::integer AS git_links
FROM tasks t WHERE t.id = ANY(sqlc.arg('task_ids')::uuid[]);

-- name: ListTaskAttachments :many
SELECT f.* FROM task_attachments a JOIN files f ON f.id = a.file_id WHERE a.task_id = $1 ORDER BY a.position;

-- name: TaskAttachmentIDs :many
SELECT file_id FROM task_attachments WHERE task_id = $1 ORDER BY position;

-- name: DeleteTaskAttachments :exec
DELETE FROM task_attachments WHERE task_id = $1;

-- name: InsertTaskAttachment :exec
INSERT INTO task_attachments (task_id, file_id, position) VALUES ($1, $2, $3);

-- name: FilesAttachable :many
-- Uploads of the user in the workspace that are neither attached to a message nor to another
-- task (task_id's own ones count as free).
SELECT f.id FROM files f
WHERE f.id = ANY(sqlc.arg('ids')::uuid[]) AND f.uploader_id = sqlc.arg('user_id') AND f.workspace_id = sqlc.arg('workspace_id')::uuid
  AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM task_attachments ta WHERE ta.file_id = f.id AND ta.task_id <> sqlc.arg('task_id')::uuid);

-- ---- subscriptions, notifications ----

-- name: ListTaskSubscribers :many
SELECT * FROM task_subscribers WHERE task_id = $1;

-- name: ListViewerSubscriptions :many
SELECT * FROM task_subscribers WHERE user_id = $1 AND task_id = ANY(sqlc.arg('task_ids')::uuid[]);

-- name: ListTaskWatchers :many
-- The watchers of tasks (ADR-0076), in a stable order.
SELECT task_id, user_id FROM task_subscribers WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[]) AND watcher
ORDER BY task_id, user_id;

-- name: AddTaskWatchers :exec
-- Makes users watchers (and subscribers) of a task; an existing row keeps its muted flag.
INSERT INTO task_subscribers (task_id, user_id, watcher) SELECT sqlc.arg('task_id'), unnest(sqlc.arg('user_ids')::uuid[]), true
ON CONFLICT (task_id, user_id) DO UPDATE SET watcher = true;

-- name: UnsetTaskWatcher :one
-- Removes the watcher role (the subscription stays); false when the user was not a watcher.
WITH upd AS (
    UPDATE task_subscribers SET watcher = false WHERE task_id = sqlc.arg('task_id') AND user_id = sqlc.arg('user_id') AND watcher
    RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM upd)::boolean;

-- name: DeleteTaskSubscription :exec
DELETE FROM task_subscribers WHERE task_id = $1 AND user_id = $2;

-- name: ListBoardInvitees :many
-- The humans who are assignees, approvers or watchers of the live tasks of a board (ADR-0076:
-- «Позванные по карточкам» counts those of them without VIEW_BOARD).
SELECT DISTINCT x.user_id FROM tasks t
JOIN (SELECT a.task_id, a.user_id FROM task_assignees a
      UNION ALL SELECT p.task_id, p.user_id FROM task_approvers p
      UNION ALL SELECT w.task_id, w.user_id FROM task_subscribers w WHERE w.watcher) x ON x.task_id = t.id
JOIN users u ON u.id = x.user_id AND NOT u.is_bot
WHERE t.board_id = $1 AND t.archived_at IS NULL;

-- name: Subscribe :exec
-- Auto-subscription: keeps an existing row (a muted one stays muted).
INSERT INTO task_subscribers (task_id, user_id) SELECT sqlc.arg('task_id'), unnest(sqlc.arg('user_ids')::uuid[])
ON CONFLICT DO NOTHING;

-- name: SetSubscription :one
INSERT INTO task_subscribers (task_id, user_id, muted) VALUES ($1, $2, $3)
ON CONFLICT (task_id, user_id) DO UPDATE SET muted = EXCLUDED.muted
RETURNING *;

-- name: MarkNotified :exec
UPDATE task_subscribers SET notified_at = now() WHERE task_id = $1 AND user_id = ANY(sqlc.arg('user_ids')::uuid[]);

-- name: MarkTaskSeen :one
-- Returns whether the task was unread.
WITH old AS (
    SELECT (o.notified_at IS NOT NULL AND (o.seen_at IS NULL OR o.notified_at > o.seen_at)) AS unread
    FROM task_subscribers o WHERE o.task_id = sqlc.arg('task_id') AND o.user_id = sqlc.arg('user_id')
), upd AS (
    UPDATE task_subscribers u SET seen_at = now() WHERE u.task_id = sqlc.arg('task_id') AND u.user_id = sqlc.arg('user_id')
)
SELECT coalesce((SELECT old.unread FROM old), false)::boolean;

-- name: UnreadTaskIDs :many
-- Open tasks with something unseen for the user on live boards of the workspace (≤ 999); the
-- caller keeps those on boards the user sees. Closed ones are left out: the badge counts what
-- «Мои задачи» lists (GET /api/me/tasks?open=1), a closed task keeps its own unread mark.
SELECT t.id, t.board_id FROM task_subscribers s
JOIN tasks t ON t.id = s.task_id AND t.archived_at IS NULL
JOIN board_statuses st ON st.id = t.status_id AND st.type NOT IN ('completed', 'cancelled')
JOIN boards b ON b.id = t.board_id AND b.archived_at IS NULL AND b.workspace_id = sqlc.arg('workspace_id')
WHERE s.user_id = sqlc.arg('user_id') AND s.notified_at IS NOT NULL AND (s.seen_at IS NULL OR s.notified_at > s.seen_at)
ORDER BY s.notified_at DESC
LIMIT 999;

-- name: GetTaskLevel :many
-- The users' task notification level and workspace mute in the workspace ('all' when unset).
SELECT u.id::uuid AS user_id, coalesce(s.task_level, 'all')::text AS task_level,
    (s.muted_until IS NOT NULL AND s.muted_until > now())::boolean AS muted
FROM unnest(sqlc.arg('user_ids')::uuid[]) AS u (id)
LEFT JOIN workspace_notification_settings s ON s.user_id = u.id AND s.workspace_id = sqlc.arg('workspace_id');

-- ---- activity ----

-- name: InsertTaskActivity :one
INSERT INTO task_activity (task_id, board_id, actor_id, kind, before, after, rule_id)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.narg('rule_id'))
RETURNING *;

-- name: ListTaskActivity :many
SELECT * FROM task_activity WHERE task_id = sqlc.arg('task_id')
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC LIMIT sqlc.arg('lim');

-- name: ListTaskRoomMessages :many
SELECT * FROM messages WHERE room_id = sqlc.arg('room_id') AND deleted_at IS NULL
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC LIMIT sqlc.arg('lim');

-- name: ListBoardActivity :many
SELECT a.*, b.key AS board_key, t.number AS task_number FROM task_activity a
JOIN tasks t ON t.id = a.task_id
JOIN boards b ON b.id = t.board_id
WHERE a.board_id = sqlc.arg('board_id')
  AND (sqlc.narg('since')::timestamptz IS NULL OR a.created_at >= sqlc.narg('since')::timestamptz)
  AND (sqlc.narg('until')::timestamptz IS NULL OR a.created_at < sqlc.narg('until')::timestamptz)
  AND (sqlc.narg('actor')::uuid IS NULL OR a.actor_id = sqlc.narg('actor')::uuid)
  AND (sqlc.narg('kind')::text IS NULL OR a.kind = sqlc.narg('kind')::text)
  AND (sqlc.narg('after_id')::uuid IS NULL OR a.id > sqlc.narg('after_id')::uuid)
ORDER BY a.id
LIMIT sqlc.arg('lim');

-- ---- sweeper ----

-- name: DueAutoArchive :many
-- Live tasks finished longer ago than their board's auto_archive_days (0 = never), oldest first.
SELECT t.id, t.board_id, b.workspace_id FROM tasks t
JOIN boards b ON b.id = t.board_id AND b.archived_at IS NULL AND b.auto_archive_days > 0
JOIN board_statuses st ON st.id = t.status_id AND st.type IN ('completed', 'cancelled')
WHERE t.archived_at IS NULL AND t.completed_at IS NOT NULL
  AND t.completed_at < now() - make_interval(days => b.auto_archive_days)
ORDER BY t.completed_at
LIMIT sqlc.arg('lim');

-- name: ArchiveTasks :many
UPDATE tasks SET archived_at = now(), updated_at = now()
WHERE id = ANY(sqlc.arg('ids')::uuid[]) AND archived_at IS NULL
RETURNING id, board_id;

-- ---- approvals (ADR-0049) ----

-- name: ListTaskApprovers :many
SELECT * FROM task_approvers WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[])
ORDER BY task_id, added_at, user_id;

-- name: InsertTaskApprover :exec
-- clock_timestamp: approvers added in one request keep their order (added_at).
INSERT INTO task_approvers (task_id, user_id, added_by, added_at) VALUES ($1, $2, $3, clock_timestamp())
ON CONFLICT DO NOTHING;

-- name: DeleteTaskApprovers :exec
DELETE FROM task_approvers WHERE task_id = $1 AND user_id = ANY(sqlc.arg('user_ids')::uuid[]);

-- name: SetTaskApprovalRequired :exec
UPDATE tasks SET approval_required = $2, updated_at = now() WHERE id = $1;

-- name: SetApproverVote :exec
-- A vote; pending (withdraw) asks for it again: the reminders start over.
UPDATE task_approvers SET state = sqlc.arg('state')::text, comment = sqlc.arg('comment')::text,
    decided_at = CASE WHEN sqlc.arg('state')::text = 'pending' THEN NULL ELSE now() END,
    requested_at = CASE WHEN sqlc.arg('state')::text = 'pending' THEN now() ELSE requested_at END,
    reminders = CASE WHEN sqlc.arg('state')::text = 'pending' THEN 0 ELSE reminders END,
    reminded_at = CASE WHEN sqlc.arg('state')::text = 'pending' THEN NULL ELSE reminded_at END
WHERE task_id = sqlc.arg('task_id') AND user_id = sqlc.arg('user_id');

-- name: ResetTaskApprovals :many
-- The task changed (title / description / its attachments): every decided vote is asked for
-- again; pending ones keep their notice and reminder schedule (ADR-0082). Returns the
-- approvers whose vote was reset.
UPDATE task_approvers SET state = 'pending', comment = '', decided_at = NULL, requested_at = now(),
    reminders = 0, reminded_at = NULL
WHERE task_id = $1 AND state <> 'pending'
RETURNING user_id;

-- name: BoardApprovalNotifyDelay :one
SELECT approval_notify_delay_seconds FROM boards WHERE id = $1;

-- name: ScheduleApprovalNotices :exec
-- The approval notice of these approvers goes out in delay seconds (ADR-0082, DB time).
UPDATE task_approvers SET notify_due_at = now() + make_interval(secs => sqlc.arg('delay')::integer),
    notify_reason = sqlc.arg('reason')::text
WHERE task_id = sqlc.arg('task_id') AND user_id = ANY(sqlc.arg('user_ids')::uuid[]);

-- name: DueApprovalNoticeTasks :many
-- The tasks with an approval notice due (the partial index; cheap while none is due).
SELECT DISTINCT task_id FROM (
    SELECT task_id FROM task_approvers
    WHERE notify_due_at IS NOT NULL AND notify_due_at <= now()
    ORDER BY notify_due_at
    LIMIT sqlc.arg('lim')
) d;

-- name: ClaimApprovalNotices :many
-- Claims the due approval notices of one task: clears notify_due_at under the row locks
-- (SKIP LOCKED: another server instance's pass takes them, never both). A vote still pending
-- is asked for from now on: the daily reminders count from the notice (ADR-0082). The caller
-- sends only to pending votes.
WITH due AS (
    SELECT a.task_id, a.user_id FROM task_approvers a
    WHERE a.task_id = sqlc.arg('task_id') AND a.notify_due_at IS NOT NULL AND a.notify_due_at <= now()
    FOR UPDATE SKIP LOCKED
)
UPDATE task_approvers a SET notify_due_at = NULL,
    requested_at = CASE WHEN a.state = 'pending' THEN now() ELSE a.requested_at END,
    reminders = CASE WHEN a.state = 'pending' THEN 0 ELSE a.reminders END,
    reminded_at = CASE WHEN a.state = 'pending' THEN NULL ELSE a.reminded_at END
FROM due WHERE a.task_id = due.task_id AND a.user_id = due.user_id
RETURNING a.user_id, a.state, a.notify_reason, a.added_by;

-- name: DueApprovalReminders :many
-- Votes pending for 24 h since they were asked for or last reminded (≤ 3 reminders), on live
-- tasks of live boards that are neither finished nor rejected.
SELECT a.task_id, a.user_id FROM task_approvers a
JOIN tasks t ON t.id = a.task_id AND t.archived_at IS NULL
JOIN boards b ON b.id = t.board_id AND b.archived_at IS NULL
    AND b.disabled_features & 512 = 0 -- BOARD_FEATURE_APPROVALS (9) off: no reminders (ADR-0058 §3)
JOIN board_statuses st ON st.id = t.status_id AND st.type NOT IN ('completed', 'cancelled')
WHERE a.state = 'pending' AND a.reminders < 3 AND a.notify_due_at IS NULL
  AND coalesce(a.reminded_at, a.requested_at) <= now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM task_approvers r WHERE r.task_id = a.task_id AND r.state = 'rejected')
ORDER BY a.task_id, a.user_id
LIMIT sqlc.arg('lim');

-- name: ClaimApprovalReminders :many
-- Claims the reminders of one task: re-checks DueApprovalReminders' conditions under the row
-- locks, so a vote cast since, or another server instance's pass, never gets a second notice.
UPDATE task_approvers a SET reminders = a.reminders + 1, reminded_at = now()
FROM tasks t JOIN board_statuses st ON st.id = t.status_id JOIN boards b ON b.id = t.board_id
WHERE a.task_id = sqlc.arg('task_id') AND a.user_id = ANY(sqlc.arg('user_ids')::uuid[])
  AND t.id = a.task_id AND t.archived_at IS NULL AND st.type NOT IN ('completed', 'cancelled')
  AND b.disabled_features & 512 = 0
  AND a.state = 'pending' AND a.reminders < 3 AND a.notify_due_at IS NULL
  AND coalesce(a.reminded_at, a.requested_at) <= now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM task_approvers r WHERE r.task_id = a.task_id AND r.state = 'rejected')
RETURNING a.user_id;
