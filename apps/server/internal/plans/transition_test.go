package plans

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ADR-0086: what a transition is refused for, and what is not a violation.
func TestViolations(t *testing.T) {
	u := Usage{sqlc.GetWorkspacePlanUsageRow{
		Members: 51, Bots: 6, StorageBytes: 5<<30 + 1, Boards: 3, StickerPacks: 1, Stickers: 10,
		RoomUserLimits: []int32{30, 10, 5}, MaxBoardForms: 2, Automations: 3, BoardWebhooks: 1, Telephony: 1,
		Sso: 1, Directories: 1, OauthApps: 2, OperatorFeatures: []string{featureDirectory},
	}}
	got := map[v1.PlanLimitKind]*v1.PlanLimitViolation{}
	for _, v := range u.Violations(DefaultFree, false) {
		got[v.GetKind()] = v
	}
	want := map[v1.PlanLimitKind][3]uint64{
		v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS:        {51, 50, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS:           {6, 1, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB:     {5<<10 + 1, 5 << 10, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS:   {30, 5, 2},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS:    {2, 0, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS:    {3, 0, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS: {1, 0, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY:      {1, 0, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO:            {1, 0, 0},
		v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS:     {2, 0, 0},
	}
	if len(got) != len(want) {
		t.Fatalf("violations %v, want %v", got, want)
	}
	for k, w := range want {
		v := got[k]
		if v == nil || v.GetCurrent() != w[0] || v.GetLimit() != w[1] || uint64(v.GetRooms()) != w[2] {
			t.Fatalf("%v: %v, want %v", k, v, w)
		}
	}
	// Business fits all of it (identity granted, no feature flags off, limits above the usage).
	if v := u.Violations(DefaultBusiness, true); len(v) != 0 {
		t.Fatalf("Business: %v", v)
	}
	// Exactly at the limit is fine.
	at := Usage{sqlc.GetWorkspacePlanUsageRow{Members: 50, Bots: 1}}
	if v := at.Violations(DefaultFree, false); len(v) != 0 {
		t.Fatalf("at the limit: %v", v)
	}
}
