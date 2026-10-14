-- Deleting imported CalDAV events from the owner's calendar (ADR-0045, amendment 1).
--
-- external_busy  + href (the absolute URL of the calendar object), etag (its ETag at the import:
--                the If-Match of DELETE / PUT), recurring (an occurrence of a series: the client
--                offers «only this / the whole series»), web_url (the provider's web page of the
--                event when it can be built reliably; '' otherwise). Rows of before are filled by
--                the next import (15 min); until then they cannot be deleted.

-- +goose Up
-- Constant defaults: metadata-only since PG 11 (no rewrite); the CHECKs scan the table once under
-- ACCESS EXCLUSIVE, so fail fast instead of queueing the import / reads behind a long transaction.
SET LOCAL lock_timeout = '10s';

ALTER TABLE external_busy
    ADD COLUMN href      text NOT NULL DEFAULT '' CHECK (char_length(href) <= 2048),
    ADD COLUMN etag      text NOT NULL DEFAULT '' CHECK (char_length(etag) <= 256),
    ADD COLUMN recurring boolean NOT NULL DEFAULT false,
    ADD COLUMN web_url   text NOT NULL DEFAULT '' CHECK (char_length(web_url) <= 2048);

-- +goose Down
ALTER TABLE external_busy DROP COLUMN href, DROP COLUMN etag, DROP COLUMN recurring, DROP COLUMN web_url;
