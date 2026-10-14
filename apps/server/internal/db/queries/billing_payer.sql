-- Payer requisites and versions (ADR-0080 §0.1, migration 00079).

-- name: SaveBillingPayer :one
-- The caller holds the account lock (LockBillingAccount), passes the next version and inserts
-- the same values into billing_payer_versions in the same transaction.
INSERT INTO billing_payers (account_id, type, name, country, email, tax_id, requisites, version, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, sqlc.arg('now')::timestamptz)
ON CONFLICT (account_id) DO UPDATE SET
    type = EXCLUDED.type, name = EXCLUDED.name, country = EXCLUDED.country, email = EXCLUDED.email,
    tax_id = EXCLUDED.tax_id, requisites = EXCLUDED.requisites, version = EXCLUDED.version,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
RETURNING *;

-- name: InsertBillingPayerVersion :exec
INSERT INTO billing_payer_versions (account_id, version, type, name, country, email, tax_id, requisites, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, sqlc.arg('now')::timestamptz);

-- name: ListBillingPayerVersions :many
SELECT * FROM billing_payer_versions WHERE account_id = $1 ORDER BY version;
