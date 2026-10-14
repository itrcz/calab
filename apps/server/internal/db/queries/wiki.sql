-- Wiki (ADR-0096). Access is computed in Go (perm.ComputeWikiPage over WikiPagePath / WikiPagePaths
-- and the overrides of the levels); these queries return what is stored, visible or not. The
-- content (Yjs updates and snapshots) is opaque bytes.

-- ---- tree ----

-- name: ListWikiChildren :many
-- The live children of a page (parent_id NULL = the top level) in order, with whether each has
-- live children of its own (the tree expands lazily). Cursor: the last row's (position, id);
-- cursor_id NULL = the first page.
SELECT sqlc.embed(p),
    EXISTS (SELECT 1 FROM wiki_pages c WHERE c.parent_id = p.id AND c.trashed_at IS NULL)::boolean AS has_children
FROM wiki_page_heads p
WHERE p.workspace_id = sqlc.arg('workspace_id')::uuid
  AND (p.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND p.parent_id IS NULL))
  AND p.trashed_at IS NULL
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR (p.position, p.id) > (sqlc.arg('cursor_position')::int, sqlc.narg('cursor_id')::uuid))
ORDER BY p.position, p.id
LIMIT sqlc.arg('lim');

-- name: ListWikiTrash :many
-- The trash: roots of deletions, the most recent first. Cursor: the last row's (trashed_at, id).
SELECT * FROM wiki_page_heads
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND trashed_root
  AND (sqlc.narg('cursor_id')::uuid IS NULL
       OR (trashed_at, id) < (sqlc.arg('cursor_trashed')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY trashed_at DESC, id DESC
LIMIT sqlc.arg('lim');

-- name: ListWikiTrashRootsAll :many
-- Every trash root of a workspace («Очистить корзину»: the caller deletes those they may).
SELECT * FROM wiki_page_heads WHERE workspace_id = $1 AND trashed_root ORDER BY trashed_at, id;

-- name: GetWikiPage :one
SELECT * FROM wiki_page_heads WHERE id = $1;

-- name: GetWikiPageForUpdate :one
SELECT * FROM wiki_page_heads WHERE id = $1 FOR UPDATE;

-- name: GetWikiPageText :one
-- The page with its text (a version's «text changed» check, the Markdown-free export).
SELECT * FROM wiki_pages WHERE id = $1;

-- name: ListWikiPagesByIDs :many
SELECT * FROM wiki_page_heads WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListWikiPagesWithChildren :many
-- Which of the pages have live children (WikiPage.has_children outside a listing).
SELECT DISTINCT parent_id::uuid FROM wiki_pages
WHERE parent_id = ANY(sqlc.arg('ids')::uuid[]) AND trashed_at IS NULL;

-- name: WikiPagePath :many
-- The page and its ancestors, the top-level page first (depth = distance from the page).
-- Bounded at 64 levels (the API keeps trees ≤ 32 deep).
WITH RECURSIVE up (id, parent_id, depth) AS (
    SELECT w.id, w.parent_id, 0 FROM wiki_pages w WHERE w.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT p.id, p.parent_id, up.depth + 1 FROM wiki_pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT sqlc.embed(wp), up.depth::int AS depth
FROM up JOIN wiki_page_heads wp ON wp.id = up.id
ORDER BY up.depth DESC;

-- name: WikiPagePaths :many
-- The chains of several pages at once (a listing's ancestors, the trash, search hits, an
-- event): every page with its ancestors, per leaf the top-level page first.
WITH RECURSIVE up (leaf, id, parent_id, depth) AS (
    SELECT w.id, w.id, w.parent_id, 0 FROM wiki_pages w WHERE w.id = ANY(sqlc.arg('ids')::uuid[])
    UNION ALL
    SELECT up.leaf, p.id, p.parent_id, up.depth + 1 FROM wiki_pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
)
SELECT up.leaf::uuid AS leaf, sqlc.embed(wp), up.depth::int AS depth
FROM up JOIN wiki_page_heads wp ON wp.id = up.id
ORDER BY up.leaf, up.depth DESC;

-- name: CountWikiSubtreeDepth :one
-- The depth of the deepest descendant below a page (0 = no children): a move keeps
-- depth(target) + 1 + this ≤ 32.
WITH RECURSIVE down (id, depth) AS (
    SELECT w.id, 0 FROM wiki_pages w WHERE w.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id, down.depth + 1 FROM wiki_pages c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
)
SELECT coalesce(max(depth), 0)::int FROM down;

-- name: ListWikiBranch :many
-- The live pages below a page (not the page itself), each with its depth: the table of contents
-- of a public link with include_children (the caller drops restricted pages and their
-- branches), the cycle check of a move. Bounded at 64 levels.
WITH RECURSIVE down (id, depth) AS (
    SELECT c.id, 1 FROM wiki_pages c WHERE c.parent_id = sqlc.arg('id')::uuid AND c.trashed_at IS NULL
    UNION ALL
    SELECT c.id, down.depth + 1 FROM wiki_pages c JOIN down ON c.parent_id = down.id
    WHERE c.trashed_at IS NULL AND down.depth < 64
)
SELECT sqlc.embed(wp), down.depth::int AS depth
FROM down JOIN wiki_page_heads wp ON wp.id = down.id
ORDER BY down.depth, wp.position, wp.id;

-- name: LockWikiTree :exec
-- Serializes the structural changes of one workspace's Wiki (positions among siblings, moves and
-- their cycle check, restore). Taken after any workspaces row lock of the transaction, never
-- before one (the order of the Disk's LockDiskTree).
SELECT pg_advisory_xact_lock(hashtext('calaba.wiki.' || sqlc.arg('workspace_id')::uuid::text));

-- name: CreateWikiPage :one
-- A new page goes last among its live siblings (under LockWikiTree).
INSERT INTO wiki_pages (workspace_id, parent_id, title, icon, owner_id, updated_by, position)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('parent_id'), sqlc.arg('title'), sqlc.narg('icon'), sqlc.narg('owner_id'),
        sqlc.narg('owner_id'),
        (SELECT coalesce(max(s.position) + 1, 0) FROM wiki_pages s
         WHERE s.workspace_id = sqlc.arg('workspace_id')::uuid AND s.trashed_at IS NULL
           AND (s.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND s.parent_id IS NULL))))
RETURNING *;

-- name: UpdateWikiPage :one
-- Rename (title), the icon and the cover (set_* + value; NULL removes) and the restricted switch.
UPDATE wiki_pages SET
    title         = coalesce(sqlc.narg('title'), title),
    icon          = CASE WHEN sqlc.arg('set_icon')::boolean THEN sqlc.narg('icon')::text ELSE icon END,
    cover_file_id = CASE WHEN sqlc.arg('set_cover')::boolean THEN sqlc.narg('cover_file_id')::uuid ELSE cover_file_id END,
    restricted    = coalesce(sqlc.narg('restricted'), restricted),
    updated_by    = sqlc.narg('updated_by'),
    updated_at    = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: MoveWikiPage :one
-- A move (under LockWikiTree): the page goes under parent_id (NULL = the top level) at
-- position; ReindexWikiSiblings of the new and the old parent follows.
UPDATE wiki_pages SET
    parent_id  = sqlc.narg('parent_id')::uuid,
    position   = sqlc.arg('position')::int,
    updated_by = sqlc.narg('updated_by'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: ReindexWikiSiblings :exec
-- Renumbers the live children of a parent (NULL = the top level) 0.. in their order; on a tie
-- first_id goes first (the page just moved to that position pushes the others down).
WITH ordered AS (
    SELECT s.id, (row_number() OVER (ORDER BY s.position, (s.id = sqlc.narg('first_id')::uuid) DESC, s.id) - 1)::int AS pos
    FROM wiki_pages s
    WHERE s.workspace_id = sqlc.arg('workspace_id')::uuid AND s.trashed_at IS NULL
      AND (s.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND s.parent_id IS NULL))
)
UPDATE wiki_pages w SET position = ordered.pos
FROM ordered WHERE w.id = ordered.id AND w.position <> ordered.pos;

-- name: SetWikiPageContent :one
-- After a snapshot (ADR-0096 §4 SNAPSHOT_POST): the text for search and versions, the preview
-- and the size; the client caps plain_text at 256 KiB and preview at 200 characters.
UPDATE wiki_pages SET
    plain_text = sqlc.arg('plain_text'),
    preview    = sqlc.arg('preview'),
    doc_size   = sqlc.arg('doc_size'),
    updated_by = sqlc.narg('updated_by'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: TrashWikiSubtree :many
-- Moves a page and its live subtree to the trash in one UPDATE: one timestamp for all, the page
-- is the root. Descendants trashed before stay their own roots. Returns the ids (the pages:
-- ListWikiPagesByIDs).
WITH RECURSIVE sub (id) AS (
    SELECT w.id FROM wiki_pages w WHERE w.id = sqlc.arg('id')::uuid AND w.trashed_at IS NULL
    UNION ALL
    SELECT c.id FROM wiki_pages c JOIN sub ON c.parent_id = sub.id WHERE c.trashed_at IS NULL
)
UPDATE wiki_pages w SET
    trashed_at   = sqlc.arg('trashed_at')::timestamptz,
    trashed_by   = sqlc.narg('trashed_by')::uuid,
    trashed_root = (w.id = sqlc.arg('id')::uuid)
FROM sub WHERE w.id = sub.id
RETURNING w.id;

-- name: RestoreWikiSubtree :many
-- Restores a trash root and the part of its subtree trashed with it (same trashed_at, not a
-- root of its own). parent_id: where the root goes back (the caller picks the top level when the
-- old parent is gone or in the trash); the root goes last among its new siblings (under
-- LockWikiTree). Returns the ids.
WITH RECURSIVE root AS (
    SELECT r.id, r.workspace_id, r.trashed_at FROM wiki_pages r WHERE r.id = sqlc.arg('id')::uuid AND r.trashed_root
), sub (id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT c.id FROM wiki_pages c JOIN sub ON c.parent_id = sub.id
    WHERE NOT c.trashed_root AND c.trashed_at = (SELECT root.trashed_at FROM root)
), last AS (
    SELECT coalesce(max(s.position) + 1, 0)::int AS pos FROM wiki_pages s, root
    WHERE s.workspace_id = root.workspace_id AND s.trashed_at IS NULL
      AND (s.parent_id = sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND s.parent_id IS NULL))
)
UPDATE wiki_pages w SET
    trashed_at   = NULL,
    trashed_by   = NULL,
    trashed_root = false,
    parent_id    = CASE WHEN w.id = sqlc.arg('id')::uuid THEN sqlc.narg('parent_id')::uuid ELSE w.parent_id END,
    position     = CASE WHEN w.id = sqlc.arg('id')::uuid THEN (SELECT last.pos FROM last) ELSE w.position END,
    updated_at   = CASE WHEN w.id = sqlc.arg('id')::uuid THEN now() ELSE w.updated_at END
FROM sub WHERE w.id = sub.id
RETURNING w.id;

-- name: DeleteWikiSubtreeFiles :many
-- Delete forever, step 1: the files rows of a page's whole subtree (trashed or not) — its
-- wiki_page_files and covers — that no page outside the subtree references. The caller releases
-- the quota in the same transaction (ReleaseQuota) and deletes the blobs after commit, like
-- DeleteDiskSubtreeFiles (deleting only the pages would leave the bytes to the orphan cleanup,
-- which would release the quota a second time).
WITH RECURSIVE sub (id) AS (
    SELECT w.id FROM wiki_pages w WHERE w.id = sqlc.arg('id')::uuid
    UNION ALL
    SELECT c.id FROM wiki_pages c JOIN sub ON c.parent_id = sub.id
), refs AS (
    SELECT pf.file_id FROM wiki_page_files pf JOIN sub ON sub.id = pf.page_id
    UNION
    SELECT w.cover_file_id FROM wiki_pages w JOIN sub ON sub.id = w.id WHERE w.cover_file_id IS NOT NULL
)
DELETE FROM files f
USING refs
WHERE f.id = refs.file_id
  AND NOT EXISTS (SELECT 1 FROM wiki_page_files o WHERE o.file_id = f.id AND o.page_id NOT IN (SELECT sub.id FROM sub))
  AND NOT EXISTS (SELECT 1 FROM wiki_pages o WHERE o.cover_file_id = f.id AND o.id NOT IN (SELECT sub.id FROM sub))
RETURNING f.*;

-- name: DeleteWikiPage :execrows
-- Delete forever, step 2: the page and its subtree (CASCADE: updates, snapshots, versions,
-- overrides, links, page files; the journal keeps its entries with page_id NULL).
DELETE FROM wiki_pages WHERE id = $1;

-- ---- trash retention ----

-- name: ListWikiSweepWorkspaces :many
-- Workspaces with a trash retention and at least one expired trash root (the hourly sweeper).
SELECT w.id, w.wiki_trash_days::int AS days FROM workspaces w
WHERE w.wiki_trash_days IS NOT NULL AND EXISTS (
    SELECT 1 FROM wiki_pages p WHERE p.workspace_id = w.id AND p.trashed_root
      AND p.trashed_at < sqlc.arg('now')::timestamptz - make_interval(days => w.wiki_trash_days));

-- name: ListWikiTrashRootsBefore :many
-- The sweeper's batch of one workspace: its trash roots deleted before the cutoff, oldest first.
SELECT * FROM wiki_page_heads
WHERE workspace_id = sqlc.arg('workspace_id') AND trashed_root AND trashed_at < sqlc.arg('cutoff')::timestamptz
ORDER BY trashed_at, id
LIMIT sqlc.arg('lim');

-- name: GetWikiTrashDays :one
SELECT wiki_trash_days FROM workspaces WHERE id = $1;

-- name: SetWikiTrashDays :exec
UPDATE workspaces SET wiki_trash_days = sqlc.narg('days') WHERE id = sqlc.arg('id');

-- ---- permissions ----

-- name: ListWikiPermissions :many
SELECT * FROM wiki_permissions WHERE page_id = $1 ORDER BY target_type, target_id;

-- name: ListWikiPermissionsForPages :many
-- The overrides of several pages at once (a path, a listing).
SELECT * FROM wiki_permissions WHERE page_id = ANY(sqlc.arg('ids')::uuid[]) ORDER BY page_id, target_type, target_id;

-- name: ListSharedWikiPages :many
-- Which of the pages have overrides (WikiPage.shared).
SELECT DISTINCT page_id FROM wiki_permissions WHERE page_id = ANY(sqlc.arg('ids')::uuid[]);

-- name: DeleteWikiPermissions :exec
DELETE FROM wiki_permissions WHERE page_id = $1;

-- name: InsertWikiPermission :exec
INSERT INTO wiki_permissions (page_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5);

-- ---- public links ----

-- name: UpsertWikiLink :one
-- Turns the public link of a page on or changes it: a live link keeps its code (include_children
-- and expires_at change); a revoked or expired one gets the new code and starts over.
INSERT INTO wiki_links (page_id, code, include_children, created_by, expires_at)
VALUES (sqlc.arg('page_id'), sqlc.arg('code'), sqlc.arg('include_children'), sqlc.narg('created_by'), sqlc.narg('expires_at'))
ON CONFLICT (page_id) DO UPDATE SET
    code             = CASE WHEN wiki_links.revoked_at IS NULL AND (wiki_links.expires_at IS NULL OR wiki_links.expires_at > now())
                            THEN wiki_links.code ELSE EXCLUDED.code END,
    views            = CASE WHEN wiki_links.revoked_at IS NULL AND (wiki_links.expires_at IS NULL OR wiki_links.expires_at > now())
                            THEN wiki_links.views ELSE 0 END,
    created_by       = CASE WHEN wiki_links.revoked_at IS NULL AND (wiki_links.expires_at IS NULL OR wiki_links.expires_at > now())
                            THEN wiki_links.created_by ELSE EXCLUDED.created_by END,
    created_at       = CASE WHEN wiki_links.revoked_at IS NULL AND (wiki_links.expires_at IS NULL OR wiki_links.expires_at > now())
                            THEN wiki_links.created_at ELSE now() END,
    include_children = EXCLUDED.include_children,
    expires_at       = EXCLUDED.expires_at,
    revoked_at       = NULL
RETURNING *;

-- name: GetWikiLinkByPage :one
-- The live link of a page (not revoked, not expired).
SELECT * FROM wiki_links WHERE page_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: GetWikiLinkByCode :one
-- An anonymous visit: the live link with its page. The caller refuses a page in the trash.
SELECT sqlc.embed(l), sqlc.embed(wp)
FROM wiki_links l
JOIN wiki_page_heads wp ON wp.id = l.page_id
WHERE l.code = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now());

-- name: RevokeWikiLink :execrows
UPDATE wiki_links SET revoked_at = now() WHERE page_id = $1 AND revoked_at IS NULL;

-- name: CountWikiLinkView :exec
UPDATE wiki_links SET views = views + 1 WHERE id = $1;

-- name: ListWikiLinksForPages :many
-- Live links of several pages (WikiPage.link in a listing).
SELECT * FROM wiki_links
WHERE page_id = ANY(sqlc.arg('ids')::uuid[]) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: ListWorkspaceWikiLinks :many
-- Every live link of a workspace (WIKI_MANAGE), the newest first.
SELECT sqlc.embed(l), sqlc.embed(wp)
FROM wiki_links l JOIN wiki_page_heads wp ON wp.id = l.page_id
WHERE wp.workspace_id = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
ORDER BY l.created_at DESC;

-- ---- journal ----

-- name: InsertWikiActivity :one
INSERT INTO wiki_activity (workspace_id, page_id, page_title, actor_id, kind, before, after)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('page_id'), sqlc.arg('page_title'), sqlc.narg('actor_id'), sqlc.arg('kind'),
        sqlc.narg('before'), sqlc.narg('after'))
