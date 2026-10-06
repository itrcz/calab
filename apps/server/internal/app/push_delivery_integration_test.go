//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type pushRecorder struct {
	mu       sync.Mutex
	payloads []push.Payload
	result   push.Result
}

func (r *pushRecorder) Send(_ context.Context, _ push.Endpoint, p push.Payload) push.Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.payloads = append(r.payloads, p)
	return r.result
}
func (r *pushRecorder) sent() []push.Payload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]push.Payload(nil), r.payloads...)
}
func pushHarness(t *testing.T) (*push.Service, *httptest.Server, *pushRecorder) {
	t.Helper()
	rec := &pushRecorder{result: push.Result{Accepted: true}}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec, Push: map[v1.PushProvider]push.Provider{v1.PushProvider_PUSH_PROVIDER_FCM: {AppID: "ru.calab.test", Environment: "production", Sender: rec}}})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	return a.Push, server, rec
}
func pushPending(t *testing.T) int {
	t.Helper()
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_deliveries WHERE delivered_at IS NULL").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
func pushMessage(m *v1.Message) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: m}}}
}
func routePush(t *testing.T, s *push.Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for round := 0; round < 2048; round++ {
		var ready int
		if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM push_intents WHERE completed_at IS NULL AND expires_at>now() AND attempts<64 AND not_before<=now() AND (lease_until IS NULL OR lease_until<now())").Scan(&ready); err != nil {
			t.Fatal(err)
		}
		if ready == 0 {
			return
		}
		if err := s.Fanout(ctx); err != nil {
			t.Fatal(err)
		}
	}
	t.Fatal("routing did not settle bounded pending jobs")
}
func deliverPush(t *testing.T, s *push.Service) {
	t.Helper()
	routePush(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
}
func pushAll(t *testing.T, u *user, room string) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), "INSERT INTO room_notification_settings(user_id,room_id,level) VALUES($1,$2,'all') ON CONFLICT(user_id,room_id) DO UPDATE SET level='all'", u.id, room); err != nil {
		t.Fatal(err)
	}
}
func TestPushMessageFreshPermissionsPreviewAndDedupe(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, ws, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	endpoint := registerPush(t, server, bob, uuid.NewString(), "delivery-token", 200)
	msg := dmPost(t, o, room.Id, "message before edit")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	routePush(t, s)
	if pushPending(t) != 1 {
		t.Fatal("authorized routing did not enqueue")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE messages SET content='Привет после правки' WHERE id=$1", msg.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET display_name='Илья' WHERE id=$1", o.id); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	sent := rec.sent()
	if len(sent) != 1 || sent[0].Binding != endpoint.Id || sent[0].ReferenceID != msg.Id {
		t.Fatal("delivery binding mismatch")
	}
	if sent[0].Title != "Илья" || sent[0].Body != "Привет после правки" {
		t.Fatal("preview did not use current authorized sender/message")
	}
	body, _ := json.Marshal(sent[0])
	for _, private := range []string{"message before edit", "delivery-token", o.id, bob.id, "http", "authorization"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("payload exposed %s", private)
		}
	}
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("repeated committed event bypassed dedupe")
	}
	late := dmPost(t, o, room.Id, "access revoked before dispatch")
	s.Observe(context.Background(), uuid.Nil, pushMessage(late))
	routePush(t, s)
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", ws.Id, bob.id); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("worker sent with revoked room access")
	}
}
func TestPushDNDAndFreshSessionSuppressOSMessage(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, _, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), "dnd-token", 200)
	msg := dmPost(t, o, room.Id, "queued before dnd")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	routePush(t, s)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET presence_status=3,presence_until=NULL WHERE id=$1", bob.id); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 0 {
		t.Fatal("DND change did not suppress OS delivery")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET presence_status=NULL WHERE id=$1", bob.id); err != nil {
		t.Fatal(err)
	}
	fresh := dmPost(t, o, room.Id, "queued before revoke")
	s.Observe(context.Background(), uuid.Nil, pushMessage(fresh))
	routePush(t, s)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET revoked_at=now() WHERE id=$1", bob.session); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 0 {
		t.Fatal("worker trusted cached session")
	}
}
func TestPushPrivateRoomNeverFansWorkspaceEventToDevices(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, ws, _ := setupTeam(t)
	room := textRoom(t, o, ws.Id, "private", true)
	pushAll(t, bob, room)
	registerPush(t, server, bob, uuid.NewString(), "hidden-room-token", 200)
	msg := dmPost(t, o, room, "private domain event")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	if len(rec.sent()) != 0 || pushPending(t) != 0 {
		t.Fatal("raw workspace event bypassed private-room resolver")
	}
}
func TestPushRetryAndConcurrentWorkersAreBounded(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, _, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), "retry-token", 200)
	msg := dmPost(t, o, room.Id, "retry")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	routePush(t, s)
	rec.result = push.Result{Retry: true, RetryAfter: time.Minute}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); _ = s.Deliver(context.Background()) }()
	}
	workers.Wait()
	if len(rec.sent()) != 1 {
		t.Fatal("replicas dispatched the same lease")
	}
	var delay time.Time
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT not_before FROM push_deliveries WHERE reference_id=$1", msg.Id).Scan(&delay); err != nil || delay.Before(time.Now().Add(50*time.Second)) {
		t.Fatal("provider Retry-After not respected")
	}
	for attempt := 2; attempt <= 6; attempt++ {
		if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET not_before=now() WHERE reference_id=$1", msg.Id); err != nil {
			t.Fatal(err)
		}
		deliverPush(t, s)
	}
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	if len(rec.sent()) != 6 {
		t.Fatal("retry/dedupe bound exceeded")
	}
}

