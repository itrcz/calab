package core

import (
	"context"

	"github.com/google/uuid"
)

// Integrity checks.
const (
	CheckLedger  = "ledger"  // balance cache and entry_seq = sum / count / max of the ledger
	CheckFunding = "funding" // balance = free advance of the lots - unpaid charges
)

// Mismatch is one account that failed an integrity check.
type Mismatch struct {
	AccountID uuid.UUID
	Check     string
	Balance   int64 // cached balance
	Expected  int64 // what the ledger / lots and charges say
	EntrySeq  int64 // ledger check: cached entry_seq
	LedgerSeq int64 // ledger check: last seq in the ledger
}

// CheckIntegrity runs the nightly reconciliation (read-only): sum(ledger) = balance and
// balance = free advance - debt for every account. It never repairs anything.
func (c *Core) CheckIntegrity(ctx context.Context) ([]Mismatch, error) {
	var out []Mismatch
	ledger, err := c.db.Q.ListBillingLedgerMismatches(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range ledger {
		out = append(out, Mismatch{AccountID: m.ID, Check: CheckLedger, Balance: m.BalanceMinor, Expected: m.LedgerTotal,
			EntrySeq: m.EntrySeq, LedgerSeq: m.LedgerSeq})
	}
	funding, err := c.db.Q.ListBillingFundingMismatches(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range funding {
		out = append(out, Mismatch{AccountID: m.ID, Check: CheckFunding, Balance: m.BalanceMinor, Expected: m.FreeMinor - m.DebtMinor})
	}
	return out, nil
}
