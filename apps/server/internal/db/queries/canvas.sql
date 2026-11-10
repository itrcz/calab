-- Canvas (ADR-0126). Access is computed in Go (perm.ComputeCanvasItem over CanvasItemPath /
-- CanvasItemPaths and the overrides of the levels); these queries return what is stored, visible
-- or not. The content (Yjs updates and snapshots) is opaque bytes. Mirror of queries/wiki.sql
-- without icons, covers, files, public links and search (the search section comes with H2).

-- ---- tree ----

-- name: ListCanvasRootChildren :many
-- The live items of the top level in order, with whether each has live children of its own (the
-- tree expands lazily). Cursor: the last row's (position, id); the zero cursor (0, the nil uuid) is
-- the first page (positions are ≥ 0, ids above the nil uuid).
-- Two queries without an OR, not one with «parent_id = $2 OR ($2 IS NULL AND parent_id IS NULL)»
-- and «cursor IS NULL OR …»: the generic plan of that one read both levels, then filtered and sorted
-- them whole on every page (second review, minor 13). Each of these starts on canvas_items_tree_idx
-- at the cursor of its level.
SELECT sqlc.embed(p),
    EXISTS (SELECT 1 FROM canvas_items c WHERE c.parent_id = p.id AND c.trashed_at IS NULL)::boolean AS has_children
FROM canvas_item_heads p
WHERE p.workspace_id = sqlc.arg('workspace_id')::uuid
  AND p.parent_id IS NULL
  AND p.trashed_at IS NULL
  AND (p.position, p.id) > (sqlc.arg('cursor_position')::int, sqlc.arg('cursor_id')::uuid)
ORDER BY p.position, p.id
LIMIT sqlc.arg('lim');

-- name: ListCanvasFolderChildren :many
-- The live children of a folder, like ListCanvasRootChildren.
SELECT sqlc.embed(p),
    EXISTS (SELECT 1 FROM canvas_items c WHERE c.parent_id = p.id AND c.trashed_at IS NULL)::boolean AS has_children
FROM canvas_item_heads p
WHERE p.workspace_id = sqlc.arg('workspace_id')::uuid
  AND p.parent_id = sqlc.arg('parent_id')::uuid
  AND p.trashed_at IS NULL
  AND (p.position, p.id) > (sqlc.arg('cursor_position')::int, sqlc.arg('cursor_id')::uuid)
ORDER BY p.position, p.id
LIMIT sqlc.arg('lim');

-- name: ListCanvasTrash :many
-- The trash: roots of deletions, the most recent first. Cursor: the last row's (trashed_at, id);
-- the first page passes ('infinity', the max uuid), not NULL: a «cursor IS NULL OR …» is no index
-- condition in the generic plan, and deep pages would read the trash from its start.
SELECT * FROM canvas_item_heads
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND trashed_root
  AND (trashed_at, id) < (sqlc.arg('cursor_trashed')::timestamptz, sqlc.arg('cursor_id')::uuid)
ORDER BY trashed_at DESC, id DESC
LIMIT sqlc.arg('lim');

-- name: ListCanvasTrashRootsAll :many
-- Every trash root of a workspace («Очистить корзину»: the caller deletes those they may).
SELECT * FROM canvas_item_heads WHERE workspace_id = $1 AND trashed_root ORDER BY trashed_at, id;

-- name: GetCanvasItem :one
SELECT * FROM canvas_item_heads WHERE id = $1;

-- name: GetCanvasItemForUpdate :one
SELECT * FROM canvas_item_heads WHERE id = $1 FOR UPDATE;

