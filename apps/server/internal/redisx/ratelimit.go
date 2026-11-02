package redisx

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/httpx"
)

// Token bucket in a Redis hash {t: tokens, ts: last refill ms}. Uses the Redis clock, so
// all API instances share one bucket per key. Returns 0 if the request is allowed, else the
// milliseconds until the next token (for Retry-After).
var tokenBucket = rueidis.NewLuaScript(`
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) -- tokens per ms
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local b = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) * rate)
local wait = 0
if tokens >= 1 then tokens = tokens - 1 else wait = math.max(1, math.ceil((1 - tokens) / rate)) end
redis.call('HSET', key, 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(burst / rate) + 1000)
return wait
`)

// RateLimiter is a Redis-backed token bucket limiter: one bucket per key, stored under
// Key(prefix + key).
type RateLimiter struct {
	c      rueidis.Client
	prefix string
	burst  int
	perMs  float64
}

// NewRateLimiter allows `burst` requests at once, refilled at perMinute tokens/minute.
func NewRateLimiter(c rueidis.Client, prefix string, burst int, perMinute float64) *RateLimiter {
	return &RateLimiter{c: c, prefix: prefix, burst: burst, perMs: perMinute / 60000}
}

// Allow takes one token for key: ok=false with the wait until the next token when the
// bucket is empty. Redis errors are returned.
func (l *RateLimiter) Allow(ctx context.Context, key string) (ok bool, retryAfter time.Duration, err error) {
	ms, err := tokenBucket.Exec(ctx, l.c, []string{Key(l.prefix + key)},
		[]string{strconv.Itoa(l.burst), strconv.FormatFloat(l.perMs, 'g', -1, 64)}).AsInt64()
	if err != nil {
		return false, 0, err
	}
	return ms == 0, time.Duration(ms) * time.Millisecond, nil
}

// Take is Allow as an API error: 429 with Retry-After when limited, and 503 when Redis is
// unavailable — limiters fail closed (an outage must not disable brute-force protection).
func (l *RateLimiter) Take(ctx context.Context, key string) error {
	ok, wait, err := l.Allow(ctx, key)
	if err != nil {
		return httpx.Unavailable(err)
	}
	if !ok {
		e := httpx.RateLimited()
		e.RetryAfter = time.Duration(math.Ceil(wait.Seconds())) * time.Second
		return e
	}
	return nil
}

// TakeWith is Take with the bucket's size and refill given per call — limits an admin sets per
// workspace (ADR-0155): burst requests at once, refilled at perHour an hour. As with TakeHourly,
// a smaller burst applies to a fuller bucket at once; callers keep overridden buckets under
// their own keys so they never share one with the default limits.
func (l *RateLimiter) TakeWith(ctx context.Context, key string, burst, perHour int) error {
	h := *l
	h.burst, h.perMs = max(burst, 1), float64(max(perHour, 1))/3_600_000
	return h.Take(ctx, key)
}

// TakeHourly is Take with the bucket's size given per call — a limit an admin sets: perHour
// requests at once, refilled at perHour an hour. A smaller limit applies to a fuller bucket at
// once (the stored tokens are capped by the new size).
func (l *RateLimiter) TakeHourly(ctx context.Context, key string, perHour int) error {
	return l.TakeWith(ctx, key, perHour, perHour)
}
