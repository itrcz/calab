package app

import "github.com/calaba/calaba/server/internal/plans"

// planInactiveRoutes are the routes the restricted mode refuses («тариф не активен», ADR-0086
// amendment, owner 10.10): a stopped plan whose paid days ran out while the workspace used more
// than Free allows. identityGate refuses them with 403 WORKSPACE_PLAN_INACTIVE for everyone in
// the workspace — the owner, admins and bots too — once the route's workspace is resolved
// (rooms, messages, boards, invite codes). DMs and notes have no workspace and stay open.
//
// Everything else stays: reading, search, export, deleting messages and files, removing
// reactions, leaving and moderating voice, members / bots / roles / settings, rooms and boards
// editing and deleting, tasks editing, calendar, and the billing routes — what the owner needs
// to fit Free or pay. The voice room cap (2) and the audio-only LiveKit grants are in rtc
// (plans.Info.Lapsed). TestPlanInactiveRoutesClassified keeps the table in sync with the routes.
var planInactiveRoutes = map[string]string{
	// writing (messages, threads, reactions, pins, bot buttons)
	"POST /api/rooms/{id}/messages":               plans.RestrictedSend,
	"POST /api/rooms/{id}/messages/{mid}/forward": plans.RestrictedSend,
	"PATCH /api/messages/{id}":                    plans.RestrictedSend,
	"PUT /api/messages/{id}/reactions/{emoji}":    plans.RestrictedSend,
	"PUT /api/messages/{id}/pin":                  plans.RestrictedSend,
	"POST /api/messages/{id}/interactions":        plans.RestrictedSend,
	// files
	"POST /api/workspaces/{id}/files": plans.RestrictedUpload,
	"POST /api/boards/{id}/files":     plans.RestrictedUpload,
	// invitations, guests and joining (growth is pointless until the plan is active)
	"POST /api/workspaces/{id}/invites":                  plans.RestrictedInvite,
	"POST /api/workspaces/{id}/invites/email":            plans.RestrictedInvite,
	"POST /api/workspaces/{id}/members":                  plans.RestrictedInvite,
	"POST /api/workspaces/{id}/members/{userId}/promote": plans.RestrictedInvite,
	"POST /api/workspaces/{id}/join":                     plans.RestrictedInvite,
	"POST /api/invites/{code}/join":                      plans.RestrictedInvite,
	"POST /api/rooms/{id}/invites":                       plans.RestrictedInvite,
	"PATCH /api/rooms/{id}/invites/{inviteId}":           plans.RestrictedInvite,
	"POST /api/room-invites/{code}/join":                 plans.RestrictedInvite,
	"POST /api/rooms/{id}/admissions/{userId}":           plans.RestrictedInvite,
	// new rooms, boards, tasks, bots, stickers, sounds
	"POST /api/workspaces/{id}/rooms":         plans.RestrictedCreate,
	"POST /api/workspaces/{id}/rooms/temp":    plans.RestrictedCreate,
	"POST /api/workspaces/{id}/boards":        plans.RestrictedCreate,
	"POST /api/boards/{id}/tasks":             plans.RestrictedCreate,
	"POST /api/checklist-items/{id}/convert":  plans.RestrictedCreate, // a subtask is a new task
	"POST /api/workspaces/{id}/bots":          plans.RestrictedCreate,
	"POST /api/workspaces/{id}/bots/add":      plans.RestrictedCreate,
	"POST /api/workspaces/{id}/sticker-packs": plans.RestrictedCreate,
	"POST /api/sticker-packs/{id}/stickers":   plans.RestrictedCreate,
	"POST /api/workspaces/{id}/sounds":        plans.RestrictedCreate,
	// integrations: apps, GPTunneL, bot tokens, board webhooks / Git / rules / forms, telephony
	"POST /api/workspaces/{id}/apps":                  plans.RestrictedConnect,
	"POST /api/workspaces/{id}/integrations/gptunnel": plans.RestrictedConnect,
	"POST /api/workspaces/{id}/bots/{botId}/token":    plans.RestrictedConnect,
	"PUT /api/boards/{id}/webhook":                    plans.RestrictedConnect,
	"PUT /api/boards/{id}/git":                        plans.RestrictedConnect,
	"POST /api/boards/{id}/rules":                     plans.RestrictedConnect,
	"POST /api/boards/{id}/forms":                     plans.RestrictedConnect,
	"PUT /api/boards/{id}/forms/{fid}":                plans.RestrictedConnect,
	"PUT /api/workspaces/{id}/sip":                    plans.RestrictedConnect,
	"POST /api/workspaces/{id}/sip/test":              plans.RestrictedConnect,
	"POST /api/rooms/{id}/calls":                      plans.RestrictedConnect,
	// voice: audio only (the LiveKit grants drop camera / screen too, rtc)
	"POST /api/rooms/{id}/stream/request":              plans.RestrictedMedia,
	"POST /api/rooms/{id}/camera/request":              plans.RestrictedMedia,
	"POST /api/rooms/{id}/voice/{userId}/allow-camera": plans.RestrictedMedia,
	"POST /api/rooms/{id}/recording/start":             plans.RestrictedRecord,
}
