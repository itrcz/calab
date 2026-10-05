package sip

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/rtc"
)

func TestTestVerdict(t *testing.T) {
	// What LiveKit SIP returns when its ringing timeout ends a call that got no final answer.
	timedOut := &rtc.Error{Status: 499, Code: "canceled", Msg: "sip request timed out"}
	for _, c := range []struct {
		name   string
		err    error
		rang   bool
		ok     bool
		status uint32
		msg    string // substring
	}{
		{"answered", nil, false, true, 0, "answered"},
		{"busy", &rtc.Error{Code: "unavailable", Meta: map[string]string{"sip_status_code": "486", "sip_status": "Busy Here"}}, false, true, 486, "486 Busy Here"},
		{"auth", &rtc.Error{Code: "unavailable", Meta: map[string]string{"sip_status_code": "403", "sip_status": "Forbidden"}}, true, false, 403, "403 Forbidden"},
		{"rang, no answer", timedOut, true, true, 0, "rang the number"},
		{"silent provider", timedOut, false, false, 0, "did not answer the call within 15 s"},
		{"transaction", &rtc.Error{Code: "canceled", Msg: "transaction failed to complete (0 intermediate responses)"}, false, false, 0, "check the host, port and transport"},
		{"our deadline", fmt.Errorf("livekit: %w", context.DeadlineExceeded), false, false, 0, "within 25 s"},
		{"livekit text", &rtc.Error{Code: "internal", Msg: "no trunk"}, false, false, 0, "no trunk"},
		{"unreachable", fmt.Errorf("dial tcp: refused"), false, false, 0, "unreachable"},
	} {
		got := testVerdict(c.err, c.rang)
		if got.GetOk() != c.ok || got.GetSipStatus() != c.status || !strings.Contains(got.GetMessage(), c.msg) {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestFailureReasonTimedOut(t *testing.T) {
	if r := failureReason(&rtc.Error{Code: "canceled", Msg: "sip request timed out"}); r != reasonNoAnswer {
		t.Fatalf("timed out: %q", r)
	}
	if r := failureReason(&rtc.Error{Code: "canceled", Msg: "something else"}); r != reasonError {
		t.Fatalf("other: %q", r)
	}
}
