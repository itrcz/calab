package plans

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Admin serves /api/admin/* (ADR-0024): superadmins only, everyone else gets 404 so the
// API does not reveal itself. Every request is logged.
type Admin struct {
	db      *db.DB
	plans   *Service
	events  events.Publisher
	limiter *redisx.RateLimiter // per superadmin (60/min)
	// StorageQuota returns a user's personal quota and usage (ADR-0039 §5; set by the app:
	// the notes package depends on this one).
	StorageQuota func(ctx context.Context, q *sqlc.Queries, userID uuid.UUID) (*v1.UserStorageQuota, error)
}

// NewAdmin creates the admin handlers.
func NewAdmin(d *db.DB, p *Service, ev events.Publisher, limiter *redisx.RateLimiter) *Admin {
	return &Admin{db: d, plans: p, events: ev, limiter: limiter}
}

// Routes registers the admin routes; wrap must apply auth.
func (a *Admin) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	handle := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(a.guard(f))) }
	handle("GET /api/admin/workspaces", a.search)
	handle("GET /api/admin/workspaces/{id}", a.get)
	handle("PUT /api/admin/workspaces/{id}/plan", a.setPlan)
	handle("GET /api/admin/workspaces/{id}/plan/log", a.log)
	handle("PUT /api/admin/workspaces/{id}/suspension", a.setSuspension)
	handle("GET /api/admin/users/{id}/storage-quota", a.storageQuota)
	handle("PUT /api/admin/users/{id}/storage-quota", a.setStorageQuota)
}

// storageQuota: GET /api/admin/users/{id}/storage-quota — a user's personal quota (ADR-0039).
func (a *Admin) storageQuota(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "user")
	if err != nil {
		return err
	}
	if _, err := a.db.Q.GetUser(r.Context(), id); err != nil {
		if db.IsNotFound(err) {
			return httpx.NotFound("user")
		}
		return err
	}
	out, err := a.StorageQuota(r.Context(), a.db.Q, id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setStorageQuota: PUT /api/admin/users/{id}/storage-quota {quota_bytes?} — unset = the default.
func (a *Admin) setStorageQuota(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "user")
	if err != nil {
		return err
	}
	var req v1.SetUserStorageQuotaRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var quota *int64
	if req.QuotaBytes != nil {
		if req.GetQuotaBytes() > 1<<50 {
			return httpx.Validation("quotaBytes", "quota must be at most 1 PiB")
		}
		v := int64(req.GetQuotaBytes()) //nolint:gosec // checked above
		quota = &v
	}
	if _, err := db.GuardValue(r.Context(), a.db, func(guarded *sqlc.Queries) (*int64, error) {
		return guarded.SetUserStorageQuota(r.Context(), sqlc.SetUserStorageQuotaParams{ID: id, Quota: quota})
	}); err != nil {
		if db.IsNotFound(err) {
			return httpx.NotFound("user")
		}
		return err
	}
	slog.InfoContext(r.Context(), "admin: personal storage quota", "user", id, "quota", quota)
	return a.storageQuota(w, r)
}

const maxNote = 500

// guard lets superadmins through (email re-read on every request) and rate-limits them.
func (a *Admin) guard(next httpx.HandlerFunc) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		id := auth.MustFromContext(r.Context())
		uid := id.UserID
		// The app has checked the UUID or trusted local legacy source and recent local proof.
		if id.IsBot || id.Principal.Authority != identitypolicy.LocalAccount {
			return httpx.NotFound("route")
		}
		if a.limiter != nil {
			if err := a.limiter.Take(r.Context(), uid.String()); err != nil {
				return err
			}
		}
		slog.InfoContext(r.Context(), "admin request", "user", uid, "method", r.Method, "path", r.URL.Path,
			"query", r.URL.RawQuery, "request_id", httpx.RequestID(r.Context()))
		return next(w, r)
	}
}

// likePattern escapes LIKE wildcards so the query matches literally.
func likePattern(q string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
}

func (a *Admin) search(w http.ResponseWriter, r *http.Request) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 100 {
		return httpx.Validation("q", "query must be at most 100 characters")
	}
	ids, err := a.db.Q.AdminSearchWorkspaces(r.Context(), likePattern(q))
	if err != nil {
		return err
	}
	out, err := a.details(r.Context(), ids)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminSearchWorkspacesResponse{Workspaces: out})
	return nil
}

// details loads workspaces with owner, plan and usage, in the order of ids.
func (a *Admin) details(ctx context.Context, ids []uuid.UUID) ([]*v1.AdminWorkspace, error) {
	if len(ids) == 0 {
		return []*v1.AdminWorkspace{}, nil
	}
	rows, err := a.db.Q.AdminWorkspaceDetails(ctx, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]sqlc.AdminWorkspaceDetailsRow, len(rows))
	for _, row := range rows {
		byID[row.Workspace.ID] = row
	}
	out := make([]*v1.AdminWorkspace, 0, len(ids))
	for _, id := range ids {
		row, ok := byID[id]
		if !ok {
			continue // deleted meanwhile
		}
		aw, err := a.adminWorkspace(ctx, row)
		if err != nil {
			return nil, err
		}
		out = append(out, aw)
	}
	return out, nil
}

func (a *Admin) adminWorkspace(ctx context.Context, row sqlc.AdminWorkspaceDetailsRow) (*v1.AdminWorkspace, error) {
	ws := pbconv.Workspace(row.Workspace)
	if err := a.plans.Fill(ctx, ws); err != nil {
		return nil, err
	}
	used := uint64(max(row.Workspace.StorageUsedBytes, 0))
	aw := &v1.AdminWorkspace{
		Workspace: ws,
		Owner:     pbconv.User(row.User),
		Usage: &v1.WorkspaceUsage{
			Members: uint32(max(row.Members, 0)), Rooms: uint32(max(row.Rooms, 0)), //nolint:gosec // counts
			Bots: uint32(max(row.Bots, 0)), StickerPacks: uint32(max(row.StickerPacks, 0)), //nolint:gosec // counts
			StorageBytes: used, StorageMb: (used + 1<<20 - 1) >> 20,
		},
	}
	if row.User.Email != nil {
		aw.OwnerEmail = *row.User.Email
	}
	if row.LastActivity.After(time.Unix(0, 0)) {
		aw.Usage.LastActivity = timestamppb.New(row.LastActivity)
	}
	if row.PlanNote != nil {
		aw.PlanNote = *row.PlanNote
	}
	if row.PlanUpdatedBy != nil {
		aw.PlanUpdatedBy = row.PlanUpdatedBy.String()
	}
	if row.PlanUpdatedAt != nil {
		aw.PlanUpdatedAt = timestamppb.New(*row.PlanUpdatedAt)
	}
	if row.Workspace.SuspendedBy != nil {
		aw.SuspendedBy = row.Workspace.SuspendedBy.String()
	}
	if row.SuspendedByEmail != nil {
		aw.SuspendedByEmail = *row.SuspendedByEmail
	}
	return aw, nil
}

func (a *Admin) one(ctx context.Context, id uuid.UUID) (*v1.AdminWorkspace, error) {
	out, err := a.details(ctx, []uuid.UUID{id})
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, httpx.NotFound("workspace")
	}
	return out[0], nil
}

func (a *Admin) get(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	aw, err := a.one(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminGetWorkspaceResponse{Workspace: aw})
	return nil
}

// validatePlan checks an AdminSetPlanRequest and returns the DB plan text, the limits to
// store (custom only) and the limits to log.
func (a *Admin) validatePlan(req *v1.AdminSetPlanRequest, now time.Time) (plan string, stored []byte, logged []byte, err error) {
	plan, ok := PlanToDB(req.GetPlan())
	if !ok {
		return "", nil, nil, httpx.Validation("plan", "plan must be PLAN_FREE, PLAN_TEAM, PLAN_ENTERPRISE or PLAN_CUSTOM")
	}
	var l Limits
	if req.GetPlan() == v1.Plan_PLAN_CUSTOM {
		if req.Limits == nil {
			return "", nil, nil, httpx.Validation("limits", "limits are required for PLAN_CUSTOM")
		}
		l = FromProto(req.GetLimits())
		if err := l.Validate(); err != nil {
			return "", nil, nil, httpx.Validation("limits", err.Error())
		}
	} else {
		if req.Limits != nil {
			return "", nil, nil, httpx.Validation("limits", "limits are only set for PLAN_CUSTOM")
		}
		l = a.plans.PlanLimits(req.GetPlan())
	}
	if req.ValidUntil != nil {
		if err := req.GetValidUntil().CheckValid(); err != nil || !req.GetValidUntil().AsTime().After(now) {
			return "", nil, nil, httpx.Validation("validUntil", "valid_until must be in the future")
		}
	}
	if utf8.RuneCountInString(req.GetNote()) > maxNote {
		return "", nil, nil, httpx.Validation("note", "note must be at most 500 characters")
	}
	if logged, err = json.Marshal(l); err != nil {
		return "", nil, nil, err
	}
	if req.GetPlan() == v1.Plan_PLAN_CUSTOM {
		stored = logged
	}
	return plan, stored, logged, nil
}

func (a *Admin) setPlan(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.AdminSetPlanRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	plan, stored, logged, err := a.validatePlan(&req, time.Now())
	if err != nil {
		return err
	}
	var until *time.Time
	if req.ValidUntil != nil {
		t := req.GetValidUntil().AsTime()
		until = &t
	}
	note := strings.TrimSpace(req.GetNote())
	actor := auth.MustFromContext(r.Context()).UserID
	var ws sqlc.Workspace
	err = a.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if ws, err = q.LockOAuthWorkspace(r.Context(), id); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("workspace")
			}
			return err
		}
		if _, err := q.UpsertWorkspacePlan(r.Context(), sqlc.UpsertWorkspacePlanParams{
			WorkspaceID: id, Plan: plan, Limits: stored, ValidUntil: until, Note: note, UpdatedBy: &actor,
		}); db.IsNotFound(err) {
			// The plan of a billing workspace follows its paid days (ADR-0080 §3): the owner
			// changes it through billing, never a direct edit.
			return billing.ErrPlanManagedByBilling
		} else if err != nil {
			return err
		}
		if _, err := setBusinessGrants(r.Context(), q, id, plan == "enterprise", until, &actor, true); err != nil {
			return err
		}
		if err := auth.InvalidateIdentity(r.Context(), q, id, nil, &actor, "plan_changed"); err != nil {
			return err
		}
		return q.InsertPlanLog(r.Context(), sqlc.InsertPlanLogParams{
			WorkspaceID: id, ActorID: &actor, Plan: plan, Limits: logged, ValidUntil: until, Note: note,
		})
	})
	if err != nil {
		return err
	}
	a.plans.Invalidate(r.Context(), id)
	slog.InfoContext(r.Context(), "workspace plan changed", "workspace", id, "by", actor, "plan", plan,
		"limits", string(logged), "valid_until", until, "note", note)
	pw := pbconv.Workspace(ws)
	if err := a.plans.Fill(r.Context(), pw); err != nil {
		return err
	}
	a.events.Workspace(r.Context(), id, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pw}}})
	aw, err := a.one(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminSetPlanResponse{Workspace: aw})
	return nil
}

func (a *Admin) log(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err := a.db.Q.GetWorkspace(r.Context(), id); err != nil {
		if db.IsNotFound(err) {
			return httpx.NotFound("workspace")
		}
		return err
	}
	rows, err := a.db.Q.ListPlanLog(r.Context(), id)
	if err != nil {
		return err
	}
	out := make([]*v1.PlanLogEntry, 0, len(rows))
	for _, row := range rows {
		l, err := ParseLimits(string(row.Limits), CustomBase)
		if err != nil {
			slog.WarnContext(r.Context(), "invalid plan log limits", "id", row.ID, "err", err)
		}
		e := &v1.PlanLogEntry{
			Id: row.ID.String(), WorkspaceId: row.WorkspaceID.String(), Plan: PlanFromDB(row.Plan),
			Limits: l.Proto(), Note: row.Note, CreatedAt: timestamppb.New(row.CreatedAt),
		}
		if row.ActorID != nil {
			e.ActorId = row.ActorID.String()
		}
		if row.ActorEmail != nil {
			e.ActorEmail = *row.ActorEmail
		}
		if row.ValidUntil != nil {
			e.ValidUntil = timestamppb.New(*row.ValidUntil)
		}
		out = append(out, e)
	}
	httpx.Write(w, http.StatusOK, &v1.AdminPlanLogResponse{Entries: out})
	return nil
}

// setSuspension: PUT /api/admin/workspaces/{id}/suspension {suspended, reason} (item 32).
// Suspending an already suspended workspace updates the reason (and keeps the original time).
// WORKSPACE_UPDATE carries the new state; rtc.SyncPublisher disconnects the workspace's voice
// rooms when it shows a suspension.
func (a *Admin) setSuspension(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.AdminSetSuspensionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	reason := strings.TrimSpace(req.GetReason())
	if req.GetSuspended() {
		if reason == "" {
			return httpx.Validation("reason", "a reason is required to suspend a workspace")
		}
		if utf8.RuneCountInString(reason) > maxNote {
			return httpx.Validation("reason", "reason must be at most 500 characters")
		}
	} else {
		reason = ""
	}
	actor := auth.MustFromContext(r.Context()).UserID
	var ws sqlc.Workspace
	err = a.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.LockOAuthWorkspace(r.Context(), id)
		if err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("workspace")
			}
			return err
		}
		p := sqlc.SetWorkspaceSuspensionParams{ID: id, Reason: reason}
		action := "resume"
		if req.GetSuspended() {
			action = "suspend"
			at := time.Now()
			if cur.SuspendedAt != nil {
				at = *cur.SuspendedAt
			}
			p.SuspendedAt, p.SuspendedBy = &at, &actor
		}
		if ws, err = q.SetWorkspaceSuspension(r.Context(), p); err != nil {
			return err
		}
		if err := auth.InvalidateIdentity(r.Context(), q, id, nil, &actor, "workspace_"+action); err != nil {
			return err
		}
		return q.InsertAdminLog(r.Context(), sqlc.InsertAdminLogParams{WorkspaceID: id, ActorID: &actor, Action: action, Reason: reason})
	})
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "workspace suspension changed", "workspace", id, "by", actor,
		"suspended", req.GetSuspended(), "reason", reason)
	pw := pbconv.Workspace(ws)
	if err := a.plans.Fill(r.Context(), pw); err != nil {
		return err
	}
	a.events.Workspace(r.Context(), id, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pw}}})
	aw, err := a.one(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminSetSuspensionResponse{Workspace: aw})
	return nil
}
