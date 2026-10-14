package plans

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestCleanText(t *testing.T) {
	for in, want := range map[string]string{
		"  Acme Pro  ":           "Acme Pro",
		"Acme\n\tPro":            "Acme Pro",
		"Acme\u202eorP":          "AcmeorP", // bidi override removed
		"A\u200bc\u0000me":       "Acme",    // zero-width and NUL removed
		"Тариф   «Нейро-офис»":   "Тариф «Нейро-офис»",
		"\u00a0Pro\u00a0":        "Pro",
		"":                       "",
		"\u200b\u200b":           "",
		"Pro\r\nMax\x7fLine\x1b": "Pro MaxLine",
	} {
		if got := CleanText(in); got != want {
			t.Errorf("CleanText(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCustomText(t *testing.T) {
	if n, d, err := CustomText(" "+strings.Repeat("я", 40)+"\n", strings.Repeat("d", 140)); err != nil || n != strings.Repeat("я", 40) || len(d) != 140 {
		t.Fatalf("at the limits: %q %q %v", n, d, err)
	}
	if _, _, err := CustomText(strings.Repeat("я", 41), ""); err == nil {
		t.Fatal("41 characters accepted")
	}
	if _, _, err := CustomText("", strings.Repeat("d", 141)); err == nil {
		t.Fatal("141 characters of description accepted")
	}
}

// Workspace.plan carries the name of a custom plan only; an empty name stays empty (the client
// shows «Индивидуальный»).
func TestCustomPlanName(t *testing.T) {
	s := New(nil, nil, DefaultFree, DefaultTeam, DefaultBusiness)
	now := time.Now()
	ws := uuid.New()
	custom := &sqlc.WorkspacePlan{WorkspaceID: ws, Plan: "custom", Limits: []byte(`{"members":7}`), Source: "billing",
		DisplayName: "Acme Pro", Description: "Contract 7"}
	p := s.Resolve(context.Background(), custom, now).Proto()
	if p.GetPlan() != v1.Plan_PLAN_CUSTOM || p.GetDisplayName() != "Acme Pro" || p.GetDescription() != "Contract 7" || p.GetLimits().GetMembers() != 7 {
		t.Fatalf("custom: %v", p)
	}
	custom.DisplayName, custom.Description = "", ""
	if p := s.Resolve(context.Background(), custom, now).Proto(); p.GetDisplayName() != "" {
		t.Fatalf("unnamed custom: %v", p)
	}
	team := &sqlc.WorkspacePlan{WorkspaceID: ws, Plan: "team", DisplayName: "stale", Source: "billing"}
	if p := s.Resolve(context.Background(), team, now).Proto(); p.GetDisplayName() != "" {
		t.Fatalf("team carries a name: %v", p)
	}
	// The billing custom plan blocks self-serve, a manual one too; an expired manual one does not.
	if !AdminAssigned(sqlc.WorkspacePlan{Plan: "custom", Source: "billing"}, now) {
		t.Fatal("billing custom plan not admin-assigned")
	}
	past := now.Add(-time.Hour)
	if AdminAssigned(sqlc.WorkspacePlan{Plan: "custom", Source: "manual", ValidUntil: &past}, now) {
		t.Fatal("expired manual plan admin-assigned")
	}
	if AdminAssigned(sqlc.WorkspacePlan{Plan: "team", Source: "billing"}, now) {
		t.Fatal("billing Team admin-assigned")
	}
}
