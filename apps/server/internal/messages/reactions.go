package messages

import (
	"bytes"
	"context"
	"net/http"
	"slices"
	"strconv"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Limits for reactions and pins. MaxReactionsPerUser: different emojis one user may put on
// one message (docs/09 item 27); a product rule, not configuration.
const (
	MaxEmojisPerMessage = 20
	MaxReactionsPerUser = 3
	MaxPinsPerRoom      = 50
)

// ReasonReactionLimit is ApiError.reason of the 409 returned when MaxReactionsPerUser is hit.
const ReasonReactionLimit = "REACTION_LIMIT"

var errReactionLimit = httpx.Conflict("at most 3 different reactions per message")

// ValidEmoji accepts one emoji sequence: 1..64 bytes, ≤ 16 code points, at least one
// non-ASCII code point, no spaces or control characters. (Emoji segmentation is left to
// the client; this only keeps arbitrary text out.)
func ValidEmoji(s string) bool {
	if len(s) == 0 || len(s) > 64 || !utf8.ValidString(s) || utf8.RuneCountInString(s) > 16 {
		return false
	}
	nonASCII := false
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
		nonASCII = nonASCII || r > unicode.MaxASCII
	}
	return nonASCII
}

// withDetails converts messages for REST responses: attachments and reactions (with `me`
// relative to the caller) are loaded in one query each.
func (h *Handlers) withDetails(r *http.Request, ms []sqlc.Message) ([]*v1.Message, error) {
	return h.details(r.Context(), ms, uid(r))
}

// details loads attachments and reactions; viewer uuid.Nil = for events (me always false).
func (h *Handlers) details(ctx context.Context, ms []sqlc.Message, viewer uuid.UUID) ([]*v1.Message, error) {
	return Details(ctx, h.db.Q, ms, viewer)
}