RETURNING *;

-- name: ListWikiPageActivity :many
-- A page's history, the newest first; cursor: the last id (NULL = the first page).
SELECT * FROM wiki_activity
WHERE page_id = sqlc.arg('page_id')::uuid
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: ListWorkspaceWikiActivity :many
-- The Wiki's history (WIKI_MANAGE), the newest first, optionally of one actor.
SELECT * FROM wiki_activity
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('actor_id')::uuid IS NULL OR actor_id = sqlc.narg('actor_id')::uuid)
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: LastWikiActivity :one
-- The newest journal entry of a page (the rename coalescing of ADR-0081).
SELECT * FROM wiki_activity WHERE page_id = $1 ORDER BY id DESC LIMIT 1;

-- name: UpdateWikiActivityAfter :exec
UPDATE wiki_activity SET after = sqlc.narg('after'), page_title = sqlc.arg('page_title'), created_at = now()
WHERE id = sqlc.arg('id');

-- name: DeleteWikiActivity :exec
DELETE FROM wiki_activity WHERE id = $1;

-- ---- versions ----

-- name: InsertWikiVersion :one
INSERT INTO wiki_page_versions (page_id, state, plain_text, title, authors)
VALUES (sqlc.arg('page_id'), sqlc.arg('state'), sqlc.arg('plain_text'), sqlc.arg('title'), sqlc.arg('authors')::uuid[])
RETURNING id, page_id, title, authors, created_at, octet_length(state)::int AS size;

