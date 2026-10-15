package mailbox

// One-time reset tokens (ADR-0101): the new password from the hosting lives in Redis for
// 10 minutes under an unguessable 128-bit token; redemption deletes the key (GETDEL), so a
// link works exactly once. The password never reaches Postgres or the logs.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// ResetTTL is how long a reset link lives (ADR-0101: 10 minutes).
const ResetTTL = 10 * time.Minute

// MaxTokenLen bounds a token from a client before it becomes a Redis key.
const MaxTokenLen = 128

// ResetPayload is what a reset token opens (until redeemed).
type ResetPayload struct {
	UserID   string `json:"u"`
	Email    string `json:"e"`
	Password string `json:"p"`
}

// Store issues and redeems one-time reset tokens in Redis.
type Store struct {
	redis rueidis.Client
	ttl   time.Duration
}

// NewStore creates the store with the standard TTL.
func NewStore(c rueidis.Client) *Store { return &Store{redis: c, ttl: ResetTTL} }

func resetKey(token string) string { return redisx.Key("mail:reset:" + token) }

// newToken is a fresh 128-bit crypto/rand token, base64url.
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Issue stores the payload under a fresh token (SET NX, so a collision with a live token
// is retried with a new one rather than overwriting it).
func (s *Store) Issue(ctx context.Context, p ResetPayload) (string, error) {
	val, err := json.Marshal(p) //nolint:gosec // G117: the password must travel to Redis; it never appears in logs or Postgres
	if err != nil {
		return "", err
	}
	for range 3 {
		tok, err := newToken()
		if err != nil {
			return "", err
		}
		ok, err := s.redis.Do(ctx, s.redis.B().Set().Key(resetKey(tok)).Value(string(val)).Nx().Ex(s.ttl).Build()).AsBool()
		if err != nil {
			return "", err
		}
		if ok {
			return tok, nil
		}
	}
	return "", errors.New("mailbox: reset token collision")
}

// Redeem returns the payload and deletes the key: a token works exactly once. nil, nil =
// no such token (unknown, expired or already redeemed).
func (s *Store) Redeem(ctx context.Context, token string) (*ResetPayload, error) {
	raw, err := s.redis.Do(ctx, s.redis.B().Getdel().Key(resetKey(token)).Build()).ToString()
	if err != nil {
		if rueidis.IsRedisNil(err) {
			return nil, nil
		}
		return nil, err
	}
	var p ResetPayload
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return nil, fmt.Errorf("mailbox: malformed reset payload: %w", err)
	}
	return &p, nil
}
