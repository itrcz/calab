-- Wiki (ADR-0096): a tree of pages of a workspace with Yjs content, per-page access, public
-- links, trash, version history and a journal. The server stores and relays the Yjs bytes, it
-- never parses them.
--
-- wiki_pages           one tree per workspace (parent_id NULL = top level), siblings ordered by
--                      position (0..; the API reindexes on a move). plain_text / preview /
--                      doc_size / title come from the last snapshot the clients posted;
--                      plain_text is what search indexes (00091), capped at 256 KiB (a tsvector
--                      holds ≤ 1 MiB). next_seq is the page's update counter: an append takes it
--                      and bumps it in one statement (row lock per page, no global sequence).
--                      Trash: trashed_at on the whole subtree (one timestamp), trashed_root on
--                      the page the deletion started at. Deleting a page deletes its subtree
--                      and everything below (CASCADE); its files go through wiki_page_files.
-- wiki_page_updates    Yjs updates after the snapshot, (page_id, seq) with seq from next_seq;
--                      ≤ 64 KiB each (one sync frame).
-- wiki_page_snapshots  the current snapshot (Y.encodeStateAsUpdate) through through_seq; ≤ 2 MiB.
-- wiki_page_versions   history: state + text + title, the authors since the previous version;
--                      ≤ 200 per page, older than 7 days thinned to one per day (PruneWikiVersions).
-- wiki_permissions     role / user overrides of WIKI_VIEW | WIKI_WRITE (1 << 38 | 1 << 39), like
--                      disk_permissions; a deleted role / a leaving member drops theirs.
-- wiki_links           the public link of a page (43-character code), include_children opens the
--                      branch below it (not restricted pages); one row per page.
-- wiki_activity        the journal, like disk_activity; page_id SET NULL on delete forever.
-- wiki_page_files      pictures and attachments of a page (and its cover): a reference for the
--                      orphan cleanup and the pending-upload bytes (files.sql), in the workspace
--                      quota («вне диска» in the Disk usage).
-- wiki_page_heads      wiki_pages without plain_text (a view): what listings, paths and access
--                      checks read.
-- workspaces.wiki_trash_days the trash retention in days; NULL = never (default).
-- Built-in member role: + WIKI_VIEW | WIKI_WRITE (824633720832), existing roles and new
-- workspaces (workspace_builtin_roles). WIKI_MANAGE (1 << 40) is in ADMINISTRATOR.
--
-- Safe on a populated database: new tables, a nullable column without a default (metadata
-- only), one UPDATE of the member roles (one row per workspace).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE workspaces ADD COLUMN wiki_trash_days integer
    CHECK (wiki_trash_days IS NULL OR wiki_trash_days BETWEEN 1 AND 3650);

CREATE TABLE wiki_pages (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    parent_id     uuid REFERENCES wiki_pages (id) ON DELETE CASCADE,
    title         text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
    icon          text CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 32),
    cover_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    position      integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    owner_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    restricted    boolean NOT NULL DEFAULT false,
    plain_text    text NOT NULL DEFAULT '' CHECK (octet_length(plain_text) <= 262144),
    preview       text NOT NULL DEFAULT '' CHECK (char_length(preview) <= 200),
    doc_size      integer NOT NULL DEFAULT 0 CHECK (doc_size BETWEEN 0 AND 2097152),
    next_seq      bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    updated_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    trashed_at    timestamptz,
    trashed_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    trashed_root  boolean NOT NULL DEFAULT false,
    CONSTRAINT wiki_pages_trash_check CHECK (NOT trashed_root OR trashed_at IS NOT NULL),
    CONSTRAINT wiki_pages_parent_check CHECK (parent_id IS DISTINCT FROM id)
);
-- The tree: live children of a page (or of the top level) in order.
CREATE INDEX wiki_pages_tree_idx ON wiki_pages (workspace_id, parent_id, position) WHERE trashed_at IS NULL;
-- Subtrees (trash / restore / path CTEs, including trashed pages), has_children and the CASCADE.
CREATE INDEX wiki_pages_parent_idx ON wiki_pages (parent_id) WHERE parent_id IS NOT NULL;
-- The trash: its roots by deletion time; the sweeper's candidates per workspace.
CREATE INDEX wiki_pages_trash_idx ON wiki_pages (workspace_id, trashed_at) WHERE trashed_root;
CREATE INDEX wiki_pages_owner_idx ON wiki_pages (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX wiki_pages_updated_by_idx ON wiki_pages (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX wiki_pages_trashed_by_idx ON wiki_pages (trashed_by) WHERE trashed_by IS NOT NULL;
CREATE INDEX wiki_pages_cover_idx ON wiki_pages (cover_file_id) WHERE cover_file_id IS NOT NULL;

CREATE TABLE wiki_page_updates (
    page_id    uuid NOT NULL REFERENCES wiki_pages (id) ON DELETE CASCADE,
    seq        bigint NOT NULL CHECK (seq >= 1),
    data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 65536), -- one Yjs update
    author_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, seq)
);
CREATE INDEX wiki_page_updates_author_idx ON wiki_page_updates (author_id) WHERE author_id IS NOT NULL;

