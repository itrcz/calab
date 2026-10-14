package worker

import (
	"testing"

	"github.com/calaba/calaba/server/internal/config"
)

func TestEnabledAndDefaults(t *testing.T) {
	for _, tc := range []struct {
		b    config.Billing
		want bool
	}{
		{config.Billing{}, false},
		{config.Billing{Enabled: true}, false},
		{config.Billing{Enabled: true, DebitsEnabled: true}, true},
	} {
		if got := Enabled(tc.b); got != tc.want {
			t.Errorf("%+v: %v", tc.b, got)
		}
	}
	w := New(nil, Options{})
	if w.opts.Poll != DefaultPoll || w.opts.Batch != DefaultBatch || w.opts.IntegrityEvery != DefaultIntegrityEvery {
		t.Fatalf("defaults %+v", w.opts)
	}
}
