-- Disk (ADR-0094): folders and files of a workspace, per-item access, public file links,
-- trash, journal and storage add-ons.
--
-- disk_items                one root per workspace (parent_id NULL = in the root); a file item
--                           points at a files row (another reference: ListOrphanFiles and
--                           UnattachedBytesByUploader skip it). Names are unique per folder
--                           ignoring case among items not in the trash. Trash: trashed_at on the
--                           whole subtree (one timestamp), trashed_root on the item the deletion
--                           started at. Deleting the files row deletes the item (CASCADE);
--                           deleting a folder deletes its subtree (CASCADE).
-- disk_permissions          role / user overrides of DISK_VIEW | DISK_WRITE (1 << 35 | 1 << 36)
--                           on an item, like board_permissions.
-- disk_links                the public link of a file: 43-character code (base64url of 32
--                           random bytes); one row per item, re-enabling replaces the code.
-- disk_activity             the journal, like task_activity; item_id SET NULL when the item is
--                           deleted forever (the workspace history keeps the entry).
-- workspace_storage_addons  bought storage packs; the effective limit is
--                           min(storage_quota_bytes, plan storage_mb + Σ active size_mb).
-- workspaces.disk_trash_days the trash retention in days; NULL = never (default).
-- files(workspace_id) is indexed since 00001 (DiskUsage aggregates by it).
-- Built-in member role: + DISK_VIEW | DISK_WRITE (103079215104), existing roles and new
-- workspaces (workspace_builtin_roles). DISK_MANAGE (1 << 37) is in ADMINISTRATOR.
--
-- Safe on a populated database: new tables, a nullable column without a default (metadata
-- only), one UPDATE of the member roles (one row per workspace).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE workspaces ADD COLUMN disk_trash_days integer
    CHECK (disk_trash_days IS NULL OR disk_trash_days BETWEEN 1 AND 3650);

CREATE TABLE disk_items (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    parent_id    uuid REFERENCES disk_items (id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('folder', 'file')),
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    file_id      uuid REFERENCES files (id) ON DELETE CASCADE,
    owner_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    restricted   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    trashed_at   timestamptz,
    trashed_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    trashed_root boolean NOT NULL DEFAULT false,
    CONSTRAINT disk_items_file_check CHECK ((kind = 'file') = (file_id IS NOT NULL)),
    CONSTRAINT disk_items_trash_check CHECK (NOT trashed_root OR trashed_at IS NOT NULL),
    CONSTRAINT disk_items_parent_check CHECK (parent_id IS DISTINCT FROM id)
);
-- Names in a folder, and the folder listing (workspace_id, parent_id) of live items.
CREATE UNIQUE INDEX disk_items_name_key ON disk_items (workspace_id, parent_id, lower(name)) NULLS NOT DISTINCT
    WHERE trashed_at IS NULL;
-- Subtrees (trash / restore / path CTEs, including trashed items) and the CASCADE of a folder.
CREATE INDEX disk_items_parent_idx ON disk_items (parent_id) WHERE parent_id IS NOT NULL;
-- One item per file; the orphan cleanup and the files ⋈ disk_items usage go through it.
CREATE UNIQUE INDEX disk_items_file_key ON disk_items (file_id) WHERE file_id IS NOT NULL;
-- The trash: its roots by deletion time; the sweeper's candidates per workspace.
CREATE INDEX disk_items_trash_idx ON disk_items (workspace_id, trashed_at) WHERE trashed_root;
CREATE INDEX disk_items_owner_idx ON disk_items (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX disk_items_trashed_by_idx ON disk_items (trashed_by) WHERE trashed_by IS NOT NULL;

CREATE TABLE disk_permissions (
    item_id     uuid NOT NULL REFERENCES disk_items (id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('role', 'user')),
    target_id   text NOT NULL,
    allow       bigint NOT NULL DEFAULT 0,
    deny        bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, target_type, target_id),
    CONSTRAINT disk_permissions_bits_check CHECK ((allow | deny) & ~103079215104::bigint = 0 AND allow & deny = 0)
);
-- A role deleted / a member leaving drops their overrides.
CREATE INDEX disk_permissions_target_idx ON disk_permissions (target_type, target_id);

CREATE TABLE disk_links (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    item_id    uuid NOT NULL UNIQUE REFERENCES disk_items (id) ON DELETE CASCADE,
    code       text NOT NULL UNIQUE CHECK (char_length(code) = 43),
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    downloads  integer NOT NULL DEFAULT 0 CHECK (downloads >= 0)
);
CREATE INDEX disk_links_created_by_idx ON disk_links (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE disk_activity (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    item_id      uuid REFERENCES disk_items (id) ON DELETE SET NULL,
    item_name    text NOT NULL DEFAULT '',
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    kind         text NOT NULL CHECK (kind IN ('create', 'upload', 'rename', 'move', 'share', 'link_on',
                                               'link_off', 'trash', 'restore', 'delete')),
    before       jsonb,
    after        jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disk_activity_item_idx ON disk_activity (item_id, id) WHERE item_id IS NOT NULL;
CREATE INDEX disk_activity_workspace_idx ON disk_activity (workspace_id, id);
CREATE INDEX disk_activity_actor_idx ON disk_activity (workspace_id, actor_id, id) WHERE actor_id IS NOT NULL;

CREATE TABLE workspace_storage_addons (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    size_mb      bigint NOT NULL CHECK (size_mb > 0),
    sku          text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 64),
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    CONSTRAINT workspace_storage_addons_active_check CHECK (active = (ended_at IS NULL))
);
CREATE INDEX workspace_storage_addons_active_idx ON workspace_storage_addons (workspace_id) WHERE active;

UPDATE workspace_roles SET permissions = permissions | 103079215104 WHERE builtin = 'member';

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

-- +goose Down
SET LOCAL lock_timeout = '10s';
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 8798327, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd
UPDATE workspace_roles SET permissions = permissions & ~240518168576::bigint WHERE permissions & 240518168576 <> 0;
DROP TABLE workspace_storage_addons;
DROP TABLE disk_activity;
DROP TABLE disk_links;
DROP TABLE disk_permissions;
DROP TABLE disk_items;
ALTER TABLE workspaces DROP COLUMN disk_trash_days;
