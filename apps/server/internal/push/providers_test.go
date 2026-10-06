package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type providerTransport func(*http.Request) (*http.Response, error)

func (f providerTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func providerResponse(code int, body string, headers http.Header) *http.Response {
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: headers}
}
func providerPayload() Payload {
	return Payload{Version: 1, Binding: uuid.NewString(), EventID: uuid.NewString(), Kind: "call", ReferenceID: uuid.NewString(), RoomID: uuid.NewString(), ExpiresAt: time.Now().Add(40 * time.Second).UnixMilli()}
}
func TestAPNSRequestBoundedMinimalVoIPAndTimestamp(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := providerPayload()
	invalidAt := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	sender := &apnsSender{key: key, team: "TEAM", keyID: "KEY", app: "ru.calab.test", environment: "production"}
	sender.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.push.apple.com" || r.URL.Path != "/3/device/aabb" || r.Header.Get("apns-topic") != "ru.calab.test.voip" || r.Header.Get("apns-push-type") != "voip" || r.Header.Get("apns-id") != payload.EventID || r.Header.Get("apns-expiration") != strconv.FormatInt(payload.ExpiresAt/1000, 10) {
			t.Fatal("APNs transport binding/expiry incorrect")
		}
		token, err := jwt.Parse(strings.TrimPrefix(r.Header.Get("Authorization"), "bearer "), func(_ *jwt.Token) (any, error) { return &key.PublicKey, nil }, jwt.WithValidMethods([]string{"ES256"}))
		if err != nil || !token.Valid {
			t.Fatal("APNs credential invalid")
		}
		var body struct {
			Payload
			APS map[string]any `json:"aps"`
		}
		if err = json.NewDecoder(r.Body).Decode(&body); err != nil || body.Binding != payload.Binding || body.Kind != "call" {
			t.Fatal("minimal APNs routing missing")
		}
		if len(body.APS) != 0 {
			t.Fatal("VoIP payload contained ordinary alert/sound")
		}
		return providerResponse(410, `{"reason":"Unregistered","timestamp":`+strconv.FormatInt(invalidAt.UnixMilli(), 10)+`}`, http.Header{}), nil
	})}
	result := sender.Send(context.Background(), Endpoint{Token: "aabb", AppID: sender.app, Environment: sender.environment, Provider: v1.PushProvider_PUSH_PROVIDER_VOIP}, payload)
	if !result.Invalid || result.InvalidBefore == nil || !result.InvalidBefore.Equal(invalidAt) {
		t.Fatal("APNs invalid timestamp discarded")
	}
}
func TestFCMRequestDataTTLAndTypedInvalidation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	payload := providerPayload()
	calls := 0
	sender := &fcmSender{key: key, email: "test@calab.iam.gserviceaccount.com", project: "calab", app: "ru.calab.test"}
	sender.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host == "oauth2.googleapis.com" {
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			token, err := jwt.Parse(r.Form.Get("assertion"), func(_ *jwt.Token) (any, error) { return &key.PublicKey, nil }, jwt.WithValidMethods([]string{"RS256"}))
			if err != nil || !token.Valid {
				t.Fatal("FCM OAuth assertion invalid")
			}
			claims := token.Claims.(jwt.MapClaims)
			if claims["scope"] != "https://www.googleapis.com/auth/firebase.messaging" || claims["aud"] != "https://oauth2.googleapis.com/token" {
				t.Fatal("FCM credential audience/scope mismatch")
			}
			return providerResponse(200, `{"access_token":"fake-local-access","expires_in":3600,"token_type":"Bearer"}`, http.Header{}), nil
		}
		if r.URL.Host != "fcm.googleapis.com" || r.URL.Path != "/v1/projects/calab/messages:send" || r.Header.Get("Authorization") != "Bearer fake-local-access" {
			t.Fatal("FCM fixed destination/auth mismatch")
		}
		var request struct {
			Message struct {
				Token   string
				Data    map[string]string
				Android struct {
					TTL               string
					Priority          string
					RestrictedPackage string `json:"restricted_package_name"`
				}
				Notification any
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		ttl, err := time.ParseDuration(request.Message.Android.TTL)
		if err != nil || ttl <= 0 || ttl > 40*time.Second || request.Message.Android.Priority != "HIGH" || request.Message.Android.RestrictedPackage != sender.app || request.Message.Data["binding"] != payload.Binding || request.Message.Notification != nil {
			t.Fatal("FCM minimal data/short lifetime/package contract failed")
		}
		if calls == 2 {
			return providerResponse(400, `{"error":{"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest"}]}}`, http.Header{}), nil
		}
		return providerResponse(404, `{"error":{"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`, http.Header{}), nil
	})}
	endpoint := Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, Token: "local-token", AppID: sender.app, Environment: "production"}
	if sender.Send(context.Background(), endpoint, payload).Invalid {
		t.Fatal("FCM invalid payload error deleted endpoint")
	}
	if !sender.Send(context.Background(), endpoint, payload).Invalid || calls != 3 {
		t.Fatal("typed FCM unregistration or OAuth cache failed")
	}
}
func TestProviderQuotaRetryAfterAndExpiry(t *testing.T) {
	sender := &fcmSender{project: "calab", app: "ru.calab.test", access: "local", accessUntil: time.Now().Add(time.Hour)}
	requests := 0
	sender.client = &http.Client{Transport: providerTransport(func(_ *http.Request) (*http.Response, error) {
		requests++
		return providerResponse(429, `{"error":{"status":"RESOURCE_EXHAUSTED"}}`, http.Header{"Retry-After": []string{"90"}}), nil
	})}
	endpoint := Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, Token: "local-token", AppID: sender.app, Environment: "production"}
	payload := providerPayload()
	result := sender.Send(context.Background(), endpoint, payload)
	if !result.Retry || result.RetryAfter < 90*time.Second || result.Invalid {
		t.Fatal("quota pacing failed")
	}
	payload.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	sender.Send(context.Background(), endpoint, payload)
	if requests != 1 {
		t.Fatal("expired call reached provider")
	}
}

