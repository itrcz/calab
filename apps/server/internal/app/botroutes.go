package app

import (
	"log/slog"
	"net/http"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// botAccess says whether a bot token (ADR-0031) may call a route.
type botAccess int

const (
	// botPublic: no authentication; a bot is anonymous there. Public handlers that
	// authenticate themselves (logout, room links) refuse bot tokens (auth.Authenticate).
	botPublic botAccess = iota + 1
	// botAllow: bots use the route like people, within the rights of their roles — the handler's
	// own permission checks are the only gate (ADR-0109).
	botAllow
	// botDeny: people only — 403 FORBIDDEN, reason BOT_NOT_ALLOWED (auth.NoBots), whatever roles
	// the bot has. Kept only for a reason a role cannot lift (ADR-0109 §2).
	botDeny
)

// botRouteGroup is one section of the bot route table: routes with the same access and reason.
type botRouteGroup struct {
	access botAccess
	// why the routes have this access: for botDeny the reason a role cannot lift (required,
	// TestBotRouteGroups), for botAllow what the handlers check.
	why string
	// onBehalf, when set, tags every route of the group in onBehalfRoutes (ADR-0106 §3).
	onBehalf onBehalfAccess
	routes   []string
}

// botRouteGroups classifies every route of the server for bots. Principle (ADR-0031 §1,
// ADR-0051 §1, ADR-0109): a bot is a user whose rights come only from its roles and the
// overrides; a route the handler guards with a permission is botAllow, and the bot gets exactly
// what a member with the same roles gets — "if we gave the bot the right, it can do it".
// botDeny is kept only where a role cannot be the answer: the person's account and identity,
// money, the workspace's ownership, bots managing bots, a person's own decision or private
// data, and voice / guest entry where the bot model differs. Every pattern New registers must be
// listed: TestBotRouteTable fails on an unlisted route, so a new route needs an explicit
// decision; an unlisted pattern is denied to bots at run time. tools/gen-bot-routes.ts reads
// this table for the docs (_routes.json): keep one route per line.
var botRouteGroups = []botRouteGroup{
	// ---------------------------------------------------------------- public
	{access: botPublic, why: "outside the API or before authentication; /gateway takes IDENTIFY with the bot token", routes: []string{
		"GET /healthz",
		"GET /readyz",
		"GET /metrics",
		"GET /gateway",
		"GET /api/version",
		"/api/",
		"POST /api/auth/register",
		"POST /api/auth/login",
		"POST /api/auth/refresh",
		"POST /api/auth/logout",
		"POST /api/auth/password/forgot",
		"POST /api/auth/password/reset",
		"POST /api/mailbox/password/redeem",
	}},
	{access: botPublic, why: "anonymous links: the code is the credential; room links and meeting answers refuse bot tokens, the wiki socket authenticates in band (bot tokens too), the canvas socket in band too and refuses bot tokens, the canvas's public link (ADR-0127 wave 5) is anonymous and receive-only: no token is read at all", routes: []string{
		"GET /api/invites/{code}",
		"GET /api/room-invites/{code}",
		"POST /api/room-invites/{code}/join",
		"GET /api/event-rsvp",
		"POST /api/event-rsvp",
		"GET /api/public/forms/{code}",
		"POST /api/public/forms/{code}/submissions",
		"POST /api/public/forms/{code}/files",
		"GET /api/public/disk/{code}",
		"GET /api/public/disk/{code}/content",
		"GET /api/public/disk/{code}/thumbnail",
		"GET /api/office/file/{token}",
		"POST /api/office/callback/{token}",
		"GET /api/public/wiki/{code}",
		"GET /api/public/wiki/{code}/state",
		"GET /api/public/wiki/{code}/files/{fileId}",
		"GET /api/wiki/pages/{id}/sync",
		"GET /api/canvas/items/{id}/sync",
		"GET /api/public/canvas/{code}",
		"GET /api/public/canvas/{code}/sync",
		"GET /api/stickers/builtin/{name}",
	}},
	{access: botPublic, why: "the IVR worker (ADR-0117 §2): its own bearer token (IVR_AGENT_TOKEN), never a user's or a bot's", routes: []string{
		"GET /api/internal/ivr-agent",
		"GET /api/internal/ivr-agent/files/{id}",
	}},
	{access: botPublic, why: "the SIP registration agent (ADR-0121): its own bearer token (SIPREG_AGENT_TOKEN), never a user's or a bot's", routes: []string{
		"GET /api/internal/sipreg-agent",
	}},
	{access: botPublic, why: "calendar widgets (ADR-0145): the handler accepts only a purpose-bound widget grant for a live human session, never a user's access token or a bot token", routes: []string{
		"GET /api/calendar-widget",
	}},
	{access: botPublic, why: "signed deliveries of LiveKit, the payment providers and the repository hosting; public offers and the checkout return page", routes: []string{
		"POST /api/rtc/webhook",
		"POST /api/billing/stripe/webhook",
		"POST /api/billing/tochka/webhook",
		"POST /api/billing/tochkapay/webhook",
		"POST /api/git/boards/{id}/{provider}",
		"GET /api/billing/public/offers",
		"GET /api/billing/return",
	}},

	// ---------------------------------------------------------------- allow: like people
	{access: botAllow, why: "the bot's own profile: display name and avatar only (users.update refuses the other fields)", routes: []string{
		"GET /api/me",
		"PATCH /api/me",
		"POST /api/me/avatar",
		"GET /api/me/mentions",
	}},
	{access: botAllow, why: "mailbox password recovery (ADR-0101): only the MAILHOST_RESET_BOTS allowlist passes the handlers", routes: []string{
		"POST /api/mailbox/hosting-check",
		"POST /api/mailbox/password-reset",
	}},
	{access: botAllow, why: "workspaces and members by the bits of the roles (ADR-0048, ADR-0051): MANAGE_WORKSPACE, INVITE_MEMBERS (an admin invite — the owner only), MANAGE_MEMBERS / MANAGE_ROLES with the hierarchy, MANAGE_NICKNAMES, MANAGE_STICKERS for sounds", routes: []string{
		"GET /api/workspaces",
		"GET /api/workspaces/{id}",
		"PATCH /api/workspaces/{id}",
		"GET /api/workspaces/{id}/invites",
		"POST /api/workspaces/{id}/invites",
		"DELETE /api/workspaces/{id}/invites/{inviteId}",
		"POST /api/workspaces/{id}/invites/email",
		"GET /api/workspaces/{id}/invites/email",
		"DELETE /api/workspaces/{id}/invites/email/{inviteId}",
		"GET /api/workspaces/{id}/members",
		"GET /api/workspaces/{id}/members/{userId}",
		"GET /api/workspaces/{id}/users",
		"GET /api/workspaces/{id}/former-members",
		"GET /api/workspaces/{id}/birthdays",
		"GET /api/workspaces/{id}/badges",
		"POST /api/workspaces/{id}/badges",
		"PATCH /api/workspaces/{id}/badges/{badgeId}",
		"DELETE /api/workspaces/{id}/badges/{badgeId}",
		"PUT /api/workspaces/{id}/members/{userId}/badge",
		"GET /api/workspaces/{id}/sounds",
		"POST /api/workspaces/{id}/sounds",
		"PATCH /api/workspaces/{id}/sounds/{soundId}",
		"DELETE /api/workspaces/{id}/sounds/{soundId}",
		"PATCH /api/workspaces/{id}/members/{userId}",
		"DELETE /api/workspaces/{id}/members/{userId}",
		"POST /api/workspaces/{id}/members/{userId}/promote",
		"PUT /api/workspaces/{id}/members/{userId}/roles",
		"GET /api/workspaces/{id}/roles",
		"POST /api/workspaces/{id}/roles",
		"PATCH /api/workspaces/{id}/roles/{roleId}",
		"DELETE /api/workspaces/{id}/roles/{roleId}",
		"PUT /api/workspaces/{id}/roles/order",
		"GET /api/workspaces/{id}/bans",
		"POST /api/workspaces/{id}/bans",
		"DELETE /api/workspaces/{id}/bans/{userId}",
		"GET /api/workspaces/{id}/audit",
		"GET /api/workspaces/{id}/achievements",
		"GET /api/workspaces/{id}/members/{userId}/achievements",
	}},
	{access: botAllow, why: "rooms and categories: MANAGE_ROOM, CREATE_TEMP_ROOMS (members-only link, no meeting, ADR-0044), the creator's own archived room", routes: []string{
		"POST /api/workspaces/{id}/rooms",
		"GET /api/workspaces/{id}/rooms",
		"POST /api/workspaces/{id}/rooms/temp",
		"POST /api/rooms/{id}/restore",
		"GET /api/rooms/{id}",
		"PATCH /api/rooms/{id}",
		"DELETE /api/rooms/{id}",
		"PUT /api/rooms/{id}/permissions",
		"GET /api/workspaces/{id}/categories",
		"POST /api/workspaces/{id}/categories",
		"PATCH /api/categories/{id}",
		"DELETE /api/categories/{id}",
		"PUT /api/workspaces/{id}/rooms/order",
	}},
	{access: botAllow, why: "messages, DMs (members of shared workspaces, unless blocked), files and search by VIEW_ROOM / SEND_MESSAGES / MANAGE_MESSAGES (ADR-0033, ADR-0062)", routes: []string{
		"GET /api/rooms/{id}/messages",
		"GET /api/rooms/{id}/messages/{messageId}",
		"GET /api/rooms/{id}/messages/{messageId}/readers", // the author only (ADR-0140)
		"POST /api/rooms/{id}/messages",
		"POST /api/rooms/{id}/messages/{mid}/forward",
		"PATCH /api/messages/{id}",
		"DELETE /api/messages/{id}",
		"PUT /api/rooms/{id}/read",
		"GET /api/workspaces/{id}/messages/search",
		"GET /api/messages/{id}/reactions/{emoji}",
		"PUT /api/messages/{id}/reactions/{emoji}",
		"DELETE /api/messages/{id}/reactions/{emoji}",
		"PUT /api/messages/{id}/pin",
		"DELETE /api/messages/{id}/pin",
		"GET /api/rooms/{id}/pins",
		"PUT /api/messages/{id}/embeds-hidden",
		"POST /api/dms",
		"GET /api/dms",
		"GET /api/dms/candidates",
		"POST /api/dms/{id}/files",
		"POST /api/workspaces/{id}/files",
		"GET /api/files/{id}",
		"GET /api/files/{id}/thumbnail",
		"GET /api/search",
	}},
	{access: botAllow, why: "stickers (ADR-0030, ADR-0031 §3): a bot sends stickers, installs packs for itself and manages the workspace's packs with MANAGE_STICKERS", routes: []string{
		"GET /api/workspaces/{id}/sticker-packs",
		"POST /api/workspaces/{id}/sticker-packs",
		"GET /api/sticker-packs/{id}",
		"PATCH /api/sticker-packs/{id}",
		"DELETE /api/sticker-packs/{id}",
		"POST /api/sticker-packs/{id}/stickers",
		"PUT /api/sticker-packs/{id}/stickers/{sid}",
		"PATCH /api/stickers/{id}",
		"DELETE /api/stickers/{id}",
		"GET /api/me/sticker-packs",
		"PUT /api/me/sticker-packs/order",
		"PUT /api/me/sticker-packs/{id}",
		"DELETE /api/me/sticker-packs/{id}",
	}},
	{access: botAllow, why: "voice (ADR-0031 §5): a bot joins, listens and speaks through LiveKit like a person; moderation by MUTE / MOVE / MANAGE bits; sounds (ADR-0036); recording also needs MANAGE_RECORDINGS (ADR-0051 §4); guest admission with INVITE_GUESTS (ADR-0040); PLACE_CALLS from a room whose call it is in (ADR-0046)", routes: []string{
		"POST /api/rooms/{id}/join",
		"POST /api/rooms/{id}/voice/leave",
		"POST /api/rooms/{id}/stream/request",
		"POST /api/rooms/{id}/camera/request",
		"POST /api/rooms/{id}/camera/stop",
		"POST /api/rooms/{id}/voice/{userId}/stop-camera",
		"POST /api/rooms/{id}/voice/{userId}/allow-camera",
		"PATCH /api/voice/self",
		"PATCH /api/rooms/{id}/voice-status",
		"POST /api/rooms/{id}/voice/{userId}/mute",
		"POST /api/rooms/{id}/voice/{userId}/unmute",
		"POST /api/rooms/{id}/voice/{userId}/disconnect",
		"POST /api/rooms/{id}/voice/{userId}/stop-stream",
		"POST /api/rooms/{id}/voice/{userId}/move",
		"POST /api/rooms/{id}/sounds/play",
		"POST /api/rooms/{id}/recording/start",
		"POST /api/rooms/{id}/recording/stop",
		"GET /api/rooms/{id}/recordings/{rid}/transcript",
		"GET /api/rooms/{id}/admissions",
		"POST /api/rooms/{id}/admissions/{userId}",
		"POST /api/rooms/{id}/calls",
		"DELETE /api/rooms/{id}/calls/{cid}",
	}},
	{access: botAllow, why: "the bot's own settings, commands and webhook (the handlers check the caller is a bot)", routes: []string{
		"GET /api/bots/me",
		"PATCH /api/bots/me",
		"PUT /api/bots/me/commands",
		"GET /api/bots/me/webhook",
		"PUT /api/bots/me/webhook",
		"DELETE /api/bots/me/webhook",
		"GET /api/rooms/{id}/bot-commands",
	}},
	{access: botAllow, why: "calendar (ADR-0038, ADR-0051): a bot organizes meetings (never an attendee), changes others' by MANAGE_ROOM / MANAGE_EVENTS, sees free / busy without external details", routes: []string{
		"GET /api/workspaces/{id}/events",
		"POST /api/workspaces/{id}/events",
		"GET /api/events/{id}",
		"PATCH /api/events/{id}",
		"DELETE /api/events/{id}",
		"GET /api/workspaces/{id}/freebusy",
		"POST /api/workspaces/{id}/freebusy/suggest",
	}},
	{access: botAllow, why: "task boards (ADR-0042, ADR-0048, ADR-0058, ADR-0063): the board bits and overrides; CREATE_BOARDS; a closed board only with an override; the final delete (?purge=1) is refused to bots by the handler; approvers are set like people, never voted (ADR-0049)", routes: []string{
		"GET /api/workspaces/{id}/boards",
		"POST /api/workspaces/{id}/boards",
		"GET /api/boards/{id}",
		"PATCH /api/boards/{id}",
		"DELETE /api/boards/{id}",
		"POST /api/boards/{id}/restore",
		"PUT /api/boards/{id}/position",
		"GET /api/boards/{id}/permissions",
		"POST /api/boards/{id}/statuses",
		"PATCH /api/boards/{id}/statuses/{sid}",
		"DELETE /api/boards/{id}/statuses/{sid}",
		"POST /api/boards/{id}/labels",
		"PATCH /api/boards/{id}/labels/{sid}",
		"DELETE /api/boards/{id}/labels/{sid}",
		"POST /api/boards/{id}/milestones",
		"PATCH /api/boards/{id}/milestones/{sid}",
		"DELETE /api/boards/{id}/milestones/{sid}",
		"GET /api/boards/{id}/views",
		"POST /api/boards/{id}/views",
		"PATCH /api/boards/{id}/views/{sid}",
		"DELETE /api/boards/{id}/views/{sid}",
		"POST /api/boards/{id}/files",
		"GET /api/boards/{id}/activity",
		"GET /api/boards/{id}/tasks",
		"POST /api/boards/{id}/tasks",
		"GET /api/tasks/{id}",
		"PATCH /api/tasks/{id}",
		"POST /api/tasks/{id}/archive",
		"POST /api/tasks/{id}/restore",
		"PUT /api/tasks/{id}/assignees",
		"PUT /api/tasks/{id}/approvers",
		"PUT /api/tasks/{id}/relations",
		"DELETE /api/tasks/{id}/relations",
		"PUT /api/tasks/{id}/subscription",
		"PUT /api/tasks/{id}/watchers",
		"DELETE /api/tasks/{id}/watchers",
		"PUT /api/tasks/{id}/read",
		"GET /api/tasks/{id}/activity",
		"GET /api/tasks/{id}/mention-access",
		"GET /api/t/{key}",
		"GET /api/workspaces/{id}/board-categories",
		"POST /api/workspaces/{id}/board-categories",
		"PATCH /api/board-categories/{id}",
		"DELETE /api/board-categories/{id}",
		"PUT /api/workspaces/{id}/boards/order",
		"POST /api/tasks/{id}/checklists",
		"PATCH /api/checklists/{id}",
		"DELETE /api/checklists/{id}",
		"POST /api/checklists/{id}/items",
		"PATCH /api/checklist-items/{id}",
		"DELETE /api/checklist-items/{id}",
		"POST /api/checklist-items/{id}/convert",
		"POST /api/tasks/{id}/milestones",
		"PATCH /api/task-milestones/{id}",
		"DELETE /api/task-milestones/{id}",
		"GET /api/boards/{id}/rules",
		"GET /api/rules/{id}/runs",
		"GET /api/me/tasks",
		"GET /api/me/task-notices",
		"GET /api/workspaces/{id}/tasks/search",
	}},
	{access: botAllow, why: "board forms: MANAGE_BOARD to manage, the form's access list to submit (a closed form needs the bot in allowedUserIds)", routes: []string{
		"GET /api/boards/{id}/forms",
		"POST /api/boards/{id}/forms",
		"PUT /api/boards/{id}/forms/{fid}",
		"DELETE /api/boards/{id}/forms/{fid}",
		"POST /api/boards/{id}/forms/preview",
		"GET /api/forms/{code}",
		"POST /api/forms/{code}/submissions",
		"POST /api/forms/{code}/files",
	}},
	{access: botAllow, why: "Disk (ADR-0094 §2 addendum): the disk bits of the roles and the item overrides", routes: []string{
		"GET /api/workspaces/{id}/disk/items",
		"POST /api/workspaces/{id}/disk/folders",
		"POST /api/workspaces/{id}/disk/upload",
		"POST /api/workspaces/{id}/disk/import",
		"POST /api/workspaces/{id}/disk/trash/empty",
		"GET /api/workspaces/{id}/disk/usage",
		"GET /api/workspaces/{id}/disk/activity",
		"GET /api/workspaces/{id}/disk/settings",
		"PUT /api/workspaces/{id}/disk/settings",
		"GET /api/disk/items/{id}",
		"PATCH /api/disk/items/{id}",
		"DELETE /api/disk/items/{id}",
		"POST /api/disk/items/{id}/trash",
		"POST /api/disk/items/{id}/restore",
		"GET /api/disk/items/{id}/path",
		"GET /api/disk/items/{id}/activity",
		"GET /api/disk/items/{id}/permissions",
		"PUT /api/disk/items/{id}/permissions",
		"POST /api/disk/items/{id}/link",
		"DELETE /api/disk/items/{id}/link",
	}},
	{access: botAllow, why: "Wiki (ADR-0096 §2 addendum): the wiki bits of the roles and the page overrides", routes: []string{
		"GET /api/workspaces/{id}/wiki/pages",
		"POST /api/workspaces/{id}/wiki/pages",
		"POST /api/workspaces/{id}/wiki/trash/empty",
		"GET /api/workspaces/{id}/wiki/activity",
		"GET /api/workspaces/{id}/wiki/settings",
		"PUT /api/workspaces/{id}/wiki/settings",
		"GET /api/wiki/pages/{id}",
		"PATCH /api/wiki/pages/{id}",
		"DELETE /api/wiki/pages/{id}",
		"POST /api/wiki/pages/{id}/trash",
		"POST /api/wiki/pages/{id}/restore",
		"GET /api/wiki/pages/{id}/path",
		"GET /api/wiki/pages/{id}/activity",
		"GET /api/wiki/pages/{id}/permissions",
		"PUT /api/wiki/pages/{id}/permissions",
		"POST /api/wiki/pages/{id}/link",
		"DELETE /api/wiki/pages/{id}/link",
		"GET /api/wiki/pages/{id}/versions",
		"GET /api/wiki/pages/{id}/versions/{vid}",
		"POST /api/wiki/pages/{id}/files",
	}},

	// ---------------------------------------------------------------- allow: opened by ADR-0109
	// Closed on behalf of the owner (ADR-0106 §3 is not widened by ADR-0109).
	{access: botDeny, why: "Canvas v1 (ADR-0126), its comments (ADR-0127 wave 4) and its public link (wave 5): people only — there is no bot SDK for it yet, the sync socket refuses bot tokens (4003) and a bot is never @mentioned on a canvas; the group becomes botAllow by the canvas bits like the Disk and the Wiki (ADR-0109) when bots get the Canvas", routes: []string{
		"DELETE /api/canvas/comments/{id}",
		"DELETE /api/canvas/items/{id}",
		"DELETE /api/canvas/items/{id}/link",
		"GET /api/canvas/items/{id}",
		"GET /api/canvas/items/{id}/activity",
		"GET /api/canvas/items/{id}/comments",
		"GET /api/canvas/items/{id}/comments/mention-access",
		"GET /api/canvas/items/{id}/link",
		"GET /api/canvas/items/{id}/path",
		"GET /api/canvas/items/{id}/permissions",
		"GET /api/canvas/items/{id}/versions",
		"GET /api/canvas/items/{id}/versions/{vid}",
		"GET /api/workspaces/{id}/canvas/activity",
		"GET /api/workspaces/{id}/canvas/items",
		"GET /api/workspaces/{id}/canvas/settings",
		"PATCH /api/canvas/comments/{id}",
		"PATCH /api/canvas/items/{id}",
		"POST /api/canvas/items/{id}/comments",
		"POST /api/canvas/items/{id}/link",
		"POST /api/canvas/items/{id}/restore",
		"POST /api/canvas/items/{id}/take-over",
		"POST /api/canvas/items/{id}/trash",
		"POST /api/workspaces/{id}/canvas/items",
		"POST /api/workspaces/{id}/canvas/trash/empty",
		"PUT /api/canvas/items/{id}/permissions",
		"PUT /api/workspaces/{id}/canvas/settings",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0109: board administration — automation rules (MANAGE_BOARD), the board's Git and webhook (MANAGE_BOARD and MANAGE_INTEGRATIONS; the secret is shown once to whoever sets it), the board's access (MANAGE_BOARD, as rooms)", routes: []string{
		"POST /api/boards/{id}/rules",
		"PATCH /api/rules/{id}",
		"DELETE /api/rules/{id}",
		"POST /api/rules/{id}/test",
		"GET /api/boards/{id}/git",
		"PUT /api/boards/{id}/git",
		"DELETE /api/boards/{id}/git",
		"GET /api/boards/{id}/webhook",
		"PUT /api/boards/{id}/webhook",
		"DELETE /api/boards/{id}/webhook",
		"POST /api/boards/{id}/webhook/ping",
		"PUT /api/boards/{id}/permissions",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0109: workspace integrations by MANAGE_INTEGRATIONS — web apps (members read them), GPTunneL pairing, telephony settings and test (the provider password is never returned) and the exchange — internal numbers, groups, voice menus (ADR-0117; the list of numbers is open to every member but guests), the live calls (ADR-0128; numbers masked without VIEW_JOURNALS), the AI provider and its check (CBF-60; the key is never returned); the calls journal by VIEW_JOURNALS; the call journal of the telephony section (ADR-0137: the bot's own calls, all by VIEW_JOURNALS) and the telephony policy (retention, outbound limits; MANAGE_INTEGRATIONS); the working-hours schedule of the entry point (ADR-0138, MANAGE_INTEGRATIONS)", routes: []string{
		"GET /api/workspaces/{id}/apps",
		"POST /api/workspaces/{id}/apps",
		"PATCH /api/workspace-apps/{appId}",
		"DELETE /api/workspace-apps/{appId}",
		"PUT /api/workspace-apps/{appId}/position",
		"GET /api/workspaces/{id}/integrations/gptunnel",
		"POST /api/workspaces/{id}/integrations/gptunnel",
		"DELETE /api/workspaces/{id}/integrations/gptunnel",
		"GET /api/workspaces/{id}/sip",
		"PUT /api/workspaces/{id}/sip",
		"PUT /api/workspaces/{id}/sip/inbound",
		"PUT /api/workspaces/{id}/sip/recording",
		"PUT /api/workspaces/{id}/sip/policy",
		"PUT /api/workspaces/{id}/sip/schedule",
		"GET /api/workspaces/{id}/sip/journal",
		"GET /api/workspaces/{id}/sip/journal/{cid}",
		"POST /api/workspaces/{id}/sip/journal/seen",
		"POST /api/workspaces/{id}/sip/test",
		"POST /api/workspaces/{id}/sip/extensions",
		"PATCH /api/workspaces/{id}/sip/extensions/{eid}",
		"DELETE /api/workspaces/{id}/sip/extensions/{eid}",
		"GET /api/workspaces/{id}/sip/groups",
		"POST /api/workspaces/{id}/sip/groups",
		"PATCH /api/workspaces/{id}/sip/groups/{gid}",
		"DELETE /api/workspaces/{id}/sip/groups/{gid}",
		"GET /api/workspaces/{id}/sip/ivr",
		"POST /api/workspaces/{id}/sip/ivr",
		"PATCH /api/workspaces/{id}/sip/ivr/{mid}",
		"DELETE /api/workspaces/{id}/sip/ivr/{mid}",
		"GET /api/workspaces/{id}/sip/extensions",
		"GET /api/workspaces/{id}/sip/calls",
		"GET /api/workspaces/{id}/ai",
		"PUT /api/workspaces/{id}/ai",
		"POST /api/workspaces/{id}/ai/check",
		"GET /api/workspaces/{id}/calls",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0117 §5: an inbound phone call is taken by whom it rings — a bot with a number answers it like a person (accept / decline / join / hang up check that the call rings or was answered by the caller; hanging up someone else's needs MANAGE_INTEGRATIONS) and hands it over to a colleague (ADR-0132: transfer / cancel the transfer — the one on the call, or MANAGE_INTEGRATIONS); closed on behalf", routes: []string{
		"POST /api/sip/inbound/{cid}/accept",
		"POST /api/sip/inbound/{cid}/join",
		"POST /api/sip/inbound/{cid}/decline",
		"DELETE /api/sip/inbound/{cid}",
		"POST /api/workspaces/{id}/sip/calls/{cid}/transfer",
		"DELETE /api/workspaces/{id}/sip/calls/{cid}/transfer",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0137 §2: the telephony section's phone book — read, create and edit by whoever sees the section (MANAGE_INTEGRATIONS, or telephony on and PLACE_CALLS, VIEW_JOURNALS or an internal number), delete by the author or MANAGE_INTEGRATIONS, CSV import / export by MANAGE_INTEGRATIONS (a CRM sync); an employee's phone behind a number is never told to a bot; ending a personal call (§3) is the caller's or MANAGE_INTEGRATIONS'", routes: []string{
		"GET /api/workspaces/{id}/sip/contacts",
		"POST /api/workspaces/{id}/sip/contacts",
		"GET /api/workspaces/{id}/sip/contacts/export.csv",
		"POST /api/workspaces/{id}/sip/contacts/import",
		"GET /api/workspaces/{id}/sip/contacts/{cid}",
		"PATCH /api/workspaces/{id}/sip/contacts/{cid}",
		"DELETE /api/workspaces/{id}/sip/contacts/{cid}",
		"DELETE /api/workspaces/{id}/sip/calls/{cid}",
	}},
	{access: botDeny, why: "ADR-0143: the office editor is a person's session in a browser (the Document Server's frame, co-editing presence); a bot reads and writes the same files through the Disk API (by path and sha256), never through an editor session", routes: []string{
		"GET /api/office/capabilities",
		"GET /api/office/config",
		"POST /api/disk/items/{id}/office/convert",
		"POST /api/workspaces/{id}/office/convert",
		"POST /api/workspaces/{id}/office/create",
	}},
	{access: botDeny, why: "ADR-0139: saved task searches are a person's left-panel filters in the app; a bot searches with GET …/tasks/search directly", routes: []string{
		"GET /api/workspaces/{id}/task-searches",
		"POST /api/workspaces/{id}/task-searches",
		"PATCH /api/workspaces/{id}/task-searches/{sid}",
		"DELETE /api/workspaces/{id}/task-searches/{sid}",
	}},
	{access: botDeny, why: "ADR-0137 §3: a personal phone call puts the caller's own LiveKit client into the call's room — a bot has none; bots call a number from a voice room (POST /api/rooms/{id}/calls)", routes: []string{
		"POST /api/workspaces/{id}/sip/calls",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0109: workspace content — camera backgrounds (MANAGE_WORKSPACE; members read them), the achievements catalog (MANAGE_WORKSPACE) and grants (MANAGE_MEMBERS; never to a bot or oneself)", routes: []string{
		"GET /api/workspaces/{id}/backgrounds",
		"POST /api/workspaces/{id}/backgrounds",
		"PATCH /api/workspaces/{id}/backgrounds/{bgId}",
		"DELETE /api/workspaces/{id}/backgrounds/{bgId}",
		"POST /api/workspaces/{id}/achievements",
		"PATCH /api/achievements/{id}",
		"DELETE /api/achievements/{id}",
		"POST /api/workspaces/{id}/members/{userId}/achievements",
		"DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0109: rooms and meetings — a temporary room made permanent (MANAGE_ROOM of the workspace), recordings (who started it, MANAGE_MESSAGES of the room or MANAGE_RECORDINGS; recheck and resend also need MANAGE_RECORDINGS of a bot), meeting comments (whoever sees the meeting; edit — the author; delete — the author or who may change the meeting)", routes: []string{
		"POST /api/rooms/{id}/make-permanent",
		"POST /api/rooms/{id}/recordings/{rid}/recheck",
		"POST /api/rooms/{id}/recordings/{rid}/reupload",
		"DELETE /api/rooms/{id}/recordings/{rid}",
		"GET /api/events/{id}/comments",
		"POST /api/events/{id}/comments",
		"PATCH /api/events/{id}/comments/{comment_id}",
		"DELETE /api/events/{id}/comments/{comment_id}",
	}},

	// MCP for bots (CBF-48), closed on behalf: the endpoint is the bot itself.
	{access: botAllow, onBehalf: onBehalfClosed, why: "MCP for bots (CBF-48): bot tokens only (the handler refuses people); every tool calls a REST route of this table in process with the same token, so it has exactly the bot's rights", routes: []string{
		"/api/mcp",
	}},

	// ---------------------------------------------------------------- deny: people only
	{access: botDeny, why: "account security: a bot has no password, email, sessions, push devices or nickname of its own; it authenticates with its token only (ADR-0031 §2)", routes: []string{
		"GET /api/me/sessions",
		"DELETE /api/me/sessions/{id}",
		"PATCH /api/me/password",
		"PATCH /api/me/email",
		"POST /api/auth/verify/send",
		"POST /api/auth/verify",
		"GET /api/me/push-capabilities",
		"POST /api/me/push-devices",
		"DELETE /api/me/push-devices/{id}",
		"POST /api/me/push-resolve",
		"GET /api/usernames/{name}/available",
	}},
	{access: botDeny, why: "identity: SSO, the directory, OAuth / OIDC clients and consents are a person's login and the workspace's identity policy (ADR-0091, ADR-0102); a bot token is not a login", routes: []string{
		"PUT /api/workspaces/{workspace_id}/identity/policy",
		"PUT /api/workspaces/{workspace_id}/identity/directory/members/{user_id}",
		"PUT /api/workspaces/{workspace_id}/identity/directory",
		"PUT /api/workspaces/{workspace_id}/identity/connection",
		"POST /api/workspaces/{workspace_id}/identity/test",
		"POST /api/workspaces/{workspace_id}/identity/recovery-kit",
		"POST /api/workspaces/{workspace_id}/identity/directory/test",
		"POST /api/workspaces/{workspace_id}/identity/directory/sync",
		"POST /api/workspaces/{workspace_id}/identity/connections/{connection_id}/activate",
		"GET /api/workspaces/{workspace_id}/identity/directory/members",
		"GET /api/workspaces/{workspace_id}/identity/directory",
		"GET /api/workspaces/{workspace_id}/identity",
		"DELETE /api/workspaces/{workspace_id}/identity/link",
		"POST /api/auth/sso/workspaces/{workspace_id}/recover",
		"POST /api/auth/sso/workspaces/{workspace_id}/begin",
		"POST /api/auth/sso/workspaces/{id}/refresh",
		"POST /api/auth/sso/workspaces/{id}/logout",
		"POST /api/auth/sso/finish",
		"POST /api/auth/sso/exchange",
		"POST /api/auth/local/reauth",
		"GET /api/auth/sso/workspaces/{slug}",
		"GET /api/auth/sso/callback/{connection_id}",
		"GET /api/auth/sso/browser-start",
		"POST /oidc/workspaces/{workspace}/userinfo",
		"POST /oidc/workspaces/{workspace}/token",
		"POST /oidc/workspaces/{workspace}/revoke",
		"POST /oidc/workspaces/{workspace}/authorize",
		"OPTIONS /oidc/workspaces/{workspace}/{endpoint}",
		"GET /oidc/workspaces/{workspace}/userinfo",
		"GET /oidc/workspaces/{workspace}/jwks",
		"GET /oidc/workspaces/{workspace}/authorize",
		"GET /oidc/workspaces/{workspace}/.well-known/openid-configuration",
		"GET /.well-known/oauth-authorization-server/oidc/workspaces/{workspace}",
		"POST /api/workspaces/{workspace}/oauth/clients/{client}/rotate-secret",
		"POST /api/workspaces/{workspace}/oauth/clients",
		"PATCH /api/workspaces/{workspace}/oauth/clients/{client}",
		"GET /api/workspaces/{workspace}/oauth/clients/{client}",
		"GET /api/workspaces/{workspace}/oauth/clients",
		"DELETE /api/workspaces/{workspace}/oauth/clients/{client}",
		"POST /api/oauth/requests/{request}/decision",
		"POST /api/oauth/requests/{request}/bind",
		"GET /api/me/oauth-grants",
		"DELETE /api/me/oauth-grants/{grant}",
	}},
	{access: botDeny, why: "money: the workspace's balance, plan, payer and payment methods are the owner's (ADR-0080; roles refuse BILLING to bots); superadmin billing is people only", routes: []string{
		"GET /api/workspaces/{id}/billing",
		"POST /api/workspaces/{id}/billing/quote",
		"POST /api/workspaces/{id}/billing/activate",
		"POST /api/workspaces/{id}/billing/stop",
		"POST /api/workspaces/{id}/billing/change-plan",
		"POST /api/workspaces/{id}/billing/resume",
		"GET /api/workspaces/{id}/billing/payer",
		"PUT /api/workspaces/{id}/billing/payer",
		"GET /api/workspaces/{id}/billing/payer-schema",
		"POST /api/workspaces/{id}/billing/topups",
		"GET /api/workspaces/{id}/billing/checkouts/{cid}",
		"GET /api/workspaces/{id}/billing/auto-topup",
		"PUT /api/workspaces/{id}/billing/auto-topup",
		"DELETE /api/workspaces/{id}/billing/auto-topup",
		"GET /api/workspaces/{id}/billing/payment-methods",
		"DELETE /api/workspaces/{id}/billing/payment-methods/{pmId}",
		"POST /api/workspaces/{id}/billing/saved-method-topups",
		"GET /api/workspaces/{id}/billing/saved-method-topups/{tid}",
		"GET /api/workspaces/{id}/billing/ledger",
		"GET /api/workspaces/{id}/billing/payments",
		"GET /api/admin/billing/accounts",
		"GET /api/admin/billing/accounts/{id}",
		"GET /api/admin/billing/accounts/{id}/ledger",
		"GET /api/admin/billing/payments",
		"GET /api/admin/billing/refunds",
		"GET /api/admin/billing/disputes",
		"GET /api/admin/billing/events",
		"POST /api/admin/billing/workspaces/{id}/enable",
		"POST /api/admin/billing/accounts/{id}/manual-credits",
		"POST /api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse",
		"POST /api/admin/billing/accounts/{id}/admin-debit",
		"POST /api/admin/billing/payments/{id}/refunds",
		"POST /api/admin/billing/accounts/{id}/hold",
		"POST /api/admin/billing/accounts/{id}/reconcile",
		"POST /api/admin/billing/auto-topup/reconcile",
		"PUT /api/admin/billing/accounts/{id}/discount",
		"PUT /api/admin/billing/accounts/{id}/custom-plan",
		"POST /api/admin/billing/accounts/{id}/plan",
		"GET /api/admin/billing/prices",
		"POST /api/admin/billing/prices",
		"POST /api/admin/billing/test-clock",
		"POST /api/admin/billing/accounts/{id}/market",
		"GET /api/admin/billing/providers",
		"PUT /api/admin/billing/providers/{provider}",
		"GET /api/admin/billing/issues",
		"POST /api/admin/billing/issues/{id}/import",
		"POST /api/admin/billing/issues/{id}/dismiss",
		"POST /api/admin/billing/accounts/{id}/charges/{attemptId}/check",
		"POST /api/admin/billing/payments/{id}/chargebacks",
		"POST /api/admin/billing/disputes/{id}/close",
	}},
	{access: botDeny, why: "superadmin of the product: people with a local account only", routes: []string{
		"GET /api/admin/workspaces",
		"GET /api/admin/workspaces/{id}",
		"PUT /api/admin/workspaces/{id}/plan",
		"GET /api/admin/workspaces/{id}/plan/log",
		"PUT /api/admin/workspaces/{id}/suspension",
		"GET /api/admin/users/{id}/storage-quota",
		"PUT /api/admin/users/{id}/storage-quota",
	}},
	{access: botDeny, why: "workspace ownership and membership: a bot never owns, creates, deletes or joins a workspace by itself (a person adds it, ADR-0031 §2); take-over is the workspace owner's (ADR-0078)", routes: []string{
		"POST /api/workspaces",
		"DELETE /api/workspaces/{id}",
		"GET /api/workspaces/discover",
		"POST /api/workspaces/{id}/join",
		"POST /api/invites/{code}/join",
		"POST /api/rooms/{id}/take-over",
		"POST /api/disk/items/{id}/take-over",
		"POST /api/wiki/pages/{id}/take-over",
		"POST /api/boards/{id}/take-over",
	}},
	{access: botDeny, why: "accounts without consent (ADR-0051 §5): no lookup of an account by address, no adding an account directly — bots invite", routes: []string{
		"POST /api/workspaces/{id}/invites/lookup",
		"POST /api/workspaces/{id}/members",
	}},
	{access: botDeny, why: "bots managing bots: creating, tokens, avatars, acts_as_owner and the oversight of bots (contacts shared with bots, a person's bot blocks) are people's — no self-escalation (ADR-0031, ADR-0048, ADR-0100, ADR-0106)", routes: []string{
		"POST /api/workspaces/{id}/bots",
		"GET /api/workspaces/{id}/bots",
		"POST /api/workspaces/{id}/bots/add",
		"PATCH /api/workspaces/{id}/bots/{botId}",
		"DELETE /api/workspaces/{id}/bots/{botId}",
		"POST /api/workspaces/{id}/bots/{botId}/token",
		"DELETE /api/workspaces/{id}/bots/{botId}/token",
		"POST /api/workspaces/{id}/bots/{botId}/avatar",
		"DELETE /api/workspaces/{id}/bots/{botId}/avatar",
		"GET /api/bots/{ref}",
		"GET /api/workspaces/{id}/bot-contact-shares",
		"GET /api/me/blocked-bots",
		"POST /api/me/blocked-bots/{id}",
		"DELETE /api/me/blocked-bots/{id}",
	}},
	{access: botDeny, why: "ADR-0111: a consent to act on someone's behalf is that person's own decision (giving, revoking, declining or cancelling an invitation)", routes: []string{
		"PUT /api/workspaces/{id}/bots/{botId}/delegations/{userId}",
		"DELETE /api/workspaces/{id}/bots/{botId}/delegations/{userId}",
		"DELETE /api/workspaces/{id}/bots/{botId}/delegation-invites/{userId}",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0119: the bot asks members for its own consent ({botId} = the bot itself, a non-guest role; another bot gets 403); only the invitee's own click in their DM grants it; closed on behalf", routes: []string{
		"POST /api/workspaces/{id}/bots/{botId}/delegation-invites",
	}},
	{access: botAllow, onBehalf: onBehalfClosed, why: "ADR-0111: the bot reads whom it may act for (members of the workspace read it too; another bot gets 403); closed on behalf", routes: []string{
		"GET /api/workspaces/{id}/bots/{botId}",
	}},
	{access: botDeny, why: "a person's decision (ADR-0049, ADR-0051 §5, ADR-0100, ADR-0108): the approval vote, pressing a button, sharing one's contact, answering an invitation", routes: []string{
		"POST /api/tasks/{id}/approval",
		"POST /api/messages/{id}/interactions",
		"POST /api/messages/{id}/buttons/{buttonId}/contact",
		"PUT /api/events/{id}/rsvp",
	}},
	{access: botDeny, why: "a person's private data and settings: personal notes, presence status, notification and chat-list settings, birthdays (hidden ones included), today's agenda and external calendars (ADR-0039, ADR-0045, docs/09 #77)", routes: []string{
		"GET /api/users/{id}/note",
		"PUT /api/users/{id}/note",
		"DELETE /api/users/{id}/note",
		"GET /api/notes",
		"POST /api/notes",
		"PATCH /api/notes/{id}",
		"DELETE /api/notes/{id}",
		"PATCH /api/me/status",
		"PUT /api/workspaces/{id}/notifications",
		"PUT /api/rooms/{id}/notifications",
		"PATCH /api/dms/{id}/state",
		"GET /api/workspaces/{id}/members/birthdays",
		"PATCH /api/workspaces/{id}/members/{userId}/birthday",
		"GET /api/me/events/today",
		"POST /api/me/calendar-widget",
		"GET /api/me/caldav",
		"POST /api/me/caldav",
		"PUT /api/me/caldav",
		"PATCH /api/me/caldav",
		"DELETE /api/me/caldav",
		"POST /api/me/caldav/sync",
		"GET /api/me/external-events",
		"DELETE /api/me/external-events",
		"POST /api/me/external-events/rsvp",
	}},
	{access: botDeny, why: "voice where the bot model differs: one-to-one calls ring a person (ADR-0034 §7); guest links hand anonymous entry to calls to outsiders, which a bot never mints (ADR-0031; temporary rooms and meetings of bots follow it); waiting for admission is a guest's", routes: []string{
		"POST /api/dms/{id}/call",
		"POST /api/calls/{id}/accept",
		"POST /api/calls/{id}/decline",
		"POST /api/calls/{id}/cancel",
		"POST /api/calls/{id}/hangup",
		"POST /api/rooms/{id}/invites",
		"GET /api/rooms/{id}/invites",
		"DELETE /api/rooms/{id}/invites/{inviteId}",
		"PATCH /api/rooms/{id}/invites/{inviteId}",
		"DELETE /api/rooms/{id}/admissions/me",
	}},
	{access: botDeny, why: "client helpers, not the bot API: server-side fetches of arbitrary URLs (link previews) and the HEIC converter would make a token a free proxy / CPU", routes: []string{
		"GET /api/unfurl",
		"GET /api/unfurl/image",
		"POST /api/files/convert",
	}},
	{access: botDeny, why: "smart tasks (CBF-68, ADR-0118): a person's request sent to the workspace's model, billed to its key — a bot creates tasks with POST /api/boards/{id}/tasks itself; the AI status serves the person's «+» menu", routes: []string{
		"POST /api/workspaces/{id}/smart-tasks",
		"GET /api/workspaces/{id}/ai/status",
	}},
}

// botRoutes indexes botRouteGroups by pattern.
var botRoutes = indexBotRoutes(botRouteGroups)

// indexBotRoutes builds the pattern → access map; a pattern listed twice is a programming error.
func indexBotRoutes(groups []botRouteGroup) map[string]botAccess {
	out := make(map[string]botAccess, 512)
	for _, g := range groups {
		for _, p := range g.routes {
			if _, dup := out[p]; dup {
				panic("botroutes: " + p + " is listed twice")
			}
			out[p] = g.access
		}
	}
	return out
}

// botAudited: administrative routes whose bot calls are logged as "bot action" with the
// bot's owner (ADR-0051: a token with admin bits acts as an admin; the log says whose bot).
var botAudited = map[string]bool{
	"PATCH /api/workspaces/{id}":                           true,
	"PATCH /api/workspaces/{id}/members/{userId}":          true,
	"DELETE /api/workspaces/{id}/members/{userId}":         true,
	"POST /api/workspaces/{id}/members/{userId}/promote":   true,
	"PUT /api/workspaces/{id}/members/{userId}/roles":      true,
	"PUT /api/workspaces/{id}/members/{userId}/badge":      true,
	"POST /api/workspaces/{id}/roles":                      true,
	"PATCH /api/workspaces/{id}/roles/{roleId}":            true,
	"DELETE /api/workspaces/{id}/roles/{roleId}":           true,
	"PUT /api/workspaces/{id}/roles/order":                 true,
	"POST /api/workspaces/{id}/bans":                       true,
	"DELETE /api/workspaces/{id}/bans/{userId}":            true,
	"POST /api/workspaces/{id}/invites":                    true,
	"DELETE /api/workspaces/{id}/invites/{inviteId}":       true,
	"POST /api/workspaces/{id}/invites/email":              true,
	"DELETE /api/workspaces/{id}/invites/email/{inviteId}": true,
	"POST /api/mailbox/password-reset":                     true, // ADR-0101: with the target in the handler's own audit line
	"POST /api/workspaces/{id}/badges":                     true,
	"PATCH /api/workspaces/{id}/badges/{badgeId}":          true,
	"DELETE /api/workspaces/{id}/badges/{badgeId}":         true,
	"POST /api/workspaces/{id}/sounds":                     true,
	"PATCH /api/workspaces/{id}/sounds/{soundId}":          true,
	"DELETE /api/workspaces/{id}/sounds/{soundId}":         true,
	"POST /api/workspaces/{id}/events":                     true,
	"PATCH /api/events/{id}":                               true,
	"DELETE /api/events/{id}":                              true,
	"POST /api/rooms/{id}/admissions/{userId}":             true,
	"POST /api/rooms/{id}/recording/start":                 true,
	"POST /api/rooms/{id}/recording/stop":                  true,
	"PUT /api/rooms/{id}/permissions":                      true,
	"DELETE /api/rooms/{id}":                               true,
	// ADR-0109
	"POST /api/boards/{id}/rules":                                         true,
	"PATCH /api/rules/{id}":                                               true,
	"DELETE /api/rules/{id}":                                              true,
	"PUT /api/boards/{id}/git":                                            true,
	"DELETE /api/boards/{id}/git":                                         true,
	"PUT /api/boards/{id}/webhook":                                        true,
	"DELETE /api/boards/{id}/webhook":                                     true,
	"PUT /api/boards/{id}/permissions":                                    true,
	"POST /api/workspaces/{id}/apps":                                      true,
	"PATCH /api/workspace-apps/{appId}":                                   true,
	"DELETE /api/workspace-apps/{appId}":                                  true,
	"POST /api/workspaces/{id}/integrations/gptunnel":                     true,
	"DELETE /api/workspaces/{id}/integrations/gptunnel":                   true,
	"PUT /api/workspaces/{id}/sip":                                        true,
	"PUT /api/workspaces/{id}/sip/inbound":                                true,
	"PUT /api/workspaces/{id}/sip/recording":                              true,
	"POST /api/workspaces/{id}/sip/test":                                  true, // a real call billed to the workspace
	"POST /api/workspaces/{id}/sip/contacts/import":                       true, // ADR-0137: a bulk write of personal data
	"GET /api/workspaces/{id}/sip/contacts/export.csv":                    true, // ADR-0137: the whole phone book leaves
	"POST /api/workspaces/{id}/sip/extensions":                            true,
	"PATCH /api/workspaces/{id}/sip/extensions/{eid}":                     true,
	"DELETE /api/workspaces/{id}/sip/extensions/{eid}":                    true,
	"POST /api/workspaces/{id}/sip/groups":                                true,
	"PATCH /api/workspaces/{id}/sip/groups/{gid}":                         true,
	"DELETE /api/workspaces/{id}/sip/groups/{gid}":                        true,
	"POST /api/workspaces/{id}/sip/ivr":                                   true,
	"PATCH /api/workspaces/{id}/sip/ivr/{mid}":                            true,
	"DELETE /api/workspaces/{id}/sip/ivr/{mid}":                           true,
	"PUT /api/workspaces/{id}/ai":                                         true,
	"POST /api/workspaces/{id}/ai/check":                                  true, // a model call billed to the key
	"POST /api/workspaces/{id}/backgrounds":                               true,
	"PATCH /api/workspaces/{id}/backgrounds/{bgId}":                       true,
	"DELETE /api/workspaces/{id}/backgrounds/{bgId}":                      true,
	"POST /api/workspaces/{id}/achievements":                              true,
	"PATCH /api/achievements/{id}":                                        true,
	"DELETE /api/achievements/{id}":                                       true,
	"POST /api/workspaces/{id}/members/{userId}/achievements":             true,
	"DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}": true,
	"POST /api/rooms/{id}/make-permanent":                                 true,
	"DELETE /api/rooms/{id}/recordings/{rid}":                             true,
}

// onBehalfAccess classifies a route for a bot acting on behalf of its owner (ADR-0106).
type onBehalfAccess int

const (
	// onBehalfOpen: a botDeny route that ADR-0051 §5 closed only because the decision is a
	// person's; the owner's bot makes it on the owner's behalf.
	onBehalfOpen onBehalfAccess = iota + 1
	// onBehalfClosed: a botAllow route that stays closed on behalf of the owner: the person's
	// account, the bot's own settings, voice and calls, and the routes ADR-0109 opened to bots
	// (on behalf of the owner is not widened by it).
	onBehalfClosed
)

// onBehalfRoutes is the route tag of requests on behalf of the owner (ADR-0106 §3): such a
// request may call every botAllow route except onBehalfClosed ones, and the onBehalfOpen ones.
// Everything else (botDeny, botPublic, unlisted) is 403 ON_BEHALF_ROUTE: the account (password,
// email, sessions, devices, OAuth, profile), bot management (acts_as_owner included: no
// self-escalation), billing, workspace deletion and ownership, superadmin. TestOnBehalfRouteTable
// keeps the table consistent with botRoutes. Groups of botRouteGroups with an onBehalf tag
// (the routes ADR-0109 opened to bots) are added to it.
var onBehalfRoutes = withGroupOnBehalf(map[string]onBehalfAccess{
	// a person's decision (ADR-0049, ADR-0051 §5)
	"POST /api/tasks/{id}/approval": onBehalfOpen,
	// the owner's account: the profile and its picture are the person's
	"PATCH /api/me":       onBehalfClosed,
	"POST /api/me/avatar": onBehalfClosed,
	// the bot's own routes: it calls them as itself
	"GET /api/bots/me":            onBehalfClosed,
	"PATCH /api/bots/me":          onBehalfClosed,
	"PUT /api/bots/me/commands":   onBehalfClosed,
	"GET /api/bots/me/webhook":    onBehalfClosed,
	"PUT /api/bots/me/webhook":    onBehalfClosed,
	"DELETE /api/bots/me/webhook": onBehalfClosed,
	// mailbox hosting (ADR-0101): an allowlisted bot's own job
	"POST /api/mailbox/hosting-check":  onBehalfClosed,
	"POST /api/mailbox/password-reset": onBehalfClosed,
	// voice and calls: a LiveKit participant "as the owner" would fake the person's voice and
	// session; recording keeps MANAGE_RECORDINGS of the bot (ADR-0051 §4)
	"POST /api/rooms/{id}/join":                        onBehalfClosed,
	"POST /api/rooms/{id}/voice/leave":                 onBehalfClosed,
	"POST /api/rooms/{id}/stream/request":              onBehalfClosed,
	"POST /api/rooms/{id}/camera/request":              onBehalfClosed,
	"POST /api/rooms/{id}/camera/stop":                 onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/stop-camera":  onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/allow-camera": onBehalfClosed,
	"PATCH /api/voice/self":                            onBehalfClosed,
	"PATCH /api/rooms/{id}/voice-status":               onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/mute":         onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/unmute":       onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/disconnect":   onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/stop-stream":  onBehalfClosed,
	"POST /api/rooms/{id}/voice/{userId}/move":         onBehalfClosed,
	"POST /api/rooms/{id}/sounds/play":                 onBehalfClosed,
	"POST /api/rooms/{id}/calls":                       onBehalfClosed,
	"DELETE /api/rooms/{id}/calls/{cid}":               onBehalfClosed,
	"POST /api/rooms/{id}/recording/start":             onBehalfClosed,
	"POST /api/rooms/{id}/recording/stop":              onBehalfClosed,
}, botRouteGroups)

// withGroupOnBehalf adds the onBehalf tags of the route groups to the on-behalf table; a route
// tagged twice is a programming error.
func withGroupOnBehalf(m map[string]onBehalfAccess, groups []botRouteGroup) map[string]onBehalfAccess {
	for _, g := range groups {
		if g.onBehalf == 0 {
			continue
		}
		for _, p := range g.routes {
			if _, dup := m[p]; dup {
				panic("botroutes: " + p + " has two on-behalf tags")
			}
			m[p] = g.onBehalf
		}
	}
	return m
}

// memberClosed: routes open on behalf of the owner (ADR-0106) but closed on behalf of a member
// who consented (ADR-0111 §3): the workspace's access control — its settings, who is in it,
// roles, bans, invitations, permission overrides. The token is the bot owner's, not the
// member's: a consenting admin must not hand the bot (or its owner) roles or access that
// outlive the revocation of the consent.
var memberClosed = map[string]bool{
	"PATCH /api/workspaces/{id}":                           true,
	"PATCH /api/workspaces/{id}/members/{userId}":          true,
	"DELETE /api/workspaces/{id}/members/{userId}":         true,
	"POST /api/workspaces/{id}/members/{userId}/promote":   true,
	"PUT /api/workspaces/{id}/members/{userId}/roles":      true,
	"POST /api/workspaces/{id}/roles":                      true,
	"PATCH /api/workspaces/{id}/roles/{roleId}":            true,
	"DELETE /api/workspaces/{id}/roles/{roleId}":           true,
	"PUT /api/workspaces/{id}/roles/order":                 true,
	"POST /api/workspaces/{id}/bans":                       true,
	"DELETE /api/workspaces/{id}/bans/{userId}":            true,
	"POST /api/workspaces/{id}/invites":                    true,
	"DELETE /api/workspaces/{id}/invites/{inviteId}":       true,
	"POST /api/workspaces/{id}/invites/email":              true,
	"DELETE /api/workspaces/{id}/invites/email/{inviteId}": true,
	"POST /api/rooms/{id}/admissions/{userId}":             true,
	"PUT /api/rooms/{id}/permissions":                      true,
	"PUT /api/wiki/pages/{id}/permissions":                 true,
	"PUT /api/disk/items/{id}/permissions":                 true,
	"PUT /api/workspaces/{id}/disk/settings":               true,
	"PUT /api/workspaces/{id}/wiki/settings":               true,
	// ADR-0140: who read the member's messages is other people's reading, not the member's data.
	"GET /api/rooms/{id}/messages/{messageId}/readers": true,
}

// onBehalfAllowedFor is onBehalfAllowed for id: a member's consent (ADR-0111) also closes
// memberClosed.
func onBehalfAllowedFor(id auth.Identity, pattern string) bool {
	return onBehalfAllowed(pattern) && (!id.ForMember || !memberClosed[pattern])
}

// onBehalfAllowed reports whether a request on behalf of the owner may call the route.
func onBehalfAllowed(pattern string) bool {
	switch onBehalfRoutes[pattern] {
	case onBehalfOpen:
		return true
	case onBehalfClosed:
		return false
	}
	return botRoutes[pattern] == botAllow
}

// botGate lets bot identities through only on botAllow routes (by the matched pattern), and
// requests on behalf of a bot's owner only on the routes onBehalfAllowed gives (ADR-0106).
// It runs inside auth.Require. Bot calls of botAudited routes and every mutating call on
// behalf of an owner are logged as "bot action" with the bot's owner.
func botGate(q *sqlc.Queries, next http.Handler) http.Handler {
	deny := auth.NoBots(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := auth.FromContext(r.Context())
		if ok && id.OnBehalf() {
			if !onBehalfAllowedFor(id, r.Pattern) {
				httpx.WriteError(w, r, auth.ErrOnBehalfRoute)
				return
			}
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				next.ServeHTTP(w, r)
				return
			}
			sw := &auditWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			if id.ForMember { // ADR-0111: a member who consented, not the owner
				slog.InfoContext(r.Context(), "bot action", "route", r.Pattern, "path", r.URL.Path, "status", sw.code(),
					"bot_id", id.ViaBot, "on_behalf", true, "member_id", id.UserID)
				return
			}
			slog.InfoContext(r.Context(), "bot action", "route", r.Pattern, "path", r.URL.Path, "status", sw.code(),
				"bot_id", id.ViaBot, "bot_owner", id.UserID, "on_behalf", true, "owner_id", id.UserID)
			return
		}
		if botRoutes[r.Pattern] != botAllow {
			deny.ServeHTTP(w, r)
			return
		}
		if !ok || !id.IsBot || !botAudited[r.Pattern] {
			next.ServeHTTP(w, r)
			return
		}
		sw := &auditWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		owner := ""
		if b, err := q.GetBot(r.Context(), id.UserID); err == nil {
			owner = b.OwnerUserID.String()
		}
		slog.InfoContext(r.Context(), "bot action", "route", r.Pattern, "path", r.URL.Path, "status", sw.code(),
			"bot_id", id.UserID, "bot_owner", owner, "on_behalf", false)
	})
}

// auditWriter remembers the status of a response.
type auditWriter struct {
	http.ResponseWriter
	status int
}

func (a *auditWriter) WriteHeader(code int) {
	if a.status == 0 {
		a.status = code
	}
	a.ResponseWriter.WriteHeader(code)
}

func (a *auditWriter) Write(b []byte) (int, error) {
	if a.status == 0 {
		a.status = http.StatusOK
	}
	return a.ResponseWriter.Write(b)
}

func (a *auditWriter) code() int {
	if a.status == 0 {
		return http.StatusOK
	}
	return a.status
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (a *auditWriter) Unwrap() http.ResponseWriter { return a.ResponseWriter }

// routeRecorder records every pattern registered on the mux (App.Routes).
type routeRecorder struct {
	*http.ServeMux
	patterns   []string
	capability func(string, http.Handler) http.Handler
}

func (m *routeRecorder) Handle(pattern string, h http.Handler) {
	m.patterns = append(m.patterns, pattern)
	if m.capability != nil {
		h = m.capability(pattern, h)
	}
	m.ServeMux.Handle(pattern, h)
}

func (m *routeRecorder) HandleFunc(pattern string, f func(http.ResponseWriter, *http.Request)) {
	m.Handle(pattern, http.HandlerFunc(f))
}

// BotRouteAccess reports how bots may use a registered route: "public", "allow", "deny" or ""
// (unlisted — denied at run time; tests fail on it).
func BotRouteAccess(pattern string) string {
	switch botRoutes[pattern] {
	case botPublic:
		return "public"
	case botAllow:
		return "allow"
	case botDeny:
		return "deny"
	}
	return ""
}

// OnBehalfRouteAccess reports how a request on behalf of a bot's owner may use a route (ADR-0106):
// "open" (a botDeny route opened on behalf), "closed" (a botAllow route closed on behalf), or ""
// (as for bots: allowed iff BotRouteAccess is "allow"). OnBehalfAllowed is the decision.
func OnBehalfRouteAccess(pattern string) string {
	switch onBehalfRoutes[pattern] {
	case onBehalfOpen:
		return "open"
	case onBehalfClosed:
		return "closed"
	}
	return ""
}

// OnBehalfAllowed reports whether a request on behalf of a bot's owner may call the route.
func OnBehalfAllowed(pattern string) bool { return onBehalfAllowed(pattern) }

// OnBehalfRoutePatterns lists the patterns of the on-behalf table (tests).
func OnBehalfRoutePatterns() []string {
	out := make([]string, 0, len(onBehalfRoutes))
	for p := range onBehalfRoutes {
		out = append(out, p)
	}
	return out
}

// BotAuditedPatterns lists the routes whose bot calls are logged with the bot's owner (tests:
// each is a bot route).
func BotAuditedPatterns() []string {
	out := make([]string, 0, len(botAudited))
	for p := range botAudited {
		out = append(out, p)
	}
	return out
}

// BotRoutePatterns lists the patterns of the table (tests: no stale entries).
func BotRoutePatterns() []string {
	out := make([]string, 0, len(botRoutes))
	for p := range botRoutes {
		out = append(out, p)
	}
	return out
}
