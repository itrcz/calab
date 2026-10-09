package plans

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// CacheTTL bounds how long an instance serves a plan it read: changes made on this instance
// invalidate at once, other instances hear about them over Redis (changedChannel); the TTL
// covers a lost notification.
const CacheTTL = 30 * time.Second

// changedChannel carries the ids of workspaces whose plan changed (all instances).
const changedChannel = "plans:changed"

// Info is the resolved plan of a workspace.
type Info struct {
	Plan       v1.Plan
	Limits     Limits // effective (free when expired)
	ValidUntil *time.Time
	Expired    bool
	// billing: Workspace.billing (BILLING_ENABLED and a live billing account), else nil.
	billing *billingInfo
}

// Proto converts the plan to the wire message (Workspace.plan).
func (i Info) Proto() *v1.WorkspacePlan {
	p := &v1.WorkspacePlan{Plan: i.Plan, Limits: i.Limits.Proto(), Expired: i.Expired}
	if i.ValidUntil != nil {
		p.ValidUntil = timestamppb.New(*i.ValidUntil)
	}
	return p
}

type cached struct {
	info  Info
	until time.Time
}

// Service resolves workspace plans with a short in-memory cache.
type Service struct {
	load  func(ctx context.Context, wsID uuid.UUID) (*sqlc.WorkspacePlan, error) // nil row = none
	redis rueidis.Client                                                         // nil: no cross-instance invalidation
	free  Limits
	team  Limits
	biz   Limits // PLAN_ENTERPRISE, shown to users as «Business»
	now   func() time.Time
	// userWorkspaces lists the workspaces a user belongs to (AllowsCalDAV).
	userWorkspaces func(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error)
	// loadBilling reads the billing status of Workspace.billing (Billing.Enabled only).
	loadBilling func(ctx context.Context, wsID uuid.UUID) (sqlc.GetWorkspaceBillingStatusRow, error)

	mu    sync.Mutex
	cache map[uuid.UUID]cached
	gen   uint64  // bumped by every invalidation: a read that raced one is not cached
	bill  Billing // SetBilling
}

// New creates the service with the free / team / business limits (see Defaults).
func New(d *db.DB, r rueidis.Client, free, team, biz Limits) *Service {
	load := func(ctx context.Context, wsID uuid.UUID) (*sqlc.WorkspacePlan, error) {
		row, err := d.Q.GetWorkspacePlan(ctx, wsID)
		if db.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &row, nil
	}
	userWS := func(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error) {
		return d.Q.ListUserWorkspaceIDs(ctx, user)
	}
	loadBilling := func(ctx context.Context, wsID uuid.UUID) (sqlc.GetWorkspaceBillingStatusRow, error) {
		return d.Q.GetWorkspaceBillingStatus(ctx, wsID)
	}
	return &Service{load: load, userWorkspaces: userWS, loadBilling: loadBilling, redis: r, free: free, team: team, biz: biz, now: time.Now, cache: map[uuid.UUID]cached{}}
}

// Defaults parses PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS / PLAN_BUSINESS_LIMITS over the built-in
// defaults.
func Defaults(freeJSON, teamJSON, bizJSON string) (free, team, biz Limits, err error) {
	if free, err = ParseLimits(freeJSON, DefaultFree); err != nil {
		return Limits{}, Limits{}, Limits{}, err
	}
	if team, err = ParseLimits(teamJSON, DefaultTeam); err != nil {
		return Limits{}, Limits{}, Limits{}, err
	}
	if biz, err = ParseLimits(bizJSON, DefaultBusiness); err != nil {
		return Limits{}, Limits{}, Limits{}, err
	}
	return free, team, biz, nil
}

// SetDefaults replaces the free / team / business limits and drops the cache (tests).
func (s *Service) SetDefaults(free, team, biz Limits) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.free, s.team, s.biz = free, team, biz
	s.cache = map[uuid.UUID]cached{}
	s.gen++
}

