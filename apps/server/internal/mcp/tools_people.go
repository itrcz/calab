package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// CBF-188: people (read person=, read room= members=true), what was written to me (inbox),
// a message to a person (send_message to=) and reactions (react).

// ---- read person ----

// findMember resolves a person (me, id, name, nickname) in ws, or in the caller's first
// workspace where the person is a member.
func findMember(ctx context.Context, c *api, ws, ref string) (string, string, error) {
	wss, err := workspaceIDs(ctx, c, ws)
	if err != nil {
		return "", "", err
	}
	var miss error
	for _, w := range wss {
		id, err := resolveUser(ctx, c, w, ref)
		if err == nil {
			return w, id, nil
		}
		var ae *apiError
		if len(wss) > 1 && (strings.HasPrefix(err.Error(), "no member") || errors.As(err, &ae) && (ae.status == http.StatusForbidden || ae.status == http.StatusNotFound)) {
			miss = err
			continue
		}
		return "", "", err
	}
	if miss == nil {
		miss = errors.New("no member " + strconv.Quote(ref))
	}
	return "", "", miss
}

func readPerson(ctx context.Context, c *api, a args) (any, error) {
	ws, id, err := findMember(ctx, c, a.Workspace, a.Person)
	if err != nil {
		return nil, err
	}
	var r v1.GetMemberResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/members/"+seg(id), nil, nil, &r); err != nil {
		return nil, err
	}
	if a.Full {
		return raw(&r)
	}
	m, u := r.GetMember(), r.GetMember().GetUser()
	out := map[string]any{"id": u.GetId(), "name": u.GetDisplayName(), "username": u.GetUsername(), "nick": m.GetNickname(),
		"role": enum(m.GetRole().String(), "WORKSPACE_ROLE_"), "timezone": u.GetTimezone(), "bot": u.GetIsBot(), "guest": u.GetIsGuest(),
		"email": u.GetEmail(), "phone": u.GetPhone(), "extension": m.GetExtension(), "workspace": ws}
	if s := strings.TrimSpace(u.GetStatusEmoji() + " " + u.GetStatusText()); s != "" {
		out["status"] = s
		if u.GetStatusExpiresAt() != nil {
			out["status_until"] = ts(u.GetStatusExpiresAt())
		}
	}
	if loc, err := time.LoadLocation(u.GetTimezone()); err == nil && u.GetTimezone() != "" {
		out["local_time"] = time.Now().In(loc).Format("Mon 15:04")
	}
	if m.GetJoinedAt() != nil {
		out["joined"] = m.GetJoinedAt().AsTime().UTC().Format(time.DateOnly)
	}
	// Custom roles by name (the built-in one is "role"); a refusal only loses the names.
	var rr v1.ListRolesResponse
	if len(m.GetRoleIds()) > 0 && c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/roles", nil, nil, &rr) == nil {
		var names []string
		for _, role := range rr.GetRoles() {
			if role.GetBuiltin() == v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED && slices.Contains(m.GetRoleIds(), role.GetId()) {
				names = append(names, role.GetName())
			}
		}
		out["roles"] = names
	}
	var tasks []map[string]any
	for _, t := range r.GetOpenTasks() {
		if len(tasks) == 10 {
			break
		}
		tasks = append(tasks, map[string]any{"key": t.GetKey(), "title": t.GetTitle()})
	}
	out["open_tasks"] = tasks
	if n := len(r.GetOpenTasks()); n > len(tasks) {
		out["open_tasks_total"] = n
	}
	return compact(out), nil
}

// ---- read room members=true ----

// maxMembers caps the people listed for a room.
const maxMembers = 100

