package rtc

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// brokenDB answers every query with an error: the plan of a workspace cannot be read.
type brokenDB struct{}

func (brokenDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("injected database failure")
}

func (brokenDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("injected database failure")
}
func (brokenDB) QueryRow(context.Context, string, ...any) pgx.Row { return brokenRow{} }

type brokenRow struct{}

func (brokenRow) Scan(...any) error { return errors.New("injected database failure") }

// An unreadable plan must not keep a camera or a screen share on a LiveKit grant (ADR-0086
// amendment 1): the voice grant falls back to the restricted one, microphone only. A service
// without plans (no billing) stays unrestricted.
func TestLapsedFailsClosedOnPlanReadError(t *testing.T) {
	s := &Service{Plans: plans.New(&db.DB{Q: sqlc.New(brokenDB{})}, nil, plans.Limits{}, plans.Limits{}, plans.Limits{})}
	if !s.lapsed(context.Background(), uuid.New()) {
		t.Fatal("plan read error: want the restricted grant")
	}
	bits := perm.PlanInactive(perm.Speak | perm.Stream | perm.Video)
	if bits.Has(perm.Stream) || bits.Has(perm.Video) || !bits.Has(perm.Speak) {
		t.Fatalf("restricted bits %v: want the microphone only", bits)
	}
	if (&Service{}).lapsed(context.Background(), uuid.New()) {
		t.Fatal("no plans service: not restricted")
	}
}