-- name: GetCanvasItemText :one
-- The item with its text (the export of plain text, a version's check).
SELECT * FROM canvas_items WHERE id = $1;

-- name: ListCanvasItemsByIDs :many
SELECT * FROM canvas_item_heads WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListCanvasItemsWithChildren :many
-- Which of the items have live children (CanvasItem.has_children outside a listing).
SELECT DISTINCT parent_id::uuid FROM canvas_items
WHERE parent_id = ANY(sqlc.arg('ids')::uuid[]) AND trashed_at IS NULL;

-- name: CanvasItemPath :many
-- The item and its ancestors, the top-level item first (depth = distance from the item).
-- Bounded at 64 levels (the API keeps trees ≤ 32 deep).
WITH RECURSIVE up (id, parent_id, depth) AS (
    SELECT w.id, w.parent_id, 0 FROM canvas_items w WHERE w.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT p.id, p.parent_id, up.depth + 1 FROM canvas_items p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT sqlc.embed(wp), up.depth::int AS depth
FROM up JOIN canvas_item_heads wp ON wp.id = up.id
ORDER BY up.depth DESC;

-- name: CanvasItemPaths :many
-- The chains of several items at once (a listing's ancestors, the trash, search hits, an
-- event): every item with its ancestors, per leaf the top-level item first.
WITH RECURSIVE up (leaf, id, parent_id, depth) AS (
    SELECT w.id, w.id, w.parent_id, 0 FROM canvas_items w WHERE w.id = ANY(sqlc.arg('ids')::uuid[])
    UNION ALL
    SELECT up.leaf, p.id, p.parent_id, up.depth + 1 FROM canvas_items p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT up.leaf::uuid AS leaf, sqlc.embed(wp), up.depth::int AS depth
FROM up JOIN canvas_item_heads wp ON wp.id = up.id
ORDER BY up.leaf, up.depth DESC;

-- name: CountCanvasSubtreeDepth :one
-- The depth of the deepest descendant below an item (0 = no children): a move keeps
-- depth(target) + 1 + this ≤ 32.
WITH RECURSIVE down (id, depth) AS (
    SELECT w.id, 0 FROM canvas_items w WHERE w.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id, down.depth + 1 FROM canvas_items c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
)
SELECT coalesce(max(depth), 0)::int FROM down;

-- name: LockCanvasTree :exec
-- Serializes the structural changes of one workspace's Canvas (positions among siblings, moves
-- and their cycle check, restore). Taken after any workspaces row lock of the transaction, never
-- before one (the order of the Disk's LockDiskTree and the Wiki's LockWikiTree).
SELECT pg_advisory_xact_lock(hashtext('calaba.canvas.' || sqlc.arg('workspace_id')::uuid::text));

-- name: CountLiveCanvases :one
-- Live (not trashed) canvases of a workspace, folders not counted: the plan limit of ADR-0126
-- (addendum 2026-10-23) counts these.
SELECT count(*) FROM canvas_items WHERE workspace_id = $1 AND kind = 'canvas' AND trashed_at IS NULL;

-- name: CountCanvasRestoreCanvases :one
-- The canvases RestoreCanvasSubtree would bring back with trash root id (the same subtree): the
-- plan limit is checked before the restore.
WITH RECURSIVE root AS (
    SELECT r.id, r.trashed_at FROM canvas_items r WHERE r.id = sqlc.arg('id')::uuid AND r.trashed_root
), sub (id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT c.id FROM canvas_items c JOIN sub ON c.parent_id = sub.id
    WHERE NOT c.trashed_root AND c.trashed_at = (SELECT root.trashed_at FROM root)
)
SELECT count(*) FROM canvas_items w JOIN sub ON w.id = sub.id WHERE w.kind = 'canvas';

-- name: CreateCanvasItem :one
-- A new item at position (under LockCanvasTree: the caller takes the slot after its last sibling).
INSERT INTO canvas_items (workspace_id, parent_id, kind, name, owner_id, updated_by, position)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('parent_id'), sqlc.arg('kind'), sqlc.arg('name'), sqlc.narg('owner_id'),
        sqlc.narg('owner_id'), sqlc.arg('position'))
RETURNING *;

-- name: UpdateCanvasItem :one
-- Rename (name), the emoji and the restricted switch.
UPDATE canvas_items SET
    name       = coalesce(sqlc.narg('name'), name),
    emoji      = coalesce(sqlc.narg('emoji'), emoji),
    restricted = coalesce(sqlc.narg('restricted'), restricted),
    updated_by = sqlc.narg('updated_by'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING id, workspace_id, parent_id, kind, name, position, owner_id, restricted, preview, doc_size, next_seq,
    updated_by, created_at, updated_at, trashed_at, trashed_by, trashed_root, emoji;

-- name: MoveCanvasItem :one
-- A move (under LockCanvasTree): the item goes under parent_id (NULL = the top level) at position
-- (a free slot between its new neighbours, see canvas.slot). The old siblings keep their gap.
-- Returns the head columns (CanvasItemHead): the text stays where it is.
UPDATE canvas_items SET
    parent_id  = sqlc.narg('parent_id')::uuid,
    position   = sqlc.arg('position')::int,
    updated_by = sqlc.narg('updated_by'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING id, workspace_id, parent_id, kind, name, position, owner_id, restricted, preview, doc_size, next_seq,
    updated_by, created_at, updated_at, trashed_at, trashed_by, trashed_root, emoji;

-- name: LastCanvasRootPosition :one
-- The highest position among the live top-level items other than exclude_id, -1 when none.
SELECT coalesce(max(position), -1)::int FROM canvas_items
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND parent_id IS NULL AND trashed_at IS NULL
  AND id <> sqlc.arg('exclude_id')::uuid;

-- name: LastCanvasFolderPosition :one
-- LastCanvasRootPosition for the live children of a folder.
SELECT coalesce(max(position), -1)::int FROM canvas_items
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND parent_id = sqlc.arg('parent_id')::uuid AND trashed_at IS NULL
  AND id <> sqlc.arg('exclude_id')::uuid;

-- name: CanvasRootSiblingPositions :many
-- The positions of the live top-level items other than exclude_id from index off on, in order:
-- the neighbours of a move to an index. Two queries without an OR, like the listings.
SELECT position FROM canvas_items
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND parent_id IS NULL AND trashed_at IS NULL
  AND id <> sqlc.arg('exclude_id')::uuid
ORDER BY position, id
OFFSET sqlc.arg('off') LIMIT sqlc.arg('lim');

-- name: CanvasFolderSiblingPositions :many
-- CanvasRootSiblingPositions for the live children of a folder.
SELECT position FROM canvas_items
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND parent_id = sqlc.arg('parent_id')::uuid AND trashed_at IS NULL
  AND id <> sqlc.arg('exclude_id')::uuid
ORDER BY position, id
OFFSET sqlc.arg('off') LIMIT sqlc.arg('lim');

-- name: SpreadCanvasSiblings :exec
-- Only when two neighbours have no free position between them (or the last one is near the int
-- limit): renumbers the live children of a parent (NULL = the top level) other than exclude_id
-- to 0, step, 2·step.. in their order, leaving the slot at index hole free (hole < 0: none).
WITH ordered AS (
    SELECT s.id, (row_number() OVER (ORDER BY s.position, s.id) - 1)::int AS rn
    FROM canvas_items s
    WHERE s.workspace_id = sqlc.arg('workspace_id')::uuid AND s.trashed_at IS NULL
      AND (s.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND s.parent_id IS NULL))
      AND s.id <> sqlc.arg('exclude_id')::uuid
), spread AS (
    SELECT id, (CASE WHEN sqlc.arg('hole')::int >= 0 AND rn >= sqlc.arg('hole')::int THEN rn + 1 ELSE rn END)
               * sqlc.arg('step')::int AS pos
    FROM ordered
)
UPDATE canvas_items w SET position = spread.pos
FROM spread WHERE w.id = spread.id AND w.position <> spread.pos;

-- name: SetCanvasContent :one
-- After a snapshot (ADR-0126 §3 SNAPSHOT_POST): the text for search, the preview and the size;
-- the client caps plain_text at 256 KiB and preview at 200 characters. Canvases only.
UPDATE canvas_items SET
    plain_text = sqlc.arg('plain_text'),
    preview    = sqlc.arg('preview'),
    doc_size   = sqlc.arg('doc_size'),
    updated_by = sqlc.narg('updated_by'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND kind = 'canvas'
RETURNING id, workspace_id, parent_id, kind, name, position, owner_id, restricted, preview, doc_size, next_seq,
    updated_by, created_at, updated_at, trashed_at, trashed_by, trashed_root, emoji;

-- name: TrashCanvasSubtree :many
-- Moves an item and its live subtree to the trash in one UPDATE: one timestamp for all, the item
-- is the root. Descendants trashed before stay their own roots. Returns the ids (the items:
-- ListCanvasItemsByIDs).
WITH RECURSIVE sub (id) AS (
    SELECT w.id FROM canvas_items w WHERE w.id = sqlc.arg('id')::uuid AND w.trashed_at IS NULL
    UNION ALL
    SELECT c.id FROM canvas_items c JOIN sub ON c.parent_id = sub.id WHERE c.trashed_at IS NULL
)
UPDATE canvas_items w SET
    trashed_at   = sqlc.arg('trashed_at')::timestamptz,
    trashed_by   = sqlc.narg('trashed_by')::uuid,
    trashed_root = (w.id = sqlc.arg('id')::uuid)
FROM sub WHERE w.id = sub.id
RETURNING w.id;

-- name: RestoreCanvasSubtree :many
-- Restores a trash root and the part of its subtree trashed with it (same trashed_at, not a
-- root of its own). parent_id: where the root goes back (the caller picks the top level when the
-- old parent is gone or in the trash); the root goes to position (the caller's slot after the
-- last sibling, under LockCanvasTree). Returns the ids.
WITH RECURSIVE root AS (
    SELECT r.id, r.workspace_id, r.trashed_at FROM canvas_items r WHERE r.id = sqlc.arg('id')::uuid AND r.trashed_root
), sub (id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT c.id FROM canvas_items c JOIN sub ON c.parent_id = sub.id
    WHERE NOT c.trashed_root AND c.trashed_at = (SELECT root.trashed_at FROM root)
)
UPDATE canvas_items w SET
    trashed_at   = NULL,
    trashed_by   = NULL,
    trashed_root = false,
    parent_id    = CASE WHEN w.id = sqlc.arg('id')::uuid THEN sqlc.narg('parent_id')::uuid ELSE w.parent_id END,
    position     = CASE WHEN w.id = sqlc.arg('id')::uuid THEN sqlc.arg('position')::int ELSE w.position END,
    updated_at   = CASE WHEN w.id = sqlc.arg('id')::uuid THEN now() ELSE w.updated_at END
FROM sub WHERE w.id = sub.id
RETURNING w.id;

-- name: DeleteCanvasItem :execrows
-- Delete forever: the item and its subtree (CASCADE: updates, snapshots, versions, overrides;
-- the journal keeps its entries with item_id NULL). Canvases hold no files.
DELETE FROM canvas_items WHERE id = $1;

-- ---- trash retention ----

-- name: ListCanvasSweepWorkspaces :many
-- Workspaces with a trash retention and at least one expired trash root (the hourly sweeper), in a
-- fixed order.
SELECT w.id, w.canvas_trash_days::int AS days FROM workspaces w
WHERE w.canvas_trash_days IS NOT NULL AND EXISTS (
    SELECT 1 FROM canvas_items p WHERE p.workspace_id = w.id AND p.trashed_root
      AND p.trashed_at < sqlc.arg('now')::timestamptz - make_interval(days => w.canvas_trash_days))
ORDER BY w.id;

-- name: ListCanvasTrashRootsBefore :many
-- The sweeper's batch of one workspace: its trash roots deleted before the cutoff, oldest first.
SELECT * FROM canvas_item_heads
WHERE workspace_id = sqlc.arg('workspace_id') AND trashed_root AND trashed_at < sqlc.arg('cutoff')::timestamptz
ORDER BY trashed_at, id
LIMIT sqlc.arg('lim');

-- name: GetCanvasTrashDays :one
SELECT canvas_trash_days FROM workspaces WHERE id = $1;

-- name: SetCanvasTrashDays :exec
UPDATE workspaces SET canvas_trash_days = sqlc.narg('days') WHERE id = sqlc.arg('id');

-- ---- permissions ----

-- name: ListCanvasPermissions :many
SELECT * FROM canvas_permissions WHERE canvas_id = $1 ORDER BY target_type, target_id;

-- name: ListCanvasPermissionsForItems :many
-- The overrides of several items at once (a path, a listing).
SELECT * FROM canvas_permissions WHERE canvas_id = ANY(sqlc.arg('ids')::uuid[]) ORDER BY canvas_id, target_type, target_id;

-- name: ListSharedCanvasItems :many
-- Which of the items have overrides (CanvasItem.shared).
SELECT DISTINCT canvas_id FROM canvas_permissions WHERE canvas_id = ANY(sqlc.arg('ids')::uuid[]);

-- name: DeleteCanvasPermissions :exec
DELETE FROM canvas_permissions WHERE canvas_id = $1;

-- name: InsertCanvasPermission :exec
INSERT INTO canvas_permissions (canvas_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5);

-- ---- journal ----

-- name: InsertCanvasActivity :one
INSERT INTO canvas_activity (workspace_id, item_id, item_name, actor_id, kind, before, after, private)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('item_id'), sqlc.arg('item_name'), sqlc.narg('actor_id'), sqlc.arg('kind'),
        sqlc.narg('before'), sqlc.narg('after'), sqlc.arg('private'))
RETURNING *;

-- name: MarkCanvasSubtreeActivityPrivate :exec
-- Before a delete forever (addendum 2026-10-14 of ADR-0094 / ADR-0096 §2, ADR-0126 §2): the
-- journal entries of every node of the subtree that lies under a restricted node (restricted:
-- the root's chain has one) become private — the workspace journal cannot check a chain that is
-- gone.
WITH RECURSIVE sub (id, r) AS (
    SELECT t.id, sqlc.arg('restricted')::bool FROM canvas_items t WHERE t.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id, sub.r OR c.restricted FROM canvas_items c JOIN sub ON c.parent_id = sub.id
)
UPDATE canvas_activity a SET private = true FROM sub WHERE a.item_id = sub.id AND sub.r AND NOT a.private;

-- name: ListCanvasItemActivity :many
-- An item's history, the newest first; cursor: the last id (the max uuid = the first page, an
-- index condition unlike «cursor IS NULL OR …»).
SELECT * FROM canvas_activity
WHERE item_id = sqlc.arg('item_id')::uuid AND id < sqlc.arg('cursor')::uuid
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: ListWorkspaceCanvasActivity :many
-- The Canvas section's history (CANVAS_MANAGE), the newest first, optionally of one actor.
SELECT * FROM canvas_activity
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('actor_id')::uuid IS NULL OR actor_id = sqlc.narg('actor_id')::uuid)
  AND id < sqlc.arg('cursor')::uuid -- the max uuid = the first page
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: LastCanvasActivity :one
-- The newest journal entry of an item (the rename coalescing of ADR-0081).
SELECT * FROM canvas_activity WHERE item_id = $1 ORDER BY id DESC LIMIT 1;

-- name: UpdateCanvasActivityAfter :exec
UPDATE canvas_activity SET after = sqlc.narg('after'), item_name = sqlc.arg('item_name'), created_at = now()
WHERE id = sqlc.arg('id');

-- name: DeleteCanvasActivity :exec
DELETE FROM canvas_activity WHERE id = $1;

-- ---- versions ----

-- name: InsertCanvasVersion :one
INSERT INTO canvas_versions (canvas_id, state, authors, state_hash)
VALUES (sqlc.arg('canvas_id'), sqlc.arg('state'), sqlc.arg('authors')::uuid[], sha256(sqlc.arg('state')))
RETURNING id, canvas_id, authors, created_at, octet_length(state)::int AS size;

-- name: LastCanvasVersion :one
-- The newest version of a canvas without its state: the 10-minute rule and the «content
-- changed» check of ADR-0126 §1 (state_hash against sha256 of the new state; NULL for a version
-- stored before 00119, see SetCanvasVersionHash).
SELECT id, created_at, state_hash FROM canvas_versions
WHERE canvas_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: SetCanvasVersionHash :one
-- The state_hash of a version stored before 00119, computed once and kept.
UPDATE canvas_versions SET state_hash = coalesce(state_hash, sha256(state)) WHERE id = $1
RETURNING state_hash::bytea;

-- name: ListCanvasVersions :many
-- A canvas's versions without their state, the newest first; cursor: the last id (versions are
-- uuidv7: id order is creation order).
SELECT id, canvas_id, authors, created_at, octet_length(state)::int AS size
FROM canvas_versions
WHERE canvas_id = sqlc.arg('canvas_id')::uuid
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: GetCanvasVersion :one
-- One version with its state (GET …/versions/{vid}); canvas_id guards against a foreign id.
SELECT * FROM canvas_versions WHERE id = sqlc.arg('id') AND canvas_id = sqlc.arg('canvas_id');