func TestPushEndpointPreferenceGatesAtDispatch(t *testing.T) {
	for _, test := range []struct {
		name                         string
		mentions, all, mention, want bool
	}{
		{"mentions ordinary", true, false, false, false}, {"mentions direct", true, false, true, true},
		{"all ordinary", false, true, false, true}, {"off mention", false, false, true, false},
		{"both ordinary", true, true, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, server, rec := pushHarness(t)
			o, bob, _, room := setupTeam(t)
			pushAll(t, bob, room.Id)
			endpoint := registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
			content := "ordinary"
			if test.mention {
				content = "@" + bob.id + " direct"
			}
			msg := dmPost(t, o, room.Id, content)
			s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
			routePush(t, s)
			if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_devices SET mentions_enabled=$2,all_enabled=$3 WHERE id=$1", endpoint.Id, test.mentions, test.all); err != nil {
				t.Fatal(err)
			}
			deliverPush(t, s)
			if (len(rec.sent()) == 1) != test.want {
				t.Fatalf("sent=%d want=%v", len(rec.sent()), test.want)
			}
		})
	}
}
func TestPushResolveCurrentSessionAccessAndExpiry(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, ws, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	installation := uuid.NewString()
	registerPush(t, server, bob, installation, uuid.NewString(), 200)
	msg := dmPost(t, o, room.Id, "private content")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("message not delivered")
	}
	receipt := rec.sent()[0]
	request := &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	var route v1.ResolvePushResponse
	pushHTTP(t, server, bob, 200, "POST", "/api/me/push-resolve", request, &route)
	if route.RoomId != room.Id || route.WorkspaceId != ws.Id || route.MessageId != msg.Id {
		t.Fatal("authorized route mismatch")
	}
	pushHTTP(t, server, o, 404, "POST", "/api/me/push-resolve", request, nil)
	other := secondDevice(t, bob)
	pushHTTP(t, server, other, 404, "POST", "/api/me/push-resolve", request, nil)
	registerPush(t, server, bob, installation, uuid.NewString(), 200)
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
	fresh := dmPost(t, o, room.Id, "fresh")
	s.Observe(context.Background(), uuid.Nil, pushMessage(fresh))
	deliverPush(t, s)
	receipt = rec.sent()[len(rec.sent())-1]
	request = &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET expires_at=now()-interval '1 second' WHERE id=$1", receipt.EventID); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
	last := dmPost(t, o, room.Id, "last")
	s.Observe(context.Background(), uuid.Nil, pushMessage(last))
	deliverPush(t, s)
	receipt = rec.sent()[len(rec.sent())-1]
	request = &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", ws.Id, bob.id); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
}
func TestPushMessageCutRejectsCallCapabilities(t *testing.T) {
	server := pushServer(t)
	u := owner(t)
	pushHTTP(t, server, u, 422, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: "test", CallsEnabled: true, NotificationsEnabled: true, MentionsEnabled: proto.Bool(true)}, nil)
	pushHTTP(t, server, u, 422, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_VOIP, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: "aa"}, nil)
}

