-- Disk «Управление» (CBF-161, ADR-0161): a person's override of an item may carry DISK_MANAGE
-- (1 << 37) as well — allowed only together with DISK_VIEW | DISK_WRITE, denied freely; a
-- role's override stays within DISK_VIEW | DISK_WRITE (103079215104). Guests are checked by the
-- server (the member's role is not on the row).

-- +goose Up
ALTER TABLE disk_permissions
    DROP CONSTRAINT disk_permissions_bits_check,
    ADD CONSTRAINT disk_permissions_bits_check CHECK (
        allow & deny = 0
        AND (allow | deny) & ~(CASE WHEN target_type = 'user' THEN 240518168576 ELSE 103079215104 END)::bigint = 0
        AND (allow & 137438953472 = 0 OR allow & 103079215104 = 103079215104)
    );

-- +goose Down
UPDATE disk_permissions SET allow = allow & ~137438953472::bigint, deny = deny & ~137438953472::bigint
    WHERE (allow | deny) & 137438953472 <> 0;
DELETE FROM disk_permissions WHERE allow = 0 AND deny = 0;
ALTER TABLE disk_permissions
    DROP CONSTRAINT disk_permissions_bits_check,
    ADD CONSTRAINT disk_permissions_bits_check CHECK ((allow | deny) & ~103079215104::bigint = 0 AND allow & deny = 0);
