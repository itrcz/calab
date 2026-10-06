//go:build integration

package rtc

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/voice"
)

// voicePub records the VOICE_STATE_UPDATEs published to workspaces, in publish order.
type voicePub struct {
	events.Nop
	mu  sync.Mutex
	got []*v1.VoiceState
}

func (p *voicePub) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	if vs := ev.GetVoiceStateUpdate().GetState(); vs != nil {
		p.mu.Lock()
		p.got = append(p.got, proto.CloneOf(vs))
		p.mu.Unlock()
	}
}

func (p *voicePub) last(t *testing.T) *v1.VoiceState {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.got) == 0 {
		t.Fatal("no VOICE_STATE_UPDATE published")
	}
	return p.got[len(p.got)-1]
}

// Two changes of one user whose announcements reach Redis in the opposite order (a
// participant_left of the old room handled by one API instance, the /join of the new room
// by another, each publishing after its own unlock): the announcement published last must
// carry the latest state. It used to carry its own stale snapshot ("not in voice"), which
// every connected client kept — the person talked in the room but was missing from it.
func TestVoicePublishLastCarriesLatestState(t *testing.T) {
	s, _ := testService(t, &fakeLK{})
	pub := &voicePub{}
	s.events = pub
	ctx := context.Background()
	wid, roomA, roomB, uid, sid := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()

	if _, err := s.voice.Update(ctx, wid, uid, sid, func(*voice.SessionState) *voice.SessionState {
		return &voice.SessionState{RoomID: roomA}
	}); err != nil {
		t.Fatal(err)
	}
	left, err := s.voice.Update(ctx, wid, uid, sid, func(*voice.SessionState) *voice.SessionState { return nil })
	if err != nil {
		t.Fatal(err)
	}
	joined, err := s.voice.Update(ctx, wid, uid, sid, func(*voice.SessionState) *voice.SessionState {
		return &voice.SessionState{RoomID: roomB, Pending: true}
	})
	if err != nil {
		t.Fatal(err)
	}
	s.publishVoice(ctx, wid, joined)
	s.publishVoice(ctx, wid, left) // the older change's announcement is late
	if got := pub.last(t); got.GetRoomId() != roomB.String() || !got.GetPending() {
		t.Fatalf("last published state = room %q pending %v, want the current one: room %s pending", got.GetRoomId(), got.GetPending(), roomB)
	}
}

// Concurrent changes of one user from many goroutines: whatever the interleaving, the last
// VOICE_STATE_UPDATE equals the state in Redis.
func TestVoicePublishConcurrentEndsOnStoredState(t *testing.T) {
	s, _ := testService(t, &fakeLK{})
	pub := &voicePub{}
	s.events = pub
	ctx := context.Background()
	wid, uid, sid := uuid.New(), uuid.New(), uuid.New()
	rooms := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}

	var wg sync.WaitGroup
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := s.voice.Update(ctx, wid, uid, sid, func(*voice.SessionState) *voice.SessionState {
				if i%4 == 3 {
					return nil // left
				}
				return &voice.SessionState{RoomID: rooms[i%len(rooms)], Muted: i%2 == 0}
			})
			if err != nil {
				t.Error(err)
				return
			}
			s.publishVoice(ctx, wid, c)
		}()
	}
	wg.Wait()
	want, err := s.voice.State(ctx, wid, uid)
	if err != nil {
		t.Fatal(err)
	}
	if got := pub.last(t); got.GetRoomId() != want.GetRoomId() || got.GetMuted() != want.GetMuted() {
		t.Fatalf("last published = room %q muted %v, stored = room %q muted %v", got.GetRoomId(), got.GetMuted(), want.GetRoomId(), want.GetMuted())
	}
}
