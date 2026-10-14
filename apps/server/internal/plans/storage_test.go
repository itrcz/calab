package plans

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ADR-0094 §6: storage add-ons raise the plan's storage limit; an unlimited plan stays
// unlimited.
func TestStorageWithAddons(t *testing.T) {
	cases := []struct {
		name    string
		planMB  uint64
		addonMB int64
		want    int64
		ok      bool
	}{
		{"unlimited plan", 0, 10 << 10, 0, false},
		{"no add-ons", 300 << 10, 0, 300 << 30, true},
		{"+10 GB", 300 << 10, 10 << 10, 310 << 30, true},
		{"+100 GB and +1 TB", 300 << 10, 100<<10 + 1<<20, (300 + 100 + 1024) << 30, true},
		{"negative sum counts as none", 5 << 10, -1, 5 << 30, true},
		{"absurd add-ons are capped", 1, 1 << 62, (1 + maxAddonMB) << 20, true},
	}
	for _, c := range cases {
		got, ok := Limits{StorageMB: c.planMB}.StorageWithAddons(c.addonMB)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got %d %v, want %d %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

// A plan transition counts the add-ons in the storage limit (ADR-0094 §6, ADR-0086).
func TestViolationsStorageAddons(t *testing.T) {
	target := Limits{StorageMB: 5 << 10}
	used := int64(6 << 30)
	if vs := (Usage{sqlc.GetWorkspacePlanUsageRow{StorageBytes: used}}).Violations(target, false); !hasKind(vs, v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB) {
		t.Fatalf("6 GB over a 5 GB plan without add-ons must be a violation: %v", vs)
	}
	vs := (Usage{sqlc.GetWorkspacePlanUsageRow{StorageBytes: used, StorageAddonMb: 10 << 10}}).Violations(target, false)
	if hasKind(vs, v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB) {
		t.Fatalf("6 GB fit 5 GB + a 10 GB add-on: %v", vs)
	}
	vs = (Usage{sqlc.GetWorkspacePlanUsageRow{StorageBytes: 16 << 30, StorageAddonMb: 10 << 10}}).Violations(target, false)
	for _, v := range vs {
		if v != nil && v.GetKind() == v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB && v.GetLimit() != 15<<10 {
			t.Fatalf("the limit reported is plan + add-ons: %v", v)
		}
	}
	if !hasKind(vs, v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB) {
		t.Fatalf("16 GB over 5 GB + 10 GB: %v", vs)
	}
}

func hasKind(vs []*v1.PlanLimitViolation, k v1.PlanLimitKind) bool {
	for _, v := range vs {
		if v != nil && v.GetKind() == k {
			return true
		}
	}
	return false
}
