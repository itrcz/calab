package app

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/builtinstickers"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/google/uuid"
	"net/http"
	"strings"
)

type identityScope uint8

const (
	scopePublic identityScope = iota + 1
	scopeGlobal
	scopeAdmin
	scopeProfile
	scopeAggregate
	scopeWorkspace
	scopeFile
	scopeVoice
	scopeCapability
	scopeRoom
	scopeMessage
	scopeBoard
	scopeTask
	scopeCategory
	scopePack
	scopeSticker
	scopeEvent
	scopeApp
	scopeMachine
	scopeAdmission
	scopeBoardCategory
	scopeChecklist
	scopeChecklistItem
	scopeForm

	scopeTaskMilestone
	scopeRule
	scopeAchievement
	// scopeBilling: the owner money routes of /api/workspaces/{id}/billing. Resolved and checked
	// like scopeWorkspace; a separate scope so billing suspension (ADR-0080 §12) can keep the
	// owner's recovery scope open while it closes the rest of the workspace.
	scopeBilling
)

// billingRecoveryRoutes: workspace routes besides scopeBilling the owner keeps under a billing
// suspension (the paywall shows the workspace's name and icon). Everyone else gets 403
// WORKSPACE_SUSPENDED / WORKSPACE_BILLING_SUSPENDED there too.
var billingRecoveryRoutes = map[string]bool{
	"GET /api/workspaces/{id}": true,
}

