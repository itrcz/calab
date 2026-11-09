package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// callCancelKind is the FCM-only data message that stops an Android ring ended early.
const callCancelKind = "call-cancel"

const oauthEndpoint = "https://oauth2.googleapis.com/token"
const messagingScope = "https://www.googleapis.com/auth/firebase.messaging"

func providerHTTP() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = true
	transport.MaxIdleConnsPerHost = 8
	return &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}
func deliveryExpiry(p Payload) int64 {
	if p.DeliveryExpiresAt > 0 {
		return min(p.ExpiresAt, p.DeliveryExpiresAt)
	}
	return p.ExpiresAt
}
func routingValid(p Payload) bool {
	if p.Version != 1 || !time.UnixMilli(deliveryExpiry(p)).After(time.Now()) {
		return false
	}
	switch p.Kind {
	case "message", "call", "task", "calendar", "badge", callCancelKind:
	default:
		return false
	}
	for _, raw := range []string{p.Binding, p.EventID, p.ReferenceID} {
		id, err := uuid.Parse(raw)
		if err != nil || id == uuid.Nil {
			return false
		}
	}
	return true
}
func retryDelay(header string) time.Duration {
	if seconds, err := strconv.ParseInt(header, 10, 64); err == nil && seconds > 0 {
		return time.Duration(min(seconds, 86400)) * time.Second
	}
	if at, err := http.ParseTime(header); err == nil {
		return min(max(time.Until(at), 0), 24*time.Hour)
	}
	return 0
}
func retryResult(p Payload, status int, header string) Result {
	delay := retryDelay(header)
	if status == 429 {
		delay = max(delay, time.Minute)
	}
	id, _ := uuid.Parse(p.EventID)
	// Stable positive jitter spreads a provider retry without undercutting pacing.
	delay += time.Duration(id[15]) * time.Millisecond
	return Result{Retry: true, RetryAfter: delay}
}

type apnsSender struct {
	key                           *ecdsa.PrivateKey
	team, keyID, app, environment string
	client                        *http.Client
	mu                            sync.Mutex
	token                         string
	tokenUntil                    time.Time
}