-- name: LastWikiVersion :one
-- The newest version of a page without its state: the 5-minute rule and the «text or title
-- changed» check of ADR-0096 §1.
SELECT id, created_at, title, plain_text FROM wiki_page_versions
WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: ListWikiVersions :many
-- A page's versions without their state, the newest first; cursor: the last id (versions are
-- uuidv7: id order is creation order).
SELECT id, page_id, title, plain_text, authors, created_at, octet_length(state)::int AS size
FROM wiki_page_versions
WHERE page_id = sqlc.arg('page_id')::uuid
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: GetWikiVersion :one
-- One version with its state (GET …/versions/{vid}); page_id guards against a foreign id.
SELECT * FROM wiki_page_versions WHERE id = sqlc.arg('id') AND page_id = sqlc.arg('page_id');

-- name: PruneWikiVersions :execrows
-- Keeps ≤ 200 versions of a page (the newest) and, older than 7 days, only the newest of each
-- UTC day.
WITH ranked AS (
    SELECT v.id, v.created_at,
        row_number() OVER (ORDER BY v.created_at DESC, v.id DESC) AS n,
        row_number() OVER (PARTITION BY (v.created_at AT TIME ZONE 'UTC')::date ORDER BY v.created_at DESC, v.id DESC) AS day_n
    FROM wiki_page_versions v WHERE v.page_id = sqlc.arg('page_id')::uuid
)
DELETE FROM wiki_page_versions d USING ranked r
WHERE d.id = r.id
  AND (r.n > 200 OR (r.created_at < sqlc.arg('now')::timestamptz - interval '7 days' AND r.day_n > 1));

