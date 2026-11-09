package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestAPNSAbsoluteBadgeAndSilentClear(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"message", "badge", "call"} {
		for _, count := range []int{0, 7} {
			p := providerPayload()
			p.Kind = kind
			p.Badge = &count
			seen := false
			s := &apnsSender{key: key, team: "TEAM", keyID: "KEY", app: "ru.calab.test", environment: "production"}
			s.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				seen = true
				var body struct {
					APS map[string]any `json:"aps"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if kind == "call" {
					if _, ok := body.APS["badge"]; ok {
						t.Fatal("VoIP must not change badge")
					}
				} else if body.APS["badge"] != float64(count) {
					t.Fatalf("absolute badge missing: %#v", body.APS)
				}
				if kind == "badge" {
					if len(body.APS) != 1 {
						t.Fatalf("badge-only update made an alert: %#v", body.APS)
					}
					if r.Header.Get("apns-priority") != "5" {
						t.Fatal("badge-only updates must use priority 5")
					}
				}
				return providerResponse(200, "", http.Header{}), nil
			})}
			provider := v1.PushProvider_PUSH_PROVIDER_APNS
			if kind == "call" {
				provider = v1.PushProvider_PUSH_PROVIDER_VOIP
			}
			result := s.Send(context.Background(), Endpoint{Token: "aabb", AppID: s.app, Environment: s.environment, Provider: provider}, p)
			if !seen || !result.Accepted {
				t.Fatalf("not sent: %s %d", kind, count)
			}
		}
	}
}
