package messages

import (
	"bytes"
	"context"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Reasons of 422 VALIDATION errors about forwarding (ApiError.reason, ADR-0033).
const (
	ReasonNotForwardable     = "NOT_FORWARDABLE"
	ReasonMessageNotEditable = "MESSAGE_NOT_EDITABLE"
)

var (
	errNotForwardable = httpx.Validation("messageId", "this message cannot be forwarded").WithDetails(ReasonNotForwardable, 0, 0)
	errNotEditable    = httpx.Validation("content", "a forwarded message cannot be edited").WithDetails(ReasonMessageNotEditable, 0, 0)
)

// forward: POST /api/rooms/{id}/messages/{mid}/forward (ADR-0033). The copy is a new message of
// the caller in to_room_id: the source needs VIEW_ROOM (a restricted room does not forbid it),
// the target the rights of sending there. Attachments are the same files (no quota), the
// recording card keeps following its original (System.Update), mentions are not stored.
func (h *Handlers) forward(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	mid, err := httpx.PathUUID(r, "mid", "message")
	if err != nil {
		return err
	}
	src, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	m, err := h.db.Q.GetMessage(ctx, mid)
	if db.IsNotFound(err) || (err == nil && m.RoomID != roomID) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	since, err := h.clearedBefore(r, src, roomID)
	if err != nil {
		return err
	}
	if since != nil && bytes.Compare(m.ID[:], since[:]) <= 0 { // the caller cleared this DM history
		return httpx.NotFound("message")
	}
	var req v1.ForwardMessageRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	toID, err := uuid.Parse(req.GetToRoomId())
	if err != nil {
		return httpx.Validation("toRoomId", "invalid room id")
	}
	dst, err := rooms.Access(r, toID)
	if err != nil {
		return err
	}
	if !dst.Bits.Has(perm.SendMessages) {
		return httpx.Forbidden("SEND_MESSAGES required")
	}
	if err := h.forwardable(ctx, m, src); err != nil {
		return err
	}
	atts, err := h.db.Q.ListAttachments(ctx, []uuid.UUID{m.ID})
	if err != nil {
		return err
	}
	if len(atts) > 0 && m.Kind != pbconv.MessageKindSystem && !dst.Bits.Has(perm.AttachFiles) {
		return httpx.Forbidden("ATTACH_FILES required")
	}
	me := uid(r)
	if err := h.limiter.Take(ctx, toID.String()+":"+me.String()); err != nil {
		return err
	}
	if auth.MustFromContext(ctx).IsBot {
		if err := h.botSend(ctx, me, dst); err != nil {
			return err
		}
	} else if err := h.personSend(ctx, me, dst); err != nil {
		return err
	}
	via := auth.ViaBot(ctx) // ADR-0106
	if err := h.botOnBehalf(ctx, via); err != nil {
		return err
	}

	// A copy of a copy points at the original (one level), keeping its author and time.
	origin, author, sentAt := &m.ID, &m.AuthorID, &m.CreatedAt
	if m.ForwardSentAt != nil {
		origin, author, sentAt = m.ForwardedFrom, m.ForwardAuthorID, m.ForwardSentAt
	}
	var msg sqlc.Message
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		if m.Kind == pbconv.MessageKindSystem {
			// A recording card changes meanwhile (status, audio): take the payload as of the lock, so the
			// copy is not left with a stale one that no later update reaches.
			fresh, err := q.GetMessageShared(ctx, m.ID)
			if err != nil {
				return err
			}
			m.Payload = fresh.Payload
		}
		var err error
		msg, err = q.InsertForwardedMessage(ctx, sqlc.InsertForwardedMessageParams{
			RoomID: toID, AuthorID: me, Content: m.Content, StickerID: m.StickerID, EmbedsHidden: m.EmbedsHidden,
			Kind: m.Kind, Payload: m.Payload, ForwardedFrom: origin, ForwardAuthorID: author, ForwardSentAt: sentAt,
			ViaBotID: via,
		})
		if err != nil {
			return err
		}
		// Read again here, not from atts: a recording card may get its audio meanwhile.
		if err := q.CopyAttachments(ctx, sqlc.CopyAttachmentsParams{ToID: msg.ID, FromID: m.ID}); err != nil {
			return err
		}
		_, err = q.UpsertReadState(ctx, sqlc.UpsertReadStateParams{UserID: me, RoomID: toID, LastReadMessageID: msg.ID})
		return err
	})
	if err != nil {
		return err
	}
	out, err := h.details(ctx, []sqlc.Message{msg}, uuid.Nil)
	if err != nil {
		return err
	}
	pb := out[0]
	if dst.DM && !dst.Notes { // docs/09 item 51: an incoming message takes the DM out of the recipient's archive
		states, err := db.GuardValue(ctx, h.db, func(guarded *sqlc.Queries) ([]sqlc.DmState, error) {
			return guarded.UnarchiveDMForRecipients(ctx, sqlc.UnarchiveDMForRecipientsParams{RoomID: toID, AuthorID: me})
		})
		if err != nil {
			return err
		}
		for _, st := range states {
			h.events.User(ctx, st.UserID, dms.StateEvent(st))
		}
	}
	rooms.Publish(ctx, h.events, dst, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{WorkspaceId: rooms.WorkspaceIDString(dst), Message: pb},
	}})
	if dst.Task && h.TaskHook != nil {
		h.TaskHook(ctx, dst, msg)
	}
	h.events.User(ctx, me, &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: toID.String(), LastReadMessageId: msg.ID.String()}},
	}})
	httpx.Write(w, http.StatusCreated, &v1.ForwardMessageResponse{Message: pb})
	return nil
}