// identityRoutes enumerates every route. Unknown paths fail closed; a new registration
// always requires an explicit authority and resource classification.
var identityRoutes = map[string]identityScope{
	// Native endpoint management uses independent local-account authority. Delivery and
	// resolve additionally recheck the exact persisted session against the target policy.
	"GET /api/me/push-capabilities":                                                     scopeGlobal,
	"POST /api/me/push-devices":                                                         scopeGlobal,
	"DELETE /api/me/push-devices/{id}":                                                  scopeGlobal,
	"POST /api/me/push-resolve":                                                         scopeGlobal,
	"GET /api/stickers/builtin/{name}":                                                  scopePublic,
	"PUT /api/workspaces/{workspace_id}/identity/policy":                                scopePublic,
	"PUT /api/workspaces/{workspace_id}/identity/directory/members/{user_id}":           scopePublic,
	"PUT /api/workspaces/{workspace_id}/identity/directory":                             scopePublic,
	"PUT /api/workspaces/{workspace_id}/identity/connection":                            scopePublic,
	"POST /oidc/workspaces/{workspace}/userinfo":                                        scopePublic,
	"POST /oidc/workspaces/{workspace}/token":                                           scopePublic,
	"POST /oidc/workspaces/{workspace}/revoke":                                          scopePublic,
	"POST /oidc/workspaces/{workspace}/authorize":                                       scopePublic,
	"POST /api/workspaces/{workspace}/oauth/clients/{client}/rotate-secret":             scopePublic,
	"POST /api/workspaces/{workspace}/oauth/clients":                                    scopePublic,
	"POST /api/workspaces/{workspace_id}/identity/test":                                 scopePublic,
	"POST /api/workspaces/{workspace_id}/identity/recovery-kit":                         scopePublic,
	"POST /api/workspaces/{workspace_id}/identity/directory/test":                       scopePublic,
	"POST /api/workspaces/{workspace_id}/identity/directory/sync":                       scopePublic,
	"POST /api/workspaces/{workspace_id}/identity/connections/{connection_id}/activate": scopePublic,
	"POST /api/oauth/requests/{request}/decision":                                       scopePublic,
	"POST /api/oauth/requests/{request}/bind":                                           scopePublic,
	"POST /api/auth/sso/workspaces/{workspace_id}/recover":                              scopePublic,
	"POST /api/auth/sso/workspaces/{workspace_id}/begin":                                scopePublic,
	"POST /api/auth/sso/workspaces/{id}/refresh":                                        scopePublic,
	"POST /api/auth/sso/workspaces/{id}/logout":                                         scopePublic,
	"POST /api/auth/sso/finish":                                                         scopePublic,
	"POST /api/auth/sso/exchange":                                                       scopePublic,
	"POST /api/auth/local/reauth":                                                       scopePublic,
	"PATCH /api/workspaces/{workspace}/oauth/clients/{client}":                          scopePublic,
	"OPTIONS /oidc/workspaces/{workspace}/{endpoint}":                                   scopePublic,
	"GET /oidc/workspaces/{workspace}/userinfo":                                         scopePublic,
	"GET /oidc/workspaces/{workspace}/jwks":                                             scopePublic,
	"GET /oidc/workspaces/{workspace}/authorize":                                        scopePublic,
	"GET /oidc/workspaces/{workspace}/.well-known/openid-configuration":                 scopePublic,
	"GET /api/workspaces/{workspace}/oauth/clients/{client}":                            scopePublic,
	"GET /api/workspaces/{workspace}/oauth/clients":                                     scopePublic,
	"GET /api/workspaces/{workspace_id}/identity/directory/members":                     scopePublic,
	"GET /api/workspaces/{workspace_id}/identity/directory":                             scopePublic,
	"GET /api/workspaces/{workspace_id}/identity":                                       scopePublic,
	"GET /api/me/oauth-grants":                                                          scopePublic,
	"GET /api/auth/sso/workspaces/{slug}":                                               scopePublic,
	"GET /api/auth/sso/callback/{connection_id}":                                        scopePublic,
	"GET /api/auth/sso/browser-start":                                                   scopePublic,
	"GET /.well-known/oauth-authorization-server/oidc/workspaces/{workspace}":           scopePublic,
	"DELETE /api/workspaces/{workspace}/oauth/clients/{client}":                         scopePublic,
	"DELETE /api/workspaces/{workspace_id}/identity/link":                               scopePublic,
	"DELETE /api/me/oauth-grants/{grant}":                                               scopePublic,
	"/api/":                                                                             scopePublic,
	"DELETE /api/boards/{id}":                                                           scopeBoard,
	"DELETE /api/boards/{id}/labels/{sid}":                                              scopeBoard,
	"DELETE /api/boards/{id}/milestones/{sid}":                                          scopeBoard,
	"DELETE /api/boards/{id}/statuses/{sid}":                                            scopeBoard,
	"DELETE /api/boards/{id}/views/{sid}":                                               scopeBoard,
	"DELETE /api/bots/me/webhook":                                                       scopeMachine,
	"DELETE /api/categories/{id}":                                                       scopeCategory,
	"DELETE /api/events/{id}":                                                           scopeEvent,
	"DELETE /api/me/blocked-bots/{id}":                                                  scopeGlobal,
	"DELETE /api/me/caldav":                                                             scopeGlobal,
	"DELETE /api/me/external-events":                                                    scopeGlobal,
	"DELETE /api/me/sessions/{id}":                                                      scopeGlobal,
	"DELETE /api/me/sticker-packs/{id}":                                                 scopeGlobal,
	"DELETE /api/messages/{id}":                                                         scopeMessage,
	"DELETE /api/messages/{id}/pin":                                                     scopeMessage,
	"DELETE /api/messages/{id}/reactions/{emoji}":                                       scopeMessage,
	"DELETE /api/notes/{id}":                                                            scopeGlobal,
	"DELETE /api/rooms/{id}":                                                            scopeRoom,
	"DELETE /api/rooms/{id}/admissions/me":                                              scopeRoom,
	"DELETE /api/rooms/{id}/calls/{cid}":                                                scopeRoom,
	"DELETE /api/rooms/{id}/invites/{inviteId}":                                         scopeRoom,
	"DELETE /api/rooms/{id}/recordings/{rid}":                                           scopeRoom,
	"DELETE /api/sticker-packs/{id}":                                                    scopePack,
	"DELETE /api/stickers/{id}":                                                         scopeSticker,
	"DELETE /api/tasks/{id}/relations":                                                  scopeTask,
	"DELETE /api/tasks/{id}/watchers":                                                   scopeTask,
	"DELETE /api/users/{id}/note":                                                       scopeGlobal,
	"DELETE /api/workspace-apps/{appId}":                                                scopeApp,
	"DELETE /api/workspaces/{id}":                                                       scopeWorkspace,
	"DELETE /api/workspaces/{id}/backgrounds/{bgId}":                                    scopeWorkspace,
	"DELETE /api/workspaces/{id}/badges/{badgeId}":                                      scopeWorkspace,
	"DELETE /api/workspaces/{id}/bans/{userId}":                                         scopeWorkspace,
	"DELETE /api/workspaces/{id}/bots/{botId}":                                          scopeWorkspace,
	"DELETE /api/workspaces/{id}/bots/{botId}/avatar":                                   scopeWorkspace,
	"DELETE /api/workspaces/{id}/bots/{botId}/token":                                    scopeWorkspace,
	"DELETE /api/workspaces/{id}/integrations/gptunnel":                                 scopeWorkspace,
	"DELETE /api/workspaces/{id}/invites/email/{inviteId}":                              scopeWorkspace,
	"DELETE /api/workspaces/{id}/invites/{inviteId}":                                    scopeWorkspace,
	"DELETE /api/workspaces/{id}/members/{userId}":                                      scopeWorkspace,
	"DELETE /api/workspaces/{id}/roles/{roleId}":                                        scopeWorkspace,
	"DELETE /api/workspaces/{id}/sounds/{soundId}":                                      scopeWorkspace,
	"GET /api/admin/users/{id}/storage-quota":                                           scopeAdmin,
	"GET /api/admin/workspaces":                                                         scopeAdmin,
	"GET /api/admin/workspaces/{id}":                                                    scopeAdmin,
	"GET /api/admin/workspaces/{id}/plan/log":                                           scopeAdmin,
	"GET /api/boards/{id}/forms":                                                        scopeBoard,
	"POST /api/boards/{id}/forms":                                                       scopeBoard,
	"PUT /api/boards/{id}/forms/{fid}":                                                  scopeBoard,
	"DELETE /api/boards/{id}/forms/{fid}":                                               scopeBoard,
	"POST /api/boards/{id}/forms/preview":                                               scopeBoard,
	"GET /api/forms/{code}":                                                             scopeForm,
	"POST /api/forms/{code}/submissions":                                                scopeForm,
	"GET /api/public/forms/{code}":                                                      scopePublic,
	"POST /api/public/forms/{code}/submissions":                                         scopePublic,

	"GET /api/workspaces/{id}/achievements":                               scopeWorkspace,
	"POST /api/workspaces/{id}/achievements":                              scopeWorkspace,
	"PATCH /api/achievements/{id}":                                        scopeAchievement,
	"DELETE /api/achievements/{id}":                                       scopeAchievement,
	"GET /api/workspaces/{id}/members/{userId}/achievements":              scopeWorkspace,
	"POST /api/workspaces/{id}/members/{userId}/achievements":             scopeWorkspace,
	"DELETE /api/workspaces/{id}/members/{userId}/achievements/{grantId}": scopeWorkspace,
	"GET /api/boards/{id}":                                                scopeBoard,
	"GET /api/boards/{id}/activity":                                       scopeBoard,
	"GET /api/boards/{id}/permissions":                                    scopeBoard,
	"GET /api/boards/{id}/tasks":                                          scopeBoard,
	"GET /api/boards/{id}/views":                                          scopeBoard,
	"GET /api/bots/me":                                                    scopeMachine,
	"GET /api/bots/me/webhook":                                            scopeMachine,
	"GET /api/bots/{ref}":                                                 scopeGlobal,
	"GET /api/dms":                                                        scopeGlobal,
	"GET /api/dms/candidates":                                             scopeGlobal,
	"GET /api/event-rsvp":                                                 scopeCapability,
	"GET /api/events/{id}":                                                scopeEvent,
	"GET /api/files/{id}":                                                 scopeFile,
	"GET /api/files/{id}/thumbnail":                                       scopeFile,
	"GET /api/invites/{code}":                                             scopeCapability,
	"GET /api/me":                                                         scopeProfile,
	"GET /api/me/blocked-bots":                                            scopeGlobal,
	"GET /api/me/caldav":                                                  scopeGlobal,
	"GET /api/me/events/today":                                            scopeAggregate,
	"GET /api/me/external-events":                                         scopeGlobal,
	"GET /api/me/mentions":                                                scopeAggregate,
	"GET /api/me/sessions":                                                scopeGlobal,
	"GET /api/me/sticker-packs":                                           scopeAggregate,
	"GET /api/me/tasks":                                                   scopeAggregate,
	"GET /api/search":                                                     scopeAggregate,
	"GET /api/messages/{id}/reactions/{emoji}":                            scopeMessage,
	"GET /api/notes":                                                      scopeGlobal,
	"GET /api/room-invites/{code}":                                        scopeCapability,
	"GET /api/rooms/{id}":                                                 scopeRoom,
	"GET /api/rooms/{id}/admissions":                                      scopeRoom,
	"GET /api/rooms/{id}/bot-commands":                                    scopeRoom,
	"GET /api/rooms/{id}/invites":                                         scopeRoom,
	"GET /api/rooms/{id}/messages":                                        scopeRoom,
	"GET /api/rooms/{id}/messages/{messageId}":                            scopeRoom,
	"GET /api/rooms/{id}/pins":                                            scopeRoom,
	"GET /api/rooms/{id}/recordings/{rid}/transcript":                     scopeRoom,
	"GET /api/sticker-packs/{id}":                                         scopePack,
	"GET /api/t/{key}":                                                    scopeAggregate,
	"GET /api/tasks/{id}":                                                 scopeTask,
	"GET /api/tasks/{id}/activity":                                        scopeTask,
	"GET /api/unfurl":                                                     scopeGlobal,
	"GET /api/unfurl/image":                                               scopeGlobal,
	"GET /api/users/{id}/note":                                            scopeGlobal,
	"GET /api/version":                                                    scopePublic,
	"GET /api/workspaces":                                                 scopeAggregate,
	"GET /api/workspaces/discover":                                        scopeGlobal,
	"GET /api/workspaces/{id}":                                            scopeWorkspace,
	"GET /api/workspaces/{id}/apps":                                       scopeWorkspace,
	"GET /api/workspaces/{id}/backgrounds":                                scopeWorkspace,
	"GET /api/workspaces/{id}/badges":                                     scopeWorkspace,
	"GET /api/workspaces/{id}/bans":                                       scopeWorkspace,
	"GET /api/workspaces/{id}/birthdays":                                  scopeWorkspace,
	"GET /api/workspaces/{id}/boards":                                     scopeWorkspace,
	"GET /api/workspaces/{id}/bots":                                       scopeWorkspace,
	"GET /api/workspaces/{id}/calls":                                      scopeWorkspace,
	"GET /api/workspaces/{id}/categories":                                 scopeWorkspace,
	"GET /api/workspaces/{id}/events":                                     scopeWorkspace,
	"GET /api/workspaces/{id}/freebusy":                                   scopeWorkspace,
	"GET /api/workspaces/{id}/integrations/gptunnel":                      scopeWorkspace,
	"GET /api/workspaces/{id}/invites":                                    scopeWorkspace,
	"GET /api/workspaces/{id}/invites/email":                              scopeWorkspace,
	"GET /api/workspaces/{id}/members":                                    scopeWorkspace,
	"GET /api/workspaces/{id}/members/birthdays":                          scopeWorkspace,
	"GET /api/workspaces/{id}/members/{userId}":                           scopeWorkspace,
	"GET /api/workspaces/{id}/messages/search":                            scopeWorkspace,
	"GET /api/workspaces/{id}/roles":                                      scopeWorkspace,
	"GET /api/workspaces/{id}/rooms":                                      scopeWorkspace,
	"GET /api/workspaces/{id}/sip":                                        scopeWorkspace,
	"GET /api/workspaces/{id}/sounds":                                     scopeWorkspace,
	"GET /api/workspaces/{id}/sticker-packs":                              scopeWorkspace,
	"GET /api/workspaces/{id}/tasks/search":                               scopeWorkspace,
	"GET /gateway":                                                        scopePublic,
	"GET /healthz":                                                        scopePublic,
	"GET /metrics":                                                        scopePublic,
	"GET /readyz":                                                         scopePublic,
	"PATCH /api/boards/{id}":                                              scopeBoard,
	"PATCH /api/boards/{id}/labels/{sid}":                                 scopeBoard,
	"PATCH /api/boards/{id}/milestones/{sid}":                             scopeBoard,
	"PATCH /api/boards/{id}/statuses/{sid}":                               scopeBoard,
	"PATCH /api/boards/{id}/views/{sid}":                                  scopeBoard,
	"PATCH /api/bots/me":                                                  scopeMachine,
	"PATCH /api/categories/{id}":                                          scopeCategory,
	"PATCH /api/dms/{id}/state":                                           scopeGlobal,
	"PATCH /api/events/{id}":                                              scopeEvent,
	"PATCH /api/me":                                                       scopeGlobal,
	"GET /api/usernames/{name}/available":                                 scopeGlobal,
	"PATCH /api/me/caldav":                                                scopeGlobal,
	"PATCH /api/me/email":                                                 scopeGlobal,
	"PATCH /api/me/password":                                              scopeGlobal,
	"PATCH /api/me/status":                                                scopeGlobal,
	"PATCH /api/messages/{id}":                                            scopeMessage,
	"PATCH /api/notes/{id}":                                               scopeGlobal,
	"PATCH /api/rooms/{id}":                                               scopeRoom,
	"PATCH /api/rooms/{id}/invites/{inviteId}":                            scopeRoom,
	"PATCH /api/rooms/{id}/voice-status":                                  scopeRoom,
	"PATCH /api/sticker-packs/{id}":                                       scopePack,
	"PATCH /api/stickers/{id}":                                            scopeSticker,
	"PATCH /api/tasks/{id}":                                               scopeTask,
	"PATCH /api/voice/self":                                               scopeVoice,
	"PATCH /api/workspace-apps/{appId}":                                   scopeApp,
	"PATCH /api/workspaces/{id}":                                          scopeWorkspace,
	"PATCH /api/workspaces/{id}/backgrounds/{bgId}":                       scopeWorkspace,
	"PATCH /api/workspaces/{id}/badges/{badgeId}":                         scopeWorkspace,
	"PATCH /api/workspaces/{id}/members/{userId}":                         scopeWorkspace,
	"PATCH /api/workspaces/{id}/members/{userId}/birthday":                scopeWorkspace,
	"PATCH /api/workspaces/{id}/roles/{roleId}":                           scopeWorkspace,
	"PATCH /api/workspaces/{id}/sounds/{soundId}":                         scopeWorkspace,
	"POST /api/auth/login":                                                scopePublic,
	"POST /api/auth/logout":                                               scopePublic,
	"POST /api/auth/password/forgot":                                      scopePublic,
	"POST /api/auth/password/reset":                                       scopePublic,
	"POST /api/auth/refresh":                                              scopePublic,
	"POST /api/auth/register":                                             scopePublic,
	"POST /api/auth/verify":                                               scopeGlobal,
	"POST /api/auth/verify/send":                                          scopeGlobal,
	"POST /api/boards/{id}/files":                                         scopeBoard,
	"POST /api/boards/{id}/labels":                                        scopeBoard,
	"POST /api/boards/{id}/milestones":                                    scopeBoard,
	"POST /api/boards/{id}/restore":                                       scopeBoard,
	"POST /api/boards/{id}/statuses":                                      scopeBoard,
	"POST /api/boards/{id}/tasks":                                         scopeBoard,
	"POST /api/boards/{id}/views":                                         scopeBoard,
	"POST /api/calls/{id}/accept":                                         scopeGlobal,
	"POST /api/calls/{id}/cancel":                                         scopeGlobal,
	"POST /api/calls/{id}/decline":                                        scopeGlobal,
	"POST /api/calls/{id}/hangup":                                         scopeGlobal,
	"POST /api/dms":                                                       scopeGlobal,
	"POST /api/dms/{id}/call":                                             scopeGlobal,
	"POST /api/dms/{id}/files":                                            scopeGlobal,
	"POST /api/event-rsvp":                                                scopeCapability,
	"POST /api/files/convert":                                             scopeGlobal,
	"POST /api/invites/{code}/join":                                       scopeAdmission,
	"POST /api/me/avatar":                                                 scopeGlobal,
	"POST /api/me/blocked-bots/{id}":                                      scopeGlobal,
	"POST /api/me/caldav":                                                 scopeGlobal,
	"POST /api/me/caldav/sync":                                            scopeGlobal,
	"POST /api/me/external-events/rsvp":                                   scopeGlobal,
	"POST /api/messages/{id}/interactions":                                scopeMessage,
	"POST /api/notes":                                                     scopeGlobal,
	"POST /api/room-invites/{code}/join":                                  scopeCapability,
	"POST /api/rooms/{id}/admissions/{userId}":                            scopeRoom,
	"POST /api/rooms/{id}/calls":                                          scopeRoom,
	"POST /api/rooms/{id}/camera/request":                                 scopeRoom,
	"POST /api/rooms/{id}/camera/stop":                                    scopeRoom,
	"POST /api/rooms/{id}/invites":                                        scopeRoom,
	"POST /api/rooms/{id}/join":                                           scopeRoom,
	"POST /api/rooms/{id}/messages":                                       scopeRoom,
	"POST /api/rooms/{id}/messages/{mid}/forward":                         scopeRoom,
	"POST /api/rooms/{id}/recording/start":                                scopeRoom,
	"POST /api/rooms/{id}/recording/stop":                                 scopeRoom,
	"POST /api/rooms/{id}/recordings/{rid}/recheck":                       scopeRoom,
	"POST /api/rooms/{id}/recordings/{rid}/reupload":                      scopeRoom,
	"POST /api/rooms/{id}/sounds/play":                                    scopeRoom,
	"POST /api/rooms/{id}/stream/request":                                 scopeRoom,
	"POST /api/rooms/{id}/voice/leave":                                    scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/allow-camera":                    scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/disconnect":                      scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/move":                            scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/mute":                            scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/stop-camera":                     scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/stop-stream":                     scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/unmute":                          scopeRoom,
	"POST /api/rtc/webhook":                                               scopePublic,
	"POST /api/sticker-packs/{id}/stickers":                               scopePack,
	"POST /api/tasks/{id}/approval":                                       scopeTask,
	"POST /api/tasks/{id}/archive":                                        scopeTask,
	"POST /api/tasks/{id}/restore":                                        scopeTask,
	"POST /api/workspaces":                                                scopeGlobal,
	"POST /api/workspaces/{id}/apps":                                      scopeWorkspace,
	"POST /api/workspaces/{id}/backgrounds":                               scopeWorkspace,
	"POST /api/workspaces/{id}/badges":                                    scopeWorkspace,
	"POST /api/workspaces/{id}/bans":                                      scopeWorkspace,
	"POST /api/workspaces/{id}/boards":                                    scopeWorkspace,
	"POST /api/workspaces/{id}/bots":                                      scopeWorkspace,
	"POST /api/workspaces/{id}/bots/add":                                  scopeWorkspace,
	"POST /api/workspaces/{id}/bots/{botId}/avatar":                       scopeWorkspace,
	"POST /api/workspaces/{id}/bots/{botId}/token":                        scopeWorkspace,
	"POST /api/workspaces/{id}/categories":                                scopeWorkspace,
	"POST /api/workspaces/{id}/events":                                    scopeWorkspace,
	"POST /api/workspaces/{id}/files":                                     scopeWorkspace,
	"POST /api/workspaces/{id}/freebusy/suggest":                          scopeWorkspace,
	"POST /api/workspaces/{id}/integrations/gptunnel":                     scopeWorkspace,
	"POST /api/workspaces/{id}/invites":                                   scopeWorkspace,
	"POST /api/workspaces/{id}/invites/email":                             scopeWorkspace,
	"POST /api/workspaces/{id}/invites/lookup":                            scopeWorkspace,
	"POST /api/workspaces/{id}/join":                                      scopeAdmission,
	"POST /api/workspaces/{id}/members":                                   scopeWorkspace,
	"POST /api/workspaces/{id}/members/{userId}/promote":                  scopeWorkspace,
	"POST /api/workspaces/{id}/roles":                                     scopeWorkspace,
	"POST /api/workspaces/{id}/rooms":                                     scopeWorkspace,
	"POST /api/workspaces/{id}/rooms/temp":                                scopeWorkspace,
	"POST /api/workspaces/{id}/sip/test":                                  scopeWorkspace,
	"POST /api/workspaces/{id}/sounds":                                    scopeWorkspace,
	"POST /api/workspaces/{id}/sticker-packs":                             scopeWorkspace,
	"PUT /api/admin/users/{id}/storage-quota":                             scopeAdmin,
	"PUT /api/admin/workspaces/{id}/plan":                                 scopeAdmin,
	"PUT /api/admin/workspaces/{id}/suspension":                           scopeAdmin,
	"PUT /api/boards/{id}/permissions":                                    scopeBoard,
	"PUT /api/boards/{id}/position":                                       scopeBoard,
	"PUT /api/bots/me/commands":                                           scopeMachine,
	"PUT /api/bots/me/webhook":                                            scopeMachine,
	"PUT /api/events/{id}/rsvp":                                           scopeEvent,
	"PUT /api/me/caldav":                                                  scopeGlobal,
	"PUT /api/me/sticker-packs/order":                                     scopeGlobal,
	"PUT /api/me/sticker-packs/{id}":                                      scopeGlobal,
	"PUT /api/messages/{id}/embeds-hidden":                                scopeMessage,
	"PUT /api/messages/{id}/pin":                                          scopeMessage,
	"PUT /api/messages/{id}/reactions/{emoji}":                            scopeMessage,
	"PUT /api/rooms/{id}/notifications":                                   scopeRoom,
	"PUT /api/rooms/{id}/permissions":                                     scopeRoom,
	"PUT /api/rooms/{id}/read":                                            scopeRoom,
	"PUT /api/sticker-packs/{id}/stickers/{sid}":                          scopePack,
	"PUT /api/tasks/{id}/approvers":                                       scopeTask,
	"PUT /api/tasks/{id}/assignees":                                       scopeTask,
	"PUT /api/tasks/{id}/read":                                            scopeTask,
	"PUT /api/tasks/{id}/relations":                                       scopeTask,
	"PUT /api/tasks/{id}/subscription":                                    scopeTask,
	"PUT /api/tasks/{id}/watchers":                                        scopeTask,
	"PUT /api/users/{id}/note":                                            scopeGlobal,
	"PUT /api/workspace-apps/{appId}/position":                            scopeApp,
	"PUT /api/workspaces/{id}/members/{userId}/badge":                     scopeWorkspace,
	"PUT /api/workspaces/{id}/members/{userId}/roles":                     scopeWorkspace,
	"PUT /api/workspaces/{id}/notifications":                              scopeWorkspace,
	"PUT /api/workspaces/{id}/roles/order":                                scopeWorkspace,
	"PUT /api/workspaces/{id}/rooms/order":                                scopeWorkspace,
	"PUT /api/workspaces/{id}/sip":                                        scopeWorkspace,
	// Boards 2.0 (ADR-0058).
	"GET /api/workspaces/{id}/board-categories":  scopeWorkspace,
	"POST /api/workspaces/{id}/board-categories": scopeWorkspace,
	"PUT /api/workspaces/{id}/boards/order":      scopeWorkspace,
	"PATCH /api/board-categories/{id}":           scopeBoardCategory,
	"DELETE /api/board-categories/{id}":          scopeBoardCategory,
	"POST /api/tasks/{id}/checklists":            scopeTask,
	"PATCH /api/checklists/{id}":                 scopeChecklist,
	"DELETE /api/checklists/{id}":                scopeChecklist,
	"POST /api/checklists/{id}/items":            scopeChecklist,
	"PATCH /api/checklist-items/{id}":            scopeChecklistItem,
	"DELETE /api/checklist-items/{id}":           scopeChecklistItem,
	"POST /api/checklist-items/{id}/convert":     scopeChecklistItem,
	"POST /api/tasks/{id}/milestones":            scopeTask,
	"PATCH /api/task-milestones/{id}":            scopeTaskMilestone,
	"DELETE /api/task-milestones/{id}":           scopeTaskMilestone,
	"GET /api/boards/{id}/webhook":               scopeBoard,
	"PUT /api/boards/{id}/webhook":               scopeBoard,
	"DELETE /api/boards/{id}/webhook":            scopeBoard,
	"POST /api/boards/{id}/webhook/ping":         scopeBoard,
	// Automations (ADR-0060). The repository delivery is public like POST /api/rtc/webhook:
	// no session, the hosting signs it with the board's secret.
	"GET /api/boards/{id}/rules":           scopeBoard,
	"POST /api/boards/{id}/rules":          scopeBoard,
	"PATCH /api/rules/{id}":                scopeRule,
	"DELETE /api/rules/{id}":               scopeRule,
	"POST /api/rules/{id}/test":            scopeRule,
	"GET /api/rules/{id}/runs":             scopeRule,
	"GET /api/boards/{id}/git":             scopeBoard,
	"PUT /api/boards/{id}/git":             scopeBoard,
	"DELETE /api/boards/{id}/git":          scopeBoard,
	"POST /api/git/boards/{id}/{provider}": scopePublic,
	// Balance billing (ADR-0080 v5). The provider webhook is public like POST /api/rtc/webhook
	// (signed body, no session); the return page only redirects into the app.
	"GET /api/workspaces/{id}/billing":                                        scopeBilling,
	"POST /api/workspaces/{id}/billing/quote":                                 scopeBilling,
	"POST /api/workspaces/{id}/billing/activate":                              scopeBilling,
	"POST /api/workspaces/{id}/billing/stop":                                  scopeBilling,
	"POST /api/workspaces/{id}/billing/change-plan":                           scopeBilling,
	"POST /api/workspaces/{id}/billing/resume":                                scopeBilling,
	"GET /api/workspaces/{id}/billing/payer":                                  scopeBilling,
	"PUT /api/workspaces/{id}/billing/payer":                                  scopeBilling,
	"POST /api/workspaces/{id}/billing/topups":                                scopeBilling,
	"GET /api/workspaces/{id}/billing/checkouts/{cid}":                        scopeBilling,
	"GET /api/workspaces/{id}/billing/auto-topup":                             scopeBilling,
	"PUT /api/workspaces/{id}/billing/auto-topup":                             scopeBilling,
	"DELETE /api/workspaces/{id}/billing/auto-topup":                          scopeBilling,
	"GET /api/workspaces/{id}/billing/payment-methods":                        scopeBilling,
	"DELETE /api/workspaces/{id}/billing/payment-methods/{pmId}":              scopeBilling,
	"GET /api/workspaces/{id}/billing/ledger":                                 scopeBilling,
	"GET /api/workspaces/{id}/billing/payments":                               scopeBilling,
	"GET /api/workspaces/{id}/billing/refund-requests":                        scopeBilling,
	"POST /api/workspaces/{id}/billing/refund-requests":                       scopeBilling,
	"GET /api/admin/billing/accounts":                                         scopeAdmin,
	"GET /api/admin/billing/accounts/{id}":                                    scopeAdmin,
	"GET /api/admin/billing/accounts/{id}/ledger":                             scopeAdmin,
	"GET /api/admin/billing/payments":                                         scopeAdmin,
	"GET /api/admin/billing/refunds":                                          scopeAdmin,
	"GET /api/admin/billing/refund-requests":                                  scopeAdmin,
	"GET /api/admin/billing/disputes":                                         scopeAdmin,
	"GET /api/admin/billing/events":                                           scopeAdmin,
	"POST /api/admin/billing/workspaces/{id}/enable":                          scopeAdmin,
	"POST /api/admin/billing/accounts/{id}/manual-credits":                    scopeAdmin,
	"POST /api/admin/billing/accounts/{id}/manual-credits/{creditId}/reverse": scopeAdmin,
	"POST /api/admin/billing/accounts/{id}/admin-debit":                       scopeAdmin,
	"POST /api/admin/billing/payments/{id}/refunds":                           scopeAdmin,
	"POST /api/admin/billing/refund-requests/{id}/decide":                     scopeAdmin,
	"POST /api/admin/billing/accounts/{id}/hold":                              scopeAdmin,
	"POST /api/admin/billing/accounts/{id}/reconcile":                         scopeAdmin,
	"PUT /api/admin/billing/accounts/{id}/discount":                           scopeAdmin,
	"GET /api/admin/billing/prices":                                           scopeAdmin,
	"POST /api/admin/billing/prices":                                          scopeAdmin,
	"POST /api/admin/billing/test-clock":                                      scopeAdmin,
	"POST /api/billing/stripe/webhook":                                        scopePublic,
	"GET /api/billing/return":                                                 scopePublic,
}

