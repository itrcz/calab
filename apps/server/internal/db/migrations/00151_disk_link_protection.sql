-- Password and «Без скачивания» on public Disk links (CBF-168, ADR-0167).
--
-- disk_links.password_hash     argon2id (auth.HashPassword) of the link's password; NULL = none.
--                              Never leaves the server: clients see only DiskLink.has_password.
-- disk_links.password_version  bumped whenever the password is set, changed or removed and when
--                              the link is re-enabled: the signed unlock cookie of a visitor
--                              carries it, so an older unlock stops working at once.
-- disk_links.view_only         «Без скачивания»: no archive, file bytes only for in-browser
--                              viewers (inline), the office viewer without download/print.
-- disk_activity.kind           admits link_password_on (set or changed; after.changed) /
--                              link_password_off and link_view_only_on / link_view_only_off.

-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE disk_links
    ADD COLUMN password_hash    text,
    ADD COLUMN password_version integer NOT NULL DEFAULT 0,
    ADD COLUMN view_only        boolean NOT NULL DEFAULT false;

ALTER TABLE disk_activity DROP CONSTRAINT disk_activity_kind_check;
ALTER TABLE disk_activity ADD CONSTRAINT disk_activity_kind_check
    CHECK (kind IN ('create', 'upload', 'rename', 'move', 'share', 'link_on', 'link_off', 'trash', 'restore',
                    'delete', 'edit', 'link_password_on', 'link_password_off', 'link_view_only_on',
                    'link_view_only_off')) NOT VALID;
ALTER TABLE disk_activity VALIDATE CONSTRAINT disk_activity_kind_check;

-- +goose Down
SET LOCAL lock_timeout = '10s';
DELETE FROM disk_activity WHERE kind IN ('link_password_on', 'link_password_off', 'link_view_only_on', 'link_view_only_off');
ALTER TABLE disk_activity DROP CONSTRAINT disk_activity_kind_check;
ALTER TABLE disk_activity ADD CONSTRAINT disk_activity_kind_check
    CHECK (kind IN ('create', 'upload', 'rename', 'move', 'share', 'link_on', 'link_off', 'trash', 'restore',
                    'delete', 'edit'));
ALTER TABLE disk_links
    DROP COLUMN view_only,
    DROP COLUMN password_version,
    DROP COLUMN password_hash;