-- name: PruneCanvasVersions :execrows
-- Keeps the newest 50 versions of a canvas.
DELETE FROM canvas_versions d
WHERE d.canvas_id = sqlc.arg('canvas_id')::uuid
  AND d.id NOT IN (
      SELECT v.id FROM canvas_versions v WHERE v.canvas_id = sqlc.arg('canvas_id')::uuid
      ORDER BY v.created_at DESC, v.id DESC LIMIT 50);

-- ---- content: updates and snapshots ----

-- name: AppendCanvasUpdate :one
-- Stores one Yjs update of a live canvas under the canvas's next seq; the counter is taken and
-- bumped in the same statement (the row lock orders concurrent appends of the canvas). No row
-- when the item is gone, in the trash or a folder.
WITH s AS (
    UPDATE canvas_items SET next_seq = next_seq + 1
    WHERE id = sqlc.arg('canvas_id')::uuid AND trashed_at IS NULL AND kind = 'canvas'
    RETURNING id, next_seq - 1 AS seq
)
INSERT INTO canvas_updates (canvas_id, seq, data, author_id)
SELECT s.id, s.seq, sqlc.arg('data')::bytea, sqlc.narg('author_id')::uuid FROM s
RETURNING seq, created_at;

-- name: ListCanvasUpdatesSince :many
-- The updates after a seq (the snapshot's through_seq), in order.
SELECT seq, data, author_id, created_at FROM canvas_updates
WHERE canvas_id = sqlc.arg('canvas_id') AND seq > sqlc.arg('after_seq')::bigint
ORDER BY seq
LIMIT sqlc.arg('lim');

-- name: CanvasUpdatesSince :one
-- How many updates and bytes are stored after a seq: the COMPACT_REQUEST thresholds (> 500
-- updates or > 1 MiB) and the authors of the next version.
SELECT count(*)::int AS updates, coalesce(sum(octet_length(data)), 0)::bigint AS bytes,
    coalesce(array_agg(DISTINCT author_id) FILTER (WHERE author_id IS NOT NULL), '{}')::uuid[] AS authors
FROM canvas_updates
WHERE canvas_id = sqlc.arg('canvas_id') AND seq > sqlc.arg('after_seq')::bigint;

-- name: DeleteCanvasUpdatesThrough :execrows
-- After a snapshot: the updates it contains.
DELETE FROM canvas_updates WHERE canvas_id = sqlc.arg('canvas_id') AND seq <= sqlc.arg('through_seq')::bigint;

-- name: GetCanvasSnapshot :one
SELECT * FROM canvas_snapshots WHERE canvas_id = $1;

-- name: GetCanvasSnapshotSeq :one
-- The through_seq of the canvas's snapshot without its state (the sync socket's catch-up and
-- the COMPACT_REQUEST check).
SELECT through_seq FROM canvas_snapshots WHERE canvas_id = $1;

