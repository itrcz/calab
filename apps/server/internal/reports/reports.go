// Package reports implements reports about people and their messages (ADR-0154): a member
// reports to the workspace's moderators (MANAGE_MEMBERS, the audience of bans), who review them
// in the workspace settings and mark them resolved. Every report is stored (user_reports) and
// logged.
package reports

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Limits.
const (
	MaxComment     = 1000
	MaxMessageText = 2000
	// PerHour: reports one person may file within an hour (counted in the table, so the limit
	// survives restarts and spans instances).
	PerHour      = 10
	defaultLimit = 50
	maxLimit     = 100
)

// Handlers serves /api/reports and /api/workspaces/{id}/reports.
type Handlers struct {
	db     *db.DB
	events events.Publisher
}

// NewHandlers creates the report handlers.
func NewHandlers(d *db.DB, ev events.Publisher) *Handlers {
	return &Handlers{db: d, events: ev}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/reports", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("GET /api/workspaces/{id}/reports", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("POST /api/workspaces/{id}/reports/{reportId}/resolve", wrap(httpx.HandlerFunc(h.resolve)))
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// member: another user is a member of the workspace (the caller goes through the resolver,
// which also applies the identity policy).
func (h *Handlers) member(ctx context.Context, wsID, user uuid.UUID) (bool, error) {
	_, err := h.db.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: user})
	if db.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	var req v1.CreateReportRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me := uid(r)
	target, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	if target == me {
		return httpx.Validation("userId", "cannot report yourself")
	}
	reason := req.GetReason()
	if _, ok := v1.ReportReason_name[int32(reason)]; !ok || reason == v1.ReportReason_REPORT_REASON_UNSPECIFIED {
		return httpx.Validation("reason", "unknown reason")
	}
	comment := strings.TrimSpace(req.GetComment())
	if utf8.RuneCountInString(comment) > MaxComment {
		return httpx.Validation("comment", "comment must be at most 1000 characters")
	}

	var (
		wsID           uuid.UUID
		messageID      *uuid.UUID
		roomID         *uuid.UUID
		text           string
		roomMessage    bool // a message of a workspace room: its author may have left since
		workspaceGiven = req.GetWorkspaceId() != ""
	)
	if workspaceGiven {
		if wsID, err = uuid.Parse(req.GetWorkspaceId()); err != nil {
			return httpx.Validation("workspaceId", "invalid workspace id")
		}
	}
	if s := req.GetMessageId(); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("messageId", "invalid message id")
		}
		m, err := h.db.Q.GetMessage(ctx, id)
		if db.IsNotFound(err) || (err == nil && m.DeletedAt != nil) {
			return httpx.NotFound("message")
		}
		if err != nil {
			return err
		}
		acc, err := rooms.Access(r, m.RoomID) // 404 unless the caller sees the room
		if err != nil {
			return err
		}
		if !acc.Bits.Has(perm.ViewRoom) {
			return httpx.NotFound("message")
		}
		if m.AuthorID != target {
			return httpx.Validation("userId", "the message has another author")
		}
		if !acc.DM {
			wsID, workspaceGiven, roomMessage = acc.WorkspaceID, true, true
		} else if acc.Notes {
			return httpx.NotFound("message")
		}
		messageID, roomID = &m.ID, &m.RoomID
		text = truncate(m.Content, MaxMessageText)
	}
	if !workspaceGiven {
		return httpx.Validation("workspaceId", "workspace required")
	}
	// The caller through the resolver (identity policy, 404 for non-members), the target by table.
	if _, _, err := perm.FromContext(ctx).Workspace(ctx, wsID, me); errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	} else if err != nil {
		return err
	}
	if !roomMessage {
		if ok, err := h.member(ctx, wsID, target); err != nil {
			return err
		} else if !ok {
			return httpx.NotFound("user")
		}
	}

	var rep sqlc.UserReport
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		n, err := q.CountRecentReportsBy(ctx, sqlc.CountRecentReportsByParams{ReporterID: &me, CreatedAt: time.Now().Add(-time.Hour)})
		if err != nil {
			return err
		}
		if n >= PerHour {
			return httpx.RateLimited()
		}
		rep, err = q.CreateUserReport(ctx, sqlc.CreateUserReportParams{
			ID: uuid.Must(uuid.NewV7()), WorkspaceID: wsID, ReporterID: &me, TargetUserID: &target,
			MessageID: messageID, RoomID: roomID, MessageText: text, Reason: int16(reason), Comment: comment, //nolint:gosec // enum 1..6
		})
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "user reported", "report", rep.ID, "workspace", wsID, "reporter", me, "target", target,
		"message", messageID, "reason", reason.String())
	if pb, err := h.view(ctx, h.db.Q, []sqlc.UserReport{rep}); err == nil {
		h.events.Workspace(context.WithoutCancel(ctx), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceReportCreate{
			WorkspaceReportCreate: &v1.WorkspaceReportCreate{Report: pb[0]},
		}})
	} else {
		slog.WarnContext(ctx, "report event", "report", rep.ID, "err", err)
	}
	httpx.Write(w, http.StatusCreated, &v1.CreateReportResponse{Id: rep.ID.String()})
	return nil
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// moderator: MANAGE_MEMBERS, never a guest (as the bans, ADR-0048).
func moderator(r *http.Request) (uuid.UUID, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if !bits.Has(perm.ManageMembers) || role == perm.RoleGuest {
		return uuid.Nil, httpx.Forbidden("MANAGE_MEMBERS required")
	}
	return wsID, nil
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	wsID, err := moderator(r)
	if err != nil {
		return err
	}
	p := sqlc.ListWorkspaceReportsParams{WorkspaceID: wsID, Lim: defaultLimit}
	if s := r.URL.Query().Get("before"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("before", "invalid id")
		}
		p.Before = &id
	}
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return httpx.Validation("limit", "limit must be 1..100")
		}
		p.Lim = int32(n) //nolint:gosec // 1..100
	}
	rows, err := h.db.Q.ListWorkspaceReports(r.Context(), p)
	if err != nil {
		return err
	}
	out, err := h.view(r.Context(), h.db.Q, rows)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListReportsResponse{Reports: out})
	return nil
}