// Details converts messages with their attachments, stickers, forward sources and reactions
// (as viewer sees them; uuid.Nil = me always false), e.g. the comments of a task feed.
func Details(ctx context.Context, q *sqlc.Queries, ms []sqlc.Message, viewer uuid.UUID) ([]*v1.Message, error) {
	out, err := withAttachments(ctx, q, ms)
	if err != nil || len(ms) == 0 {
		return out, err
	}
	ids := make([]uuid.UUID, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	rows, err := q.ListReactions(ctx, sqlc.ListReactionsParams{Viewer: viewer, Ids: ids})
	if err != nil {
		return nil, err
	}
	byMsg := map[string][]*v1.Reaction{}
	for _, row := range rows {
		k := row.MessageID.String()
		byMsg[k] = append(byMsg[k], &v1.Reaction{Emoji: row.Emoji, Count: uint32(max(row.Count, 0)), Me: row.Me})
	}
	for _, m := range out {
		m.Reactions = byMsg[m.GetId()]
	}
	return out, nil
}

func (h *Handlers) reaction(r *http.Request) (sqlc.Message, perm.RoomAccess, string, error) {
	m, acc, err := h.load(r)
	if err != nil {
		return m, acc, "", err
	}
	emoji := r.PathValue("emoji")
	if !ValidEmoji(emoji) {
		return m, acc, "", httpx.Validation("emoji", "not an emoji")
	}
	return m, acc, emoji, nil
}

// visibleReaction resolves {id}/{emoji} for reading the reactor list. The message must be in
// the caller's visible history — the rules of `get` (VIEW_ROOM incl. an archived temporary
// room, not before the cleared slice of a DM) — so 404 hides it the same way.
func (h *Handlers) visibleReaction(r *http.Request) (sqlc.Message, perm.RoomAccess, string, error) {
	id, err := httpx.PathUUID(r, "id", "message")
	if err != nil {
		return sqlc.Message{}, perm.RoomAccess{}, "", err
	}
	m, err := h.db.Q.GetMessage(r.Context(), id)
	if db.IsNotFound(err) {
		return m, perm.RoomAccess{}, "", httpx.NotFound("message")
	}
	if err != nil {
		return m, perm.RoomAccess{}, "", err
	}
	acc, err := rooms.ReadAccess(r, m.RoomID)
	if err != nil {
		return m, perm.RoomAccess{}, "", httpx.NotFound("message")
	}
	since, err := h.clearedBefore(r, acc, m.RoomID)
	if err != nil {
		return m, perm.RoomAccess{}, "", err
	}
	if since != nil && bytes.Compare(m.ID[:], since[:]) <= 0 {
		return m, perm.RoomAccess{}, "", httpx.NotFound("message")
	}
	emoji := r.PathValue("emoji")
	if !ValidEmoji(emoji) {
		return m, perm.RoomAccess{}, "", httpx.Validation("emoji", "not an emoji")
	}
	return m, acc, emoji, nil
}

// DefaultReactorPage is the page size of GET …/reactions/{emoji} without a limit (a tooltip
// needs only the first names; callers page with `after` for the rest).
const DefaultReactorPage = 25

// listReactionUsers: GET /api/messages/{id}/reactions/{emoji}?after=&limit= (VIEW_ROOM) —
// who reacted with an emoji. Pages are ordered by user id, `after` is the last id of the
// previous page; limit 1..100, default 25.
func (h *Handlers) listReactionUsers(w http.ResponseWriter, r *http.Request) error {
	m, acc, emoji, err := h.visibleReaction(r)
	if err != nil {
		return err
	}
	// A guest sees only the people of its rooms (perm.GuestVisible): other reactors are left out.
	var allowed map[uuid.UUID]bool
	if acc.Role == perm.RoleGuest {
		if allowed, err = rooms.GuestVisibleUsers(r.Context(), h.db.Q, nil, acc.WorkspaceID, uid(r)); err != nil {
			return err
		}
	}
	q := r.URL.Query()
	lim := int32(DefaultReactorPage)
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > MaxLimit {
			return httpx.BadRequest("limit must be 1..100")
		}
		lim = int32(n) //nolint:gosec // bounded above
	}
	var after *uuid.UUID
	if s := q.Get("after"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.BadRequest("after must be a user id")
		}
		after = &id
	}
	rows, err := h.db.Q.ListReactionUsers(r.Context(), sqlc.ListReactionUsersParams{MessageID: m.ID, Emoji: emoji, After: after, Lim: lim + 1})
	if err != nil {
		return err
	}
	more := len(rows) > int(lim)
	if more {
		rows = rows[:lim]
	}
	users := make([]*v1.User, 0, len(rows))
	for _, row := range rows {
		if allowed == nil || allowed[row.User.ID] {
			users = append(users, pbconv.User(row.User))
		}
	}
	httpx.Write(w, http.StatusOK, &v1.ListReactionUsersResponse{Users: users, HasMore: more})
	return nil
}

func reactionEvent(add bool, acc perm.RoomAccess, m sqlc.Message, user uuid.UUID, emoji string) *v1.DispatchEvent {
	w, room, msg, u := rooms.WorkspaceIDString(acc), m.RoomID.String(), m.ID.String(), user.String()
	if add {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageReactionAdd{MessageReactionAdd: &v1.MessageReactionAdd{
			WorkspaceId: w, RoomId: room, MessageId: msg, UserId: u, Emoji: emoji}}}
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageReactionRemove{MessageReactionRemove: &v1.MessageReactionRemove{
		WorkspaceId: w, RoomId: room, MessageId: msg, UserId: u, Emoji: emoji}}}
}