func (s *apnsSender) credential() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && s.tokenUntil.After(time.Now()) {
		return s.token, nil
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": s.team, "iat": time.Now().Unix()})
	token.Header["kid"] = s.keyID
	signed, err := token.SignedString(s.key)
	if err != nil {
		return "", err
	}
	s.token, s.tokenUntil = signed, time.Now().Add(50*time.Minute)
	return signed, nil
}
func (s *apnsSender) Send(ctx context.Context, e Endpoint, p Payload) Result {
	voip := e.Provider == v1.PushProvider_PUSH_PROVIDER_VOIP
	// call-cancel is FCM-only: on APNs it would surface as a generic alert.
	if !routingValid(p) || p.Kind == callCancelKind || e.AppID != s.app || e.Environment != s.environment || voip != (p.Kind == "call") || (!voip && e.Provider != v1.PushProvider_PUSH_PROVIDER_APNS) {
		return Result{}
	}
	credential, err := s.credential()
	if err != nil {
		return Result{}
	}
	aps := map[string]any{}
	topic, pushType := s.app, "alert"
	if voip {
		topic += ".voip"
		pushType = "voip"
	} else if p.Kind == "badge" {
		if p.Badge == nil || *p.Badge < 0 || *p.Badge > 99999 {
			return Result{}
		}
		aps["badge"] = *p.Badge
	} else {
		if p.Badge != nil {
			aps["badge"] = *p.Badge
		}
		aps["alert"] = map[string]string{"title-loc-key": "CALAB_APP_NAME", "loc-key": "CALAB_NEW_NOTIFICATION"}
		if alert, ok := alertText(p); ok {
			aps["alert"] = alert
		}
		aps["category"] = "CALAB_OPEN"
		if p.Kind == "message" && p.PersonID != "" && p.ConversationID != "" {
			aps["mutable-content"] = 1
			aps["thread-id"] = p.ConversationID
		}
		if !p.Silent {
			aps["sound"] = "default"
		}
	}
	body, err := apnsBody(p, aps)
	if err != nil {
		return Result{}
	}
	host := "api.push.apple.com"
	if s.environment == "development" {
		host = "api.sandbox.push.apple.com"
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "https://"+host+"/3/device/"+url.PathEscape(e.Token), bytes.NewReader(body))
	if err != nil {
		return Result{}
	}
	request.Header.Set("Authorization", "bearer "+credential)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("apns-topic", topic)
	request.Header.Set("apns-push-type", pushType)
	request.Header.Set("apns-priority", "10")
	if p.Kind == "badge" {
		request.Header.Set("apns-priority", "5")
		request.Header.Set("apns-collapse-id", "calab-badge")
	}
	request.Header.Set("apns-id", p.EventID)
	request.Header.Set("apns-expiration", strconv.FormatInt(deliveryExpiry(p)/1000, 10))
	response, err := s.client.Do(request)
	if err != nil {
		return retryResult(p, 0, "")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 65536))
		return Result{Accepted: true}
	}
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		return retryResult(p, response.StatusCode, response.Header.Get("Retry-After"))
	}
	var failure struct {
		Reason    string `json:"reason"`
		Timestamp int64  `json:"timestamp"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&failure); err != nil {
		return retryResult(p, 0, "")
	}
	switch {
	case response.StatusCode == 410 && failure.Reason == "Unregistered" && failure.Timestamp > 0:
		at := time.UnixMilli(failure.Timestamp)
		return Result{Invalid: true, InvalidBefore: &at}
	case response.StatusCode == 400 && failure.Reason == "BadDeviceToken":
		return Result{Invalid: true}
	case response.StatusCode == 403 && failure.Reason == "ExpiredProviderToken":
		s.mu.Lock()
		if s.token == credential {
			s.token = ""
			s.tokenUntil = time.Time{}
		}
		s.mu.Unlock()
		return retryResult(p, response.StatusCode, response.Header.Get("Retry-After"))
	case response.StatusCode == 429 || response.StatusCode >= 500:
		return retryResult(p, response.StatusCode, response.Header.Get("Retry-After"))
	}
	return Result{}
}

type fcmSender struct {
	key                 *rsa.PrivateKey
	email, project, app string
	client              *http.Client
	mu                  sync.Mutex
	refreshing          chan struct{}
	access              string
	accessUntil         time.Time
	refreshRetryUntil   time.Time
}

func (s *fcmSender) credential(ctx context.Context) (access string, failure Result) {
	s.mu.Lock()
	if s.refreshRetryUntil.After(time.Now()) {
		delay := time.Until(s.refreshRetryUntil)
		s.mu.Unlock()
		return "", Result{Retry: true, RetryAfter: delay}
	}
	if s.access != "" && s.accessUntil.After(time.Now()) {
		token := s.access
		s.mu.Unlock()
		return token, Result{}
	}
	if s.refreshing != nil {
		pending := s.refreshing
		s.mu.Unlock()
		select {
		case <-pending:
			return s.credential(ctx)
		case <-ctx.Done():
			return "", Result{Retry: true}
		}
	}
	s.refreshing = make(chan struct{})
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if failure.Retry {
			// OAuth is shared by every endpoint in this project. Fan out the
			// failed exchange's pacing, rather than letting each waiter exchange
			// another assertion immediately after the leader settles.
			s.refreshRetryUntil = time.Now().Add(max(failure.RetryAfter, time.Second))
		}
		close(s.refreshing)
		s.refreshing = nil
		s.mu.Unlock()
	}()
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": s.email, "scope": messagingScope, "aud": oauthEndpoint, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
	assertion, err := token.SignedString(s.key)
	if err != nil {
		return "", Result{}
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	request, err := http.NewRequestWithContext(ctx, "POST", oauthEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", Result{}
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.client.Do(request)
	if err != nil {
		return "", Result{Retry: true}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		return "", Result{Retry: response.StatusCode == 429 || response.StatusCode >= 500, RetryAfter: max(retryDelay(response.Header.Get("Retry-After")), time.Minute)}
	}
	var result struct {
		Access  string `json:"access_token"`
		Expires int64  `json:"expires_in"`
		Type    string `json:"token_type"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result); err != nil || result.Access == "" || len(result.Access) > 16384 || strings.ContainsAny(result.Access, "\r\n") || result.Expires < 1 || result.Expires > 3600 || result.Type != "Bearer" {
		return "", Result{}
	}
	s.mu.Lock()
	s.access = result.Access
	s.accessUntil = now.Add(time.Duration(max(result.Expires-60, 0)) * time.Second)
	s.mu.Unlock()
	return result.Access, Result{}
}
func (s *fcmSender) Send(ctx context.Context, e Endpoint, p Payload) Result {
	if p.Kind == "badge" || e.Provider != v1.PushProvider_PUSH_PROVIDER_FCM || e.AppID != s.app || e.Environment != "production" || !routingValid(p) {
		return Result{}
	}
	access, result := s.credential(ctx)
	if access == "" {
		return result
	}
	if !routingValid(p) {
		return Result{}
	}
	data, err := fcmData(p)
	if err != nil {
		return Result{}
	}
	remaining := min(max(time.Until(time.UnixMilli(deliveryExpiry(p))), 0), 10*time.Minute)
	if remaining <= 0 {
		return Result{}
	}
	body, err := json.Marshal(map[string]any{"message": map[string]any{"token": e.Token, "data": json.RawMessage(data), "android": map[string]any{"priority": "HIGH", "ttl": strconv.FormatInt(int64(remaining/time.Second), 10) + "s", "restricted_package_name": s.app}}})
	if err != nil {
		return Result{}
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "https://fcm.googleapis.com/v1/projects/"+url.PathEscape(s.project)+"/messages:send", bytes.NewReader(body))
	if err != nil {
		return Result{}
	}
	request.Header.Set("Authorization", "Bearer "+access)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return retryResult(p, 0, "")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == 200 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 65536))
		return Result{Accepted: true}
	}
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		return retryResult(p, response.StatusCode, response.Header.Get("Retry-After"))
	}
	// A rejected bearer is a credential failure even when a proxy replaced the
	// JSON error body. Only retire the credential used by this request.
	if response.StatusCode == 401 {
		s.mu.Lock()
		if s.access == access {
			s.access = ""
			s.accessUntil = time.Time{}
		}
		s.mu.Unlock()
		return retryResult(p, response.StatusCode, response.Header.Get("Retry-After"))
	}
	var failure struct {
		Error struct {
			Details []struct {
				Type string `json:"@type"`
				Code string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&failure); err != nil {
		return retryResult(p, 0, "")
	}
	if response.StatusCode == 404 {
		for _, detail := range failure.Error.Details {
			if detail.Type == "type.googleapis.com/google.firebase.fcm.v1.FcmError" && detail.Code == "UNREGISTERED" {
				return Result{Invalid: true}
			}
		}
	}
	return Result{}
}

// alertText is the single ADR-0072 alert rule for both providers: a message carries its
// server-reduced title, subtitle and body (the recipient's preview setting is already applied
// in presentation); every other kind stays generic on the device.
func alertText(p Payload) (map[string]string, bool) {
	if p.Kind != "message" || p.Title == "" || p.Body == "" {
		return nil, false
	}
	return map[string]string{"title": previewLine(p.Title, 80), "subtitle": previewLine(p.Subtitle, 80), "body": previewLine(p.Body, 240)}, true
}

// fitPicture encodes p and, when the encoding exceeds limit, encodes again without the
// optional sender picture; still too large is an error, never a truncated alert.
func fitPicture(p Payload, limit int, encode func(Payload) ([]byte, error)) ([]byte, error) {
	body, err := encode(p)
	if err == nil && len(body) > limit && p.AvatarJPEG != "" {
		p.AvatarJPEG = ""
		body, err = encode(p)
	}
	if err == nil && len(body) > limit {
		err = fmt.Errorf("push presentation exceeds provider limit")
	}
	return body, err
}

// fcmLimit is the FCM data payload limit (bytes of the data object).
const fcmLimit = 4096

// fcmData is the FCM `data` object: the routing payload flattened to strings plus the
// shared alert text. Android renders the notification itself (data-only message). The
// limit is measured on the marshalled JSON object, framing and escaping included.
func fcmData(p Payload) (json.RawMessage, error) {
	return fitPicture(p, fcmLimit, func(p Payload) ([]byte, error) {
		payload, err := json.Marshal(p)
		if err != nil {
			return nil, err
		}
		var raw map[string]json.RawMessage
		if err = json.Unmarshal(payload, &raw); err != nil {
			return nil, err
		}
		data := make(map[string]string, len(raw)+3)
		for key, value := range raw {
			var text string
			if err = json.Unmarshal(value, &text); err != nil {
				text = string(value)
			}
			data[key] = text
		}
		if alert, ok := alertText(p); ok {
			for key, value := range alert {
				if value != "" {
					data[key] = value
				}
			}
		}
		return json.Marshal(data)
	})
}

// Optional pictures must never turn an otherwise valid alert into PayloadTooLarge.
func apnsBody(p Payload, aps map[string]any) ([]byte, error) {
	if len(p.AvatarJPEG) > 2048 {
		p.AvatarJPEG = ""
	}
	return fitPicture(p, 4096, func(p Payload) ([]byte, error) {
		return json.Marshal(struct {
			Payload
			APS map[string]any `json:"aps"`
		}{p, aps})
	})
}
