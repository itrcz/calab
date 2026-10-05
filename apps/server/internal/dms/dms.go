// Package dms implements direct messages (ADR-0020): a DM is a room without a workspace
// (type 'dm') with exactly two participants in dm_members. Its messages, files, reactions,
// pins and read state go through the room endpoints; access is by participation
// (perm.Resolver). This package creates and lists DMs and finds whom one may write to.
package dms

import (
	"context"
	"errors"
	"net/http"
	"strings"
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
	"github.com/calaba/calaba/server/internal/redisx"
)

// Limits.
const (
	MaxListed     = 500 // DMs in READY and GET /api/dms
	MaxCandidates = 20
	maxQuery      = 64
)

// Handlers serves /api/dms.
type Handlers struct {
	db      *db.DB
	events  events.Publisher
	limiter *redisx.RateLimiter // new DMs per user
	// EmailGate: whether starting a DM needs a confirmed address (ADR-0023,
	// EMAIL_VERIFICATION, ADR-0065). The zero value requires one.
	EmailGate auth.EmailGate
}

// NewHandlers creates the DM handlers; limiter bounds how many DMs a user creates.
func NewHandlers(d *db.DB, ev events.Publisher, limiter *redisx.RateLimiter) *Handlers {
	return &Handlers{db: d, events: ev, limiter: limiter}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/dms", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("GET /api/dms", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("GET /api/dms/candidates", wrap(httpx.HandlerFunc(h.candidates)))
	mux.Handle("PATCH /api/dms/{id}/state", wrap(httpx.HandlerFunc(h.setState)))
}

// Key is the pair key of a DM: the smaller id, ':', the larger one.
func Key(a, b uuid.UUID) string {
	x, y := a.String(), b.String()
	if y < x {
		x, y = y, x
	}
	return x + ":" + y
}

// Summary converts a ListDMs row (see DmSummary in gateway.proto).
func Summary(row sqlc.ListDMsRow) *v1.DmSummary {
	room := &v1.Room{Id: row.RoomID.String(), Type: v1.RoomType_ROOM_TYPE_DM, CreatedAt: timestamppb.New(row.RoomCreatedAt)}
	unread := uint32(max(row.UnreadCount, 0)) //nolint:gosec // 0..999
	rs := &v1.ReadState{RoomId: room.GetId(), UnreadCount: unread, MentionCount: unread}
	if row.LastReadMessageID != nil {
		rs.LastReadMessageId = row.LastReadMessageID.String()
	}
	out := &v1.DmSummary{Room: room, Peer: pbconv.User(row.User), ReadState: rs}
	if row.ArchivedAt != nil {
		out.ArchivedAt = timestamppb.New(*row.ArchivedAt)
	}
	if row.ClearedBefore != nil {
		out.ClearedBeforeMessageId = row.ClearedBefore.String()
	}
	if row.PeerReadMessageID != nil {
		out.PeerReadMessageId = row.PeerReadMessageID.String()
	}
	if row.HasMessages {
		room.LastMessageId = row.LastMessageID.String()
		room.LastMessageAt = timestamppb.New(row.LastMessageAt)
		out.LastMessageAt = room.GetLastMessageAt()
		out.LastMessage = &v1.DmLastMessage{
			Id: room.GetLastMessageId(), AuthorId: row.LastAuthorID.String(), Content: row.LastPreview,
			AttachmentCount: uint32(max(row.LastAttachments, 0)), CreatedAt: room.GetLastMessageAt(), //nolint:gosec // 0..20
			StickerEmoji: row.LastStickerEmoji,
		}
	}
	return out
}

// List returns the user's DMs, most recent activity first (READY and GET /api/dms).
func List(ctx context.Context, q *sqlc.Queries, userID uuid.UUID) ([]*v1.DmSummary, error) {
	rows, err := q.ListDMs(ctx, sqlc.ListDMsParams{UserID: userID, Lim: MaxListed})
	if err != nil {
		return nil, err
	}
	out := make([]*v1.DmSummary, len(rows))
	for i, row := range rows {
		out[i] = Summary(row)
	}
	return out, nil
}

// one returns the summary of one DM as userID sees it.
func one(ctx context.Context, q *sqlc.Queries, userID, roomID uuid.UUID) (*v1.DmSummary, error) {
	rows, err := q.ListDMs(ctx, sqlc.ListDMsParams{UserID: userID, RoomID: &roomID, Lim: 1})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, httpx.NotFound("user")
	}
	return Summary(rows[0]), nil
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// notGuest rejects guest accounts (ADR-0016/0020: guests do not see DMs).
func (h *Handlers) notGuest(r *http.Request) error {
	u, err := h.db.Q.GetUser(r.Context(), uid(r))
	if err != nil {
		return err
	}
	if u.IsGuest {
		return httpx.Forbidden("direct messages are not available for guest accounts")
	}
	return nil
}

