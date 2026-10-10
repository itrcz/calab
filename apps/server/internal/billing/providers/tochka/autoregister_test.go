package tochka

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

type fakeBank struct {
	hook   *Webhook
	getErr error
	setErr []error // consumed per Set call
	gets   int
	sets   []string
}

func (f *fakeBank) GetWebhook(context.Context) (Webhook, error) {
	f.gets++
	if f.getErr != nil {
		return Webhook{}, f.getErr
	}
	if f.hook == nil {
		return Webhook{}, provider.ErrNotFound
	}
	return *f.hook, nil
}

func (f *fakeBank) SetWebhook(_ context.Context, u string) (Webhook, error) {
	f.sets = append(f.sets, u)
	if len(f.setErr) > 0 {
		e := f.setErr[0]
		f.setErr = f.setErr[1:]
		if e != nil {
			return Webhook{}, e
		}
	}
	f.hook = &Webhook{URL: u, Types: []string{WebhookTypeAcquiring}}
	return *f.hook, nil
}

const hookURL = "https://app.example.test/api/billing/tochka/webhook"

func TestEnsure(t *testing.T) {
	ctx := context.Background()
	for name, tc := range map[string]struct {
		hook     *Webhook
		wantSets int
	}{
		"already registered": {&Webhook{URL: hookURL, Types: []string{WebhookTypeAcquiring}}, 0},
		"other url":          {&Webhook{URL: "https://old.example.test/x", Types: []string{WebhookTypeAcquiring}}, 1},
		"missing type":       {&Webhook{URL: hookURL, Types: []string{"incomingPayment"}}, 1},
		"none":               {nil, 1},
	} {
		t.Run(name, func(t *testing.T) {
			f := &fakeBank{hook: tc.hook}
			if err := NewRegistrar(f, hookURL).Ensure(ctx); err != nil {
				t.Fatal(err)
			}
			if len(f.sets) != tc.wantSets {
				t.Fatalf("sets = %v, want %d", f.sets, tc.wantSets)
			}
		})
	}
}

func TestRunBackoffThenRecheck(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &fakeBank{setErr: []error{errors.New("bank 502"), errors.New("bank 400"), nil}}
	r := NewRegistrar(f, hookURL)
	var waits []time.Duration
	r.Sleep = func(_ context.Context, d time.Duration) bool {
		waits = append(waits, d)
		if len(waits) == 4 { // two failures, the success, one recheck
			cancel()
			return false
		}
		return true
	}
	r.Run(ctx)
	want := []time.Duration{10 * time.Second, 30 * time.Second, 6 * time.Hour, 6 * time.Hour}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
	if len(f.sets) != 3 {
		t.Fatalf("sets = %v, want 3 (2 failed + 1 ok); the recheck sees it registered", f.sets)
	}
}

func TestRunBackoffCapsAtThirtyMinutes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &fakeBank{getErr: errors.New("bank 500")}
	r := NewRegistrar(f, hookURL)
	var waits []time.Duration
	r.Sleep = func(_ context.Context, d time.Duration) bool {
		waits = append(waits, d)
		if len(waits) == 7 {
			cancel()
			return false
		}
		return true
	}
	r.Run(ctx)
	if waits[3] != 5*time.Minute || waits[4] != 30*time.Minute || waits[6] != 30*time.Minute {
		t.Fatalf("waits = %v", waits)
	}
	if len(f.sets) != 0 {
		t.Fatalf("set called on a failed read: %v", f.sets)
	}
}

func TestRunLockHeldByOtherReplica(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &fakeBank{}
	r := NewRegistrar(f, hookURL)
	r.Lock = func(context.Context) (func(), bool) { return func() {}, false }
	r.Sleep = func(_ context.Context, d time.Duration) bool {
		if d != r.Busy {
			t.Errorf("wait = %v, want Busy", d)
		}
		cancel()
		return false
	}
	r.Run(ctx)
	if f.gets != 0 || len(f.sets) != 0 {
		t.Fatalf("bank touched without the lock: gets=%d sets=%v", f.gets, f.sets)
	}
}