// addReaction: PUT /api/messages/{id}/reactions/{emoji} (SEND_MESSAGES). Idempotent, 204;
// 409 CONFLICT reason REACTION_LIMIT (used/limit) when the caller already has
// MaxReactionsPerUser different emojis on the message.
func (h *Handlers) addReaction(w http.ResponseWriter, r *http.Request) error {
	m, acc, emoji, err := h.reaction(r)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.SendMessages) {
		return httpx.Forbidden("SEND_MESSAGES required")
	}
	if err := h.personSend(r.Context(), uid(r), acc); err != nil { // ADR-0154: no reactions in a blocked DM
		return err
	}
	var n int64
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		// The message row lock serializes concurrent adds, so the caps below hold.
		if err := q.LockMessageReactions(r.Context(), m.ID); err != nil {
			return err
		}
		st, err := q.ReactionEmojiStats(r.Context(), sqlc.ReactionEmojiStatsParams{MessageID: m.ID, UserID: uid(r), Emoji: emoji})
		if err != nil {
			return err
		}
		if st.UserHasEmoji { // idempotent repeat
			return nil
		}
		if st.UserEmojis >= MaxReactionsPerUser {
			return errReactionLimit.WithDetails(ReasonReactionLimit, uint64(st.UserEmojis), MaxReactionsPerUser)
		}
		if !st.HasEmoji && st.DistinctEmojis >= MaxEmojisPerMessage {
			return httpx.Validation("emoji", "too many different reactions on this message")
		}
		n, err = q.AddReaction(r.Context(), sqlc.AddReactionParams{MessageID: m.ID, UserID: uid(r), Emoji: emoji})
		return err
	})
	if db.IsForeignKeyViolation(err) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	if n > 0 {
		rooms.Publish(r.Context(), h.events, acc, reactionEvent(true, acc, m, uid(r), emoji))
	}
	httpx.NoContent(w)
	return nil
}

// removeReaction: DELETE /api/messages/{id}/reactions/{emoji} — the caller's own reaction.
func (h *Handlers) removeReaction(w http.ResponseWriter, r *http.Request) error {
	m, acc, emoji, err := h.reaction(r)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RemoveReaction(r.Context(), sqlc.RemoveReactionParams{MessageID: m.ID, UserID: uid(r), Emoji: emoji})
	})
	if err != nil {
		return err
	}
	if n > 0 {
		rooms.Publish(r.Context(), h.events, acc, reactionEvent(false, acc, m, uid(r), emoji))
	}
	httpx.NoContent(w)
	return nil
}

// ---- pins ----

func (h *Handlers) setPin(w http.ResponseWriter, r *http.Request, pin bool) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if !canPin(acc) {
		return httpx.Forbidden("MANAGE_MESSAGES required")
	}
	var upd sqlc.Message
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if pin {
			n, err := q.CountPins(r.Context(), m.RoomID)
			if err != nil {
				return err
			}
			if n >= MaxPinsPerRoom {
				return httpx.Validation("id", "a room can have at most 50 pinned messages")
			}
			upd, err = q.PinMessage(r.Context(), sqlc.PinMessageParams{ID: m.ID, PinnedBy: ptr(uid(r))})
			return err
		}
		upd, err = q.UnpinMessage(r.Context(), m.ID)
		return err
	})
	if db.IsNotFound(err) { // already in the requested state
		httpx.NoContent(w)
		return nil
	}
	if err != nil {
		return err
	}
	out, err := h.details(r.Context(), []sqlc.Message{upd}, uuid.Nil)
	if err != nil {
		return err
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: out[0]},
	}})
	httpx.NoContent(w)
	return nil
}

// canPin: MANAGE_MESSAGES in a workspace room; in a DM both participants (ADR-0020).
func canPin(acc perm.RoomAccess) bool {
	return acc.Bits.Has(perm.ManageMessages) || (acc.DM && acc.Bits.Has(perm.ViewRoom))
}

func ptr[T any](v T) *T { return &v }

func (h *Handlers) listPins(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.ReadAccess(r, roomID) // archived temporary rooms too (ADR-0044)
	if err != nil {
		return err
	}
	since, err := h.clearedBefore(r, acc, roomID)
	if err != nil {
		return err
	}
	ms, err := h.db.Q.ListPins(r.Context(), roomID)
	if err != nil {
		return err
	}
	if since != nil { // a cleared DM (item 51): pins of the hidden history are hidden too
		ms = slices.DeleteFunc(ms, func(m sqlc.Message) bool { return bytes.Compare(m.ID[:], since[:]) <= 0 })
	}
	out, err := h.withDetails(r, ms)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListMessagesResponse{Messages: out})
	return nil
}

func parseMsgID(m *v1.Message) uuid.UUID {
	id, _ := uuid.Parse(m.GetId())
	return id
}

// forEvent returns a copy of m for broadcasting: reaction counts stay, `me` is cleared
// (it is relative to the REST caller).
func forEvent(m *v1.Message) *v1.Message {
	c := proto.Clone(m).(*v1.Message)
	for _, r := range c.GetReactions() {
		r.Me = false
	}
	return c
}
