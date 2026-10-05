package push

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
	"testing"
	"time"
)

func TestIncomingCallJobAndTransportBoundary(t *testing.T) {
	id, room := uuid.NewString(), uuid.NewString()
	event := &v1.DispatchEvent{Event: &v1.DispatchEvent_CallRing{CallRing: &v1.CallRing{Call: &v1.Call{Id: id, DmRoomId: room, State: v1.CallState_CALL_STATE_RINGING, CreatedAt: timestamppb.Now()}}}}
	job, ok := eventJob(event)
	if !ok || job.Kind != callKind || job.ReferenceID.String() != id || time.Until(job.ExpiresAt) > 46*time.Second {
		t.Fatal("live call was not bounded and routed")
	}
	if !deviceEnabled(2, false, true, callKind) || deviceEnabled(1, true, true, callKind) || deviceEnabled(3, true, true, callKind) {
		t.Fatal("only explicitly enabled VoIP can ring")
	}
	event.GetCallRing().Call.State = v1.CallState_CALL_STATE_CANCELLED
	if _, ok = eventJob(event); ok {
		t.Fatal("terminal event routed")
	}
	event.GetCallRing().Call.State = v1.CallState_CALL_STATE_RINGING
	event.GetCallRing().Call.CreatedAt = timestamppb.New(time.Now().Add(-time.Minute))
	if _, ok = eventJob(event); ok {
		t.Fatal("expired ring routed")
	}
}