func identityGate(q *sqlc.Queries, a *auth.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := auth.MustFromContext(r.Context())
		scope, ok := identityRoutes[r.Pattern]
		if !ok {
			httpx.WriteError(w, r, httpx.Forbidden("unclassified identity route"))
			return
		}
		// Public catalog metadata is safe for scoped sessions, like the aggregate pack list.
		if r.Pattern == "GET /api/sticker-packs/{id}" && strings.EqualFold(r.PathValue("id"), builtinstickers.PackID()) {
			scope = scopeAggregate
		}
		op := identitypolicy.WorkspaceWrite
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			op = identitypolicy.WorkspaceRead
		}
		if scope == scopeBilling || billingRecoveryRoutes[r.Pattern] {
			// The owner's recovery scope stays open under a billing suspension (ADR-0080 §12).
			op = identitypolicy.BillingWrite
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				op = identitypolicy.BillingRead
			}
		}
		ctx := a.WithPolicy(r.Context(), id, op)
		r = r.WithContext(ctx)
		// The typed file handler checks every live reference with this exact policy
		// context; the source workspace is not the only possible reading authority.
		if scope == scopeFile && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			next.ServeHTTP(w, r)
			return
		}
		var err error
		mutation := auth.MutationOptions{}
		switch scope {
		case scopeGlobal:
			mutation.Global, mutation.ExclusiveUser = true, true
			if !id.IsBot {
				err = a.CheckGlobal(ctx, id, identitypolicy.GlobalRead)
			}
		case scopeAdmin:
			mutation.Admin, mutation.Global, mutation.ExclusiveUser = true, true, true
			mutation.ExclusiveWorkspace = true
			if strings.Contains(r.Pattern, "/workspaces/{id}") {
				mutation.Workspace, _ = httpx.PathUUID(r, "id", "workspace") // handler validates the ID after authority
			}
			err = a.CheckGlobal(ctx, id, identitypolicy.ProductAdmin)
		case scopeProfile, scopeAggregate:
			if id.Principal.Authority == identitypolicy.Recovery {
				err = httpx.Coded(403, v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY, "recovery only")
			}
		case scopeMachine:
			mutation.Global, mutation.ExclusiveUser = true, true
			if !id.IsBot {
				err = auth.ErrBotNotAllowed
			}
		case scopeAdmission:
			mutation.Admission, mutation.ExclusiveWorkspace = true, true
			mutation.OpenAdmission = r.PathValue("code") == ""
			var ws uuid.UUID
			if r.PathValue("code") != "" {
				row, e := q.GetInviteByCode(ctx, r.PathValue("code"))
				ws, err = row.WorkspaceID, e
				if db.IsNotFound(err) {
					err = auth.ErrInviteInvalid()
				}
			} else {
				ws, err = httpx.PathUUID(r, "id", "workspace")
			}
			if err == nil {
				mutation.Workspace = ws
				if r.PathValue("code") != "" {
					err = a.CheckGlobal(ctx, id, identitypolicy.GlobalWrite)
				} else {
					err = a.CheckAdmission(ctx, id, ws)
				}
			}
		case scopePublic:
		case scopeVoice:
			if !id.IsBot && id.Principal.Authority == identitypolicy.Recovery {
				err = a.CheckGlobal(ctx, id, identitypolicy.GlobalWrite)
			}
		default:
			var ws uuid.UUID
			ws, err = identityTarget(r, q, scope)
			mutation.Workspace = ws
			mutation.Global = ws == uuid.Nil
			mutation.ExclusiveUser = ws == uuid.Nil
			mutation.ExclusiveWorkspace = scope == scopeWorkspace || scope == scopeBilling
			mutation.Billing = scope == scopeBilling
			if strings.HasSuffix(r.Pattern, "/members/{userId}/birthday") {
				mutation.TargetUser, err = httpx.PathUUID(r, "userId", "user")
			}
			if r.PathValue("botId") != "" {
				mutation.TargetUser, err = httpx.PathUUID(r, "botId", "bot")
			}
			if db.IsNotFound(err) {
				err = httpx.NotFound("resource")
			}
			if err == nil {
				if ws == uuid.Nil {
					if !id.IsBot {
						err = a.CheckGlobal(ctx, id, identitypolicy.GlobalRead)
					}
				} else {
					err = a.CheckWorkspace(ctx, id, ws, op)
				}
			}
		}
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && scope != scopePublic {
			r = r.WithContext(a.WithMutation(ctx, id, mutation))
		}
		next.ServeHTTP(w, r)
	})
}

