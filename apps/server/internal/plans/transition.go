package plans

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Plan transitions (ADR-0086): a workspace moves to a plan only if it fits the plan's limits now —
// the owner's self-serve change (billing quote and commit) and the superadmin's plan edit (unless
// overridden). Nothing is deleted or switched off by a transition; the owner fixes the usage first.
// Automatic transitions (paid days over after a stop, debt suspension, an expired manual plan) are
// never refused: the existing limit checks then stop new additions (ADR-0024).

// Usage is what a transition is checked against: counted resources and plan-gated features in use.
type Usage struct{ r sqlc.GetWorkspacePlanUsageRow }

// ReadUsage reads the usage of ws (one query; inside a transaction it sees the transaction's rows).
func ReadUsage(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) (Usage, error) {
	r, err := q.GetWorkspacePlanUsage(ctx, ws)
	return Usage{r}, err
}

// LockUsage serializes a transition with the counted additions that race it (members and bots
// joining): the same advisory locks as Check, in its order (bots, then members — bots.Create). Call
// it before any billing account lock (lock order of admission: members → account).
func LockUsage(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	if err := q.LockWorkspaceBots(ctx, ws.String()); err != nil {
		return err
	}
	return q.LockWorkspaceMembers(ctx, ws)
}

// Identity features a plan grants (setBusinessGrants), by workspace_identity_grants.feature.
const (
	featureSSO       = "corporate_sso"
	featureDirectory = "directory_sync"
	featureOAuth     = "oauth_provider"
)

func over(kind v1.PlanLimitKind, used int64, limit uint64) *v1.PlanLimitViolation {
	if limit == 0 || used <= 0 || uint64(used) <= limit {
		return nil
	}
	return &v1.PlanLimitViolation{Kind: kind, Current: uint64(used), Limit: limit}
}

func inUse(kind v1.PlanLimitKind, used int64) *v1.PlanLimitViolation {
	if used <= 0 {
		return nil
	}
	return &v1.PlanLimitViolation{Kind: kind, Current: uint64(used)}
}

// Violations lists what the usage exceeds of target. identity: the target plan grants the identity
// features (Business). Media quality caps (voice tier, stream / camera presets, streams and cameras
// per room) are not violations: they are applied as min(room, plan) at join and lose nothing.
// Features that keep working read-only or per person (checklists, musician mode, CalDAV) neither.
func (u Usage) Violations(target Limits, identity bool) []*v1.PlanLimitViolation {
	r := u.r
	storageMB := (max(r.StorageBytes, 0) + 1<<20 - 1) >> 20
	out := []*v1.PlanLimitViolation{
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS, r.Members, uint64(target.Members)),
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS, r.Bots, uint64(target.Bots)),
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB, storageMB, target.StorageMB),
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARDS, r.Boards, uint64(target.Boards)),
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKER_PACKS, r.StickerPacks, uint64(target.StickerPacks)),
		over(v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKERS, r.Stickers, uint64(target.Stickers)),
	}
	if lim := target.RoomMembers; lim > 0 {
		var rooms uint32
		var top int32
		for _, n := range r.RoomUserLimits {
			if n > 0 && uint32(n) > lim {
				rooms++
				top = max(top, n)
			}
		}
		if rooms > 0 {
			out = append(out, &v1.PlanLimitViolation{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS, Current: uint64(top), Limit: uint64(lim), Rooms: rooms})
		}
	}
	if target.BoardFormsDisabled {
		out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS, r.MaxBoardForms))
	} else {
		out = append(out, over(v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS, r.MaxBoardForms, uint64(target.BoardFormsPerBoard)))
	}
	if target.AutomationsDisabled {
		out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS, r.Automations))
	}
	if target.BoardWebhooksDisabled {
		out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS, r.BoardWebhooks))
	}
	if target.TelephonyDisabled {
		out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY, r.Telephony))
	}
	if !identity {
		operator := func(f string) bool { return slices.Contains(r.OperatorFeatures, f) }
		if !operator(featureSSO) {
			out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO, r.Sso))
		}
		if !operator(featureDirectory) {
			out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_DIRECTORY_SYNC, r.Directories))
		}
		if !operator(featureOAuth) {
			out = append(out, inUse(v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS, r.OauthApps))
		}
	}
	return slices.DeleteFunc(out, func(v *v1.PlanLimitViolation) bool { return v == nil })
}

// ViolationsError is the refusal of a transition: 409 CONFLICT, reason PLAN_LIMITS_EXCEEDED, with
// ApiError.plan_violations.
func ViolationsError(target string, v []*v1.PlanLimitViolation) *httpx.Error {
	e := httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT,
		fmt.Sprintf("the workspace uses more than the %s plan allows", target)).
		WithDetails(httpx.ReasonPlanLimitsExceeded, 0, 0)
	e.PlanViolations = v
	return e
}

// TargetLimits are the limits of a self-serve plan by its DB name (free | team | enterprise) and
// whether it grants the identity features (Business only).
func (s *Service) TargetLimits(plan string) (Limits, bool) {
	switch plan {
	case "team":
		return s.PlanLimits(v1.Plan_PLAN_TEAM), false
	case "enterprise":
		return s.PlanLimits(v1.Plan_PLAN_ENTERPRISE), true
	}
	return s.PlanLimits(v1.Plan_PLAN_FREE), false
}