// PlanLimits returns the configured limits of a plan kind (FREE for unknown kinds).
func (s *Service) PlanLimits(p v1.Plan) Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch p {
	case v1.Plan_PLAN_TEAM:
		return s.team
	case v1.Plan_PLAN_ENTERPRISE:
		return s.biz
	}
	return s.free
}

// AllowsCalDAV reports whether CalDAV works for the user: CalDAV belongs to a person, not to a
// workspace, so one workspace whose plan includes it is enough (ADR-0024, 30.09). A user
// without workspaces gets the Free answer. A nil service allows everything.
func (s *Service) AllowsCalDAV(ctx context.Context, user uuid.UUID) (bool, error) {
	if s == nil {
		return true, nil
	}
	ids, err := s.userWorkspaces(ctx, user)
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		l, err := s.Effective(ctx, id)
		if err != nil {
			return false, err
		}
		if !l.CalDAVDisabled {
			return true, nil
		}
	}
	return !s.PlanLimits(v1.Plan_PLAN_FREE).CalDAVDisabled, nil
}

// AllowsMusician reports whether musician mode (ADR-0052) is part of the plan of a voice scope:
// a workspace — its own plan; a DM call (no workspace, wid == rid) — like CalDAV, any of the
// user's workspaces allowing it is enough. A nil service allows everything.
func (s *Service) AllowsMusician(ctx context.Context, wsID uuid.UUID, dm bool, user uuid.UUID) (bool, error) {
	if s == nil {
		return true, nil
	}
	if !dm {
		l, err := s.Effective(ctx, wsID)
		return !l.MusicianDisabled, err
	}
	ids, err := s.userWorkspaces(ctx, user)
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		l, err := s.Effective(ctx, id)
		if err != nil {
			return false, err
		}
		if !l.MusicianDisabled {
			return true, nil
		}
	}
	return !s.PlanLimits(v1.Plan_PLAN_FREE).MusicianDisabled, nil
}

// Effective returns the effective limits of a workspace.
func (s *Service) Effective(ctx context.Context, wsID uuid.UUID) (Limits, error) {
	i, err := s.Info(ctx, wsID)
	return i.Limits, err
}

// Info returns the resolved plan of a workspace.
func (s *Service) Info(ctx context.Context, wsID uuid.UUID) (Info, error) {
	now := s.now()
	s.mu.Lock()
	c, ok := s.cache[wsID]
	gen := s.gen
	billingOn := s.bill.Enabled
	s.mu.Unlock()
	if ok && now.Before(c.until) {
		return c.info, nil
	}
	rp, err := s.load(ctx, wsID)
	if err != nil {
		return Info{}, err
	}
	var bill *billingInfo
	if billingOn && s.loadBilling != nil {
		row, err := s.loadBilling(ctx, wsID)
		if err != nil && !db.IsNotFound(err) {
			return Info{}, err
		}
		bill = resolveBilling(row)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info := s.resolveLocked(ctx, rp, now)
	info.billing = bill
	until := now.Add(CacheTTL)
	if info.ValidUntil != nil && !info.Expired && info.ValidUntil.Before(until) {
		until = *info.ValidUntil // re-resolve the moment the plan expires
	}
	if s.gen == gen {
		s.cache[wsID] = cached{info: info, until: until}
	}
	return info, nil
}

// Resolve computes the plan of a stored row (nil = no row) at time now.
func (s *Service) Resolve(ctx context.Context, row *sqlc.WorkspacePlan, now time.Time) Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resolveLocked(ctx, row, now)
}

