// Package boards implements task boards (ADR-0042): boards with statuses, labels, milestones,
// saved views and access overrides; tasks with per-board numbering, fractional order,
// assignees with one lead, labels, relations, attachments, subtasks and archive; the task
// journal (task_activity) merged with the comments of the task's hidden room; the universal
// TaskFilter; «Мои задачи», search, CSV export, the auto-archive sweeper and task
// notifications. Comments themselves are messages of rooms.type 'task' served by the message
// routes (perm.RoomAccess.Task).
package boards

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// Uploader stores an upload of the caller into a workspace (files.Service).
type Uploader interface {
	UploadInto(w http.ResponseWriter, r *http.Request, wsID uuid.UUID) error
}

// Limiter is a per-key rate limit (redisx.RateLimiter): Take answers 429 when the budget is out.
type Limiter interface {
	Take(ctx context.Context, key string) error
}

// Service serves the boards API.
type Service struct {
	db    *db.DB
	ev    events.Publisher
	plans *plans.Service
	files Uploader
	hooks *Webhooks  // board webhooks (EnableWebhooks); nil = off
	repo  *repoHooks // Git webhooks of boards (EnableGit, ADR-0060); nil = off
	// system posts the automation cards of rules (ADR-0060).
	system *messages.System
	// PublicURL is PUBLIC_APP_URL: links to messages in «Создать задачу из сообщения».
	PublicURL string
	// CreateLimit / SearchLimit: per-user budgets of task creation and of ⌘K task search
	// (security review 1.1.0; comments are messages under the message limit). nil = none.
	CreateLimit, SearchLimit                                   Limiter
	FormReadLimit, FormIPLimit, FormUserLimit, FormSubmitLimit Limiter
	// Now is the clock (tests move it).
	Now func() time.Time
}

// New creates the service; p and f may be nil (no plan limit, no uploads).
func New(d *db.DB, ev events.Publisher, p *plans.Service, f Uploader) *Service {
	return &Service{db: d, ev: ev, plans: p, files: f, system: messages.NewSystem(d, ev), Now: time.Now}
}

// Routes registers the routes; wrap applies auth + the permission resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/workspaces/{id}/boards", s.listBoards)
	h("POST /api/workspaces/{id}/boards", s.createBoard)
	h("GET /api/boards/{id}", s.getBoard)
	h("GET /api/boards/{id}/forms", s.listForms)
	h("POST /api/boards/{id}/forms", s.createForm)
	h("PUT /api/boards/{id}/forms/{fid}", s.updateForm)
	h("DELETE /api/boards/{id}/forms/{fid}", s.deleteForm)
	h("POST /api/boards/{id}/forms/preview", s.previewForm)
	h("GET /api/forms/{code}", s.publicForm)
	h("POST /api/forms/{code}/submissions", s.submitForm)
	mux.Handle("GET /api/public/forms/{code}", httpx.HandlerFunc(s.publicForm))
	mux.Handle("POST /api/public/forms/{code}/submissions", httpx.HandlerFunc(s.submitForm))
	h("PATCH /api/boards/{id}", s.updateBoard)
	h("DELETE /api/boards/{id}", s.deleteBoard)
	h("POST /api/boards/{id}/restore", s.restoreBoard)
	h("PUT /api/boards/{id}/position", s.setBoardPosition)
	h("GET /api/boards/{id}/permissions", s.getPermissions)
	h("PUT /api/boards/{id}/permissions", s.setPermissions)
	h("POST /api/boards/{id}/statuses", s.createStatus)
	h("PATCH /api/boards/{id}/statuses/{sid}", s.updateStatus)
	h("DELETE /api/boards/{id}/statuses/{sid}", s.deleteStatus)
	h("POST /api/boards/{id}/labels", s.createLabel)
	h("PATCH /api/boards/{id}/labels/{sid}", s.updateLabel)
	h("DELETE /api/boards/{id}/labels/{sid}", s.deleteLabel)
	h("POST /api/boards/{id}/milestones", s.createMilestone)
	h("PATCH /api/boards/{id}/milestones/{sid}", s.updateMilestone)
	h("DELETE /api/boards/{id}/milestones/{sid}", s.deleteMilestone)
	h("GET /api/boards/{id}/views", s.listViews)
	h("POST /api/boards/{id}/views", s.createView)
	h("PATCH /api/boards/{id}/views/{sid}", s.updateView)
	h("DELETE /api/boards/{id}/views/{sid}", s.deleteView)
	h("POST /api/boards/{id}/files", s.upload)
	h("GET /api/boards/{id}/activity", s.boardActivity)
	h("GET /api/boards/{id}/tasks", s.listTasks)
	h("POST /api/boards/{id}/tasks", s.createTask)
	h("GET /api/tasks/{id}", s.getTask)
	h("PATCH /api/tasks/{id}", s.updateTask)
	h("POST /api/tasks/{id}/archive", func(w http.ResponseWriter, r *http.Request) error { return s.setArchived(w, r, true) })
	h("POST /api/tasks/{id}/restore", func(w http.ResponseWriter, r *http.Request) error { return s.setArchived(w, r, false) })
	h("PUT /api/tasks/{id}/assignees", s.setAssignees)
	h("PUT /api/tasks/{id}/approvers", s.setApprovers)
	h("POST /api/tasks/{id}/approval", s.vote)
	h("PUT /api/tasks/{id}/relations", s.addRelation)
	h("DELETE /api/tasks/{id}/relations", s.removeRelation)
	h("PUT /api/tasks/{id}/watchers", s.addWatcher)
	h("DELETE /api/tasks/{id}/watchers", s.removeWatcher)
	h("PUT /api/tasks/{id}/subscription", s.setSubscription)
	h("PUT /api/tasks/{id}/read", s.markRead)
	h("GET /api/tasks/{id}/activity", s.taskActivity)
	h("GET /api/t/{key}", s.lookup)
	h("GET /api/me/tasks", s.myTasks)
	h("GET /api/workspaces/{id}/tasks/search", s.search)
	h("GET /api/workspaces/{id}/board-categories", s.listCategories)
	h("POST /api/workspaces/{id}/board-categories", s.createCategory)
	h("PATCH /api/board-categories/{id}", s.updateCategory)
	h("DELETE /api/board-categories/{id}", s.deleteCategory)
	h("PUT /api/workspaces/{id}/boards/order", s.setOrder)
	h("POST /api/tasks/{id}/checklists", s.createChecklist)
	h("PATCH /api/checklists/{id}", s.updateChecklist)
	h("DELETE /api/checklists/{id}", s.deleteChecklist)
	h("POST /api/checklists/{id}/items", s.createChecklistItem)
	h("PATCH /api/checklist-items/{id}", s.updateChecklistItem)
	h("DELETE /api/checklist-items/{id}", s.deleteChecklistItem)
	h("POST /api/checklist-items/{id}/convert", s.convertChecklistItem)
	h("POST /api/tasks/{id}/milestones", s.createTaskMilestone)
	h("PATCH /api/task-milestones/{id}", s.updateTaskMilestone)
	h("DELETE /api/task-milestones/{id}", s.deleteTaskMilestone)
	s.webhookRoutes(mux, wrap)
	s.ruleRoutes(mux, wrap)
	s.repoRoutes(mux, wrap)
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