func TestProviderPacingDoesNotDependOnJSONErrorBody(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []int{429, 503} {
		for _, body := range []string{"", "<html>proxy unavailable</html>", `{"error":`} {
			t.Run(strconv.Itoa(code)+"-"+strconv.Itoa(len(body)), func(t *testing.T) {
				client := &http.Client{Transport: providerTransport(func(_ *http.Request) (*http.Response, error) {
					return providerResponse(code, body, http.Header{"Retry-After": []string{"90"}}), nil
				})}
				apns := &apnsSender{key: key, team: "TEAM", keyID: "KEY", app: "ru.calab.test", environment: "production", client: client}
				fcm := &fcmSender{project: "calab", app: "ru.calab.test", access: "local", accessUntil: time.Now().Add(time.Hour), client: client}
				for _, sender := range []struct {
					sender   Sender
					provider v1.PushProvider
				}{{apns, v1.PushProvider_PUSH_PROVIDER_VOIP}, {fcm, v1.PushProvider_PUSH_PROVIDER_FCM}} {
					result := sender.sender.Send(context.Background(), Endpoint{Provider: sender.provider, Token: "aabb", AppID: "ru.calab.test", Environment: "production"}, providerPayload())
					if !result.Retry || result.RetryAfter < 90*time.Second || result.Invalid {
						t.Fatal("status/header retry pacing lost with malformed body")
					}
				}
			})
		}
	}
}
func TestProviderConstructionIsInertAndRejectsCredentialOrigins(t *testing.T) {
	providers, err := NewProviders(&config.Config{})
	if err != nil || len(providers) != 0 {
		t.Fatal("unconfigured transports became active")
	}
	_, err = NewProviders(&config.Config{PushFCMAppID: "ru.calab.test"})
	if err == nil {
		t.Fatal("incomplete provider accepted")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "service-account.json")
	data := `{"type":"service_account","project_id":"calab-test","client_email":"test@calab-test.iam.gserviceaccount.com","token_uri":"https://untrusted.invalid/token"}`
	if err = os.WriteFile(file, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = NewProviders(&config.Config{PushFCMServiceAccountFile: file, PushFCMProjectID: "calab-test", PushFCMAppID: "ru.calab.test"})
	if err == nil || strings.Contains(err.Error(), file) || strings.Contains(err.Error(), "untrusted.invalid") {
		t.Fatal("credential origin accepted or credential source exposed")
	}
}

func TestAPNSOrdinaryLocalizationSilenceAndEndpointBinding(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := providerPayload()
	payload.Kind, payload.Silent = "message", true
	requests := 0
	sender := &apnsSender{key: key, team: "TEAM", keyID: "KEY", app: "ru.calab.test", environment: "development"}
	sender.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.Host != "api.sandbox.push.apple.com" || r.Header.Get("apns-topic") != sender.app || r.Header.Get("apns-push-type") != "alert" {
			t.Fatal("ordinary APNs destination mismatch")
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		var aps map[string]any
		if err := json.Unmarshal(body["aps"], &aps); err != nil {
			t.Fatal(err)
		}
		alert, ok := aps["alert"].(map[string]any)
		if !ok || alert["loc-key"] != "CALAB_NEW_NOTIFICATION" || alert["title-loc-key"] != "CALAB_APP_NAME" || aps["category"] != "CALAB_OPEN" || aps["sound"] != nil {
			t.Fatal("localized silent notification contract failed")
		}
		for _, forbidden := range []string{"body", "title", "url", "origin", "accessToken"} {
			if body[forbidden] != nil {
				t.Fatal("sensitive/selected-origin payload field")
			}
		}
		return providerResponse(200, "", http.Header{}), nil
	})}
	endpoint := Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_APNS, Token: "aabb", AppID: sender.app, Environment: sender.environment}
	sender.Send(context.Background(), endpoint, payload)
	endpoint.Environment = "production"
	sender.Send(context.Background(), endpoint, payload)
	endpoint.Environment, endpoint.AppID = sender.environment, "other.application"
	sender.Send(context.Background(), endpoint, payload)
	if requests != 1 {
		t.Fatal("foreign environment/application dispatched")
	}
}