-- name: UpsertCanvasSnapshot :execrows
-- Saves a snapshot unless a newer one is stored (through_seq never goes back); 0 rows = stale.
-- The caller checks through_seq < canvas_items.next_seq.
INSERT INTO canvas_snapshots (canvas_id, state, through_seq, saved_by)
VALUES (sqlc.arg('canvas_id'), sqlc.arg('state'), sqlc.arg('through_seq'), sqlc.narg('saved_by'))
ON CONFLICT (canvas_id) DO UPDATE SET
    state       = EXCLUDED.state,
    through_seq = EXCLUDED.through_seq,
    saved_by    = EXCLUDED.saved_by,
    saved_at    = now()
WHERE canvas_snapshots.through_seq <= EXCLUDED.through_seq;

-- ---- takeover, detach ----

-- name: SetCanvasItemOwner :exec
-- «Сделать меня владельцем» (addendum 2026-10-14): a former member's private item gets a new owner.
UPDATE canvas_items SET owner_id = sqlc.arg('owner_id'), updated_by = sqlc.arg('owner_id'), updated_at = now()
WHERE id = sqlc.arg('id');

-- name: ListCanvasSubtree :many
-- The items below an item (not the item itself), parents before children, trashed or not: a
-- trash, delete forever or move first detaches what the actor does not see (addendum 2026-10-14
-- of ADR-0096 §2, ADR-0126 §2). Bounded at 64 levels.
WITH RECURSIVE down (id, depth) AS (
    SELECT c.id, 1 FROM canvas_items c WHERE c.parent_id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id, down.depth + 1 FROM canvas_items c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
)
SELECT sqlc.embed(wp), down.depth::int AS depth
FROM down JOIN canvas_item_heads wp ON wp.id = down.id
ORDER BY down.depth, wp.id;

