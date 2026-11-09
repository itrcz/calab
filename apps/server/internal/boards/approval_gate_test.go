package boards

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// ADR-0160: a board with the gate off lets a task with approvers start in COMPLETED.
func TestCreateGateOff(t *testing.T) {
	done := sqlc.BoardStatus{ID: uuid.New(), Type: "completed"}
	if err := checkCreateGate(2, 0, done, false); httpx.AsError(err).Reason != ReasonTaskApprovalRequired {
		t.Fatalf("hold: %v", err)
	}
	if err := checkCreateGate(2, 0, done, true); err != nil {
		t.Fatalf("off: %v", err)
	}
	if ApprovalGateProto(false) != v1.ApprovalGate_APPROVAL_GATE_HOLD || ApprovalGateProto(true) != v1.ApprovalGate_APPROVAL_GATE_OFF {
		t.Fatal("ApprovalGateProto")
	}
	if _, ok := approvalGates[v1.ApprovalGate_APPROVAL_GATE_UNSPECIFIED]; ok {
		t.Fatal("UNSPECIFIED must be refused")
	}
}