// create: POST /api/dms {user_id} — get-or-create the DM with a user (see dm.proto).
func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuest(r); err != nil {
		return err
	}
	var req v1.CreateDmRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	peerID, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	me := uid(r)
	if peerID == me {
		return httpx.Validation("userId", "cannot start a direct message with yourself")
	}
	peer, err := h.db.Q.GetUser(r.Context(), peerID)
	if db.IsNotFound(err) || (err == nil && peer.DisabledAt != nil) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	if peer.IsGuest {
		return httpx.Forbidden("guest accounts cannot receive direct messages")
	}
	if auth.MustFromContext(r.Context()).IsBot { // ADR-0031: blocked, or no shared workspace any more
		if err := CheckBotDM(r.Context(), h.db.Q, me, peerID); errors.Is(err, ErrBotNoSharedWorkspace) {
			return httpx.NotFound("user") // as for people: users outside the caller's workspaces are not revealed
		} else if err != nil {
			return err
		}
	}
	key := Key(me, peerID)
	room, err := h.db.Q.GetDMByKey(r.Context(), &key)
	switch {
	case err == nil: // an existing DM stays reachable even without a common workspace now
		return h.respond(w, r, http.StatusOK, room.ID)
	case !db.IsNotFound(err):
		return err
	}
	shared, err := h.db.Q.ShareWorkspace(r.Context(), sqlc.ShareWorkspaceParams{UserID: me, OtherID: peerID})
	if err != nil {
		return err
	}
	if !shared {
		return httpx.NotFound("user") // do not reveal users outside the caller's workspaces
	}
	// Starting a new DM needs a verified email (ADR-0023) unless EMAIL_VERIFICATION=optional
	// (ADR-0065); existing DMs stay reachable.
	if _, err := h.EmailGate.User(r.Context(), h.db.Q, me); err != nil {
		return err
	}
	if err := h.limiter.Take(r.Context(), me.String()); err != nil {
		return err
	}
	created := false
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		room, err = q.CreateDMRoom(r.Context(), &key)
		if db.IsNotFound(err) { // a concurrent request created it: return that one
			room, err = q.GetDMByKey(r.Context(), &key)
			return err
		}
		if err != nil {
			return err
		}
		created = true
		return q.AddDMMembers(r.Context(), sqlc.AddDMMembersParams{RoomID: room.ID, UserIds: []uuid.UUID{me, peerID}})
	})
	if err != nil {
		return err
	}
	if !created {
		return h.respond(w, r, http.StatusOK, room.ID)
	}
	// Both participants' devices learn about the DM, each with their own peer.
	for _, u := range []uuid.UUID{me, peerID} {
		s, err := one(r.Context(), h.db.Q, u, room.ID)
		if err != nil {
			return err
		}
		h.events.User(r.Context(), u, &v1.DispatchEvent{Event: &v1.DispatchEvent_DmCreate{DmCreate: &v1.DmCreate{Dm: s}}})
	}
	return h.respond(w, r, http.StatusCreated, room.ID)
}

func (h *Handlers) respond(w http.ResponseWriter, r *http.Request, status int, roomID uuid.UUID) error {
	s, err := one(r.Context(), h.db.Q, uid(r), roomID)
	if err != nil {
		return err
	}
	httpx.Write(w, status, &v1.CreateDmResponse{Dm: s})
	return nil
}

// list: GET /api/dms.
func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuest(r); err != nil {
		return err
	}
	out, err := List(r.Context(), h.db.Q, uid(r))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListDmsResponse{Dms: out})
	return nil
}

// StateEvent is DM_STATE_UPDATE for the user's own devices (item 51).
func StateEvent(st sqlc.DmState) *v1.DispatchEvent {
	ev := &v1.DmStateUpdate{RoomId: st.RoomID.String()}
	if st.ArchivedAt != nil {
		ev.ArchivedAt = timestamppb.New(*st.ArchivedAt)
	}
	if st.ClearedBefore != nil {
		ev.ClearedBeforeMessageId = st.ClearedBefore.String()
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_DmStateUpdate{DmStateUpdate: ev}}
}

// setState: PATCH /api/dms/{id}/state {archived?, cleared} — the caller's own archive / «Удалить
// чат» (docs/09 item 51). Participants only; the peer's history and counts do not change.
func (h *Handlers) setState(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuest(r); err != nil {
		return err
	}
	roomID, err := httpx.PathUUID(r, "id", "dm")
	if err != nil {
		return err
	}
	me := uid(r)
	if _, err := h.db.Q.GetDMPeer(r.Context(), sqlc.GetDMPeerParams{RoomID: roomID, UserID: me}); err != nil {
		if db.IsNotFound(err) {
			return httpx.NotFound("dm")
		}
		return err
	}
	var req v1.UpdateDmStateRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.Archived == nil && !req.GetCleared() {
		return httpx.Validation("archived", "set archived or cleared")
	}
	var st sqlc.DmState
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if req.GetCleared() { // clearing also leaves the archive; archived below may put it back
			if st, err = q.ClearDM(r.Context(), sqlc.ClearDMParams{UserID: me, RoomID: roomID}); err != nil {
				return err
			}
		}
		if req.Archived != nil {
			st, err = q.SetDMArchived(r.Context(), sqlc.SetDMArchivedParams{UserID: me, RoomID: roomID, Archived: req.GetArchived()})
		}
		return err
	})
	if err != nil {
		return err
	}
	h.events.User(r.Context(), me, StateEvent(st))
	s, err := one(r.Context(), h.db.Q, me, roomID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateDmStateResponse{Dm: s})
	return nil
}