func TestFCMSingleFlightRefreshCanceledWaiterAndRejectedCredential(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	sender := &fcmSender{key: key, email: "test@calab.iam.gserviceaccount.com", project: "calab", app: "ru.calab.test"}
	sender.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "oauth2.googleapis.com" {
			if requests.Add(1) == 1 {
				close(entered)
				<-release
			}
			return providerResponse(200, `{"access_token":"local-access","expires_in":3600,"token_type":"Bearer"}`, http.Header{}), nil
		}
		return providerResponse(401, "<html>unauthorized</html>", http.Header{}), nil
	})}
	type credentialResult struct {
		access string
		result Result
	}
	leader := make(chan credentialResult, 1)
	go func() { a, r := sender.credential(context.Background()); leader <- credentialResult{a, r} }()
	<-entered
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if access, r := sender.credential(canceled); access != "" || !r.Retry {
		t.Fatal("canceled refresh waiter blocked or obtained authority")
	}
	second := make(chan credentialResult, 1)
	go func() { a, r := sender.credential(context.Background()); second <- credentialResult{a, r} }()
	close(release)
	for _, channel := range []chan credentialResult{leader, second} {
		select {
		case r := <-channel:
			if r.access != "local-access" || r.result.Retry {
				t.Fatal("refresh did not settle")
			}
		case <-time.After(time.Second):
			t.Fatal("refresh waiter stuck")
		}
	}
	if requests.Load() != 1 {
		t.Fatal("parallel OAuth refresh was not single-flight")
	}
	endpoint := Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, AppID: sender.app, Environment: "production", Token: "local"}
	if r := sender.Send(context.Background(), endpoint, providerPayload()); !r.Retry || r.Invalid {
		t.Fatal("non-JSON 401 misclassified")
	}
	if sender.access != "" {
		t.Fatal("rejected cached OAuth credential survived")
	}
	// A late failure for the previous credential cannot erase its replacement.
	sender.access, sender.accessUntil = "old", time.Now().Add(time.Hour)
	sender.client = &http.Client{Transport: providerTransport(func(_ *http.Request) (*http.Response, error) {
		sender.mu.Lock()
		sender.access = "replacement"
		sender.mu.Unlock()
		return providerResponse(401, "", http.Header{}), nil
	})}
	sender.Send(context.Background(), endpoint, providerPayload())
	if sender.access != "replacement" {
		t.Fatal("late credential error erased newer credential")
	}
}

