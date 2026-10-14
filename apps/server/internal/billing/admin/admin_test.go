package admin

import (
	"bytes"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/config"
)

func TestNewCmdHashAndValidation(t *testing.T) {
	rid := uuid.NewString()
	mk := func(query string, req *v1.AdminManualCreditRequest, target string) (*cmd, error) {
		r := httptest.NewRequestWithContext(t.Context(), "POST", "/x"+query, nil)
		r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uuid.New()}))
		return newCmd(r, actionManualCredit, req, target)
	}
	base := &v1.AdminManualCreditRequest{Amount: &v1.Money{Minor: 5, Currency: "USD"}, Reason: "goodwill", RequestId: rid}
	a, err := mk("", base, "acc1")
	if err != nil || a.preview || a.reason != "goodwill" || a.requestID.String() != rid {
		t.Fatalf("cmd: %+v %v", a, err)
	}
	withPreview := &v1.AdminManualCreditRequest{Amount: base.Amount, Reason: base.Reason, RequestId: rid, Preview: true}
	b, err := mk("", withPreview, "acc1")
	if err != nil || !b.preview || !bytes.Equal(a.hash, b.hash) {
		t.Fatalf("preview must not change the hash: %+v %v", b, err)
	}
	q, err := mk("?preview=1", base, "acc1")
	if err != nil || !q.preview || !bytes.Equal(a.hash, q.hash) {
		t.Fatalf("query preview: %+v %v", q, err)
	}
	if other, _ := mk("", base, "acc2"); bytes.Equal(a.hash, other.hash) {
		t.Fatal("target is part of the hash")
	}
	if other, _ := mk("", &v1.AdminManualCreditRequest{Amount: &v1.Money{Minor: 6, Currency: "USD"}, Reason: "goodwill", RequestId: rid}, "acc1"); bytes.Equal(a.hash, other.hash) {
		t.Fatal("body is part of the hash")
	}
	for _, bad := range []*v1.AdminManualCreditRequest{
		{Reason: "goodwill"}, {Reason: "goodwill", RequestId: "nope"}, {Reason: " abc ", RequestId: rid},
		{Reason: string(bytes.Repeat([]byte("x"), 1001)), RequestId: rid},
	} {
		if _, err := mk("", bad, "acc1"); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	if _, err := mk("?preview=maybe", base, "acc1"); err == nil {
		t.Error("accepted preview=maybe")
	}
}

func TestTestClockAllowed(t *testing.T) {
	for _, c := range []struct {
		cfg  config.Billing
		want bool
	}{
		{config.Billing{}, false},
		{config.Billing{TestClock: true}, true},
		{config.Billing{TestClock: true, StripeSecretKey: "sk_live_abcdefgh123"}, false},
		{config.Billing{TestClock: true, StripeLivemodeAllowed: true}, false},
	} {
		if got := TestClockAllowed(c.cfg); got != c.want {
			t.Errorf("%+v: %v", c.cfg, got)
		}
	}
}