// candidates: GET /api/dms/candidates?q= — whom the caller may start a DM with.
func (h *Handlers) candidates(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuest(r); err != nil {
		return err
	}
	raw := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(raw) > maxQuery {
		return httpx.Validation("q", "query must be at most 64 characters")
	}
	// LIKE wildcards in the query are literal text.
	q := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(raw)
	me := uid(r)
	readable, all, err := readableWorkspaces(r.Context(), h.db.Q, me)
	if err != nil {
		return err
	}
	lim := int32(MaxCandidates)
	if !all {
		lim = MaxCandidates * 5 // some are filtered out below
	}
	rows, err := h.db.Q.ListDMCandidates(r.Context(), sqlc.ListDMCandidatesParams{UserID: me, Q: q, Lim: lim})
	if err != nil {
		return err
	}
	if !all {
		if rows, err = readableCandidates(r.Context(), h.db.Q, me, readable, rows, raw); err != nil {
			return err
		}
	}
	out := &v1.ListDmCandidatesResponse{Users: make([]*v1.User, len(rows))}
	for i, u := range rows {
		out.Users[i] = pbconv.User(u)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// readableWorkspaces lists the caller's workspaces this session may read under the
// identity policy (the request's access guard, ADR-0054): a password-only session does not
// see an enforced workspace's members through DMs either. all: none is denied, so the plain
// membership queries apply unchanged. A gate error counts as denied (fail closed).
// Read-only requests only: the guard records each workspace into a mutation's admission.
func readableWorkspaces(ctx context.Context, q *sqlc.Queries, me uuid.UUID) ([]uuid.UUID, bool, error) {
	ids, err := q.ListUserWorkspaceIDs(ctx, me)
	if err != nil {
		return nil, false, err
	}
	readable := make([]uuid.UUID, 0, len(ids))
	for _, ws := range ids {
		if perm.CheckAccess(ctx, ws, me) == nil {
			readable = append(readable, ws)
		}
	}
	return readable, len(readable) == len(ids), nil
}

// readableCandidates keeps the candidates who share a readable workspace with the caller
// (as a full member there) and match the query there: by display name or that workspace's
// nickname, never a nickname of a workspace the session may not read.
func readableCandidates(ctx context.Context, q *sqlc.Queries, me uuid.UUID, readable []uuid.UUID, rows []sqlc.User, query string) ([]sqlc.User, error) {
	ids := make([]uuid.UUID, len(rows))
	for i, u := range rows {
		ids[i] = u.ID
	}
	needle := strings.ToLower(query)
	matches := func(name string) bool { return needle == "" || strings.Contains(strings.ToLower(name), needle) }
	member, named := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}
	for _, ws := range readable {
		if len(ids) == 0 {
			break
		}
		if m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: me}); err != nil || m.Role == "guest" {
			if err != nil && !db.IsNotFound(err) {
				return nil, err
			}
			continue
		}
		names, err := q.ListMemberNames(ctx, sqlc.ListMemberNamesParams{WorkspaceID: ws, UserIds: ids})
		if err != nil {
			return nil, err
		}
		for _, n := range names {
			name, _ := n.Name.(string)
			member[n.UserID] = true
			named[n.UserID] = named[n.UserID] || matches(name)
		}
	}
	out := make([]sqlc.User, 0, min(len(rows), MaxCandidates))
	for _, u := range rows {
		if len(out) < MaxCandidates && member[u.ID] && (named[u.ID] || matches(u.DisplayName)) {
			out = append(out, u)
		}
	}
	return out, nil
}

// ErrBotBlocked means the person blocked this bot (ADR-0031, POST /api/me/blocked-bots/{id}).
var ErrBotBlocked = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_BOT_BLOCKED, "this person blocked the bot")

// ErrBotNoSharedWorkspace means a bot writes in DMs only to members of workspaces it is in now
// (ADR-0031); a bot removed from them cannot keep writing into an existing DM.
var ErrBotNoSharedWorkspace = httpx.Forbidden("the bot shares no workspace with this person")

// CheckBotDM refuses a bot writing to a person who blocked it or with whom it no longer
// shares a workspace.
func CheckBotDM(ctx context.Context, q *sqlc.Queries, bot, person uuid.UUID) error {
	blocked, err := q.IsBotBlocked(ctx, sqlc.IsBotBlockedParams{UserID: person, BotUserID: bot})
	if err != nil {
		return err
	}
	if blocked {
		return ErrBotBlocked
	}
	shared, err := q.ShareWorkspace(ctx, sqlc.ShareWorkspaceParams{UserID: bot, OtherID: person})
	if err != nil {
		return err
	}
	if !shared {
		return ErrBotNoSharedWorkspace
	}
	return nil
}
