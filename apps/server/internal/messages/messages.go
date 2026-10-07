// Package messages implements room chat: history, idempotent send, edit, delete, read state.
package messages

import (
	"bytes"
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Limits (docs/04, docs/05).
const (
	MaxContent     = 4000
	MaxAttachments = 20
	MaxNonce       = 64
	DefaultLimit   = 50
	MaxLimit       = 100
)

// Handlers serves message endpoints.
type Handlers struct {
	db      *db.DB
	events  events.Publisher
	limiter *redisx.RateLimiter // per (room, user): burst 5, 1/s
	// BotLimiter bounds the messages of one bot in all rooms and DMs (ADR-0031,
	// BOT_MESSAGES_PER_MIN); nil = none.
	BotLimiter *redisx.RateLimiter
	// Receipts publishes READ_RECEIPT after reads (docs/09 #92); nil = none.
	Receipts *Receipts
	// TaskHook runs after a message is posted (or forwarded) into a task's comment room
	// (ADR-0042): subscriptions, notifications, TASK_UPDATE; nil = none.
	TaskHook func(ctx context.Context, acc perm.RoomAccess, msg sqlc.Message)
	// TaskCommentHook runs after a comment of a task room is edited or deleted (kind "updated" /
	// "deleted"; actor = who did it): the board webhook (ADR-0058 §4); nil = none.
	TaskCommentHook func(ctx context.Context, acc perm.RoomAccess, kind string, msg sqlc.Message, actor uuid.UUID)
}

// NewHandlers creates the message handlers.
func NewHandlers(d *db.DB, ev events.Publisher, limiter *redisx.RateLimiter) *Handlers {
	return &Handlers{db: d, events: ev, limiter: limiter}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/rooms/{id}/messages", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("GET /api/rooms/{id}/messages/{messageId}", wrap(httpx.HandlerFunc(h.get)))
	mux.Handle("POST /api/rooms/{id}/messages", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("POST /api/rooms/{id}/messages/{mid}/forward", wrap(httpx.HandlerFunc(h.forward)))
	mux.Handle("POST /api/messages/{id}/interactions", wrap(httpx.HandlerFunc(h.interact)))
	mux.Handle("PATCH /api/messages/{id}", wrap(httpx.HandlerFunc(h.update)))
	mux.Handle("DELETE /api/messages/{id}", wrap(httpx.HandlerFunc(h.delete)))
	mux.Handle("PUT /api/rooms/{id}/read", wrap(httpx.HandlerFunc(h.read)))
	mux.Handle("GET /api/workspaces/{id}/messages/search", wrap(httpx.HandlerFunc(h.searchWorkspace)))
	mux.Handle("GET /api/messages/{id}/reactions/{emoji}", wrap(httpx.HandlerFunc(h.listReactionUsers)))
	mux.Handle("PUT /api/messages/{id}/reactions/{emoji}", wrap(httpx.HandlerFunc(h.addReaction)))
	mux.Handle("DELETE /api/messages/{id}/reactions/{emoji}", wrap(httpx.HandlerFunc(h.removeReaction)))
	mux.Handle("PUT /api/messages/{id}/pin", wrap(httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error { return h.setPin(w, r, true) })))
	mux.Handle("DELETE /api/messages/{id}/pin", wrap(httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error { return h.setPin(w, r, false) })))
	mux.Handle("GET /api/rooms/{id}/pins", wrap(httpx.HandlerFunc(h.listPins)))
	mux.Handle("GET /api/me/mentions", wrap(httpx.HandlerFunc(h.listMentions)))
	mux.Handle("PUT /api/messages/{id}/embeds-hidden", wrap(httpx.HandlerFunc(h.setEmbedsHidden)))
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// withAttachments converts messages, loading all attachments in one query.
func withAttachments(ctx context.Context, q *sqlc.Queries, ms []sqlc.Message) ([]*v1.Message, error) {
	ids := make([]uuid.UUID, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	files := map[uuid.UUID][]sqlc.File{}
	if len(ids) > 0 {
		rows, err := q.ListAttachments(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			files[r.MessageID] = append(files[r.MessageID], r.File)
		}
	}
	out := make([]*v1.Message, len(ms))
	for i, m := range ms {
		out[i] = pbconv.Message(m, files[m.ID])
	}
	if err := withForwardRooms(ctx, q, out); err != nil {
		return nil, err
	}
	return out, withStickers(ctx, q, ms, out)
}

// withForwardRooms fills Forward.room_id of forwarded copies (ADR-0033) in one query; a DM's
// room is not disclosed.
func withForwardRooms(ctx context.Context, q *sqlc.Queries, out []*v1.Message) error {
	var ids []uuid.UUID
	for _, m := range out {
		if id, err := uuid.Parse(m.GetForward().GetMessageId()); err == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ForwardSources(ctx, ids)
	if err != nil {
		return err
	}
	by := make(map[string]string, len(rows))
	for _, r := range rows {
		if r.RoomID != uuid.Nil {
			by[r.ID.String()] = r.RoomID.String()
		}
	}
	for _, m := range out {
		if f := m.GetForward(); f != nil {
			f.RoomId = by[f.GetMessageId()]
		}
	}
	return nil
}

// withStickers fills Message.sticker of sticker messages (ADR-0030) in one query; deleted
// stickers are included (the history keeps showing them).
func withStickers(ctx context.Context, q *sqlc.Queries, ms []sqlc.Message, out []*v1.Message) error {
	var ids []uuid.UUID
	for _, m := range ms {
		if m.StickerID != nil {
			ids = append(ids, *m.StickerID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListStickersByID(ctx, ids)
	if err != nil {
		return err
	}
	by := make(map[uuid.UUID]*v1.Sticker, len(rows))
	for _, r := range rows {
		by[r.Sticker.ID] = pbconv.Sticker(r.Sticker, r.FileSize)
	}
	for i, m := range ms {
		if m.StickerID != nil {
			out[i].Sticker = by[*m.StickerID]
		}
	}
	return nil
}

// sticker resolves CreateMessageRequest.sticker_id (ADR-0030 §4): a live sticker whose pack
// may be used in the room — a room of the pack's workspace by a member who is not a guest
// there, or a DM whose two participants are both non-guest members of it.
func (h *Handlers) sticker(ctx context.Context, raw string, acc perm.RoomAccess, author uuid.UUID) (*sqlc.GetStickerRow, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, httpx.Validation("stickerId", "invalid sticker id")
	}
	s, err := h.db.Q.GetSticker(ctx, id)
	if db.IsNotFound(err) {
		return nil, httpx.Validation("stickerId", "sticker not found")
	}
	if err != nil {
		return nil, err
	}
	if s.WorkspaceID == uuid.Nil {
		return &s, nil
	}
	users, ws := []uuid.UUID{author}, s.WorkspaceID
	if acc.DM {
		users = acc.Members
	} else if acc.WorkspaceID != ws {
		return nil, httpx.Forbidden("this sticker pack cannot be used here")
	}
	n, err := h.db.Q.CountNonGuestMembers(ctx, sqlc.CountNonGuestMembersParams{WorkspaceID: ws, UserIds: users})
	if err != nil {
		return nil, err
	}
	if int(n) != len(users) {
		return nil, httpx.Forbidden("this sticker pack cannot be used here")
	}
	return &s, nil
}

// Page parses ?before=&after=&limit=. A malformed cursor is a 400.
type Page struct {
	Before, After *uuid.UUID
	Limit         int32
}

// ParsePage validates pagination query parameters.
func ParsePage(r *http.Request) (Page, error) {
	q := r.URL.Query()
	p := Page{Limit: DefaultLimit}
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > MaxLimit {
			return p, httpx.BadRequest("limit must be 1..100")
		}
		p.Limit = int32(n) //nolint:gosec // bounded above
	}
	for name, dst := range map[string]**uuid.UUID{"before": &p.Before, "after": &p.After} {
		if s := q.Get(name); s != "" {
			id, err := uuid.Parse(s)
			if err != nil {
				return p, httpx.BadRequest(name + " must be a message id")
			}
			*dst = &id
		}
	}
	if p.Before != nil && p.After != nil {
		return p, httpx.BadRequest("use either before or after")
	}
	return p, nil
}

// get resolves a reply target without paging through history. It uses the history read
// policy, including the caller's cleared DM boundary, and returns the existing Message.
func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.ReadAccess(r, roomID) // history: archived temporary rooms too (ADR-0044)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "messageId", "message")
	if err != nil {
		return err
	}
	since, err := h.clearedBefore(r, acc, roomID)
	if err != nil {
		return err
	}
	if since != nil && bytes.Compare(id[:], since[:]) <= 0 {
		return httpx.NotFound("message")
	}
	m, err := h.db.Q.GetMessage(r.Context(), id)
	if db.IsNotFound(err) || (err == nil && m.RoomID != roomID) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	out, err := h.withDetails(r, []sqlc.Message{m})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out[0])
	return nil
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.ReadAccess(r, roomID) // history: archived temporary rooms too (ADR-0044)
	if err != nil {
		return err
	}
	since, err := h.clearedBefore(r, acc, roomID)
	if err != nil {
		return err
	}
	if r.URL.Query().Has("q") {
		return h.search(w, r, []uuid.UUID{roomID}, nil, since)
	}
	p, err := ParsePage(r)
	if err != nil {
		return err
	}
	var ms []sqlc.Message
	if p.After != nil {
		after := *p.After
		if since != nil && bytes.Compare(after[:], since[:]) < 0 {
			after = *since
		}
		ms, err = h.db.Q.ListMessagesAfter(r.Context(), sqlc.ListMessagesAfterParams{RoomID: roomID, After: after, Lim: p.Limit + 1})
	} else {
		ms, err = h.db.Q.ListMessagesBefore(r.Context(), sqlc.ListMessagesBeforeParams{RoomID: roomID, Before: p.Before, Since: since, Lim: p.Limit + 1})
	}
	if err != nil {
		return err
	}
	more := len(ms) > int(p.Limit)
	if more {
		ms = ms[:p.Limit]
	}
	out, err := h.withDetails(r, ms)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListMessagesResponse{Messages: out, HasMore: more})
	return nil
}

// clearedBefore is the caller's «Удалить чат» mark in a DM (docs/09 item 51): they see only
// messages after it. nil = the whole history (never cleared, or not a DM).
func (h *Handlers) clearedBefore(r *http.Request, acc perm.RoomAccess, roomID uuid.UUID) (*uuid.UUID, error) {
	if !acc.DM || acc.Notes { // a notes shelf is never cleared (ADR-0039)
		return nil, nil
	}
	id, err := h.db.Q.GetDMClearedBefore(r.Context(), sqlc.GetDMClearedBeforeParams{UserID: uid(r), RoomID: roomID})
	if err != nil || id == uuid.Nil {
		return nil, err
	}
	return &id, nil
}

// ValidateContent checks message text; empty text is allowed only with attachments.
func ValidateContent(content string, attachments int) error {
	if utf8.RuneCountInString(content) > MaxContent {
		return httpx.Validation("content", "content must be at most 4000 characters")
	}
	if strings.TrimSpace(content) == "" && attachments == 0 {
		return httpx.Validation("content", "message is empty")
	}
	return nil
}

func parseAttachments(ids []string) ([]uuid.UUID, error) {
	if len(ids) > MaxAttachments {
		return nil, httpx.Validation("attachmentIds", "at most 20 attachments")
	}
	out := make([]uuid.UUID, 0, len(ids))
	seen := map[uuid.UUID]bool{}
	for _, s := range ids {
		id, err := uuid.Parse(s)
		if err != nil || seen[id] {
			return nil, httpx.Validation("attachmentIds", "invalid or duplicate file id")
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// sameScope reports whether a file may be attached in the room: a workspace room takes
// uploads to its workspace, a DM takes user-scoped uploads (POST /api/dms/{id}/files).
func sameScope(fileWS *uuid.UUID, acc perm.RoomAccess) bool {
	if acc.DM {
		return fileWS == nil
	}
	return fileWS != nil && *fileWS == acc.WorkspaceID
}

func (h *Handlers) existing(ctx context.Context, roomID, author uuid.UUID, nonce string) (*v1.Message, error) {
	m, err := h.db.Q.GetMessageByNonce(ctx, sqlc.GetMessageByNonceParams{AuthorID: author, Nonce: &nonce})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if m.RoomID != roomID || m.DeletedAt != nil {
		return nil, httpx.Conflict("nonce already used")
	}
	out, err := withAttachments(ctx, h.db.Q, []sqlc.Message{m})
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.SendMessages) {
		return httpx.Forbidden("SEND_MESSAGES required")
	}
	var req v1.CreateMessageRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.InlineKeyboard != nil && !auth.MustFromContext(r.Context()).IsBot {
		return httpx.Forbidden("only bots can attach keyboards")
	}
	keyboard, err := encodeKeyboard(req.InlineKeyboard)
	if err != nil {
		return err
	}
	if req.InlineKeyboard != nil && req.GetStickerId() != "" {
		return httpx.Validation("inlineKeyboard", "sticker messages cannot have keyboards")
	}
	fileIDs, err := parseAttachments(req.GetAttachmentIds())
	if err != nil {
		return err
	}
	var sticker *sqlc.GetStickerRow
	if sid := req.GetStickerId(); sid != "" {
		if req.GetContent() != "" || len(fileIDs) > 0 {
			return httpx.Validation("stickerId", "a sticker message has no text or attachments")
		}
		if sticker, err = h.sticker(r.Context(), sid, acc, uid(r)); err != nil {
			return err
		}
	} else if err := ValidateContent(req.GetContent(), len(fileIDs)); err != nil {
		return err
	}
	if len(fileIDs) > 0 && !acc.Bits.Has(perm.AttachFiles) {
		return httpx.Forbidden("ATTACH_FILES required")
	}
	var nonce *string
	if n := req.GetNonce(); n != "" {
		if len(n) > MaxNonce {
			return httpx.Validation("nonce", "nonce must be at most 64 bytes")
		}
		nonce = &n
		// A retry must not be rate limited or create a duplicate.
		if m, err := h.existing(r.Context(), roomID, uid(r), n); err != nil || m != nil {
			if err == nil {
				httpx.Write(w, http.StatusOK, &v1.CreateMessageResponse{Message: m})
			}
			return err
		}
	}
	if err := h.limiter.Take(r.Context(), roomID.String()+":"+uid(r).String()); err != nil {
		return err
	}
	isBot := auth.MustFromContext(r.Context()).IsBot
	if isBot {
		if err := h.botSend(r.Context(), uid(r), acc); err != nil {
			return err
		}
	}
	content := req.GetContent()
	if sticker == nil {
		if content, err = resolveNicks(r.Context(), h.db.Q, content, acc, uid(r)); err != nil { // ADR-0077
			return err
		}
	}
	var replyTo *uuid.UUID
	if s := req.GetReplyToId(); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("replyToId", "invalid message id")
		}
		ref, err := h.db.Q.GetMessage(r.Context(), id)
		if db.IsNotFound(err) || (err == nil && ref.RoomID != roomID) {
			return httpx.Validation("replyToId", "message not found in this room")
		}
		if err != nil {
			return err
		}
		replyTo = &id
	}

	var (
		msg   sqlc.Message
		files []sqlc.File
		dup   bool
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if len(fileIDs) > 0 {
			rows, err := q.GetFilesWithUsage(r.Context(), fileIDs)
			if err != nil {
				return err
			}
			byID := map[uuid.UUID]sqlc.GetFilesWithUsageRow{}
			for _, f := range rows {
				byID[f.ID] = f
			}
			for _, id := range fileIDs {
				f, ok := byID[id]
				if !ok || f.UploaderID != uid(r) || !sameScope(f.WorkspaceID, acc) || f.Attached {
					return httpx.Validation("attachmentIds", "file "+id.String()+" is not an unattached upload of yours in this workspace")
				}
				files = append(files, sqlc.File{
					ID: f.ID, WorkspaceID: f.WorkspaceID, UploaderID: f.UploaderID, Key: f.Key, ThumbnailKey: f.ThumbnailKey,
					Name: f.Name, Mime: f.Mime, Size: f.Size, Width: f.Width, Height: f.Height, Sha256: f.Sha256, CreatedAt: f.CreatedAt,
					VoiceDurationMs: f.VoiceDurationMs, VoiceWaveform: f.VoiceWaveform,
				})
			}
		}
		var err error
		params := sqlc.InsertMessageParams{
			RoomID: roomID, AuthorID: uid(r), Content: content, ReplyToID: replyTo, Nonce: nonce, InlineKeyboard: keyboard,
		}
		if sticker != nil {
			params.StickerID = &sticker.Sticker.ID
		}
		msg, err = q.InsertMessage(r.Context(), params)
		if db.IsNotFound(err) { // concurrent retry with the same nonce won the race
			dup = true
			return nil
		}
		if err != nil {
			return err
		}
		for i, f := range files {
			if err := q.InsertAttachment(r.Context(), sqlc.InsertAttachmentParams{MessageID: msg.ID, FileID: f.ID, Position: int16(i)}); err != nil { //nolint:gosec // ≤ 20
				if db.UniqueViolation(err) != "" {
					return httpx.Conflict("file is already attached to another message")
				}
				return err
			}
		}
		if err := saveMentions(r.Context(), q, msg, acc, false); err != nil {
			return err
		}
		_, err = q.UpsertReadState(r.Context(), sqlc.UpsertReadStateParams{UserID: uid(r), RoomID: roomID, LastReadMessageID: msg.ID})
		return err
	})
	if err != nil {
		return err
	}
	if dup {
		m, err := h.existing(r.Context(), roomID, uid(r), *nonce)
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, &v1.CreateMessageResponse{Message: m})
		return nil
	}
	pb := pbconv.Message(msg, files)
	if sticker != nil {
		pb.Sticker = pbconv.Sticker(sticker.Sticker, sticker.FileSize)
	}
	if acc.DM && !acc.Notes { // docs/09 item 51: an incoming message takes the DM out of the recipient's archive
		states, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) ([]sqlc.DmState, error) {
			return guarded.UnarchiveDMForRecipients(r.Context(), sqlc.UnarchiveDMForRecipientsParams{RoomID: roomID, AuthorID: uid(r)})
		})
		if err != nil {
			return err
		}
		for _, st := range states {
			h.events.User(r.Context(), st.UserID, dms.StateEvent(st))
		}
	}
	ev := pb
	// A bot command (ADR-0031): the event carries it; the gateway and the webhook outbox keep
	// it only for the addressed bot. The author's response is the plain message.
	if cmd := resolveCommand(r.Context(), h.db.Q, acc, roomID, uid(r), isBot, msg.Content); cmd != nil {
		ev = proto.CloneOf(pb)
		ev.Command = cmd
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: ev},
	}})
	if acc.Task && h.TaskHook != nil {
		h.TaskHook(r.Context(), acc, msg)
	}
	h.events.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: roomID.String(), LastReadMessageId: msg.ID.String()}},
	}})
	httpx.Write(w, http.StatusCreated, &v1.CreateMessageResponse{Message: pb})
	return nil
}