// forwardable refuses what is not copied (ADR-0033 §2): a bot command (it would reach no bot
// and carry someone's arguments) and system messages other than a recording card.
func (h *Handlers) forwardable(ctx context.Context, m sqlc.Message, src perm.RoomAccess) error {
	if m.Kind == pbconv.MessageKindSystem {
		var sys v1.SystemMessage
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(m.Payload, &sys); err != nil || sys.GetRecording() == nil {
			return errNotForwardable
		}
		return nil
	}
	if m.ForwardSentAt != nil {
		return nil // a copy never was a command
	}
	if _, _, _, ok := ParseCommand(m.Content); !ok {
		return nil
	}
	_, err := h.db.Q.GetBot(ctx, m.AuthorID)
	authorIsBot := err == nil
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	if resolveCommand(ctx, h.db.Q, src, m.RoomID, m.AuthorID, authorIsBot, m.Content) != nil {
		return errNotForwardable
	}
	return nil
}

// botSend applies the limits of a bot's message (ADR-0031): a person may block it in a DM,
// and BOT_MESSAGES_PER_MIN.
// botOnBehalf charges a message written on behalf of a bot's owner (via non-nil) to the bot's
// message limit (ADR-0106 §6); the owner's own limits apply as to any message of theirs.
func (h *Handlers) botOnBehalf(ctx context.Context, via *uuid.UUID) error {
	if via == nil || h.BotLimiter == nil {
		return nil
	}
	return h.BotLimiter.Take(ctx, via.String())
}

// personSend refuses a person writing into a DM when either side blocked the other (ADR-0154).
func (h *Handlers) personSend(ctx context.Context, me uuid.UUID, acc perm.RoomAccess) error {
	if !acc.DM {
		return nil
	}
	for _, u := range acc.Members {
		if u != me {
			if err := dms.CheckPersonDM(ctx, h.db.Q, me, u); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *Handlers) botSend(ctx context.Context, bot uuid.UUID, acc perm.RoomAccess) error {
	if acc.DM {
		for _, u := range acc.Members {
			if u != bot {
				if err := dms.CheckBotDM(ctx, h.db.Q, bot, u); err != nil {
					return err
				}
			}
		}
	}
	if h.BotLimiter != nil {
		return h.BotLimiter.Take(ctx, bot.String())
	}
	return nil
}