-- name: DetachCanvasItem :one
-- Detaches an item (with its subtree) to the top level at position (the caller's slot after the
-- last live top-level item, under LockCanvasTree), with the flag that keeps its access (perm.Detached); in the trash it
-- becomes a trash root of its own.
UPDATE canvas_items w SET
    parent_id    = NULL,
    restricted   = sqlc.arg('restricted'),
    trashed_root = w.trashed_at IS NOT NULL,
    position     = CASE WHEN w.trashed_at IS NULL THEN sqlc.arg('position')::int ELSE w.position END,
    updated_at   = now()
WHERE w.id = sqlc.arg('id')
RETURNING w.id;

-- name: RetimeCanvasTrash :exec
-- The sweeper detached a trashed item from someone else's expired trash root: it and what was
-- trashed with it get a trash time of their own (now), so the retention counts from here.
WITH RECURSIVE root AS (
    SELECT r.id, r.trashed_at FROM canvas_items r WHERE r.id = sqlc.arg('id')::uuid AND r.trashed_at IS NOT NULL
), sub (id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT c.id FROM canvas_items c JOIN sub ON c.parent_id = sub.id
    WHERE NOT c.trashed_root AND c.trashed_at = (SELECT root.trashed_at FROM root)
)
UPDATE canvas_items w SET trashed_at = sqlc.arg('trashed_at')::timestamptz FROM sub WHERE w.id = sub.id;

