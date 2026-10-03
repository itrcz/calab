// Package search serves GET /api/search (ADR-0062): one query over messages, task comments,
// tasks, events, files, the caller's notes and meeting transcripts. Each section is a small
// adapter over the existing visibility functions (rooms.VisibleBits, boards.VisibleBoards,
// the calendar's viewer, recording.VisibleSQL) — search adds no permission rule of its own.
// Sections run in parallel, each in its own read-only transaction with a statement timeout: a
// slow section comes back empty with timed_out, the others are not held up.
package search

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/sync/errgroup"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
)

// MaxSections is how many sections run at once in one API process: under half of the default
// pool (20 connections, db.Connect), so that searches never starve other requests.
const MaxSections = 8

// DefaultTimeout is the time budget of one section (ADR-0062 §1).
const DefaultTimeout = 1500 * time.Millisecond

// wordSimilarity is pg_trgm.word_similarity_threshold of searches: a typo in a short word
// («рлиз» for «релиз») still matches.
const wordSimilarity = "0.4"

// Limiter is a per-user budget (redisx.RateLimiter).
type Limiter interface {
	Take(ctx context.Context, key string) error
}

// Service serves the search API.
type Service struct {
	db *db.DB
	// slots bounds the sections running at once in this process: a burst of searches must not
	// take the whole database pool (a section waiting for a slot spends its own time budget).
	slots chan struct{}
	// Limit: per-user budget of searches (nil = unlimited).
	Limit Limiter
	// Timeout of one section (DefaultTimeout).
	Timeout time.Duration
	// Now is the clock (freshness and event occurrences).
	Now func() time.Time
	// BeforeSection runs in a section's transaction before its queries; tests use it to make a
	// section slow. nil in production.
	BeforeSection func(ctx context.Context, tx pgx.Tx, t v1.SearchType) error
}

// New creates the service.
func New(d *db.DB) *Service {
	return &Service{db: d, slots: make(chan struct{}, MaxSections), Timeout: DefaultTimeout, Now: time.Now}
}

// Routes registers GET /api/search; wrap applies auth + the permission resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/search", wrap(httpx.HandlerFunc(s.search)))
}

type sectionFn func(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error

// search: GET /api/search?q=&scope=&types=&type=&limit=&cursor=&sort=.
func (s *Service) search(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	req, err := parseRequest(r, s.Now())
	if err != nil {
		return err
	}
	sc, err := s.buildScope(ctx, req, id.UserID, id.IsBot)
	if err != nil {
		return err
	}
	if s.Limit != nil {
		if err := s.Limit.Take(ctx, id.UserID.String()); err != nil {
			return err
		}
	}
	out, err := s.run(ctx, req, sc)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) sectionFn(t v1.SearchType) sectionFn {
	switch t {
	case v1.SearchType_SEARCH_TYPE_TASKS:
		return s.tasks
	case v1.SearchType_SEARCH_TYPE_EVENTS:
		return s.events
	case v1.SearchType_SEARCH_TYPE_FILES:
		return s.files
	case v1.SearchType_SEARCH_TYPE_TRANSCRIPTS:
		return s.transcripts
	}
	return s.messages // messages, task comments, notes
}

// run computes the requested sections in parallel.
func (s *Service) run(ctx context.Context, req *request, sc *scope) (*v1.SearchResponse, error) {
	out := &v1.SearchResponse{Sections: make([]*v1.SearchSection, len(req.types))}
	g, gctx := errgroup.WithContext(ctx)
	for i, t := range req.types {
		g.Go(func() error {
			sec, err := s.section(gctx, t, req, sc, s.sectionFn(t))
			out.Sections[i] = sec
			return err
		})
	}
	return out, g.Wait()
}

// section runs one section in its own read-only transaction under the time budget; a section
// that runs out of time is returned empty with timed_out.
func (s *Service) section(ctx context.Context, t v1.SearchType, req *request, sc *scope, fn sectionFn) (*v1.SearchSection, error) {
	sec := &v1.SearchSection{Type: t, Items: []*v1.SearchHit{}}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	// The context deadline also bounds the time between statements (a section runs several).
	sctx, cancel := context.WithTimeout(ctx, timeout+250*time.Millisecond)
	defer cancel()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-sctx.Done():
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return &v1.SearchSection{Type: t, Items: []*v1.SearchHit{}, TimedOut: true}, nil
	}
	err := s.db.ReadTx(sctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(sctx, "SELECT set_config('statement_timeout', $1, true), set_config('pg_trgm.word_similarity_threshold', $2, true)",
			strconv.FormatInt(timeout.Milliseconds(), 10), wordSimilarity); err != nil {
			return err
		}
		if s.BeforeSection != nil {
			if err := s.BeforeSection(sctx, tx, t); err != nil {
				return err
			}
		}
		return fn(sctx, tx, req, sc, sec)
	})
	if err == nil {
		return sec, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err() // the request itself ended
	}
	var pe *pgconn.PgError
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &pe) && pe.Code == "57014") {
		return &v1.SearchSection{Type: t, Items: []*v1.SearchHit{}, TimedOut: true}, nil
	}
	return nil, err
}
