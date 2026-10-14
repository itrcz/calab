//go:build integration

package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// TestMigration74BillingRoundTrip: 00074 goes up on a database with a manual plan (source
// defaults to manual), down cleanly (plan rows kept) and up again.
func TestMigration74BillingRoundTrip(t *testing.T) {
	ctx := context.Background()
	d, err := Connect(ctx, newTestDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := d.MigrateTo(ctx, 73); err != nil {
		t.Fatal(err)
	}
	user, ws := uuid.New(), uuid.New()
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, 'bill@example.com', 'b')`, user)
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'bill-ws', 'W', $2)`, ws, user)
	exec(`INSERT INTO workspace_plans (workspace_id, plan) VALUES ($1, 'team')`, ws)
	exec(`INSERT INTO workspace_plan_log (workspace_id, plan, limits) VALUES ($1, 'team', '{}')`, ws)

	for round := range 2 {
		if err := d.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		var source string
		if err := d.Pool.QueryRow(ctx, `SELECT source FROM workspace_plans WHERE workspace_id = $1`, ws).Scan(&source); err != nil || source != "manual" {
			t.Fatalf("round %d: source %q, %v", round, source, err)
		}
		var prices int
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM billing_prices`).Scan(&prices); err != nil || prices != 4 {
			t.Fatalf("round %d: %d seed prices, %v", round, prices, err)
		}
		exec(`INSERT INTO billing_accounts (workspace_id, market, currency, provider) VALUES ($1, 'global', 'USD', 'stripe')`, ws)
		p, err := newProvider(d)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.DownTo(ctx, 73); err != nil {
			t.Fatalf("round %d down: %v", round, err)
		}
		var n int
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_plans`).Scan(&n); err != nil || n != 1 {
			t.Fatalf("round %d: plans after down %d, %v", round, n, err)
		}
		var left int
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE tablename LIKE 'billing\_%'`).Scan(&left); err != nil || left != 0 {
			t.Fatalf("round %d: %d billing tables after down, %v", round, left, err)
		}
	}
}