func identityTarget(r *http.Request, q *sqlc.Queries, sc identityScope) (uuid.UUID, error) {
	if sc == scopeForm {
		return q.GetBoardFormWorkspace(r.Context(), r.PathValue("code"))
	}
	ctx := r.Context()
	if sc == scopeCapability {
		row, err := q.GetInviteByCode(ctx, r.PathValue("code"))
		return row.WorkspaceID, err
	}
	raw := r.PathValue("id")
	if sc == scopeApp {
		raw = r.PathValue("appId")
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, httpx.BadRequest("invalid resource id")
	}
	switch sc {
	case scopeWorkspace, scopeBilling:
		return id, nil
	case scopeRoom:
		parent, err := q.GetIdentityRoomParent(ctx, id)
		if parent != nil {
			return *parent, err
		}
		return uuid.Nil, err
	case scopeMessage:
		row, err := q.GetMessage(ctx, id)
		if err != nil {
			return uuid.Nil, err
		}
		parent, err := q.GetIdentityRoomParent(ctx, row.RoomID)
		if parent != nil {
			return *parent, err
		}
		return uuid.Nil, err
	case scopeBoard:
		row, err := q.GetBoard(ctx, id)
		return row.WorkspaceID, err
	case scopeTask:
		row, err := q.GetTaskRow(ctx, id)
		if err != nil {
			return uuid.Nil, err
		}
		board, err := q.GetBoard(ctx, row.BoardID)
		return board.WorkspaceID, err
	case scopeCategory:
		row, err := q.GetCategory(ctx, id)
		return row.WorkspaceID, err
	case scopeBoardCategory:
		row, err := q.GetBoardCategory(ctx, id)
		return row.WorkspaceID, err
	case scopeChecklist:
		return q.GetChecklistWorkspace(ctx, id)
	case scopeChecklistItem:
		return q.GetChecklistItemWorkspace(ctx, id)
	case scopeTaskMilestone:
		return q.GetTaskMilestoneWorkspace(ctx, id)
	case scopeRule:
		return q.GetBoardRuleWorkspace(ctx, id)
	case scopeAchievement:
		row, err := q.GetAchievement(ctx, id)
		return row.WorkspaceID, err
	case scopePack:
		row, err := q.GetStickerPack(ctx, id)
		if row.WorkspaceID != nil {
			return *row.WorkspaceID, err
		}
		return uuid.Nil, err
	case scopeSticker:
		row, err := q.GetSticker(ctx, id)
		return row.WorkspaceID, err
	case scopeEvent:
		row, err := q.GetEvent(ctx, id)
		return row.WorkspaceID, err
	case scopeApp:
		row, err := q.GetWorkspaceApp(ctx, id)
		return row.WorkspaceID, err
	case scopeFile:
		row, err := q.GetFile(ctx, id)
		if row.WorkspaceID != nil {
			return *row.WorkspaceID, err
		}
		return uuid.Nil, err
	}
	return uuid.Nil, httpx.Forbidden("unresolved identity scope")
}