// Completed intents only hold dedupe until expiry; they must not exhaust the pending cap.
func TestPushIntentCapCountsPendingOnly(t *testing.T) {
	s, _, _ := pushHarness(t)
	o, bob, _, room := setupTeam(t)
	marker := "cap-filler:" + uuid.NewString() + ":"
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO push_intents(recipient_id,event_key,kind,reference_id,expires_at,completed_at)
SELECT NULL,$1||g,1,gen_random_uuid(),now()+interval '5 minutes',now() FROM generate_series(1,8192) g`, marker); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_intents WHERE starts_with(event_key,$1)", marker)
	})
	msg := dmPost(t, o, room.Id, "after a burst of completed routing")
	s.Observe(context.Background(), uuid.MustParse(bob.id), pushMessage(msg))
	var queued int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_intents WHERE recipient_id=$1 AND event_key=$2", bob.id, "message:"+msg.Id).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("pending intent dropped behind completed rows: queued=%d err=%v", queued, err)
	}
}

func TestPushMessageTapRetentionAndBoundedAdmission(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, ws, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	endpoint := registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	msg := dmPost(t, o, room.Id, "read this later")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	receipt := rec.sent()[0]
	if receipt.ExpiresAt-receipt.DeliveryExpiresAt != int64(7*24*time.Hour/time.Millisecond) || receipt.DeliveryExpiresAt > time.Now().Add(5*time.Minute).UnixMilli() {
		t.Fatal("delivery and navigation deadlines were not separated")
	}
	// Advance this receipt past the old five-minute window, without changing test wall time.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET expires_at=expires_at-interval '10 minutes' WHERE id=$1", receipt.EventID); err != nil {
		t.Fatal(err)
	}
	request := &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	pushHTTP(t, server, bob, 200, "POST", "/api/me/push-resolve", request, &v1.ResolvePushResponse{})
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE messages SET deleted_at=now() WHERE id=$1", msg.Id); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE messages SET deleted_at=NULL WHERE id=$1", msg.Id); err != nil {
		t.Fatal(err)
	}
	// Fill retained receipts to the existing cap. A new message evicts only the oldest delivered receipt.
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO push_deliveries(device_id,device_version,event_key,kind,reference_id,room_id,expires_at,delivered_at)
 SELECT device_id,device_version,'retained:'||n,kind,reference_id,room_id,now()+interval '6 days',now()
 FROM push_deliveries CROSS JOIN generate_series(1,2047) n WHERE id=$1`, receipt.EventID); err != nil {
		t.Fatal(err)
	}
	fresh := dmPost(t, o, room.Id, "new delivery after receipt cap")
	s.Observe(context.Background(), uuid.Nil, pushMessage(fresh))
	deliverPush(t, s)
	if len(rec.sent()) != 2 {
		t.Fatal("retained receipts blocked fresh delivery")
	}
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_deliveries WHERE device_id=$1", endpoint.Id).Scan(&count); err != nil || count != 2048 {
		t.Fatalf("receipt storage escaped its bound: %d %v", count, err)
	}
	// Still require current workspace access even for a retained, correctly bound tap.
	if _, err := testDB.Pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", ws.Id, bob.id); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
}

func TestPushExpiredPendingMessageIsNotRetainedOrSent(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, _, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	msg := dmPost(t, o, room.Id, "too late to deliver")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	routePush(t, s)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET expires_at=now()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 0 {
		t.Fatal("expired pending message reached provider")
	}
}

func TestPushRejectedMessageDoesNotRetainNavigation(t *testing.T) {
	s, server, rec := pushHarness(t)
	rec.result = push.Result{}
	o, bob, _, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	msg := dmPost(t, o, room.Id, "provider rejected this message")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	var expiry time.Time
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT expires_at FROM push_deliveries WHERE id=$1", rec.sent()[0].EventID).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	if expiry.After(time.Now().Add(5 * time.Minute)) {
		t.Fatal("rejected message retained a navigation slot")
	}
}
