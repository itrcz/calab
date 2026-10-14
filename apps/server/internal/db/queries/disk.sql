-- Disk (ADR-0094). Access is computed in Go (perm.ComputeDiskItem) over DiskItemPath and the
-- overrides of its levels; these queries return what is stored, visible or not.

-- name: ListDiskFolderByName :many
-- A folder's live items (parent_id NULL = the root), folders first, then by name ignoring case.
-- Cursor: the last row's (folder_rank, lower(name), id); cursor_id NULL = the first page.
SELECT sqlc.embed(di), coalesce(f.size, 0)::bigint AS size, lower(di.name)::text AS lname
FROM disk_items di
LEFT JOIN files f ON f.id = di.file_id
WHERE di.workspace_id = sqlc.arg('workspace_id')::uuid
  AND (di.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND di.parent_id IS NULL))
  AND di.trashed_at IS NULL
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR ((di.kind <> 'folder')::int, lower(di.name), di.id)
          > (sqlc.arg('cursor_rank')::int, sqlc.arg('cursor_name')::text, sqlc.narg('cursor_id')::uuid))
ORDER BY (di.kind <> 'folder')::int, lower(di.name), di.id
LIMIT sqlc.arg('lim');

-- name: ListDiskFolderByUpdated :many
-- A folder's live items, the most recently changed first. Cursor: the last row's
-- (updated_at, id).
SELECT sqlc.embed(di), coalesce(f.size, 0)::bigint AS size
FROM disk_items di
LEFT JOIN files f ON f.id = di.file_id
WHERE di.workspace_id = sqlc.arg('workspace_id')::uuid
  AND (di.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND di.parent_id IS NULL))
  AND di.trashed_at IS NULL
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR (di.updated_at, di.id) < (sqlc.arg('cursor_updated')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY di.updated_at DESC, di.id DESC
LIMIT sqlc.arg('lim');

-- name: ListDiskFolderBySize :many
-- A folder's live items, folders first (by name), then files the largest first. Cursor: the
-- last row's (folder_rank, size, lower(name), id).
SELECT sqlc.embed(di), coalesce(f.size, 0)::bigint AS size, lower(di.name)::text AS lname
FROM disk_items di
LEFT JOIN files f ON f.id = di.file_id
WHERE di.workspace_id = sqlc.arg('workspace_id')::uuid
  AND (di.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND di.parent_id IS NULL))
  AND di.trashed_at IS NULL
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR ((di.kind <> 'folder')::int, -coalesce(f.size, 0), lower(di.name), di.id)
          > (sqlc.arg('cursor_rank')::int, -sqlc.arg('cursor_size')::bigint, sqlc.arg('cursor_name')::text, sqlc.narg('cursor_id')::uuid))
ORDER BY (di.kind <> 'folder')::int, -coalesce(f.size, 0), lower(di.name), di.id
LIMIT sqlc.arg('lim');

