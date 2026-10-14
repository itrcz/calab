package boards

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestStatusIconsVector: boards.StatusIcons equals the shared list (TS STATUS_ICONS checks the
// same file), and every type of the vector maps to a known DB type.
func TestStatusIconsVector(t *testing.T) {
	raw, err := os.ReadFile("../../../../proto/testdata/status_icons.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Icons  []string          `json:"icons"`
		ByType map[string]string `json:"byType"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(StatusIcons, table.Icons) {
		t.Fatalf("StatusIcons %v, vector %v", StatusIcons, table.Icons)
	}
	for typ, icon := range table.ByType {
		if StatusTypeFromDB(typ) == v1.BoardStatusType_BOARD_STATUS_TYPE_UNSPECIFIED || !slices.Contains(StatusIcons, icon) {
			t.Errorf("byType %s → %s", typ, icon)
		}
	}
	for _, s := range []string{"", "half", "shield-check", "lock"} {
		if !ValidStatusIcon(s) {
			t.Errorf("%q rejected", s)
		}
	}
	for _, s := range []string{"Half", "lucide-star", " x", "three_quarters"} {
		if ValidStatusIcon(s) {
			t.Errorf("%q accepted", s)
		}
	}
}