// IdentityRouteCovered is used by the runtime route census assertion.
func IdentityRouteCovered(pattern string) bool { _, ok := identityRoutes[pattern]; return ok }

func publicIdentityGate(q *sqlc.Queries, previews *redisx.RateLimiter) func(string, http.Handler) http.Handler {
	return func(pattern string, next http.Handler) http.Handler {
		if pattern != "GET /api/invites/{code}" && pattern != "GET /api/room-invites/{code}" && pattern != "POST /api/room-invites/{code}/join" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if pattern == "GET /api/invites/{code}" && previews != nil {
				if err := previews.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
					httpx.WriteError(w, r, err)
					return
				}
			}
			if pattern == "POST /api/room-invites/{code}/join" && auth.IsBotRequest(r) {
				httpx.WriteError(w, r, auth.ErrBotNotAllowed)
				return
			}
			// A join with an account is decided by the guests handler: a fresh local_account
			// principal (CheckGlobal GlobalWrite) and, in an enforced workspace, a current SSO
			// assurance of that session, checked inside its transaction. Account-less joins
			// and previews stay public capabilities refused by an enforced policy here.
			if pattern == "POST /api/room-invites/{code}/join" && auth.HasBearer(r) {
				next.ServeHTTP(w, r)
				return
			}
			var ws uuid.UUID
			var err error
			if pattern == "GET /api/invites/{code}" {
				row, e := q.GetInviteByCode(r.Context(), r.PathValue("code"))
				ws, err = row.WorkspaceID, e
				if db.IsNotFound(err) {
					err = auth.ErrInviteInvalid()
				}
			} else {
				row, e := q.GetRoomInviteByCode(r.Context(), r.PathValue("code"))
				ws, err = row.Workspace.ID, e
			}
			if err == nil {
				err = auth.CheckPublicCapability(r.Context(), q, ws)
			}
			if err != nil {
				if db.IsNotFound(err) {
					err = httpx.NotFound("invite")
				}
				httpx.WriteError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// IdentityRouteClass exposes the explicit registry for adversarial route coverage tests.
func IdentityRouteClass(pattern string) string {
	switch identityRoutes[pattern] {
	case scopeGlobal:
		return "global"
	case scopeAdmin:
		return "admin"
	case scopeWorkspace, scopeBilling:
		return "workspace"
	case scopeRoom:
		return "room"
	case scopeMessage:
		return "message"
	case scopeBoard:
		return "board"
	case scopeForm:
		return "form"
	case scopeTask:
		return "task"
	case scopeFile:
		return "file"
	case scopeCategory:
		return "category"
	case scopeBoardCategory:
		return "board_category"
	case scopeChecklist:
		return "checklist"
	case scopeChecklistItem:
		return "checklist_item"
	case scopeTaskMilestone:
		return "task_milestone"
	case scopeRule:
		return "rule"
	case scopePack:
		return "pack"
	case scopeSticker:
		return "sticker"
	case scopeEvent:
		return "event"
	case scopeApp:
		return "app"
	case scopeAchievement:
		return "achievement"
	default:
		return "specialized"
	}
}