-- name: ListDiskTrash :many
-- The trash: roots of deletions, the most recent first. Cursor: the last row's (trashed_at, id).
SELECT sqlc.embed(di), coalesce(f.size, 0)::bigint AS size
FROM disk_items di
LEFT JOIN files f ON f.id = di.file_id
WHERE di.workspace_id = sqlc.arg('workspace_id')::uuid AND di.trashed_root
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR (di.trashed_at, di.id) < (sqlc.arg('cursor_trashed')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY di.trashed_at DESC, di.id DESC
LIMIT sqlc.arg('lim');

-- name: ListDiskTrashRootsAll :many
-- Every trash root of a workspace («Очистить корзину»: the caller deletes those they may).
SELECT * FROM disk_items WHERE workspace_id = $1 AND trashed_root ORDER BY trashed_at, id;

-- name: GetDiskItem :one
SELECT * FROM disk_items WHERE id = $1;

-- name: GetDiskItemForUpdate :one
SELECT * FROM disk_items WHERE id = $1 FOR UPDATE;

-- name: GetDiskItemByFile :one
-- The disk item of a file (files.CanRead: a file of the Disk is read through its item).
SELECT * FROM disk_items WHERE file_id = $1;

-- name: ListDiskItemsByIDs :many
SELECT * FROM disk_items WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: DiskItemPath :many
-- The item and its ancestors, the topmost first (depth = distance from the item). Bounded at
-- 64 levels (the API keeps trees ≤ 32 deep).
WITH RECURSIVE up (id, parent_id, depth) AS (
    SELECT d.id, d.parent_id, 0 FROM disk_items d WHERE d.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT p.id, p.parent_id, up.depth + 1 FROM disk_items p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT sqlc.embed(di), up.depth::int AS depth
FROM up JOIN disk_items di ON di.id = up.id
ORDER BY up.depth DESC;

-- name: CountDiskSubtreeDepth :one
-- The depth of the deepest descendant below an item (0 = no children): a move keeps
-- depth(target) + 1 + this ≤ 32.
WITH RECURSIVE down (id, depth) AS (
    SELECT d.id, 0 FROM disk_items d WHERE d.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id, down.depth + 1 FROM disk_items c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
)
SELECT coalesce(max(depth), 0)::int FROM down;

-- name: CreateDiskItem :one
INSERT INTO disk_items (workspace_id, parent_id, kind, name, file_id, owner_id)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('parent_id'), sqlc.arg('kind'), sqlc.arg('name'), sqlc.narg('file_id'),
        sqlc.narg('owner_id'))
RETURNING *;

-- name: DiskNameTaken :one
-- Whether a live item of the folder already has the name (ignoring case); the upload picks
-- «name (2)» instead.
SELECT EXISTS (
    SELECT 1 FROM disk_items
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND (parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND parent_id IS NULL))
      AND lower(name) = lower(sqlc.arg('name')::text) AND trashed_at IS NULL
      AND id <> coalesce(sqlc.narg('except_id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- name: UpdateDiskItem :one
-- Rename (name), move (set_parent + parent_id; NULL = the root) and the restricted switch.
UPDATE disk_items SET
    name       = coalesce(sqlc.narg('name'), name),
    parent_id  = CASE WHEN sqlc.arg('set_parent')::boolean THEN sqlc.narg('parent_id')::uuid ELSE parent_id END,
    restricted = coalesce(sqlc.narg('restricted'), restricted),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: TouchDiskItem :exec
UPDATE disk_items SET updated_at = now() WHERE id = $1;

-- name: TrashDiskSubtree :many
-- Moves an item and its live subtree to the trash in one UPDATE: one timestamp for all, the
-- item is the root. Descendants trashed before stay their own roots.
WITH RECURSIVE sub (id) AS (
    SELECT d.id FROM disk_items d WHERE d.id = sqlc.arg('id')::uuid AND d.trashed_at IS NULL
    UNION ALL
    SELECT c.id FROM disk_items c JOIN sub ON c.parent_id = sub.id WHERE c.trashed_at IS NULL
)
UPDATE disk_items d SET
    trashed_at   = sqlc.arg('trashed_at')::timestamptz,
    trashed_by   = sqlc.narg('trashed_by')::uuid,
    trashed_root = (d.id = sqlc.arg('id')::uuid)
FROM sub WHERE d.id = sub.id
RETURNING d.*;

-- name: RestoreDiskSubtree :many
-- Restores a trash root and the part of its subtree trashed with it (same trashed_at, not a
-- root of its own). parent_id / name: where the root goes back (the caller picks the root
-- when the old parent is gone or in the trash, and «name (2)» on a clash).
WITH RECURSIVE root AS (
    SELECT r.id, r.trashed_at FROM disk_items r WHERE r.id = sqlc.arg('id')::uuid AND r.trashed_root
), sub (id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT c.id FROM disk_items c JOIN sub ON c.parent_id = sub.id
    WHERE NOT c.trashed_root AND c.trashed_at = (SELECT root.trashed_at FROM root)
)
UPDATE disk_items d SET
    trashed_at   = NULL,
    trashed_by   = NULL,
    trashed_root = false,
    parent_id    = CASE WHEN d.id = sqlc.arg('id')::uuid THEN sqlc.narg('parent_id')::uuid ELSE d.parent_id END,
    name         = CASE WHEN d.id = sqlc.arg('id')::uuid THEN sqlc.arg('name')::text ELSE d.name END,
    updated_at   = CASE WHEN d.id = sqlc.arg('id')::uuid THEN now() ELSE d.updated_at END
FROM sub WHERE d.id = sub.id
RETURNING d.*;

-- name: DeleteDiskSubtreeFiles :many
-- Delete forever, step 1: the files rows of an item's whole subtree (trashed or not). Their
-- disk items go with them (CASCADE); the caller releases the quota in the same transaction
-- (ReleaseQuota per workspace) and deletes the blobs after commit, like files.DeleteFile —
-- deleting only the item would leave the bytes to the orphan cleanup, which would release the
-- quota a second time.
WITH RECURSIVE sub (id) AS (
    SELECT d.id FROM disk_items d WHERE d.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id FROM disk_items c JOIN sub ON c.parent_id = sub.id
)
DELETE FROM files f
USING disk_items di, sub
WHERE di.id = sub.id AND f.id = di.file_id
RETURNING f.*;

-- name: DeleteDiskItem :execrows
-- Delete forever, step 2: the item and what is left of its subtree (folders; CASCADE).
DELETE FROM disk_items WHERE id = $1;

-- name: ListExpiredDiskTrash :many
-- Trash roots older than their workspace's disk_trash_days (NULL = never), oldest first: the
-- hourly sweeper deletes them forever.
SELECT di.* FROM disk_items di
JOIN workspaces w ON w.id = di.workspace_id
WHERE di.trashed_root AND w.disk_trash_days IS NOT NULL
  AND di.trashed_at < sqlc.arg('now')::timestamptz - make_interval(days => w.disk_trash_days)
ORDER BY di.trashed_at
LIMIT sqlc.arg('lim');

-- name: SetDiskTrashDays :exec
UPDATE workspaces SET disk_trash_days = sqlc.narg('days') WHERE id = sqlc.arg('id');

-- name: ListDiskPermissions :many
SELECT * FROM disk_permissions WHERE item_id = $1 ORDER BY target_type, target_id;

-- name: ListDiskPermissionsForItems :many
-- The overrides of several items at once (a path, a folder listing).
SELECT * FROM disk_permissions WHERE item_id = ANY(sqlc.arg('ids')::uuid[]) ORDER BY item_id, target_type, target_id;

-- name: ListSharedDiskItems :many
-- Which of the items have overrides (DiskItem.shared).
SELECT DISTINCT item_id FROM disk_permissions WHERE item_id = ANY(sqlc.arg('ids')::uuid[]);

-- name: DeleteDiskPermissions :exec
DELETE FROM disk_permissions WHERE item_id = $1;

-- name: InsertDiskPermission :exec
INSERT INTO disk_permissions (item_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5);

-- name: UpsertDiskLink :one
-- Turns the public link of a file on: a new code each time it is (re-)enabled.
INSERT INTO disk_links (item_id, code, created_by, expires_at)
VALUES (sqlc.arg('item_id'), sqlc.arg('code'), sqlc.narg('created_by'), sqlc.narg('expires_at'))
ON CONFLICT (item_id) DO UPDATE SET
    code       = EXCLUDED.code,
    created_by = EXCLUDED.created_by,
    created_at = now(),
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    downloads  = 0
RETURNING *;

-- name: GetDiskLinkByItem :one
-- The live link of an item (not revoked, not expired).
SELECT * FROM disk_links WHERE item_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: GetDiskLinkByCode :one
-- An anonymous visit: the live link with its item and file. A file in the trash or restricted
-- still answers (ADR-0094 §3); one deleted forever is gone with its rows.
SELECT sqlc.embed(l), sqlc.embed(di), sqlc.embed(f)
FROM disk_links l
JOIN disk_items di ON di.id = l.item_id
JOIN files f ON f.id = di.file_id
WHERE l.code = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now());

-- name: RevokeDiskLink :execrows
UPDATE disk_links SET revoked_at = now() WHERE item_id = $1 AND revoked_at IS NULL;

-- name: CountDiskLinkDownload :exec
UPDATE disk_links SET downloads = downloads + 1 WHERE id = $1;

-- name: ListDiskLinksForItems :many
-- Live links of several items (DiskItem.link in a listing).
SELECT * FROM disk_links
WHERE item_id = ANY(sqlc.arg('ids')::uuid[]) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: ListWorkspaceDiskLinks :many
-- Every live link of a workspace (DISK_MANAGE), the newest first.
SELECT sqlc.embed(l), sqlc.embed(di)
FROM disk_links l JOIN disk_items di ON di.id = l.item_id
WHERE di.workspace_id = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
ORDER BY l.created_at DESC;

-- name: InsertDiskActivity :one
INSERT INTO disk_activity (workspace_id, item_id, item_name, actor_id, kind, before, after)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('item_id'), sqlc.arg('item_name'), sqlc.narg('actor_id'), sqlc.arg('kind'),
        sqlc.narg('before'), sqlc.narg('after'))
RETURNING *;

-- name: ListDiskItemActivity :many
-- An item's history, the newest first; cursor: the last id (NULL = the first page).
SELECT * FROM disk_activity
WHERE item_id = sqlc.arg('item_id')::uuid
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: ListWorkspaceDiskActivity :many
-- The Disk's history (DISK_MANAGE), the newest first, optionally of one actor.
SELECT * FROM disk_activity
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('actor_id')::uuid IS NULL OR actor_id = sqlc.narg('actor_id')::uuid)
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: GetDiskUsage :one
-- DiskUsage (ADR-0094 §6): the workspace's counters, the bytes of the Disk (trash included)
-- and of its trash, through files(workspace_id) ⋈ disk_items(file_id).
SELECT w.storage_used_bytes, w.storage_quota_bytes,
    (SELECT coalesce(sum(f.size), 0) FROM files f JOIN disk_items di ON di.file_id = f.id
        WHERE f.workspace_id = w.id)::bigint AS disk_bytes,
    (SELECT coalesce(sum(f.size), 0) FROM files f JOIN disk_items di ON di.file_id = f.id
        WHERE f.workspace_id = w.id AND di.trashed_at IS NOT NULL)::bigint AS trash_bytes,
    (SELECT coalesce(sum(a.size_mb), 0) FROM workspace_storage_addons a
        WHERE a.workspace_id = w.id AND a.active)::bigint AS addon_mb
