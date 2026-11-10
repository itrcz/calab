//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/google/uuid"
	"github.com/redis/rueidis"
)

// Reject only the selected badge-cache operation; auth and delivery still use real Redis.
type badgeCacheFault struct {
	rueidis.Client
	reject       atomic.Value
	lastRejected atomic.Value
}

func (c *badgeCacheFault) Do(ctx context.Context, command rueidis.Completed) rueidis.RedisResult {
	args := command.Commands()
	if len(args) > 4 && strings.HasPrefix(args[3], redisx.Key("push:badge:")) && args[4] == c.reject.Load() {
		c.lastRejected.Store(append([]string(nil), args...))
		return c.Client.Do(ctx, c.B().Arbitrary("BADGE_CACHE_TEST_FAILURE").Build())
	}
	return c.Client.Do(ctx, command)
}

type badgeTimeoutRecorder struct{ *pushRecorder }

func (r badgeTimeoutRecorder) Send(ctx context.Context, endpoint push.Endpoint, payload push.Payload) push.Result {
	<-ctx.Done()
	return r.pushRecorder.Send(ctx, endpoint, payload)
}

func awaitBadgeAttempts(t *testing.T, rec *pushRecorder, attempts, count int) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if sent := rec.sent(); len(sent) >= attempts {
			p := sent[len(sent)-1]
			if p.Badge == nil || *p.Badge != count {
				t.Fatalf("want badge %d, got %+v", count, p)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("missing refresh to %d: got %d attempts, want %d", count, len(rec.sent()), attempts)
}

func TestPushBadgeAcrossReplicas(t *testing.T) {
	for _, mode := range []string{"accepted", "rejected", "timeout", "cache-write-failure", "cache-invalidation-failure"} {
		t.Run(mode, func(t *testing.T) {
			recA := &pushRecorder{result: push.Result{Accepted: true}}
			recB := &pushRecorder{result: push.Result{Accepted: true}}
			var senderB push.Sender = recB
			if mode == "rejected" || mode == "timeout" {
				recB.result = push.Result{Retry: true}
			}
			if mode == "timeout" {
				senderB = badgeTimeoutRecorder{recB}
			}
			cache := &badgeCacheFault{Client: testRedis}
			cache.reject.Store("")
			newReplica := func(sender push.Sender) *app.App {
				return app.New(app.Deps{Config: testCfg, DB: testDB, Redis: cache, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec,
					Push: map[v1.PushProvider]push.Provider{v1.PushProvider_PUSH_PROVIDER_APNS: {AppID: "ru.calab.test", Environment: "production", Sender: sender}}})
			}
			a, b := newReplica(recA), newReplica(senderB)
			server := httptest.NewServer(a.Handler)
			defer server.Close()
			o, bob, _, _ := setupTeam(t)
			// Use the fresh user's creation quota, not the suite's shared owner's.
			dm := openDM(t, bob, o.id, 201).GetRoom().GetId()
			var messages []*v1.Message
			for range 4 {
				messages = append(messages, dmPost(t, o, dm, "unread"))
			}
			endpoint := registerBadgeDevice(t, server, bob)
			pushHTTP(t, server, bob, 204, "PUT", "/api/rooms/"+dm+"/read", &v1.UpdateReadStateRequest{MessageId: messages[0].Id}, nil)
			awaitBadgeAttempts(t, recA, 1, 3)
			switch mode {
			case "cache-write-failure":
				cache.reject.Store("finish")
			case "cache-invalidation-failure":
				cache.reject.Store("prepare")
			}
			latest := dmPost(t, o, dm, "fourth unread")
			b.Push.Observe(t.Context(), uuid.Nil, pushMessage(latest))
			deliverPush(t, b.Push)
			if sent := recB.sent(); len(sent) != 1 || sent[0].Kind != "message" {
				t.Fatalf("ordinary alert was lost: %+v", sent)
			} else if mode == "cache-invalidation-failure" {
				if sent[0].Badge != nil {
					t.Fatal("alert changed the badge without invalidating the old cache")
				}
			} else if sent[0].Badge == nil || *sent[0].Badge != 4 {
				t.Fatalf("replica B did not send badge 4: %+v", sent[0])
			}
			cache.reject.Store("")
			if mode == "cache-invalidation-failure" {
				// The alert left the icon at 3. Once Redis recovers, the unread 4
				// must still be sent, rather than marked accepted in the failed path.
				a.Push.Observe(t.Context(), uuid.MustParse(bob.id), badgeReadEvent())
				awaitBadgeAttempts(t, recA, 2, 4)
			}
			before := len(recA.sent())
			pushHTTP(t, server, bob, 204, "PUT", "/api/rooms/"+dm+"/read", &v1.UpdateReadStateRequest{MessageId: messages[1].Id}, nil)
			awaitBadgeAttempts(t, recA, before+1, 3) // A:3 → B:4 → A:3 must not skip.
			if mode == "cache-write-failure" {
				// Reproduce an uncertain Redis timeout: the old completion arrives
				// after the new accepted count. Its token must not overwrite that count.
				key := redisx.Key("push:badge:" + endpoint.Id + ":" + strconv.FormatUint(endpoint.Version, 10))
				deadline := time.Now().Add(time.Second)
				for {
					value, err := testRedis.Do(t.Context(), testRedis.B().Get().Key(key).Build()).ToString()
					if err == nil && value == "3" {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("shared accepted count missing: %q, %v", value, err)
					}
					time.Sleep(10 * time.Millisecond)
				}
				args := cache.lastRejected.Load().([]string)
				if err := testRedis.Do(t.Context(), testRedis.B().Arbitrary(args[0]).Args(args[1:]...).Build()).Error(); err != nil {
					t.Fatal(err)
				}
			}
			beforeB := len(recB.sent())
			b.Push.Observe(t.Context(), uuid.MustParse(bob.id), badgeReadEvent())
			time.Sleep(1300 * time.Millisecond)
			if len(recB.sent()) != beforeB {
				t.Fatal("replica B did not deduplicate replica A's accepted count")
			}
		})
	}
}
