package push

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
	"testing"
)

func TestCallCardsDoNotBecomeGenericMessageAlerts(t *testing.T) {
	for _, outcome := range []v1.CallOutcome{v1.CallOutcome_CALL_OUTCOME_MISSED, v1.CallOutcome_CALL_OUTCOME_DECLINED, v1.CallOutcome_CALL_OUTCOME_CANCELLED, v1.CallOutcome_CALL_OUTCOME_ENDED, v1.CallOutcome_CALL_OUTCOME_BUSY, v1.CallOutcome_CALL_OUTCOME_UNSPECIFIED} {
		t.Run(outcome.String(), func(t *testing.T) {
			m := &v1.Message{Id: uuid.NewString(), RoomId: uuid.NewString(), Kind: v1.MessageKind_MESSAGE_KIND_SYSTEM, System: &v1.SystemMessage{Payload: &v1.SystemMessage_Call{Call: &v1.CallCard{Outcome: outcome}}}}
			job, ok := eventJob(&v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: m}}})
			if ok != (outcome == v1.CallOutcome_CALL_OUTCOME_MISSED) {
				t.Fatalf("call outcome %v queued as a generic message: %v", outcome, ok)
			}
			if ok && (job.Kind != messageKind || job.ReferenceID.String() != m.Id) {
				t.Fatal("missed call lost existing authenticated history route")
			}
		})
	}
}