FROM workspaces w WHERE w.id = $1;

-- name: SumActiveStorageAddonsMB :one
-- The storage add-ons of a workspace in effect (ADR-0094 §6), in MiB.
SELECT coalesce(sum(size_mb), 0)::bigint FROM workspace_storage_addons WHERE workspace_id = $1 AND active;

-- name: DiskItemPaths :many
-- The chains of several items at once (a trash page, an event): every item with its ancestors,
-- per leaf the topmost first. Bounded at 64 levels like DiskItemPath.
WITH RECURSIVE up (leaf, id, parent_id, depth) AS (
    SELECT d.id, d.id, d.parent_id, 0 FROM disk_items d WHERE d.id = ANY(sqlc.arg('ids')::uuid[])
    UNION ALL
    SELECT up.leaf, p.id, p.parent_id, up.depth + 1 FROM disk_items p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT up.leaf::uuid AS leaf, sqlc.embed(di), up.depth::int AS depth
FROM up JOIN disk_items di ON di.id = up.id
ORDER BY up.leaf, up.depth DESC;

-- name: LockDiskTree :exec
-- Serializes the structural changes of one workspace's Disk (names in a folder, moves and their
-- cycle check, restore). Taken after any workspaces row lock of the transaction (an upload
-- reserves its quota first), never before one.
SELECT pg_advisory_xact_lock(hashtext('calaba.disk.' || sqlc.arg('workspace_id')::uuid::text));