-- ---- content: updates and snapshots ----

-- name: AppendWikiUpdate :one
-- Stores one Yjs update of a live page under the page's next seq; the counter is taken and
-- bumped in the same statement (the row lock orders concurrent appends of the page). No row
-- when the page is gone or in the trash.
WITH s AS (
    UPDATE wiki_pages SET next_seq = next_seq + 1
    WHERE id = sqlc.arg('page_id')::uuid AND trashed_at IS NULL
    RETURNING id, next_seq - 1 AS seq
)
INSERT INTO wiki_page_updates (page_id, seq, data, author_id)
SELECT s.id, s.seq, sqlc.arg('data')::bytea, sqlc.narg('author_id')::uuid FROM s
RETURNING seq, created_at;

-- name: ListWikiUpdatesSince :many
-- The updates after a seq (the snapshot's through_seq), in order.
SELECT seq, data, author_id, created_at FROM wiki_page_updates
WHERE page_id = sqlc.arg('page_id') AND seq > sqlc.arg('after_seq')::bigint
ORDER BY seq
LIMIT sqlc.arg('lim');

-- name: WikiUpdatesSince :one
-- How many updates and bytes are stored after a seq: the COMPACT_REQUEST thresholds (> 500
-- updates or > 1 MiB) and the authors of the next version.
SELECT count(*)::int AS updates, coalesce(sum(octet_length(data)), 0)::bigint AS bytes,
    coalesce(array_agg(DISTINCT author_id) FILTER (WHERE author_id IS NOT NULL), '{}')::uuid[] AS authors
FROM wiki_page_updates
WHERE page_id = sqlc.arg('page_id') AND seq > sqlc.arg('after_seq')::bigint;

-- name: DeleteWikiUpdatesThrough :execrows
-- After a snapshot: the updates it contains.
DELETE FROM wiki_page_updates WHERE page_id = sqlc.arg('page_id') AND seq <= sqlc.arg('through_seq')::bigint;

-- name: GetWikiSnapshot :one
SELECT * FROM wiki_page_snapshots WHERE page_id = $1;

-- name: GetWikiSnapshotSeq :one
-- The through_seq of the page's snapshot without its state (the sync socket's catch-up and the
-- COMPACT_REQUEST check).
SELECT through_seq FROM wiki_page_snapshots WHERE page_id = $1;