func (s *Service) resolveLocked(ctx context.Context, row *sqlc.WorkspacePlan, now time.Time) Info {
	if row == nil {
		return Info{Plan: v1.Plan_PLAN_FREE, Limits: s.free}
	}
	info := Info{Plan: PlanFromDB(row.Plan), ValidUntil: row.ValidUntil}
	if row.ValidUntil != nil && !now.Before(*row.ValidUntil) {
		info.Expired, info.Limits = true, s.free
		return info
	}
	switch info.Plan {
	case v1.Plan_PLAN_TEAM:
		info.Limits = s.team
	case v1.Plan_PLAN_ENTERPRISE:
		info.Limits = s.biz
	case v1.Plan_PLAN_CUSTOM:
		l, err := ParseLimits(string(row.Limits), CustomBase)
		if err != nil { // written by us, validated; fail safe to free if it is ever corrupt
			slog.WarnContext(ctx, "invalid custom plan limits, using free", "workspace", row.WorkspaceID, "err", err)
			l = s.free
		}
		info.Limits = l
	default:
		info.Limits = s.free
	}
	return info
}

// Fill sets ws.plan (a workspace of the caller's view). nil-safe: a nil service fills nothing.
func (s *Service) Fill(ctx context.Context, ws *v1.Workspace) error {
	if s == nil || ws == nil {
		return nil
	}
	id, err := uuid.Parse(ws.GetId())
	if err != nil {
		return nil
	}
	info, err := s.Info(ctx, id)
	if err != nil {
		return err
	}
	ws.Plan = info.Proto()
	ws.Billing = info.billing.proto()
	return nil
}

// FillAll is Fill for a list.
func (s *Service) FillAll(ctx context.Context, wss []*v1.Workspace) error {
	for _, w := range wss {
		if err := s.Fill(ctx, w); err != nil {
			return err
		}
	}
	return nil
}

// Invalidate drops the cached plan of wsID here and on every other instance. Billing calls
// it after every change of a billing account's status / plan or of workspace_plans (the
// cache carries Workspace.billing), after commit and before publishing WORKSPACE_UPDATE.
func (s *Service) Invalidate(ctx context.Context, wsID uuid.UUID) {
	s.drop(wsID)
	if s.redis == nil {
		return
	}
	if err := s.redis.Do(ctx, s.redis.B().Publish().Channel(redisx.Channel(changedChannel)).Message(wsID.String()).Build()).Error(); err != nil {
		slog.WarnContext(ctx, "publish plan change", "workspace", wsID, "err", err) // the TTL catches up
	}
}

func (s *Service) drop(wsID uuid.UUID) {
	s.mu.Lock()
	delete(s.cache, wsID)
	s.gen++
	s.mu.Unlock()
}

// Run listens for plan changes of other instances until ctx is done. After every
// (re)subscription the whole cache is dropped: notifications may have been missed.
func (s *Service) Run(ctx context.Context) {
	if s.redis == nil {
		return
	}
	for ctx.Err() == nil {
		s.mu.Lock()
		s.cache = map[uuid.UUID]cached{}
		s.gen++
		s.mu.Unlock()
		err := s.redis.Receive(ctx, s.redis.B().Subscribe().Channel(redisx.Channel(changedChannel)).Build(), func(m rueidis.PubSubMessage) {
			if id, err := uuid.Parse(m.Message); err == nil {
				s.drop(id)
			}
		})
		if ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "plan change subscription lost, retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

var planToDB = map[v1.Plan]string{
	v1.Plan_PLAN_FREE: "free", v1.Plan_PLAN_TEAM: "team", v1.Plan_PLAN_CUSTOM: "custom", v1.Plan_PLAN_ENTERPRISE: "enterprise",
}

// PlanToDB maps the enum to the DB text; ok=false for UNSPECIFIED / unknown.
func PlanToDB(p v1.Plan) (string, bool) {
	s, ok := planToDB[p]
	return s, ok
}

// PlanFromDB maps DB text to the enum (FREE for unknown text).
func PlanFromDB(s string) v1.Plan {
	for k, v := range planToDB {
		if v == s {
			return k
		}
	}
	return v1.Plan_PLAN_FREE
}