-- name: LastDiskActivity :one
-- The newest journal entry of an item (the rename coalescing of ADR-0081).
SELECT * FROM disk_activity WHERE item_id = $1 ORDER BY id DESC LIMIT 1;

-- name: UpdateDiskActivityAfter :exec
UPDATE disk_activity SET after = sqlc.narg('after'), item_name = sqlc.arg('item_name'), created_at = now()
WHERE id = sqlc.arg('id');

-- name: DeleteDiskActivity :exec
DELETE FROM disk_activity WHERE id = $1;

-- name: ListDiskSweepWorkspaces :many
-- Workspaces with a trash retention and at least one expired trash root (the hourly sweeper).
SELECT w.id, w.disk_trash_days::int AS days FROM workspaces w
WHERE w.disk_trash_days IS NOT NULL AND EXISTS (
    SELECT 1 FROM disk_items di WHERE di.workspace_id = w.id AND di.trashed_root
      AND di.trashed_at < sqlc.arg('now')::timestamptz - make_interval(days => w.disk_trash_days));

-- name: ListDiskTrashRootsBefore :many
-- The sweeper's batch of one workspace: its trash roots deleted before the cutoff, oldest first.
SELECT * FROM disk_items
WHERE workspace_id = sqlc.arg('workspace_id') AND trashed_root AND trashed_at < sqlc.arg('cutoff')::timestamptz
ORDER BY trashed_at, id
LIMIT sqlc.arg('lim');

-- name: ListDiskFiles :many
-- The files rows of a page of items.
SELECT * FROM files WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: LockDiskQuota :exec
-- Delete forever, step 0: the workspaces row the quota release will update, locked first — the
-- order of an upload (ReserveQuota, then the item under LockDiskTree), so a deletion and an upload
-- into the same folder never wait for each other crosswise.
SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE;
