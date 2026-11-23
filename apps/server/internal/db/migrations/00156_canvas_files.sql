-- Pictures pasted or dropped on a canvas (owner 23.11.2026, ADR-0127 addendum): a file uploaded
-- through POST /api/canvas/items/{id}/files belongs to that canvas, like wiki_page_files to a
-- page. The board's image object keeps the /api/files/{id} path; files.CanRead lets whoever has
-- CANVAS_VIEW on the canvas read it. The row is a reference for the orphan cleanup and the
-- pending-upload bytes (files.sql); deleting the canvas forever drops it (CASCADE) and the file
-- becomes an orphan the cleanup takes. A new table: safe on a populated database; old pods
-- during the rollout neither write nor read it.

-- +goose Up
CREATE TABLE canvas_item_files (
    item_id    uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    file_id    uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, file_id)
);
-- The orphan cleanup, the pending-upload bytes and files.CanRead look a file up by id.
CREATE INDEX canvas_item_files_file_idx ON canvas_item_files (file_id);

-- +goose Down
DROP TABLE canvas_item_files;