// AdminAssigned reports a plan a superadmin assigned that self-serve must not override (ADR-0086):
// a manual row other than Free that has not expired, or the billing account's custom plan
// («Индивидуальный тариф»: billed daily, but chosen and changed by a superadmin only).
func AdminAssigned(row sqlc.WorkspacePlan, now time.Time) bool {
	return BillingCustom(row) || row.Source == "manual" && row.Plan != "free" && (row.ValidUntil == nil || row.ValidUntil.After(now))
}

// BillingCustom reports the custom plan of a billing account (source = billing, plan = custom).
func BillingCustom(row sqlc.WorkspacePlan) bool {
	return row.Source == "billing" && row.Plan == "custom"
}

// AdminAssignedAt reads the plan row of ws (locked when lock, inside a transaction) and reports
// AdminAssigned. No row: false.
func AdminAssignedAt(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, now time.Time, lock bool) (bool, error) {
	row, ok, err := planRow(ctx, q, ws, lock)
	return ok && AdminAssigned(row, now), err
}

func planRow(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, lock bool) (sqlc.WorkspacePlan, bool, error) {
	var row sqlc.WorkspacePlan
	var err error
	if lock {
		row, err = q.LockWorkspacePlanRow(ctx, ws)
	} else {
		row, err = q.GetWorkspacePlan(ctx, ws)
	}
	if db.IsNotFound(err) {
		return row, false, nil
	}
	return row, err == nil, err
}

// CheckTransition refuses moving ws to target (free | team | enterprise | custom) by the owner: a
// plan a superadmin assigned (billing.ErrPlanAdminAssigned) or usage over the target's limits
// (ViolationsError). The billing custom plan blocks every owner transition, a stop to Free
// included; "custom" itself is a target only while the workspace is on it (paying a debt off and
// resuming the assigned plan). Inside the command's transaction pass lock=true (the plan row is
// locked; LockUsage must have run before the billing account lock); the quote passes false. A nil
// service allows everything.
func (s *Service) CheckTransition(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, target string, now time.Time, lock bool) error {
	if s == nil {
		return nil
	}
	row, ok, err := planRow(ctx, q, ws, lock)
	if err != nil {
		return err
	}
	var lim Limits
	identity := false
	switch {
	case target == "custom":
		if !ok || !BillingCustom(row) {
			return billing.ErrPlanAdminAssigned // custom is only ever the superadmin's assignment
		}
		lim = s.CustomLimits(ctx, row)
	case ok && AdminAssigned(row, now) && (target != "free" || BillingCustom(row)):
		return billing.ErrPlanAdminAssigned
	default:
		lim, identity = s.TargetLimits(target)
	}
	u, err := ReadUsage(ctx, q, ws)
	if err != nil {
		return err
	}
	if v := u.Violations(lim, identity); len(v) > 0 {
		return ViolationsError(target, v)
	}
	return nil
}

// TransitionGuard is the billing core's Guard (core.Hooks.Guard) over the service.
type TransitionGuard struct{ S *Service }

// Lock takes LockUsage before the billing account lock.
func (g TransitionGuard) Lock(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	return LockUsage(ctx, q, ws)
}

// Check is CheckTransition with the plan row locked.
func (g TransitionGuard) Check(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, target string, now time.Time) error {
	return g.S.CheckTransition(ctx, q, ws, target, now, true)
}

// Fits reports whether ws fits target without locks (core.Guard.Fits: the end of a stopped
// account's paid days decides between Free and the restricted mode, never refusing).
func (g TransitionGuard) Fits(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, target string, _ time.Time) (bool, error) {
	u, err := ReadUsage(ctx, q, ws)
	if err != nil {
		return false, err
	}
	lim, identity := g.S.TargetLimits(target)
	return len(u.Violations(lim, identity)) == 0, nil
}

// OfferViolations are the violations of every self-serve plan for the plan screen (GET …/billing).
func (s *Service) OfferViolations(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) (map[v1.Plan][]*v1.PlanLimitViolation, error) {
	if s == nil {
		return nil, nil
	}
	u, err := ReadUsage(ctx, q, ws)
	if err != nil {
		return nil, err
	}
	out := map[v1.Plan][]*v1.PlanLimitViolation{}
	for p, name := range map[v1.Plan]string{v1.Plan_PLAN_FREE: "free", v1.Plan_PLAN_TEAM: "team", v1.Plan_PLAN_ENTERPRISE: "enterprise"} {
		lim, identity := s.TargetLimits(name)
		out[p] = u.Violations(lim, identity)
	}
	return out, nil
}

// FreeViolations is what keeps ws from fitting Free now (the mails of the restricted mode).
func (s *Service) FreeViolations(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) ([]*v1.PlanLimitViolation, error) {
	u, err := ReadUsage(ctx, q, ws)
	if err != nil {
		return nil, err
	}
	lim, identity := s.TargetLimits("free")
	return u.Violations(lim, identity), nil
}