func isBot(r *http.Request) bool { return auth.MustFromContext(r.Context()).IsBot }

// take spends one unit of a per-user budget (nil = unlimited).
func take(r *http.Request, l Limiter) error {
	if l == nil {
		return nil
	}
	return l.Take(r.Context(), uid(r).String())
}

// tx runs fn in a transaction with both the sqlc queries and the raw transaction (dynamic SQL).
func (s *Service) tx(ctx context.Context, fn func(q *sqlc.Queries, tx pgx.Tx) error) error {
	return s.db.TxRaw(ctx, fn)
}

// ---- access ----

// board resolves the caller's access to a board: 404 when it does not exist or they do not
// see it; an archived board only for MANAGE_BOARD with archivedOK. A task-scoped member
// (ADR-0059) gets their access with Bits = 0: every route decides what they may do — read the
// board, its views and their own tasks, upload; anything else answers like to a member without
// the bit (403), or use fullBoard.
func board(r *http.Request, boardID uuid.UUID, archivedOK bool) (perm.BoardAccess, error) {
	acc, err := perm.FromContext(r.Context()).Board(r.Context(), boardID, uid(r))
	if errors.Is(err, perm.ErrNoBoard) || (err == nil && !acc.Bits.Has(perm.ViewBoard) && !acc.TaskScoped) {
		return perm.BoardAccess{}, httpx.NotFound("board")
	}
	if err != nil {
		return acc, err
	}
	if acc.Archived && (!archivedOK || !acc.Bits.Has(perm.ManageBoard)) {
		return perm.BoardAccess{}, httpx.NotFound("board")
	}
	return acc, nil
}

func pathBoard(r *http.Request, archivedOK bool) (uuid.UUID, perm.BoardAccess, error) {
	id, err := httpx.PathUUID(r, "id", "board")
	if err != nil {
		return uuid.Nil, perm.BoardAccess{}, err
	}
	acc, err := board(r, id, archivedOK)
	return id, acc, err
}

// fullBoard is pathBoard for the routes closed to task-scoped members (ADR-0059 §3): 403, as to
// a member without bits.
func fullBoard(r *http.Request, archivedOK bool) (uuid.UUID, perm.BoardAccess, error) {
	id, acc, err := pathBoard(r, archivedOK)
	if err == nil && !acc.Bits.Has(perm.ViewBoard) {
		err = httpx.Forbidden("VIEW_BOARD required")
	}
	return id, acc, err
}

// writable refuses changes in a suspended workspace (item 32).
func writable(acc perm.BoardAccess) error {
	if acc.Suspended {
		return moderation.ErrSuspended
	}
	return nil
}

// manageBoard resolves a board the caller may manage (MANAGE_BOARD, not suspended).
func manageBoard(r *http.Request, archivedOK bool) (uuid.UUID, perm.BoardAccess, error) {
	id, acc, err := pathBoard(r, archivedOK)
	if err != nil {
		return id, acc, err
	}
	if !acc.Bits.Has(perm.ManageBoard) {
		return id, acc, httpx.Forbidden("MANAGE_BOARD required")
	}
	return id, acc, writable(acc)
}

// member resolves the caller's membership of a workspace (404 for non-members, 403 for guests).
func member(r *http.Request, wsID uuid.UUID) (perm.Member, error) {
	m, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return m, httpx.NotFound("workspace")
	}
	if err != nil {
		return m, err
	}
	if m.Role == perm.RoleGuest {
		return m, httpx.Forbidden("boards are not available for guests")
	}
	return m, nil
}
