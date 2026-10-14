-- +goose NO TRANSACTION
-- Wiki search (ADR-0096 §7, the ADR-0062 pattern of 00064): a full-text index over the title and
-- the text of live pages (russian + simple, like events_search_idx) and a trigram index over the
-- title (typos, substrings). The expressions must stay those of search.WikiVector and
-- queries/wiki.sql SearchWikiPages; both are partial on live pages (trashed_at IS NULL), so the
-- queries repeat the predicate. pg_trgm exists since 00064.
--
-- Built CONCURRENTLY (no write lock on wiki_pages); an index left INVALID by an interrupted build
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
        WHERE NOT i.indisvalid AND c.relname IN ('wiki_pages_search_idx', 'wiki_pages_title_trgm_idx')
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', ix);
    END LOOP;
END
$$;
-- +goose StatementEnd

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS wiki_pages_search_idx ON wiki_pages
    USING gin ((to_tsvector('russian', title || ' ' || plain_text) || to_tsvector('simple', title || ' ' || plain_text)))
    WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS wiki_pages_title_trgm_idx ON wiki_pages USING gin (title gin_trgm_ops)
    WHERE trashed_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS wiki_pages_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS wiki_pages_search_idx;