-- ---- search ----

-- name: SearchCanvasItems :many
-- Search candidates (ADR-0126 §6, the shape of SearchWikiPages): live canvases and folders of the
-- given workspaces matching the full-text query (tsq: searchq.Query.TS, over
-- canvas_items_search_idx; the expression is search.CanvasVector) or, by name, the words with
-- typos or as substrings (words: searchq.Query.Text, phrase: searchq.Like(Query.Text) of the Folded
-- query — «ё» = «е», CBF-169 — over
-- canvas_items_name_fold_trgm_idx). Ranked by greatest(ts_rank_cd, word_similarity) × freshness
-- 1 / (1 + days / 30) of updated_at at now, then id; at most lim (the candidate cap). The access
-- filter (perm.ComputeCanvasItemIn over CanvasItemPaths) and the keyset page are applied by the
-- caller; the snippets come from CanvasSearchHeadlines.
SELECT w.id, w.workspace_id, w.parent_id, w.kind, w.name, w.updated_at, w.updated_by,
    ((greatest(
        ts_rank_cd(to_tsvector('russian', w.name || ' ' || w.plain_text) || to_tsvector('simple', w.name || ' ' || w.plain_text),
                   to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text)),
        word_similarity(sqlc.arg('words')::text, translate(w.name, 'Ёё', 'Ее'))))
     * (1.0 / (1.0 + greatest(0, extract(epoch FROM (sqlc.arg('now')::timestamptz - w.updated_at)))::float8 / 2592000.0)))::float8 AS score
FROM canvas_items w
WHERE w.workspace_id = ANY(sqlc.arg('workspace_ids')::uuid[]) AND w.trashed_at IS NULL
  AND ((to_tsvector('russian', w.name || ' ' || w.plain_text) || to_tsvector('simple', w.name || ' ' || w.plain_text))
          @@ (to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text))
       OR sqlc.arg('words')::text <% translate(w.name, 'Ёё', 'Ее')
       OR translate(w.name, 'Ёё', 'Ее') ILIKE sqlc.arg('phrase')::text)
ORDER BY score DESC, w.id DESC
LIMIT sqlc.arg('lim');

-- name: CanvasSearchHeadlines :many
-- The highlighted fragments of a page of search hits: of the text on the canvas, else of the name
-- (searchq.HeadlineOptions).
SELECT w.id, ts_headline('russian', coalesce(nullif(w.plain_text, ''), w.name),
    to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text),
    sqlc.arg('options')::text)::text AS snippet
FROM canvas_items w WHERE w.id = ANY(sqlc.arg('ids')::uuid[]);
