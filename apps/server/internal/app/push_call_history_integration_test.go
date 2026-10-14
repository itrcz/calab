//go:build integration

package app_test

import (
	"context"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestPushCallHistoryOnlyMissedNotifiesAndKeepsAuthenticatedRoute(t *testing.T) {
	for _, outcome := range []v1.CallOutcome{v1.CallOutcome_CALL_OUTCOME_MISSED, v1.CallOutcome_CALL_OUTCOME_DECLINED, v1.CallOutcome_CALL_OUTCOME_CANCELLED, v1.CallOutcome_CALL_OUTCOME_ENDED, v1.CallOutcome_CALL_OUTCOME_BUSY} {
		t.Run(outcome.String(), func(t *testing.T) {
			s, server, rec := pushHarness(t)
			caller, callee, _, _ := setupTeam(t)
			dm := openDM(t, caller, callee.id, 201).GetRoom().GetId()
			endpoint := registerPush(t, server, callee, uuid.NewString(), uuid.NewString(), 200)
			callee.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
			card := &v1.SystemMessage{Payload: &v1.SystemMessage_Call{Call: &v1.CallCard{CallerId: caller.id, CallId: uuid.NewString(), Outcome: outcome}}}
			message, err := messages.NewSystem(testDB, events.Nop{}).PostDM(t.Context(), uuid.MustParse(dm), uuid.MustParse(caller.id), []uuid.UUID{uuid.MustParse(caller.id), uuid.MustParse(callee.id)}, nil, card)
			if err != nil {
				t.Fatal(err)
			}
			event := pushMessage(&v1.Message{Id: message.ID.String(), RoomId: dm, Kind: v1.MessageKind_MESSAGE_KIND_SYSTEM, System: card})
			s.Observe(t.Context(), uuid.MustParse(callee.id), event)
			deliverPush(t, s)
			if outcome != v1.CallOutcome_CALL_OUTCOME_MISSED {
				if len(rec.sent()) != 0 {
					t.Fatal("non-missed call sent a message alert")
				}
				return
			}
			if len(rec.sent()) != 1 {
				t.Fatal("missed call notification missing")
			}
			receipt := rec.sent()[0]
			if !receipt.MissedCall || receipt.Body != "Missed call" || receipt.Title == "" || receipt.PersonID == "" || receipt.ConversationID == "" {
				t.Fatalf("wrong missed-call presentation: %+v", receipt)
			}
			request := &v1.ResolvePushRequest{Binding: endpoint.Id, EventId: receipt.EventID}
			var route v1.ResolvePushResponse
			pushHTTP(t, server, callee, 200, "POST", "/api/me/push-resolve", request, &route)
			if route.MessageId != message.ID.String() || route.RoomId != dm {
				t.Fatal("missed-call tap lost existing history route")
			}
			pushHTTP(t, server, caller, 404, "POST", "/api/me/push-resolve", request, nil)
			if _, err := testDB.Pool.Exec(t.Context(), "UPDATE messages SET deleted_at=now() WHERE id=$1", message.ID); err != nil {
				t.Fatal(err)
			}
			pushHTTP(t, server, callee, 404, "POST", "/api/me/push-resolve", request, nil)
		})
	}
}

func TestPushCallHistoryRechecksPersistedOutcomeBeforeDispatch(t *testing.T) {
	s, server, rec := pushHarness(t)
	caller, callee, _, _ := setupTeam(t)
	dm := openDM(t, caller, callee.id, 201).GetRoom().GetId()
	registerPush(t, server, callee, uuid.NewString(), uuid.NewString(), 200)
	card := &v1.SystemMessage{Payload: &v1.SystemMessage_Call{Call: &v1.CallCard{CallerId: caller.id, Outcome: v1.CallOutcome_CALL_OUTCOME_MISSED}}}
	message, err := messages.NewSystem(testDB, events.Nop{}).PostDM(context.Background(), uuid.MustParse(dm), uuid.MustParse(caller.id), nil, nil, card)
	if err != nil {
		t.Fatal(err)
	}
	s.Observe(t.Context(), uuid.MustParse(callee.id), pushMessage(&v1.Message{Id: message.ID.String(), RoomId: dm, Kind: v1.MessageKind_MESSAGE_KIND_SYSTEM, System: card}))
	routePush(t, s)
	card.GetCall().Outcome = v1.CallOutcome_CALL_OUTCOME_DECLINED
	raw, err := protojson.Marshal(card)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Pool.Exec(t.Context(), "UPDATE messages SET payload=$2 WHERE id=$1", message.ID, raw); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 0 {
		t.Fatal("stale queued call outcome produced an alert")
	}
}