-- name: UpsertWikiSnapshot :execrows
-- Saves a snapshot unless a newer one is stored (through_seq never goes back); 0 rows = stale.
-- The caller checks through_seq < wiki_pages.next_seq.
INSERT INTO wiki_page_snapshots (page_id, state, through_seq, saved_by)
VALUES (sqlc.arg('page_id'), sqlc.arg('state'), sqlc.arg('through_seq'), sqlc.narg('saved_by'))
ON CONFLICT (page_id) DO UPDATE SET
    state       = EXCLUDED.state,
    through_seq = EXCLUDED.through_seq,
    saved_by    = EXCLUDED.saved_by,
    saved_at    = now()
WHERE wiki_page_snapshots.through_seq <= EXCLUDED.through_seq;

-- ---- page files ----

-- name: AddWikiPageFile :exec
INSERT INTO wiki_page_files (page_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: ListWikiPageFiles :many
-- The files of a page (pictures, attachments, the cover), the oldest first.
SELECT f.* FROM wiki_page_files pf JOIN files f ON f.id = pf.file_id
WHERE pf.page_id = $1 ORDER BY pf.created_at, f.id;

-- name: DeleteWikiPageFile :execrows
DELETE FROM wiki_page_files WHERE page_id = $1 AND file_id = $2;

-- name: GetWikiPageFile :one
-- The page a file belongs to (files.CanRead: a file of the Wiki is read through its page).
SELECT * FROM wiki_page_files WHERE file_id = $1 ORDER BY created_at LIMIT 1;

-- name: WikiBranchHasFile :one
-- Whether a file belongs to a page or (include_children) to a live page below it: the public
-- file route of a link (ADR-0096 §6).
WITH RECURSIVE down (id, depth) AS (
    SELECT sqlc.arg('page_id')::uuid, 0
    UNION ALL
    SELECT c.id, down.depth + 1 FROM wiki_pages c JOIN down ON c.parent_id = down.id
    WHERE sqlc.arg('include_children')::boolean AND c.trashed_at IS NULL AND NOT c.restricted AND down.depth < 64
)
SELECT EXISTS (
    SELECT 1 FROM down
    LEFT JOIN wiki_page_files pf ON pf.page_id = down.id AND pf.file_id = sqlc.arg('file_id')::uuid
    LEFT JOIN wiki_pages wp ON wp.id = down.id AND wp.cover_file_id = sqlc.arg('file_id')::uuid
    WHERE pf.file_id IS NOT NULL OR wp.id IS NOT NULL
);

-- name: GetWikiFilesBytes :one
-- The bytes of a workspace's wiki files (pages and covers, the trash included): part of «вне
-- диска» in DiskUsage.
SELECT coalesce(sum(f.size), 0)::bigint FROM files f
WHERE f.workspace_id = $1
  AND (EXISTS (SELECT 1 FROM wiki_page_files pf WHERE pf.file_id = f.id)
       OR EXISTS (SELECT 1 FROM wiki_pages wp WHERE wp.cover_file_id = f.id));

-- ---- search ----

-- name: SearchWikiPages :many
-- Search candidates (ADR-0096 §7, the shape of the ADR-0062 sections): live pages of the given
-- workspaces matching the full-text query (tsq: searchq.Query.TS, over wiki_pages_search_idx;
-- the expression is search.WikiVector) or, by title, the words with typos or as substrings
-- (words: searchq.Query.Text, phrase: searchq.Like(Query.Text) — the phrase as a whole, unlike
-- the per-word searchq.TitleMatch, so that both arms of the OR stay on their GIN indexes and the
-- planner can BitmapOr them instead of computing tsvectors row by row). Ranked by greatest(ts_rank_cd, word_similarity) × freshness
-- 1 / (1 + days / 30) of updated_at at now, then id; at most lim (the candidate cap). The access
-- filter (perm.ComputeWikiPageIn over WikiPagePaths) and the keyset page are applied by the
-- caller; the snippets of the page's hits come from WikiSearchHeadlines.
SELECT w.id, w.workspace_id, w.parent_id, w.title, w.icon, w.updated_at, w.updated_by,
    ((greatest(
        ts_rank_cd(to_tsvector('russian', w.title || ' ' || w.plain_text) || to_tsvector('simple', w.title || ' ' || w.plain_text),
                   to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text)),
        word_similarity(sqlc.arg('words')::text, w.title)))
     * (1.0 / (1.0 + greatest(0, extract(epoch FROM (sqlc.arg('now')::timestamptz - w.updated_at)))::float8 / 2592000.0)))::float8 AS score
FROM wiki_pages w
WHERE w.workspace_id = ANY(sqlc.arg('workspace_ids')::uuid[]) AND w.trashed_at IS NULL
  AND ((to_tsvector('russian', w.title || ' ' || w.plain_text) || to_tsvector('simple', w.title || ' ' || w.plain_text))
          @@ (to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text))
       OR sqlc.arg('words')::text <% w.title
       OR w.title ILIKE sqlc.arg('phrase')::text)
ORDER BY score DESC, w.id DESC
LIMIT sqlc.arg('lim');

-- name: WikiSearchHeadlines :many
-- The highlighted fragments of a page of search hits: of the text, else of the title
-- (searchq.HeadlineOptions).
SELECT w.id, ts_headline('russian', coalesce(nullif(w.plain_text, ''), w.title),
    to_tsquery('russian', sqlc.arg('tsq')::text) || to_tsquery('simple', sqlc.arg('tsq')::text),
    sqlc.arg('options')::text)::text AS snippet
FROM wiki_pages w WHERE w.id = ANY(sqlc.arg('ids')::uuid[]);
