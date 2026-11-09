package messages

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// maxMentions caps the direct mentions stored per message.
const maxMentions = 50

var (
	// A mention starts at a non-word boundary: "mail@x" is not one.
	mentionRE   = regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{N}_.@-])@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|everyone|here)\b`)
	codeBlockRE = regexp.MustCompile("(?s)```.*?```")
	codeSpanRE  = regexp.MustCompile("`[^`\n]*`")
)

// ParseMentions extracts mentions from message text: @<user_id> tokens (the client
// renders them as names) and @everyone / @here. Code blocks and spans are ignored.
func ParseMentions(content string) (users []uuid.UUID, everyone bool) {
	text := codeSpanRE.ReplaceAllString(codeBlockRE.ReplaceAllString(content, " "), " ")
	seen := map[uuid.UUID]bool{}
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		tok := strings.ToLower(m[1])
		if tok == "everyone" || tok == "here" {
			everyone = true
			continue
		}
		id, err := uuid.Parse(tok)
		if err != nil || seen[id] || len(users) >= maxMentions {
			continue
		}
		seen[id] = true
		users = append(users, id)
	}
	return users, everyone
}

// saveMentions (re)writes a message's mention rows inside the create/edit transaction.
// @everyone / @here count only with MENTION_EVERYONE in the room (owner/admin by default,
// others via overrides); without it they stay plain text.
func saveMentions(ctx context.Context, q *sqlc.Queries, msg sqlc.Message, acc perm.RoomAccess, replace bool) error {
	if replace {
		if err := clearMentions(ctx, q, msg.ID); err != nil {
			return err
		}
	}
	if acc.DM {
		return nil // every DM message notifies its recipient like a mention (ADR-0020): no rows
	}
	users, everyone := ParseMentions(msg.Content)
	if len(users) > 0 {
		if err := q.InsertMentions(ctx, sqlc.InsertMentionsParams{
			MessageID: msg.ID, RoomID: msg.RoomID, UserIds: users, WorkspaceID: acc.WorkspaceID, AuthorID: msg.AuthorID,
		}); err != nil {
			return err
		}
	}
	if everyone && acc.Bits.Has(perm.MentionEveryone) {
		return q.InsertEveryoneMention(ctx, sqlc.InsertEveryoneMentionParams{MessageID: msg.ID, RoomID: msg.RoomID})
	}
	return nil
}

func clearMentions(ctx context.Context, q *sqlc.Queries, id uuid.UUID) error {
	if err := q.DeleteMentions(ctx, id); err != nil {
		return err
	}
	return q.DeleteEveryoneMention(ctx, id)
}

// listMentions: GET /api/me/mentions?before=&limit=&workspace_id= — messages mentioning the
// caller in rooms the caller can view now, newest first.
func (h *Handlers) listMentions(w http.ResponseWriter, r *http.Request) error {
	p, err := ParsePage(r)
	if err != nil {
		return err
	}
	if p.After != nil {
		return httpx.BadRequest("only before is supported")
	}
	var only *uuid.UUID
	if s := r.URL.Query().Get("workspace_id"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.BadRequest("workspace_id must be a workspace id")
		}
		only = &id
	}
	me := uid(r)
	wss, err := h.db.Q.ListUserWorkspaces(r.Context(), me)
	if err != nil {
		return err
	}
	var roomIDs []uuid.UUID
	for _, ws := range wss {
		if only != nil && ws.ID != *only {
			continue
		}
		if err := perm.CheckAccess(r.Context(), ws.ID, me); err != nil {
			if httpx.AsError(err).Status >= 500 {
				return err
			}
			continue
		}
		m, err := perm.FromContext(r.Context()).Member(r.Context(), ws.ID, me)
		if err != nil {
			return err
		}
		ids, err := rooms.VisibleIDs(r.Context(), h.db.Q, ws, m)
		if err != nil {
			return err
		}
		roomIDs = append(roomIDs, ids...)
	}
	out := &v1.ListMessagesResponse{Messages: []*v1.Message{}}
	if len(roomIDs) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	ms, err := h.db.Q.ListMentions(r.Context(), sqlc.ListMentionsParams{UserID: me, RoomIds: roomIDs, Before: p.Before, Lim: p.Limit + 1})
	if err != nil {
		return err
	}
	out.HasMore = len(ms) > int(p.Limit)
	if out.HasMore {
		ms = ms[:p.Limit]
	}
	if out.Messages, err = h.withDetails(r, ms); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// maxDismiss caps the ids of each kind in one POST /api/me/inbox/dismiss.
const maxDismiss = 100

// dismissInbox: POST /api/me/inbox/dismiss (CBF-155, ADR-0163) — the ✕ on «Упоминания» cards.
// Chat mentions get a dismissal row (the list skips them for good); task notices leave the
// caller's own history. Both are the caller's own rows: an unknown or foreign id changes
// nothing and is not reported. INBOX_DISMISS then goes to the caller's sessions.
func (h *Handlers) dismissInbox(w http.ResponseWriter, r *http.Request) error {
	var req v1.InboxDismiss
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	msgs, err := dismissIDs(req.GetMessageIds(), "messageIds")
	if err != nil {
		return err
	}
	notices, err := dismissIDs(req.GetNoticeIds(), "noticeIds")
	if err != nil {
		return err
	}
	if len(msgs) == 0 && len(notices) == 0 {
		return httpx.Validation("messageIds", "nothing to dismiss")
	}
	me := uid(r)
	if err := db.GuardExec(r.Context(), h.db, func(guarded *sqlc.Queries) error {
		if len(msgs) > 0 {
			if err := guarded.DismissMentions(r.Context(), sqlc.DismissMentionsParams{UserID: me, MessageIds: msgs}); err != nil {
				return err
			}
		}
		if len(notices) > 0 {
			return guarded.DismissTaskNotices(r.Context(), sqlc.DismissTaskNoticesParams{UserID: me, Ids: notices})
		}
		return nil
	}); err != nil {
		return err
	}
	ev := &v1.InboxDismiss{MessageIds: make([]string, len(msgs)), NoticeIds: make([]string, len(notices))}
	for i, id := range msgs {
		ev.MessageIds[i] = id.String()
	}
	for i, id := range notices {
		ev.NoticeIds[i] = id.String()
	}
	h.events.User(context.WithoutCancel(r.Context()), me, &v1.DispatchEvent{Event: &v1.DispatchEvent_InboxDismiss{InboxDismiss: ev}})
	httpx.NoContent(w)
	return nil
}

// dismissIDs: up to maxDismiss distinct ids.
func dismissIDs(in []string, field string) ([]uuid.UUID, error) {
	if len(in) > maxDismiss {
		return nil, httpx.Validation(field, "too many ids")
	}
	out := make([]uuid.UUID, 0, len(in))
	seen := map[uuid.UUID]bool{}
	for _, s := range in {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, httpx.Validation(field, "invalid id")
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}