func (h *Handlers) resolve(w http.ResponseWriter, r *http.Request) error {
	wsID, err := moderator(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "reportId", "report")
	if err != nil {
		return err
	}
	me := uid(r)
	rep, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.UserReport, error) {
		return guarded.ResolveUserReport(r.Context(), sqlc.ResolveUserReportParams{ID: id, WorkspaceID: wsID, ResolvedBy: me})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("report")
	}
	if err != nil {
		return err
	}
	if pb, err := h.view(r.Context(), h.db.Q, []sqlc.UserReport{rep}); err == nil {
		h.events.Workspace(context.WithoutCancel(r.Context()), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceReportUpdate{
			WorkspaceReportUpdate: &v1.WorkspaceReportUpdate{Report: pb[0]},
		}})
	}
	httpx.NoContent(w)
	return nil
}

// view converts rows with the reporter and target profiles.
func (h *Handlers) view(ctx context.Context, q *sqlc.Queries, rows []sqlc.UserReport) ([]*v1.UserReport, error) {
	ids := make([]uuid.UUID, 0, 2*len(rows))
	for _, r := range rows {
		if r.ReporterID != nil {
			ids = append(ids, *r.ReporterID)
		}
		if r.TargetUserID != nil {
			ids = append(ids, *r.TargetUserID)
		}
	}
	users := map[uuid.UUID]sqlc.User{}
	if len(ids) > 0 {
		us, err := q.ListUsersByIDs(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, u := range us {
			users[u.ID] = u
		}
	}
	out := make([]*v1.UserReport, len(rows))
	for i, r := range rows {
		pb := &v1.UserReport{
			Id: r.ID.String(), WorkspaceId: r.WorkspaceID.String(), MessageText: r.MessageText,
			Reason: v1.ReportReason(r.Reason), Comment: r.Comment, CreatedAt: timestamppb.New(r.CreatedAt),
		}
		if r.ReporterID != nil {
			if u, ok := users[*r.ReporterID]; ok {
				pb.Reporter = pbconv.User(u)
			}
		}
		if r.TargetUserID != nil {
			if u, ok := users[*r.TargetUserID]; ok {
				pb.Target = pbconv.User(u)
			}
		}
		if r.MessageID != nil {
			pb.MessageId = r.MessageID.String()
		}
		if r.RoomID != nil {
			pb.RoomId = r.RoomID.String()
		}
		if r.ResolvedAt != nil {
			pb.ResolvedAt = timestamppb.New(*r.ResolvedAt)
		}
		if r.ResolvedBy != nil {
			pb.ResolvedBy = r.ResolvedBy.String()
		}
		out[i] = pb
	}
	return out, nil
}