CREATE TABLE wiki_page_snapshots (
    page_id     uuid PRIMARY KEY REFERENCES wiki_pages (id) ON DELETE CASCADE,
    state       bytea NOT NULL CHECK (octet_length(state) <= 2097152),
    through_seq bigint NOT NULL CHECK (through_seq >= 0),
    saved_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    saved_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_page_snapshots_saved_by_idx ON wiki_page_snapshots (saved_by) WHERE saved_by IS NOT NULL;

CREATE TABLE wiki_page_versions (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    page_id    uuid NOT NULL REFERENCES wiki_pages (id) ON DELETE CASCADE,
    state      bytea NOT NULL CHECK (octet_length(state) <= 2097152),
    plain_text text NOT NULL DEFAULT '' CHECK (octet_length(plain_text) <= 262144),
    title      text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
    -- Who edited since the previous version (no FK: a gone account stays an id the client
    -- shows as «удалённый пользователь»).
    authors    uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_page_versions_page_idx ON wiki_page_versions (page_id, created_at DESC);

CREATE TABLE wiki_permissions (
    page_id     uuid NOT NULL REFERENCES wiki_pages (id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('role', 'user')),
    target_id   text NOT NULL,
    allow       bigint NOT NULL DEFAULT 0,
    deny        bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (page_id, target_type, target_id),
    CONSTRAINT wiki_permissions_bits_check CHECK ((allow | deny) & ~824633720832::bigint = 0 AND allow & deny = 0)
);
-- A role deleted / a member leaving drops their overrides.
CREATE INDEX wiki_permissions_target_idx ON wiki_permissions (target_type, target_id);

CREATE TABLE wiki_links (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    page_id          uuid NOT NULL UNIQUE REFERENCES wiki_pages (id) ON DELETE CASCADE,
    code             text NOT NULL UNIQUE CHECK (char_length(code) = 43),
    include_children boolean NOT NULL DEFAULT false,
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz,
    revoked_at       timestamptz,
    views            integer NOT NULL DEFAULT 0 CHECK (views >= 0)
);
CREATE INDEX wiki_links_created_by_idx ON wiki_links (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE wiki_activity (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    page_id      uuid REFERENCES wiki_pages (id) ON DELETE SET NULL,
    page_title   text NOT NULL DEFAULT '',
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    kind         text NOT NULL CHECK (kind IN ('create', 'rename', 'move', 'share', 'link_on', 'link_off',
                                               'trash', 'restore', 'delete', 'icon', 'cover', 'version')),
    before       jsonb,
    after        jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_activity_page_idx ON wiki_activity (page_id, id) WHERE page_id IS NOT NULL;
CREATE INDEX wiki_activity_workspace_idx ON wiki_activity (workspace_id, id);
CREATE INDEX wiki_activity_actor_idx ON wiki_activity (workspace_id, actor_id, id) WHERE actor_id IS NOT NULL;

CREATE TABLE wiki_page_files (
    page_id    uuid NOT NULL REFERENCES wiki_pages (id) ON DELETE CASCADE,
    file_id    uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, file_id)
);
-- The orphan cleanup, the pending-upload bytes and files.CanRead look a file up by id.
CREATE INDEX wiki_page_files_file_idx ON wiki_page_files (file_id);

-- A page without its text: listings, paths and access checks never carry plain_text (≤ 256 KiB).
CREATE VIEW wiki_page_heads AS
    SELECT id, workspace_id, parent_id, title, icon, cover_file_id, position, owner_id, restricted, preview,
           doc_size, next_seq, updated_by, created_at, updated_at, trashed_at, trashed_by, trashed_root
    FROM wiki_pages;

UPDATE workspace_roles SET permissions = permissions | 824633720832 WHERE builtin = 'member';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 927721734263, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down
SET LOCAL lock_timeout = '10s';
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 103088013431, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd
UPDATE workspace_roles SET permissions = permissions & ~1924145348608::bigint WHERE permissions & 1924145348608 <> 0;
DROP VIEW wiki_page_heads;
DROP TABLE wiki_page_files;
DROP TABLE wiki_activity;
DROP TABLE wiki_links;
DROP TABLE wiki_permissions;
DROP TABLE wiki_page_versions;
DROP TABLE wiki_page_snapshots;
DROP TABLE wiki_page_updates;
DROP TABLE wiki_pages;
ALTER TABLE workspaces DROP COLUMN wiki_trash_days;