// roomMembers lists who can view the room: the members of its workspace whose permissions in
// it (perm.ComputeIn — the one room-permission rule — over the roles and the room's overrides
// read through the API) include VIEW_ROOM. A DM: its two people; notes: the caller; a task's
// comments follow its board (read the task).
func roomMembers(ctx context.Context, c *api, room *v1.Room) ([]map[string]any, int, error) {
	switch room.GetType() {
	case v1.RoomType_ROOM_TYPE_TASK:
		return nil, 0, errors.New("a task's comments are open to whoever sees its board: read the task (assignees, approvers)")
	case v1.RoomType_ROOM_TYPE_DM, v1.RoomType_ROOM_TYPE_NOTES:
		me, err := caller(ctx, c)
		if err != nil {
			return nil, 0, err
		}
		out := []map[string]any{{"id": me.id}}
		if room.GetType() == v1.RoomType_ROOM_TYPE_DM {
			var dms v1.ListDmsResponse
			if err := c.call(ctx, http.MethodGet, "/api/dms", nil, nil, &dms); err != nil {
				return nil, 0, err
			}
			for _, d := range dms.GetDms() {
				if d.GetRoom().GetId() == room.GetId() {
					out = append(out, compact(map[string]any{"id": d.GetPeer().GetId(), "name": d.GetPeer().GetDisplayName(), "bot": d.GetPeer().GetIsBot()}))
				}
			}
		}
		return out, len(out), nil
	}
	ws := room.GetWorkspaceId()
	var wr v1.ListWorkspacesResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces", nil, nil, &wr); err != nil {
		return nil, 0, err
	}
	seesPrivate := false
	for _, w := range wr.GetWorkspaces() {
		if w.GetId() == ws {
			seesPrivate = w.GetOwnerSeesPrivate()
		}
	}
	var roles v1.ListRolesResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/roles", nil, nil, &roles); err != nil {
		return nil, 0, err
	}
	byID := map[string]perm.RoleBits{}
	for _, r := range roles.GetRoles() {
		byID[r.GetId()] = perm.RoleBits{ID: r.GetId(), Position: r.GetPosition(), Permissions: perm.Bits(r.GetPermissions())}
	}
	var ms v1.ListMembersResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/members", nil, nil, &ms); err != nil {
		return nil, 0, err
	}
	// the same conversions the server's own room permissions use (rooms, workspaces)
	flags, ovs := pbconv.RoomFlags(room), pbconv.ProtoOverrideTargets(room.GetPermissionOverrides())
	var out []map[string]any
	total := 0
	for _, m := range ms.GetMembers() {
		role, ok := perm.RoleFromProto(m.GetRole())
		if !ok {
			continue
		}
		var rbs []perm.RoleBits
		for _, id := range m.GetRoleIds() {
			if rb, ok := byID[id]; ok {
				rbs = append(rbs, rb)
			}
		}
		pm := perm.NewMember(m.GetUser().GetId(), role, rbs)
		pm.OwnerSeesPrivate = seesPrivate
		if !perm.ComputeIn(pm, flags, ovs).Has(perm.ViewRoom) {
			continue
		}
		total++
		if len(out) < maxMembers {
			out = append(out, compact(map[string]any{"id": m.GetUser().GetId(), "name": m.GetUser().GetDisplayName(), "nick": m.GetNickname(),
				"bot": m.GetUser().GetIsBot(), "guest": m.GetUser().GetIsGuest()}))
		}
	}
	return out, total, nil
}

// ---- inbox ----

func inbox(ctx context.Context, c *api, a args) (any, error) {
	limit := clamp(a.Limit, 20, 50)
	out := map[string]any{}
	if a.Before == "" { // unread DMs on the first page only
		var dms v1.ListDmsResponse
		if err := c.call(ctx, http.MethodGet, "/api/dms", nil, nil, &dms); err != nil {
			return nil, err
		}
		list := slices.DeleteFunc(slices.Clone(dms.GetDms()), func(d *v1.DmSummary) bool { return d.GetReadState().GetUnreadCount() == 0 })
		slices.SortFunc(list, func(x, y *v1.DmSummary) int {
			return y.GetLastMessageAt().AsTime().Compare(x.GetLastMessageAt().AsTime())
		})
		var unread []map[string]any
		for _, d := range list[:min(len(list), limit)] {
			p := d.GetPeer()
			unread = append(unread, compact(map[string]any{"room": d.GetRoom().GetId(), "from": compact(map[string]any{"id": p.GetId(), "name": p.GetDisplayName()}),
				"unread": d.GetReadState().GetUnreadCount(), "last": d.GetLastMessage().GetContent(), "at": ts(d.GetLastMessageAt())}))
		}
		if unread != nil {
			out["dms"] = unread
		}
	}
	qs := url.Values{"limit": {strconv.Itoa(limit)}}
	if a.Before != "" {
		qs.Set("before", a.Before)
	}
	if a.Workspace != "" {
		qs.Set("workspace_id", strings.TrimSpace(a.Workspace))
	}
	var ms v1.ListMessagesResponse
	if err := c.call(ctx, http.MethodGet, "/api/me/mentions", qs, nil, &ms); err != nil {
		return nil, err
	}
	var mentions []map[string]any
	for _, m := range ms.GetMessages() {
		x := message(m)
		x["room"] = m.GetRoomId()
		mentions = append(mentions, x)
	}
	if mentions != nil {
		out["mentions"] = mentions
		out["more"] = ms.GetHasMore()
	}
	if len(out) == 0 {
		return map[string]any{"found": 0}, nil
	}
	return compact(out), nil
}

// ---- send_message to= ----

// dmWith opens (or reuses) the DM with a person (me is refused: notes are not a DM).
func dmWith(ctx context.Context, c *api, ws, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if strings.EqualFold(strings.TrimPrefix(ref, "@"), "me") {
		return "", errors.New("to: a DM is with another person")
	}
	id := ref
	if _, err := uuid.Parse(ref); err != nil {
		if _, id, err = findMember(ctx, c, ws, ref); err != nil {
			return "", err
		}
	}
	var r v1.CreateDmResponse
	if err := c.call(ctx, http.MethodPost, "/api/dms", nil, &v1.CreateDmRequest{UserId: id}, &r); err != nil {
		return "", err
	}
	return r.GetDm().GetRoom().GetId(), nil
}

// ---- react ----

func react(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("message", a.Message), need("emoji", a.Emoji)); err != nil {
		return nil, err
	}
	method := http.MethodPut
	switch a.Mode {
	case "", "add":
	case "remove":
		method = http.MethodDelete
	default:
		return nil, errors.New("mode must be add or remove")
	}
	path := "/api/messages/" + seg(a.Message) + "/reactions/" + seg(a.Emoji)
	if err := c.call(ctx, method, path, nil, nil, nil); err != nil {
		return nil, err
	}
	return map[string]any{"message": a.Message, "emoji": strings.TrimSpace(a.Emoji), "reacted": method == http.MethodPut}, nil
}