// load returns a live message and the caller's access to its room (404 if hidden).
func (h *Handlers) load(r *http.Request) (sqlc.Message, perm.RoomAccess, error) {
	id, err := httpx.PathUUID(r, "id", "message")
	if err != nil {
		return sqlc.Message{}, perm.RoomAccess{}, err
	}
	m, err := h.db.Q.GetMessage(r.Context(), id)
	if db.IsNotFound(err) {
		return m, perm.RoomAccess{}, httpx.NotFound("message")
	}
	if err != nil {
		return m, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, m.RoomID)
	if err != nil {
		return m, acc, httpx.NotFound("message")
	}
	return m, acc, nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) {
		return httpx.Forbidden("only the author can edit a message")
	}
	if m.Kind == pbconv.MessageKindSystem {
		return httpx.Forbidden("system messages cannot be edited")
	}
	if m.StickerID != nil {
		return httpx.Forbidden("sticker messages cannot be edited")
	}
	if m.ForwardSentAt != nil {
		return errNotEditable
	}
	var req v1.UpdateMessageRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.InlineKeyboard != nil && !auth.MustFromContext(r.Context()).IsBot {
		return httpx.Forbidden("only bots can attach keyboards")
	}
	keyboard, err := encodeKeyboard(req.InlineKeyboard)
	if err != nil {
		return err
	}
	// The additive flag preserves the legacy content field and PATCH {} semantics.
	if req.GetPreserveContent() && (req.InlineKeyboard == nil || req.GetContent() != "") {
		return httpx.Validation("preserveContent", "requires a keyboard and no replacement text")
	}
	content := &req.Content
	if req.GetPreserveContent() {
		content = nil
	}
	// Length first (the DB CHECK would otherwise surface as a 500); "empty only with
	// attachments" needs the attachment count and is checked in the transaction.
	if utf8.RuneCountInString(req.GetContent()) > MaxContent {
		return httpx.Validation("content", "content must be at most 4000 characters")
	}
	if content != nil {
		resolved, err := resolveNicks(r.Context(), h.db.Q, *content, acc, uid(r)) // ADR-0077
		if err != nil {
			return err
		}
		content = &resolved
	}
	var out []*v1.Message
	var edited sqlc.Message
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		upd, err := q.UpdateMessageContent(r.Context(), sqlc.UpdateMessageContentParams{ID: m.ID, Content: content, SetKeyboard: req.InlineKeyboard != nil, InlineKeyboard: keyboard})
		if db.IsNotFound(err) {
			return httpx.NotFound("message")
		}
		if err != nil {
			return err
		}
		edited = upd
		if out, err = withAttachments(r.Context(), q, []sqlc.Message{upd}); err != nil {
			return err
		}
		if err := saveMentions(r.Context(), q, upd, acc, true); err != nil {
			return err
		}
		return ValidateContent(upd.Content, len(out[0].GetAttachments())) // rolls back if empty
	})
	if err != nil {
		return err
	}
	full, err := h.details(r.Context(), []sqlc.Message{{ID: parseMsgID(out[0])}}, uid(r))
	if err != nil {
		return err
	}
	out[0].Reactions = full[0].GetReactions()
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: forEvent(out[0])},
	}})
	if acc.Task && h.TaskCommentHook != nil {
		h.TaskCommentHook(r.Context(), acc, "updated", edited, uid(r))
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateMessageResponse{Message: out[0]})
	return nil
}

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) && !acc.Bits.Has(perm.ManageMessages) {
		return httpx.Forbidden("MANAGE_MESSAGES required to delete others' messages")
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		n, err := q.SoftDeleteMessage(r.Context(), m.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("message")
		}
		if err := clearMentions(r.Context(), q, m.ID); err != nil {
			return err
		}
		// Detached files become orphans and are removed by the cleanup job.
		return q.DetachMessageFiles(r.Context(), m.ID)
	})
	if err != nil {
		return err
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageDelete{
		MessageDelete: &v1.MessageDelete{WorkspaceId: rooms.WorkspaceIDString(acc), RoomId: m.RoomID.String(), MessageId: m.ID.String()},
	}})
	if acc.Task && h.TaskCommentHook != nil {
		h.TaskCommentHook(r.Context(), acc, "deleted", m, uid(r))
	}
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) read(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	var req v1.UpdateReadStateRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	mid, err := uuid.Parse(req.GetMessageId())
	if err != nil {
		return httpx.Validation("messageId", "invalid message id")
	}
	m, err := h.db.Q.GetMessage(r.Context(), mid)
	if db.IsNotFound(err) || (err == nil && m.RoomID != roomID) {
		return httpx.Validation("messageId", "message not found in this room")
	}
	if err != nil {
		return err
	}
	rs, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.AdvanceReadStateRow, error) {
		return guarded.AdvanceReadState(r.Context(), sqlc.AdvanceReadStateParams{UserID: uid(r), RoomID: roomID, MessageID: mid})
	})
	if err != nil {
		return err
	}
	// Read receipts (docs/09 #92): only when the marker moved, never for a bot's reads.
	if h.Receipts != nil && rs.Advanced && !auth.MustFromContext(r.Context()).IsBot {
		h.Receipts.afterRead(r.Context(), acc, roomID, uid(r), rs.LastReadMessageID)
	}
	h.events.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: roomID.String(), LastReadMessageId: rs.LastReadMessageID.String()}},
	}})
	httpx.NoContent(w)
	return nil
}

// setEmbedsHidden hides or shows the link previews of a message (author, or
// MANAGE_MESSAGES). The message is not marked edited; the room gets MESSAGE_UPDATE.
func (h *Handlers) setEmbedsHidden(w http.ResponseWriter, r *http.Request) error {
	m, acc, err := h.load(r)
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) && !acc.Bits.Has(perm.ManageMessages) {
		return httpx.Forbidden("only the author or MANAGE_MESSAGES can hide link previews")
	}
	var req v1.SetEmbedsHiddenRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	upd, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.Message, error) {
		return guarded.SetEmbedsHidden(r.Context(), sqlc.SetEmbedsHiddenParams{ID: m.ID, EmbedsHidden: req.GetHidden()})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	out, err := h.details(r.Context(), []sqlc.Message{upd}, uid(r))
	if err != nil {
		return err
	}
	rooms.Publish(r.Context(), h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageUpdate{
		MessageUpdate: &v1.MessageUpdate{WorkspaceId: rooms.WorkspaceIDString(acc), Message: forEvent(out[0])},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMessageResponse{Message: out[0]})
	return nil
}
