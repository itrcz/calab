-- +goose NO TRANSACTION
-- «е» and «ё» are one letter in search (CBF-169). Stored text keeps its «ё»; only the index
-- expressions and the queries fold it: translate(x, 'Ёё', 'Ее') (searchq.FoldSQL — the queries
-- must repeat the expression exactly). Rebuilt here:
--   - tasks_search_idx → tasks_search_fold_idx: the task words (boards.SearchVector, simple);
--   - the trigram indexes of the short fields (searchq.TitleMatch, the wiki / canvas search
--     queries): task and event titles, file and Disk item names, wiki page titles, canvas names.
-- The russian || simple vectors of events, wiki and canvas stay: their russian part folds ё
-- itself, the queries fold their words; messages and transcripts are not touched.
--
-- Built CONCURRENTLY (no write lock on the tables; the pattern of 00064 / 00091 / 00100): each new
-- index is built next to the old one, then the old one is dropped CONCURRENTLY. Hence NO
-- TRANSACTION: every statement is idempotent, and an index left INVALID by an interrupted build
-- is dropped first so that a retry builds it again.

-- +goose Up
SET lock_timeout = '10s';

-- +goose StatementBegin
DO $$
DECLARE
    ix text;
BEGIN
    FOR ix IN
        SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname IN ('tasks_search_fold_idx', 'tasks_title_fold_trgm_idx',
                                                 'events_title_fold_trgm_idx', 'files_name_fold_trgm_idx',
                                                 'disk_items_name_fold_trgm_idx', 'wiki_pages_title_fold_trgm_idx',
                                                 'canvas_items_name_fold_trgm_idx')
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', ix);
    END LOOP;
END
$$;
-- +goose StatementEnd

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_search_fold_idx ON tasks
    USING gin (to_tsvector('simple', translate(title || ' ' || description, 'Ёё', 'Ее')));
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_title_fold_trgm_idx ON tasks
    USING gin (translate(title, 'Ёё', 'Ее') gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_title_fold_trgm_idx ON events
    USING gin (translate(title, 'Ёё', 'Ее') gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_name_fold_trgm_idx ON files
    USING gin (translate(name, 'Ёё', 'Ее') gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS disk_items_name_fold_trgm_idx ON disk_items
    USING gin (translate(name, 'Ёё', 'Ее') gin_trgm_ops) WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS wiki_pages_title_fold_trgm_idx ON wiki_pages
    USING gin (translate(title, 'Ёё', 'Ее') gin_trgm_ops) WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS canvas_items_name_fold_trgm_idx ON canvas_items
    USING gin (translate(name, 'Ёё', 'Ее') gin_trgm_ops) WHERE trashed_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS tasks_search_idx;
DROP INDEX CONCURRENTLY IF EXISTS tasks_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS events_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS files_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS disk_items_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS wiki_pages_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS canvas_items_name_trgm_idx;

-- +goose Down
CREATE INDEX CONCURRENTLY IF NOT EXISTS canvas_items_name_trgm_idx ON canvas_items USING gin (name gin_trgm_ops)
    WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS wiki_pages_title_trgm_idx ON wiki_pages USING gin (title gin_trgm_ops)
    WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS disk_items_name_trgm_idx ON disk_items USING gin (name gin_trgm_ops)
    WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_name_trgm_idx ON files USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_title_trgm_idx ON events USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_title_trgm_idx ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_search_idx ON tasks USING gin (to_tsvector('simple', title || ' ' || description));

DROP INDEX CONCURRENTLY IF EXISTS canvas_items_name_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS wiki_pages_title_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS disk_items_name_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS files_name_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS events_title_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS tasks_title_fold_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS tasks_search_fold_idx;