func TestProviderLocalCredentialConstructionAndRedirectPolicy(t *testing.T) {
	dir := t.TempDir()
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	ecFile := filepath.Join(dir, "apns.p8")
	if err := os.WriteFile(ecFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER}), 0600); err != nil {
		t.Fatal(err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)})
	account, err := json.Marshal(map[string]string{"type": "service_account", "project_id": "calab-test", "client_email": "test@calab-test.iam.gserviceaccount.com", "private_key": string(rsaPEM), "token_uri": oauthEndpoint})
	if err != nil {
		t.Fatal(err)
	}
	fcmFile := filepath.Join(dir, "account.json")
	if err := os.WriteFile(fcmFile, account, 0600); err != nil {
		t.Fatal(err)
	}
	providers, err := NewProviders(&config.Config{PushAPNSKeyFile: ecFile, PushAPNSKeyID: "ABCDEFGHIJ", PushAPNSTeamID: "KLMNOPQRST", PushAPNSAppID: "ru.calab.test", PushFCMServiceAccountFile: fcmFile, PushFCMProjectID: "calab-test", PushFCMAppID: "ru.calab.test"})
	if err != nil || len(providers) != 2 || providers[v1.PushProvider_PUSH_PROVIDER_VOIP].Sender != nil {
		t.Fatal("valid local credentials did not construct scoped shared transport")
	}
	optIn, err := NewProviders(&config.Config{PushAPNSKeyFile: ecFile, PushAPNSKeyID: "ABCDEFGHIJ", PushAPNSTeamID: "KLMNOPQRST", PushAPNSAppID: "ru.calab.test", PushAPNSEnvironment: "development", PushVoIPEnabled: true})
	if err != nil || len(optIn) != 2 || optIn[v1.PushProvider_PUSH_PROVIDER_VOIP].Sender == nil || optIn[v1.PushProvider_PUSH_PROVIDER_VOIP].Environment != "development" {
		t.Fatal("explicit VoIP opt-in did not construct the matching APNs transport")
	}
	var followed atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { followed.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	request, err := http.NewRequestWithContext(context.Background(), "POST", redirect.URL, strings.NewReader("credential-shaped-local-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	response, err := providerHTTP().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusTemporaryRedirect || followed.Load() != 0 {
		t.Fatal("provider redirect forwarded payload/credentials")
	}
}

func TestProviderRetryMinimumAndHTTPDate(t *testing.T) {
	payload := providerPayload()
	if r := retryResult(payload, 429, ""); r.RetryAfter < time.Minute {
		t.Fatal("quota minimum missing")
	}
	date := time.Now().Add(2 * time.Minute).UTC().Format(http.TimeFormat)
	if r := retryResult(payload, 503, date); r.RetryAfter < 119*time.Second || r.RetryAfter > 121*time.Second {
		t.Fatal("HTTP-date retry pacing lost")
	}
	if retryDelay("999999999") != 24*time.Hour {
		t.Fatal("retry delay unbounded")
	}
}

func TestFCMRefreshFailurePacesEveryConcurrentCaller(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var exchanges atomic.Int32
	sender := &fcmSender{key: key, email: "test@calab.iam.gserviceaccount.com", project: "calab", app: "ru.calab.test"}
	sender.client = &http.Client{Transport: providerTransport(func(_ *http.Request) (*http.Response, error) {
		if exchanges.Add(1) == 1 {
			close(entered)
			<-release
		}
		return providerResponse(429, "", http.Header{"Retry-After": []string{"90"}}), nil
	})}
	results := make(chan Result, 5)
	endpoint := Endpoint{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, AppID: sender.app, Environment: "production", Token: "local"}
	go func() { results <- sender.Send(context.Background(), endpoint, providerPayload()) }()
	<-entered
	for n := 0; n < 4; n++ {
		go func() { results <- sender.Send(context.Background(), endpoint, providerPayload()) }()
	}
	close(release)
	for n := 0; n < 5; n++ {
		select {
		case r := <-results:
			if !r.Retry || r.Invalid || r.RetryAfter < 89*time.Second {
				t.Fatal("shared OAuth pacing lost")
			}
		case <-time.After(time.Second):
			t.Fatal("OAuth failure waiter did not settle")
		}
	}
	if r := sender.Send(context.Background(), endpoint, providerPayload()); !r.Retry || r.RetryAfter < 89*time.Second {
		t.Fatal("fresh delivery bypassed OAuth cooldown")
	}
	if exchanges.Load() != 1 {
		t.Fatal("concurrent callers retried shared quota-limited OAuth")
	}
}

func TestAPNSMessagePreviewAndCallerPresentation(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"message", "call", "task"} {
		t.Run(kind, func(t *testing.T) {
			p := providerPayload()
			p.Kind = kind
			p.Title = "Илья"
			recipient := sqlc.User{ID: uuid.New(), DisplayName: "Данис"}
			p.Body = messagePreview("Привет, @"+recipient.ID.String(), recipient)
			p.CallerName = ""
			provider := v1.PushProvider_PUSH_PROVIDER_APNS
			if kind == "call" {
				provider = v1.PushProvider_PUSH_PROVIDER_VOIP
				p.CallerName = "Илья"
			}
			sender := &apnsSender{key: key, team: "TEAM", keyID: "KEY", app: "ru.calab.test", environment: "development"}
			called := false
			sender.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				called = true
				var wire map[string]any
				if err := json.NewDecoder(r.Body).Decode(&wire); err != nil {
					t.Fatal(err)
				}
				if _, ok := wire["ReferenceID"]; ok {
					t.Fatal("internal reference exposed")
				}
				aps := wire["aps"].(map[string]any)
				if kind == "call" {
					if wire["callerName"] != "Илья" || aps["alert"] != nil {
						t.Fatal("caller presentation missing or alert duplicated")
					}
				}
				if kind == "message" {
					a := aps["alert"].(map[string]any)
					if a["title"] != "Илья" || a["body"] != "Привет, @Данис" || a["loc-key"] != nil {
						t.Fatal("generic text replaced preview")
					}
				}
				if kind == "task" && aps["alert"].(map[string]any)["loc-key"] != "CALAB_NEW_NOTIFICATION" {
					t.Fatal("unrelated notification changed")
				}
				return providerResponse(200, "", http.Header{}), nil
			})}
			sender.Send(context.Background(), Endpoint{Token: "aabb", Provider: provider, AppID: sender.app, Environment: sender.environment}, p)
			if !called {
				t.Fatal("preview was not sent")
			}
		})
	}
}
