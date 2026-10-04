import {
  GetSipSettingsResponseSchema,
  ListSipCallsResponseSchema,
  PlaceSipCallRequestSchema,
  PutSipSettingsRequestSchema,
  PutSipSettingsResponseSchema,
  SipCallResponseSchema,
  TestSipResponseSchema,
  CreateNotesRequestSchema,
  CreateNotesResponseSchema,
  ListNotesResponseSchema,
  UpdateNotesRequestSchema,
  UpdateNotesResponseSchema,
  GetVersionResponseSchema,
  CalendarEventResponseSchema,
  CreateCalendarEventRequestSchema,
  EventRsvpTokenRequestSchema,
  EventRsvpTokenResponseSchema,
  ListCalendarEventsResponseSchema,
  RsvpCalendarEventRequestSchema,
  TodayCalendarEventsResponseSchema,
  UpdateCalendarEventRequestSchema,
  type AttendeeStatus,
  CreateSoundRequestSchema,
  ListSoundsResponseSchema,
  PlaySoundRequestSchema,
  SoundResponseSchema,
  UpdateSoundRequestSchema,
  AdminGetWorkspaceResponseSchema,
  AdminPlanLogResponseSchema,
  AdminSearchWorkspacesResponseSchema,
  AdminSetPlanRequestSchema,
  AdminSetPlanResponseSchema,
  AdminSetSuspensionRequestSchema,
  AdminSetSuspensionResponseSchema,
  CreateBanRequestSchema,
  CreateBanResponseSchema,
  ListBansResponseSchema,
  RequestCameraRequestSchema,
  RequestCameraResponseSchema,
  PutUserNoteRequestSchema,
  UserNoteResponseSchema,
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  CreateInviteRequestSchema,
  CreateRoomInviteRequestSchema,
  CreateRoomInviteResponseSchema,
  GetRoomInviteResponseSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  ListRoomInvitesResponseSchema,
  CreateInviteResponseSchema,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  CallActionResponseSchema,
  StartCallResponseSchema,
  ListDmCandidatesResponseSchema,
  UpdateDmStateRequestSchema,
  UpdateDmStateResponseSchema,
  ListDmsResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  CreateTempRoomRequestSchema,
  TempRoomResponseSchema,
  ListRoomsResponseSchema,
  SetRoomOrderRequestSchema,
  SetRoomOrderResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DiscoverWorkspacesResponseSchema,
  GetInviteResponseSchema,
  GetMeResponseSchema,
  GetRoomResponseSchema,
  JoinVoiceResponseSchema,
  JoinWorkspaceResponseSchema,
  ListInvitesResponseSchema,
  ListBirthdaysResponseSchema,
  ListMemberBirthdaysResponseSchema,
  ListMembersResponseSchema,
  ListMessagesResponseSchema,
  ListReactionUsersResponseSchema,
  MoveMemberRequestSchema,
  ListSessionsResponseSchema,
  RequestStreamRequestSchema,
  RequestStreamResponseSchema,
  SetRoomPermissionsRequestSchema,
  SetRoomPermissionsResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  UpdateMeRequestSchema,
  UpdateMemberBirthdayRequestSchema,
  UpdateMemberBirthdayResponseSchema,
  UpdateMeResponseSchema,
  UpdateMemberRequestSchema,
  UpdateMemberResponseSchema,
  ListRolesResponseSchema,
  CreateRoleRequestSchema,
  CreateRoleResponseSchema,
  UpdateRoleRequestSchema,
  UpdateRoleResponseSchema,
  SetRoleOrderRequestSchema,
  SetRoleOrderResponseSchema,
  SetMemberRolesRequestSchema,
  SetMemberRolesResponseSchema,
  ListBadgesResponseSchema,
  ListAchievementsResponseSchema,
  ListMemberAchievementsResponseSchema,
  MemberAchievementSchema,
  GrantAchievementRequestSchema,
  AchievementSchema,
  CreateAchievementRequestSchema,
  UpdateAchievementRequestSchema,
  ListBackgroundsResponseSchema,
  CreateBackgroundRequestSchema,
  CreateBackgroundResponseSchema,
  UpdateBackgroundRequestSchema,
  UpdateBackgroundResponseSchema,
  CreateBadgeRequestSchema,
  CreateWorkspaceAppRequestSchema,
  CreateWorkspaceAppResponseSchema,
  ListWorkspaceAppsResponseSchema,
  SetWorkspaceAppPositionRequestSchema,
  SetWorkspaceAppPositionResponseSchema,
  UpdateWorkspaceAppRequestSchema,
  UpdateWorkspaceAppResponseSchema,
  CreateBadgeResponseSchema,
  UpdateBadgeRequestSchema,
  UpdateBadgeResponseSchema,
  SetMemberBadgeRequestSchema,
  SetMemberBadgeResponseSchema,
  UpdateStatusRequestSchema,
  UpdateMessageRequestSchema,
  MessageSchema,
  CreateMessageInteractionRequestSchema,
  CreateMessageInteractionResponseSchema,
  UpdateMessageResponseSchema,
  SetEmbedsHiddenRequestSchema,
  ForwardMessageRequestSchema,
  ForwardMessageResponseSchema,
  UpdateReadStateRequestSchema,
  UnfurlResponseSchema,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  UpdateRoomNotificationSettingsRequestSchema,
  UpdateRoomNotificationSettingsResponseSchema,
  UpdateWorkspaceNotificationSettingsRequestSchema,
  UpdateWorkspaceNotificationSettingsResponseSchema,
  UpdateVoiceSelfRequestSchema,
  UpdateVoiceStatusRequestSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  UploadFileResponseSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  ResetPasswordRequestSchema,
  InviteLookupRequestSchema,
  InviteLookupResponseSchema,
  AddMemberRequestSchema,
  AddMemberResponseSchema,
  CreateEmailInviteRequestSchema,
  CreateEmailInviteResponseSchema,
  ListEmailInvitesResponseSchema,
  GetGptunnelIntegrationResponseSchema,
  PairGptunnelRequestSchema,
  PairGptunnelResponseSchema,
  StartRecordingResponseSchema,
  StopRecordingResponseSchema,
  RetryRecordingResponseSchema,
  GetRecordingTranscriptResponseSchema,
  CreateStickerPackRequestSchema,
  ListStickerPacksResponseSchema,
  MyStickerPacksResponseSchema,
  SetStickerPackOrderRequestSchema,
  StickerPackResponseSchema,
  UpdateStickerPackRequestSchema,
  UpdateStickerRequestSchema,
  UploadStickersResponseSchema,
  AddBotRequestSchema,
  AddBotResponseSchema,
  CreateBotRequestSchema,
  CreateBotResponseSchema,
  GetBotMeResponseSchema,
  ListBlockedBotsResponseSchema,
  ListBotsResponseSchema,
  ListRoomBotCommandsResponseSchema,
  ReissueBotTokenResponseSchema,
  SetBotAvatarResponseSchema,
  SearchResponseSchema,
  type StickerPackResponse,
  type UploadStickersResponse,
  type FileMeta,
  type ScreenSharePreset,
  type WorkspaceRole,
} from '@calaba/protocol';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { platform } from '../../platform';
import { ApiError, apiUrl, body, call, callEmpty, qs, toApiError } from './client';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

// Every REST endpoint the client uses, typed by the generated contract (docs/05, "REST").

export const api = {
  /** Public build info; the web compares its bundle with it (docs/09 #125, «Обновить страницу»). */
  version: () => call('GET', '/api/version', GetVersionResponseSchema),
  /**
   * Unified search (ADR-0062): `q`, `scope` (workspace id | all), `types` / `type`, `limit`,
   * `cursor`, `sort` — built by lib/search/query.ts. 429 RATE_LIMITED, 422 for a query without words.
   */
  search: (p: Record<string, string>, signal?: AbortSignal) => call('GET', `/api/search${qs(p)}`, SearchResponseSchema, undefined, signal),
  /** Email verification and password reset (ADR-0023). */
  auth: {
    /** 204: a code to me.pendingEmail or me.email; 409 = already verified; 429 + Retry-After. */
    sendVerification: () => callEmpty('POST', '/api/auth/verify/send'),
    /** 422 CODE_INVALID (message: attempts left) | CODE_EXPIRED. */
    verify: (code: string) => call('POST', '/api/auth/verify', VerifyEmailResponseSchema, body(VerifyEmailRequestSchema, { code })),
    /** No session needed; same answer whether or not the address has an account, except similarAccount (docs/09 #137). 503 = no mail. */
    forgotPassword: (email: string) =>
      call('POST', '/api/auth/password/forgot', ForgotPasswordResponseSchema, body(ForgotPasswordRequestSchema, { email })),
    /** 204, every session revoked (sign in again); 422 CODE_INVALID for a wrong code or address. */
    resetPassword: (init: MessageInitShape<typeof ResetPasswordRequestSchema>) =>
      callEmpty('POST', '/api/auth/password/reset', body(ResetPasswordRequestSchema, init)),
  },
  me: {
    get: () => call('GET', '/api/me', GetMeResponseSchema),
    update: (init: MessageInitShape<typeof UpdateMeRequestSchema>) =>
      call('PATCH', '/api/me', UpdateMeResponseSchema, body(UpdateMeRequestSchema, init)),
    sessions: () => call('GET', '/api/me/sessions', ListSessionsResponseSchema),
    revokeSession: (id: string) => callEmpty('DELETE', `/api/me/sessions/${id}`),
    /** 204; every other session is revoked, this one stays. 403 INVALID_CREDENTIALS = wrong current password. */
    changePassword: (init: MessageInitShape<typeof ChangePasswordRequestSchema>) =>
      callEmpty('PATCH', '/api/me/password', body(ChangePasswordRequestSchema, init)),
    changeEmail: (init: MessageInitShape<typeof ChangeEmailRequestSchema>) =>
      call('PATCH', '/api/me/email', UpdateMeResponseSchema, body(ChangeEmailRequestSchema, init)),
    /** Custom status (text + emoji, optional expiry); empty text and emoji clear it. */
    setStatus: (init: MessageInitShape<typeof UpdateStatusRequestSchema>) =>
      call('PATCH', '/api/me/status', UpdateMeResponseSchema, body(UpdateStatusRequestSchema, init)),
    /** Messages mentioning me in rooms I can view, newest first (cursor `before`, limit ≤ 100). */
    mentions: (p: { limit?: number; before?: string; workspace_id?: string }, signal?: AbortSignal) =>
      call('GET', `/api/me/mentions${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
  },
  users: {
    /** My private note about a user (docs/09 #20); empty text = none. 404 = no shared workspace / DM. */
    note: (userId: string, signal?: AbortSignal) => call('GET', `/api/users/${userId}/note`, UserNoteResponseSchema, undefined, signal),
    /** Upsert; empty text deletes it. */
    setNote: (userId: string, text: string) =>
      call('PUT', `/api/users/${userId}/note`, UserNoteResponseSchema, body(PutUserNoteRequestSchema, { text })),
  },
  workspaces: {
    create: (init: MessageInitShape<typeof CreateWorkspaceRequestSchema>) =>
      call('POST', '/api/workspaces', CreateWorkspaceResponseSchema, body(CreateWorkspaceRequestSchema, init)),
    discover: () => call('GET', '/api/workspaces/discover', DiscoverWorkspacesResponseSchema),
    update: (id: string, init: MessageInitShape<typeof UpdateWorkspaceRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}`, UpdateWorkspaceResponseSchema, body(UpdateWorkspaceRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/workspaces/${id}`),
    joinOpen: (id: string) => call('POST', `/api/workspaces/${id}/join`, JoinWorkspaceResponseSchema),
    /** My notification settings of the workspace; replaces them (MENTIONS without mutedUntil = default). */
    setNotifications: (id: string, init: MessageInitShape<typeof UpdateWorkspaceNotificationSettingsRequestSchema>) =>
      call(
        'PUT',
        `/api/workspaces/${id}/notifications`,
        UpdateWorkspaceNotificationSettingsResponseSchema,
        body(UpdateWorkspaceNotificationSettingsRequestSchema, init),
      ),
    members: (id: string) => call('GET', `/api/workspaces/${id}/members`, ListMembersResponseSchema),
    /** Members' birthdays in the next `days` days, soonest first (docs/09 #76). */
    birthdays: (id: string, days = 7) => call('GET', `/api/workspaces/${id}/birthdays?days=${days}`, ListBirthdaysResponseSchema),
    /** Every member's birthday, hidden ones marked — the admin table (MANAGE_NICKNAMES, docs/09 #77). */
    memberBirthdays: (id: string) => call('GET', `/api/workspaces/${id}/members/birthdays`, ListMemberBirthdaysResponseSchema),
    /** Set (or, without a birthday, clear) a member's birthday; their «hidden» flag stays theirs. */
    setMemberBirthday: (id: string, userId: string, init: MessageInitShape<typeof UpdateMemberBirthdayRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}/members/${userId}/birthday`, UpdateMemberBirthdayResponseSchema, body(UpdateMemberBirthdayRequestSchema, init)),
    updateMember: (id: string, userId: string, init: MessageInitShape<typeof UpdateMemberRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}/members/${userId}`, UpdateMemberResponseSchema, body(UpdateMemberRequestSchema, init)),
    removeMember: (id: string, userId: string) => callEmpty('DELETE', `/api/workspaces/${id}/members/${userId}`),
    /** Guest → member (MANAGE_WORKSPACE; ADR-0016). */
    promoteGuest: (id: string, userId: string) =>
      call('POST', `/api/workspaces/${id}/members/${userId}/promote`, UpdateMemberResponseSchema),
    invites: (id: string) => call('GET', `/api/workspaces/${id}/invites`, ListInvitesResponseSchema),
    createInvite: (id: string, init: MessageInitShape<typeof CreateInviteRequestSchema>) =>
      call('POST', `/api/workspaces/${id}/invites`, CreateInviteResponseSchema, body(CreateInviteRequestSchema, init)),
    deleteInvite: (id: string, inviteId: string) => callEmpty('DELETE', `/api/workspaces/${id}/invites/${inviteId}`),
    /** Invitations by email (ADR-0023): MANAGE_WORKSPACE + a verified address of the caller. */
    lookupInvitee: (id: string, email: string, signal?: AbortSignal) =>
      call('POST', `/api/workspaces/${id}/invites/lookup`, InviteLookupResponseSchema, body(InviteLookupRequestSchema, { email }), signal),
    /** 201: a found (verified) account becomes a member at once; 409 = already a member. */
    addMember: (id: string, userId: string) =>
      call('POST', `/api/workspaces/${id}/members`, AddMemberResponseSchema, body(AddMemberRequestSchema, { userId })),
    emailInvites: (id: string) => call('GET', `/api/workspaces/${id}/invites/email`, ListEmailInvitesResponseSchema),
    /** 201; 429 + Retry-After = the same address was invited < 24 h ago. */
    createEmailInvite: (id: string, email: string, role?: WorkspaceRole) =>
      call(
        'POST',
        `/api/workspaces/${id}/invites/email`,
        CreateEmailInviteResponseSchema,
        body(CreateEmailInviteRequestSchema, role === undefined ? { email } : { email, role }),
      ),
    revokeEmailInvite: (id: string, inviteId: string) => callEmpty('DELETE', `/api/workspaces/${id}/invites/email/${inviteId}`),
    /** Bans (docs/09 #32; MANAGE_WORKSPACE): newest first. */
    bans: (id: string, signal?: AbortSignal) => call('GET', `/api/workspaces/${id}/bans`, ListBansResponseSchema, undefined, signal),
    /** 201: removes the member (if one) and keeps them out (403 BANNED on every way back). */
    ban: (id: string, userId: string, reason: string) =>
      call('POST', `/api/workspaces/${id}/bans`, CreateBanResponseSchema, body(CreateBanRequestSchema, { userId, reason })),
    unban: (id: string, userId: string) => callEmpty('DELETE', `/api/workspaces/${id}/bans/${userId}`),
    /** The member's complete role set (ADR-0026; MANAGE_ROLES) → WORKSPACE_MEMBER_UPDATE. */
    setMemberRoles: (id: string, userId: string, roleIds: readonly string[]) =>
      call('PUT', `/api/workspaces/${id}/members/${userId}/roles`, SetMemberRolesResponseSchema, body(SetMemberRolesRequestSchema, { roleIds: [...roleIds] })),
  },
  /**
   * Member badges (docs/09 #82): the library for any member; create / rename / delete with
   * MANAGE_WORKSPACE; assigning with MANAGE_NICKNAMES (members below my top role, not bots).
   */
  badges: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/badges`, ListBadgesResponseSchema),
    /** 201; 409 = 20 badges already; 422 = bad name / picture. */
    create: (workspaceId: string, name: string, fileId: string) =>
      call('POST', `/api/workspaces/${workspaceId}/badges`, CreateBadgeResponseSchema, body(CreateBadgeRequestSchema, { name, fileId })),
    update: (workspaceId: string, badgeId: string, init: MessageInitShape<typeof UpdateBadgeRequestSchema>) =>
      call('PATCH', `/api/workspaces/${workspaceId}/badges/${badgeId}`, UpdateBadgeResponseSchema, body(UpdateBadgeRequestSchema, init)),
    /** 204: its members lose it (WORKSPACE_MEMBER_UPDATE each, then BADGE_DELETE). */
    remove: (workspaceId: string, badgeId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/badges/${badgeId}`),
    /** "" clears → WORKSPACE_MEMBER_UPDATE. */
    setMember: (workspaceId: string, userId: string, badgeId: string) =>
      call('PUT', `/api/workspaces/${workspaceId}/members/${userId}/badge`, SetMemberBadgeResponseSchema, body(SetMemberBadgeRequestSchema, { badgeId })),
  },
  /**
   * Achievements (ADR-0061, amendment 1): the workspace catalog — read by any member (archived
   * ones included, `archivedAt` set), changed with MANAGE_WORKSPACE; grants per member — list for
   * members, grant / revoke with MANAGE_MEMBERS.
   */
  achievements: {
    catalog: (workspaceId: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/achievements`, ListAchievementsResponseSchema, undefined, signal),
    /** 201; fileId = a PNG / WebP just uploaded to the workspace. 422 IMAGE_NEEDS_ALPHA, 409 ACHIEVEMENT_LIMIT. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateAchievementRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/achievements`, AchievementSchema, body(CreateAchievementRequestSchema, init)),
    /** Unset fields stay; fileId replaces the picture (the create's rules). */
    update: (id: string, init: MessageInitShape<typeof UpdateAchievementRequestSchema>) =>
      call('PATCH', `/api/achievements/${id}`, AchievementSchema, body(UpdateAchievementRequestSchema, init)),
    /** 204; 409 ACHIEVEMENT_IN_USE once granted (archive it instead). */
    remove: (id: string) => callEmpty('DELETE', `/api/achievements/${id}`),
    list: (workspaceId: string, userId: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/members/${userId}/achievements`, ListMemberAchievementsResponseSchema, undefined, signal),
    /** 422: note empty / too long, SELF_GRANT, a guest or bot, an archived achievement. */
    grant: (workspaceId: string, userId: string, init: { achievementId: string; note: string; announce: boolean }) =>
      call('POST', `/api/workspaces/${workspaceId}/members/${userId}/achievements`, MemberAchievementSchema, body(GrantAchievementRequestSchema, init)),
    /** 204; the chat card stays. */
    revoke: (workspaceId: string, userId: string, grantId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/members/${userId}/achievements/${grantId}`),
  },
  /**
   * Web apps of a workspace (ADR-0050): the list for members (not guests); create / edit / delete
   * / move with MANAGE_INTEGRATIONS. The server checks the address (https, http only to private
   * hosts) and never fetches it.
   */
  apps: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/apps`, ListWorkspaceAppsResponseSchema),
    /** 201; 409 = 20 apps already; 422 = bad name / url / icon. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateWorkspaceAppRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/apps`, CreateWorkspaceAppResponseSchema, body(CreateWorkspaceAppRequestSchema, init)),
    /** Unset fields unchanged; iconFileId "" clears. */
    update: (appId: string, init: MessageInitShape<typeof UpdateWorkspaceAppRequestSchema>) =>
      call('PATCH', `/api/workspace-apps/${appId}`, UpdateWorkspaceAppResponseSchema, body(UpdateWorkspaceAppRequestSchema, init)),
    remove: (appId: string) => callEmpty('DELETE', `/api/workspace-apps/${appId}`),
    /** Between two neighbours ("" = first / last); → all apps by position. */
    move: (appId: string, afterAppId: string, beforeAppId: string) =>
      call('PUT', `/api/workspace-apps/${appId}/position`, SetWorkspaceAppPositionResponseSchema, body(SetWorkspaceAppPositionRequestSchema, { afterAppId, beforeAppId })),
  },
  /**
   * Camera backgrounds of a workspace (ADR-0035 addendum): the list for any member; create / rename
   * / delete with MANAGE_WORKSPACE. `fileId` is my upload of this workspace; the server makes the
   * 1280×720 WebP (its thumbnail 320×180) as a new file.
   */
  backgrounds: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/backgrounds`, ListBackgroundsResponseSchema),
    /** 201; 409 = 20 already; 413 = storage quota; 422 = bad name / picture. */
    create: (workspaceId: string, name: string, fileId: string) =>
      call('POST', `/api/workspaces/${workspaceId}/backgrounds`, CreateBackgroundResponseSchema, body(CreateBackgroundRequestSchema, { name, fileId })),
    rename: (workspaceId: string, backgroundId: string, name: string) =>
      call('PATCH', `/api/workspaces/${workspaceId}/backgrounds/${backgroundId}`, UpdateBackgroundResponseSchema, body(UpdateBackgroundRequestSchema, { name })),
    /** 204 → BACKGROUND_DELETE. */
    remove: (workspaceId: string, backgroundId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/backgrounds/${backgroundId}`),
  },
  /** Workspace calendar (ADR-0038); guests → 403, bots read only. */
  calendar: {
    /** Occurrences overlapping [from, to) (≤ 62 days), earliest first, with my_status / can_edit. */
    list: (workspaceId: string, from: Date, to: Date, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/events${qs({ from: from.toISOString(), to: to.toISOString() })}`, ListCalendarEventsResponseSchema, undefined, signal),
    /** 201 → EVENT_CREATE; 422 with `field` on a bad value; 403 EMAIL_NOT_VERIFIED for external attendees. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateCalendarEventRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/events`, CalendarEventResponseSchema, body(CreateCalendarEventRequestSchema, init)),
    /** The series (occurrence_at unset); 404 for an event I may not see. */
    get: (id: string, signal?: AbortSignal) => call('GET', `/api/events/${id}`, CalendarEventResponseSchema, undefined, signal),
    /** Unset fields unchanged; a series changes every occurrence (v1). */
    update: (id: string, init: MessageInitShape<typeof UpdateCalendarEventRequestSchema>) =>
      call('PATCH', `/api/events/${id}`, CalendarEventResponseSchema, body(UpdateCalendarEventRequestSchema, init)),
    /** 204: cancels the meeting (EVENT_DELETE), or with `occurrence` (its start) that occurrence of a series only. */
    cancel: (id: string, occurrence?: Date) => callEmpty('DELETE', `/api/events/${id}${qs({ occurrence: occurrence?.toISOString() })}`),
    rsvp: (id: string, status: AttendeeStatus) =>
      call('PUT', `/api/events/${id}/rsvp`, CalendarEventResponseSchema, body(RsvpCalendarEventRequestSchema, { status })),
    /** My upcoming meetings of today in `tz`, across workspaces (the calendar icon's number). */
    today: (tz: string) => call('GET', `/api/me/events/today${qs({ tz })}`, TodayCalendarEventsResponseSchema),
    /** External attendee's answer page (public, no login): preview and answer by the signed token. */
    rsvpPreview: (token: string) => call('GET', `/api/event-rsvp${qs({ t: token })}`, EventRsvpTokenResponseSchema),
    rsvpAnswer: (token: string) => call('POST', '/api/event-rsvp', EventRsvpTokenResponseSchema, body(EventRsvpTokenRequestSchema, { token })),
  },
  /** Soundboard (ADR-0036): the library for any member; managing needs MANAGE_STICKERS. */
  sounds: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/sounds`, ListSoundsResponseSchema),
    /** 201; fileId = my upload to this workspace (MP3 / Ogg / WAV ≤ 2 MB, the server makes the clip); 409 = 50 already; 422 = bad name / emoji / file. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateSoundRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/sounds`, SoundResponseSchema, body(CreateSoundRequestSchema, init)),
    /** Rename, emoji, a new clip (fileId) or a new place (position). */
    update: (workspaceId: string, soundId: string, init: MessageInitShape<typeof UpdateSoundRequestSchema>) =>
      call('PATCH', `/api/workspaces/${workspaceId}/sounds/${soundId}`, SoundResponseSchema, body(UpdateSoundRequestSchema, init)),
    /** 204 → SOUND_DELETE. */
    remove: (workspaceId: string, soundId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/sounds/${soundId}`),
    /** 204: everyone in the call plays it; 403 = not in the call; 429 = 1 per 2 s per user, 5 per 10 s per room. */
    play: (roomId: string, soundId: string) => callEmpty('POST', `/api/rooms/${roomId}/sounds/play`, body(PlaySoundRequestSchema, { soundId })),
  },
  /** Workspace roles (ADR-0026): list for any member; the rest MANAGE_ROLES, roles below my top one. */
  roles: {
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/roles`, ListRolesResponseSchema),
    /** 201; 409 = 50 roles already; 422 = invalid name / colour / permissions. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateRoleRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/roles`, CreateRoleResponseSchema, body(CreateRoleRequestSchema, init)),
    update: (workspaceId: string, roleId: string, init: MessageInitShape<typeof UpdateRoleRequestSchema>) =>
      call('PATCH', `/api/workspaces/${workspaceId}/roles/${roleId}`, UpdateRoleResponseSchema, body(UpdateRoleRequestSchema, init)),
    /** 204, custom roles only: holders keep their other roles (ROLE_DELETE). */
    remove: (workspaceId: string, roleId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/roles/${roleId}`),
    /** All custom roles, highest first. */
    order: (workspaceId: string, roleIds: readonly string[]) =>
      call('PUT', `/api/workspaces/${workspaceId}/roles/order`, SetRoleOrderResponseSchema, body(SetRoleOrderRequestSchema, { roleIds: [...roleIds] })),
  },
  categories: {
    create: (workspaceId: string, init: MessageInitShape<typeof CreateCategoryRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/categories`, CreateCategoryResponseSchema, body(CreateCategoryRequestSchema, init)),
    update: (id: string, init: MessageInitShape<typeof UpdateCategoryRequestSchema>) =>
      call('PATCH', `/api/categories/${id}`, UpdateCategoryResponseSchema, body(UpdateCategoryRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/categories/${id}`),
  },
  /** Room links (ADR-0016): `/r/<code>`; list/create/revoke need MANAGE_ROOM. */
  roomInvites: {
    list: (roomId: string) => call('GET', `/api/rooms/${roomId}/invites`, ListRoomInvitesResponseSchema),
    create: (roomId: string, init: MessageInitShape<typeof CreateRoomInviteRequestSchema>) =>
      call('POST', `/api/rooms/${roomId}/invites`, CreateRoomInviteResponseSchema, body(CreateRoomInviteRequestSchema, init)),
    revoke: (roomId: string, inviteId: string) => callEmpty('DELETE', `/api/rooms/${roomId}/invites/${inviteId}`),
    /** Public preview (no auth needed). */
    get: (code: string) => call('GET', `/api/room-invites/${encodeURIComponent(code)}`, GetRoomInviteResponseSchema),
    /** Signed in: joins as the current user (becomes a guest of the workspace if not a member). */
    join: (code: string) =>
      call('POST', `/api/room-invites/${encodeURIComponent(code)}/join`, JoinRoomInviteResponseSchema, body(JoinRoomInviteRequestSchema, {})),
  },
  invites: {
    get: (code: string) => call('GET', `/api/invites/${encodeURIComponent(code)}`, GetInviteResponseSchema),
    join: (code: string) => call('POST', `/api/invites/${encodeURIComponent(code)}/join`, JoinWorkspaceResponseSchema),
  },
  rooms: {
    create: (workspaceId: string, init: MessageInitShape<typeof CreateRoomRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/rooms`, CreateRoomResponseSchema, body(CreateRoomRequestSchema, init)),
    /**
     * A temporary room with its link (ADR-0044): 201; 403 (no CREATE_TEMP_ROOMS; `guests` without
     * INVITE_GUESTS), 409 TEMP_ROOM_LIMIT (`reason: PER_USER` — the creator's cap), 422.
     */
    createTemp: (workspaceId: string, init: MessageInitShape<typeof CreateTempRoomRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/rooms/temp`, TempRoomResponseSchema, body(CreateTempRoomRequestSchema, init)),
    /** Closed temporary rooms (ADR-0044), newest first: MANAGE_ROOM at workspace level. */
    archived: (workspaceId: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/rooms?archived=1`, ListRoomsResponseSchema, undefined, signal),
    get: (id: string) => call('GET', `/api/rooms/${id}`, GetRoomResponseSchema),
    /** Drag & drop result (docs/09 P1 #19): positions + categories of the changed rooms and categories, one batch (MANAGE_ROOM). */
    setOrder: (workspaceId: string, init: MessageInitShape<typeof SetRoomOrderRequestSchema>) =>
      call('PUT', `/api/workspaces/${workspaceId}/rooms/order`, SetRoomOrderResponseSchema, body(SetRoomOrderRequestSchema, init)),
    update: (id: string, init: MessageInitShape<typeof UpdateRoomRequestSchema>) =>
      call('PATCH', `/api/rooms/${id}`, UpdateRoomResponseSchema, body(UpdateRoomRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/rooms/${id}`),
    /** Voice rooms: the status line of the current call (≤ 60 chars; '' clears); everyone gets ROOM_UPDATE. */
    setVoiceStatus: (id: string, status: string) =>
      call('PATCH', `/api/rooms/${id}/voice-status`, UpdateRoomResponseSchema, body(UpdateVoiceStatusRequestSchema, { status })),
    setPermissions: (id: string, init: MessageInitShape<typeof SetRoomPermissionsRequestSchema>) =>
      call('PUT', `/api/rooms/${id}/permissions`, SetRoomPermissionsResponseSchema, body(SetRoomPermissionsRequestSchema, init)),
    /** My notification settings of the room; replaces them (INHERIT without mutedUntil = default). */
    setNotifications: (id: string, init: MessageInitShape<typeof UpdateRoomNotificationSettingsRequestSchema>) =>
      call(
        'PUT',
        `/api/rooms/${id}/notifications`,
        UpdateRoomNotificationSettingsResponseSchema,
        body(UpdateRoomNotificationSettingsRequestSchema, init),
      ),
  },
  /** Sticker packs (ADR-0030): managing needs MANAGE_STICKERS; installs are the caller's own. */
  stickers: {
    /** Live packs of a workspace (any member). */
    list: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/sticker-packs`, ListStickerPacksResponseSchema),
    /** One live pack (any member of its workspace; 404 otherwise). */
    get: (packId: string) => call('GET', `/api/sticker-packs/${packId}`, StickerPackResponseSchema),
    /** 201; 409 PLAN_LIMIT (sticker_packs) or a taken short name. The creator gets it installed. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateStickerPackRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/sticker-packs`, StickerPackResponseSchema, body(CreateStickerPackRequestSchema, init)),
    update: (packId: string, init: MessageInitShape<typeof UpdateStickerPackRequestSchema>) =>
      call('PATCH', `/api/sticker-packs/${packId}`, StickerPackResponseSchema, body(UpdateStickerPackRequestSchema, init)),
    remove: (packId: string) => callEmpty('DELETE', `/api/sticker-packs/${packId}`),
    setEmoji: (stickerId: string, emoji: string) =>
      call('PATCH', `/api/stickers/${stickerId}`, StickerPackResponseSchema, body(UpdateStickerRequestSchema, { emoji })),
    removeSticker: (stickerId: string) => call('DELETE', `/api/stickers/${stickerId}`, StickerPackResponseSchema),
    /** Installed packs in my order + the packs of my workspaces I have not installed. */
    mine: () => call('GET', '/api/me/sticker-packs', MyStickerPacksResponseSchema),
    install: (packId: string) => call('PUT', `/api/me/sticker-packs/${packId}`, MyStickerPacksResponseSchema),
    uninstall: (packId: string) => call('DELETE', `/api/me/sticker-packs/${packId}`, MyStickerPacksResponseSchema),
    order: (packIds: readonly string[]) =>
      call('PUT', '/api/me/sticker-packs/order', MyStickerPacksResponseSchema, body(SetStickerPackOrderRequestSchema, { packIds: [...packIds] })),
  },
  /**
   * Bots (ADR-0031, docs/05 «Боты»). Managing: MANAGE_WORKSPACE (tokens and deletion — in the
   * bot's home workspace, also its owner); the token comes back only from create / reissue.
   */
  bots: {
    list: (workspaceId: string, signal?: AbortSignal) => call('GET', `/api/workspaces/${workspaceId}/bots`, ListBotsResponseSchema, undefined, signal),
    /** 201 {bot, token}; 409 username taken or PLAN_LIMIT (bots); 422 invalid name / username / description. */
    create: (workspaceId: string, init: MessageInitShape<typeof CreateBotRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/bots`, CreateBotResponseSchema, body(CreateBotRequestSchema, init)),
    /** 201 {bot}; 404 no such bot; 409 already a member or PLAN_LIMIT. */
    add: (workspaceId: string, ref: { botUserId?: string; username?: string }) =>
      call('POST', `/api/workspaces/${workspaceId}/bots/add`, AddBotResponseSchema, body(AddBotRequestSchema, ref)),
    /** 204: at home the bot is deleted; elsewhere it only leaves the workspace. */
    remove: (workspaceId: string, botUserId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/bots/${botUserId}`),
    /** {bot, token}: the old token stops working at once. */
    reissue: (workspaceId: string, botUserId: string) =>
      call('POST', `/api/workspaces/${workspaceId}/bots/${botUserId}/token`, ReissueBotTokenResponseSchema),
    /** 204: no token until «Перевыпустить». */
    revoke: (workspaceId: string, botUserId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/bots/${botUserId}/token`),
    /** {bot}: the avatar from the same picker as the own profile's (docs/09 #87); 422 not an image. */
    setAvatar: async (workspaceId: string, botUserId: string, file: Blob, name: string) =>
      fromJson(SetBotAvatarResponseSchema, (await postAvatar(`/api/workspaces/${workspaceId}/bots/${botUserId}/avatar`, file, name)) as JsonValue, {
        ignoreUnknownFields: true,
      }),
    /** {bot} without the avatar. */
    clearAvatar: (workspaceId: string, botUserId: string) => call('DELETE', `/api/workspaces/${workspaceId}/bots/${botUserId}/avatar`, SetBotAvatarResponseSchema),
    /** The public card by id or username (no owner / home workspace). */
    get: (ref: string, signal?: AbortSignal) => call('GET', `/api/bots/${encodeURIComponent(ref)}`, GetBotMeResponseSchema, undefined, signal),
    /** Commands of the bots that can view the room (composer hints). */
    roomCommands: (roomId: string, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/bot-commands`, ListRoomBotCommandsResponseSchema, undefined, signal),
    blocked: () => call('GET', '/api/me/blocked-bots', ListBlockedBotsResponseSchema),
    block: (botUserId: string) => callEmpty('POST', `/api/me/blocked-bots/${botUserId}`),
    unblock: (botUserId: string) => callEmpty('DELETE', `/api/me/blocked-bots/${botUserId}`),
  },
  messages: {
    get: (roomId: string, id: string) => call('GET', `/api/rooms/${roomId}/messages/${id}`, MessageSchema),
    interact: (id: string, p: MessageInitShape<typeof CreateMessageInteractionRequestSchema>) =>
      call('POST', `/api/messages/${id}/interactions`, CreateMessageInteractionResponseSchema, body(CreateMessageInteractionRequestSchema, p)),
    list: (roomId: string, p: { before?: string; after?: string; limit?: number }, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/messages${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    create: (roomId: string, init: MessageInitShape<typeof CreateMessageRequestSchema>) =>
      call('POST', `/api/rooms/${roomId}/messages`, CreateMessageResponseSchema, body(CreateMessageRequestSchema, init)),
    update: (id: string, content: string) =>
      call('PATCH', `/api/messages/${id}`, UpdateMessageResponseSchema, body(UpdateMessageRequestSchema, { content })),
    remove: (id: string) => callEmpty('DELETE', `/api/messages/${id}`),
    /** «Переслать» (ADR-0033): a copy of the message in `toRoomId`, by the caller, with `forward`. */
    forward: (roomId: string, id: string, toRoomId: string) =>
      call('POST', `/api/rooms/${roomId}/messages/${id}/forward`, ForwardMessageResponseSchema, body(ForwardMessageRequestSchema, { toRoomId })),
    markRead: (roomId: string, messageId: string) =>
      callEmpty('PUT', `/api/rooms/${roomId}/read`, body(UpdateReadStateRequestSchema, { messageId })),
    /** Full-text search in one room (newest first, cursor `before`). */
    searchRoom: (roomId: string, p: { q: string; before?: string; limit?: number }, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/messages${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    /** Full-text search over every room of a workspace the caller can view. */
    searchWorkspace: (
      workspaceId: string,
      p: { q: string; room_id?: string; author_id?: string; before?: string; limit?: number },
      signal?: AbortSignal,
    ) => call('GET', `/api/workspaces/${workspaceId}/messages/search${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    /** Who reacted with `emoji` (the chip tooltip), paged by `after` = the last user id. */
    reactionUsers: (id: string, emoji: string, p?: { after?: string; limit?: number }, signal?: AbortSignal) =>
      call('GET', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}${qs({ after: p?.after, limit: p?.limit })}`, ListReactionUsersResponseSchema, undefined, signal),
    addReaction: (id: string, emoji: string) => callEmpty('PUT', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    removeReaction: (id: string, emoji: string) => callEmpty('DELETE', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    pin: (id: string) => callEmpty('PUT', `/api/messages/${id}/pin`),
    unpin: (id: string) => callEmpty('DELETE', `/api/messages/${id}/pin`),
    /** Hide / show the link previews (author or MANAGE_MESSAGES); MESSAGE_UPDATE, not an edit. */
    setEmbedsHidden: (id: string, hidden: boolean) =>
      call('PUT', `/api/messages/${id}/embeds-hidden`, UpdateMessageResponseSchema, body(SetEmbedsHiddenRequestSchema, { hidden })),
    pins: (roomId: string) => call('GET', `/api/rooms/${roomId}/pins`, ListMessagesResponseSchema),
  },
  /** Direct messages (ADR-0020); their messages use the room endpoints above. */
  dms: {
    list: () => call('GET', '/api/dms', ListDmsResponseSchema),
    /** Get-or-create: 201 created (DM_CREATE to both), 200 existed; 422 self, 404 no common workspace, 403 guest, 429 limit. */
    create: (userId: string) => call('POST', '/api/dms', CreateDmResponseSchema, body(CreateDmRequestSchema, { userId })),
    /** Who I may write to (≤ 20, by name); q = substring of the name or a nickname. */
    candidates: (q: string, signal?: AbortSignal) => call('GET', `/api/dms/candidates${qs({ q })}`, ListDmCandidatesResponseSchema, undefined, signal),
    /** My own state of a DM (docs/09 #51): archive / «Удалить чат» (for me only); 404 not a participant. */
    setState: (roomId: string, state: { archived?: boolean; cleared?: boolean }) =>
      call('PATCH', `/api/dms/${roomId}/state`, UpdateDmStateResponseSchema, body(UpdateDmStateRequestSchema, state)),
  },
  /**
   * Notes shelves (ADR-0039): personal rooms; messages use the room endpoints, uploads go to
   * `/api/dms/{id}/files` (uploadPath) and count against the personal quota. 409 NOTES_LIMIT
   * at 20; 404 not mine; 403 bots / guest accounts.
   */
  notes: {
    list: () => call('GET', '/api/notes', ListNotesResponseSchema),
    create: (name: string, emoji: string) => call('POST', '/api/notes', CreateNotesResponseSchema, body(CreateNotesRequestSchema, { name, emoji })),
    update: (roomId: string, p: { name?: string; emoji?: string; position?: number }) =>
      call('PATCH', `/api/notes/${roomId}`, UpdateNotesResponseSchema, body(UpdateNotesRequestSchema, p)),
    remove: (roomId: string) => callEmpty('DELETE', `/api/notes/${roomId}`),
  },
  /**
   * One-to-one calls (ADR-0034, docs/05 «Звонки»): place a call in a DM → RINGING (409 IN_CALL /
   * BUSY, 403 cannot call this peer); accept / decline (the callee), cancel (the caller) while
   * RINGING, hangup (either) while ACTIVE → the call as it is now (409 wrong state).
   */
  calls: {
    start: (dmRoomId: string) => call('POST', `/api/dms/${dmRoomId}/call`, StartCallResponseSchema),
    act: (callId: string, action: 'accept' | 'decline' | 'cancel' | 'hangup') => call('POST', `/api/calls/${callId}/${action}`, CallActionResponseSchema),
  },
  /**
   * Telephony (ADR-0046, sip.proto). Settings, the connection test (a real call, up to ~25 s) and
   * the journal — MANAGE_WORKSPACE; PUT replaces the form (password unset = keep, "" = remove):
   * 422 VALIDATION field, 502 SIP_PROVIDER_ERROR. place / hangup — see PlaceSipCallRequest.
   */
  sip: {
    settings: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/sip`, GetSipSettingsResponseSchema),
    save: (workspaceId: string, init: MessageInitShape<typeof PutSipSettingsRequestSchema>) =>
      call('PUT', `/api/workspaces/${workspaceId}/sip`, PutSipSettingsResponseSchema, body(PutSipSettingsRequestSchema, init)),
    test: (workspaceId: string) => call('POST', `/api/workspaces/${workspaceId}/sip/test`, TestSipResponseSchema),
    journal: (workspaceId: string, cursor?: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/calls${qs({ cursor })}`, ListSipCallsResponseSchema, undefined, signal),
    place: (roomId: string, number: string) => call('POST', `/api/rooms/${roomId}/calls`, SipCallResponseSchema, body(PlaceSipCallRequestSchema, { number })),
    hangup: (roomId: string, callId: string) => call('DELETE', `/api/rooms/${roomId}/calls/${callId}`, SipCallResponseSchema),
  },
  /** Link preview; image URLs are server-proxied API paths (never third-party hosts). */
  unfurl: {
    get: (url: string, signal?: AbortSignal) => call('GET', `/api/unfurl${qs({ url })}`, UnfurlResponseSchema, undefined, signal),
  },
  /**
   * Meeting recording (ADR-0025, docs/05 «Запись встреч»). The GPTunneL connection of a workspace:
   * GET — any member but a guest; pair / unpair — MANAGE_WORKSPACE (422 CODE_INVALID | VALIDATION
   * code, 429, 503). Start / stop — a member (not a guest) with CONNECT in a voice room with a call:
   * 403 (guest / allow_recording off), 409 NOT_PAIRED | ALREADY_RECORDING | RECORDING_LIMIT |
   * CONFLICT (nobody in the call), 503; stop → 404 when nothing is recorded.
   */
  recording: {
    integration: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/integrations/gptunnel`, GetGptunnelIntegrationResponseSchema),
    pair: (workspaceId: string, code: string) =>
      call('POST', `/api/workspaces/${workspaceId}/integrations/gptunnel`, PairGptunnelResponseSchema, body(PairGptunnelRequestSchema, { code })),
    unpair: (workspaceId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/integrations/gptunnel`),
    start: (roomId: string) => call('POST', `/api/rooms/${roomId}/recording/start`, StartRecordingResponseSchema),
    stop: (roomId: string) => call('POST', `/api/rooms/${roomId}/recording/stop`, StopRecordingResponseSchema),
    /**
     * Retry of a FAILED recording (docs/09 #40), the same people as start: recheck (delivered file:
     * poll GPTunneL again) / reupload (upload did not complete, file kept). 409 CONFLICT |
     * ALREADY_UPLOADED | FILE_GONE | NOT_PAIRED; the card follows by MESSAGE_UPDATE.
     */
    recheck: (roomId: string, recordingId: string) =>
      call('POST', `/api/rooms/${roomId}/recordings/${recordingId}/recheck`, RetryRecordingResponseSchema),
    reupload: (roomId: string, recordingId: string) =>
      call('POST', `/api/rooms/${roomId}/recordings/${recordingId}/reupload`, RetryRecordingResponseSchema),
    /** The transcript kept on the server (docs/09 #47): VIEW_ROOM; 404 when there is none / deleted. */
    transcript: (roomId: string, recordingId: string, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/recordings/${recordingId}/transcript`, GetRecordingTranscriptResponseSchema, undefined, signal),
    /** «Удалить запись» (#50): the starter, the owner or MANAGE_MESSAGES; 409 while recording. */
    remove: (roomId: string, recordingId: string) => callEmpty('DELETE', `/api/rooms/${roomId}/recordings/${recordingId}`),
  },
  voice: {
    join: (roomId: string) => call('POST', `/api/rooms/${roomId}/join`, JoinVoiceResponseSchema),
    /** Takes this device out of the room at once, pending or connected (idempotent, 204). */
    leave: (roomId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/leave`),
    /** → the granted preset and fps: ≤ the room's and the plan's limits (ADR-0024). */
    requestStream: (roomId: string, preset: ScreenSharePreset) =>
      call('POST', `/api/rooms/${roomId}/stream/request`, RequestStreamResponseSchema, body(RequestStreamRequestSchema, { preset })),
    /**
     * Grants this device the camera source (VIDEO; 409 CONFLICT = camera_limit reached / cameras
     * off) → the granted quality, capped by the plan (ADR-0024; UNSPECIFIED / 0 = no cap).
     */
    requestCamera: (roomId: string, want: { preset: ScreenSharePreset; fps?: number }) =>
      call('POST', `/api/rooms/${roomId}/camera/request`, RequestCameraResponseSchema, body(RequestCameraRequestSchema, { preset: want.preset, fps: want.fps ?? 0 })),
    /** Withdraws this device's camera grant (after unpublishing). */
    stopCamera: (roomId: string) => callEmpty('POST', `/api/rooms/${roomId}/camera/stop`),
    /** Moderator (MUTE_MEMBERS): turns a member's webcam off → VOICE_CAMERA_STOP{MODERATOR}; 404 = no camera. */
    stopMemberCamera: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/stop-camera`),
    updateSelf: (init: MessageInitShape<typeof UpdateVoiceSelfRequestSchema>) =>
      callEmpty('PATCH', '/api/voice/self', body(UpdateVoiceSelfRequestSchema, init)),
    muteMember: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/mute`),
    /** Lifts a moderator mute (MUTE_MEMBERS); the user unmutes themself afterwards. */
    unmuteMember: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/unmute`),
    disconnectMember: (roomId: string, userId: string) =>
      callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/disconnect`),
    /** MOVE_MEMBERS in both rooms; 409 ROOM_FULL when the target is full (admins bypass). */
    moveMember: (roomId: string, userId: string, targetRoomId: string) =>
      callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/move`, body(MoveMemberRequestSchema, { targetRoomId })),
  },
};

/**
 * Superadmin API (ADR-0024): `/api/admin/*`, only for `me.isSuperadmin` (everyone else gets 404).
 * Its own rate limit (60/min): the search is debounced by the caller.
 */
export const adminApi = {
  /** q: name, slug or the owner's email (substring); empty = newest; ≤ 50. */
  search: (q: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces${qs({ q })}`, AdminSearchWorkspacesResponseSchema, undefined, signal),
  get: (id: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces/${id}`, AdminGetWorkspaceResponseSchema, undefined, signal),
  /** limits only with PLAN_CUSTOM; 422 on an invalid plan; members get WORKSPACE_UPDATE. */
  setPlan: (id: string, init: MessageInitShape<typeof AdminSetPlanRequestSchema>) =>
    call('PUT', `/api/admin/workspaces/${id}/plan`, AdminSetPlanResponseSchema, body(AdminSetPlanRequestSchema, init)),
  /** Newest first, ≤ 100. */
  log: (id: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces/${id}/plan/log`, AdminPlanLogResponseSchema, undefined, signal),
  /** Suspend (reason required) / resume (docs/09 #32); members get WORKSPACE_UPDATE, calls end. */
  setSuspension: (id: string, suspended: boolean, reason: string) =>
    call(
      'PUT',
      `/api/admin/workspaces/${id}/suspension`,
      AdminSetSuspensionResponseSchema,
      body(AdminSetSuspensionRequestSchema, { suspended, reason }),
    ),
};

export interface UploadHandle {
  promise: Promise<FileMeta>;
  abort(): void;
}

/** Where a room's attachments are uploaded: the workspace, or the DM itself (`/api/dms/{id}/files`, ADR-0020). */
export function uploadPath(workspaceId: string, roomId: string): string {
  return workspaceId ? `/api/workspaces/${workspaceId}/files` : `/api/dms/${roomId}/files`;
}

/**
 * Multipart upload with progress (XHR — fetch has no upload progress) to `path`
 * (`uploadPath()`: `POST /api/workspaces/{id}/files` or `/api/dms/{id}/files`).
 */
export function uploadFile(path: string, file: Blob, name: string, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileMeta>((resolve, reject) => {
    xhr.open('POST', apiUrl(path));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) {
        // A throw inside onload would leave the promise (and the message) pending forever (review L6).
        let file: FileMeta | undefined;
        try {
          file = fromJson(UploadFileResponseSchema, JSON.parse(xhr.responseText) as JsonValue, { ignoreUnknownFields: true }).file;
        } catch {
          file = undefined;
        }
        if (file) resolve(file);
        else reject(new ApiError('ERROR_CODE_INTERNAL', 'bad upload response', xhr.status));
      } else {
        toApiError(res).then(reject, () => reject(new ApiError('ERROR_CODE_INTERNAL', `HTTP ${xhr.status}`, xhr.status)));
      }
    };
    xhr.onerror = () => reject(new ApiError('ERROR_CODE_UNAVAILABLE', 'upload failed', 0));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    const form = new FormData();
    form.append('file', file, name);
    // Web: Bearer header (Electron: main adds it to calaba-api:// requests).
    void platform.authHeaders().then((headers) => {
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(form);
    }, reject);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * A batch of stickers (ADR-0030): multipart with an «emoji» field before each «file»; all or
 * nothing (422 field `file[i]` / `emoji[i]` names the bad one). Progress over the whole batch.
 */
export function uploadStickers(
  packId: string,
  items: ReadonlyArray<{ file: Blob; name: string; emoji: string }>,
  onProgress: (fraction: number) => void,
): Promise<UploadStickersResponse> {
  const xhr = new XMLHttpRequest();
  return new Promise<UploadStickersResponse>((resolve, reject) => {
    xhr.open('POST', apiUrl(`/api/sticker-packs/${packId}/stickers`));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(fromJson(UploadStickersResponseSchema, JSON.parse(xhr.responseText) as JsonValue, { ignoreUnknownFields: true }));
        } catch {
          reject(new ApiError('ERROR_CODE_INTERNAL', 'bad upload response', xhr.status));
        }
        return;
      }
      const res = new Response(xhr.responseText, { status: xhr.status });
      toApiError(res).then(reject, () => reject(new ApiError('ERROR_CODE_INTERNAL', `HTTP ${xhr.status}`, xhr.status)));
    };
    xhr.onerror = () => reject(new ApiError('ERROR_CODE_UNAVAILABLE', 'upload failed', 0));
    const form = new FormData();
    for (const it of items) {
      form.append('emoji', it.emoji);
      form.append('file', it.file, it.name);
    }
    void platform.authHeaders().then((headers) => {
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(form);
    }, reject);
  });
}

/**
 * Replaces a sticker in place (same id and position): a new picture and / or emoji, multipart
 * `file` / `emoji`; 422 field `file` / `emoji` names what the server refused.
 */
export async function replaceSticker(packId: string, stickerId: string, change: { file?: { blob: Blob; name: string }; emoji?: string }): Promise<StickerPackResponse> {
  const form = new FormData();
  if (change.emoji !== undefined) form.append('emoji', change.emoji);
  if (change.file) form.append('file', change.file.blob, change.file.name);
  const res = await platform.apiFetch(`/api/sticker-packs/${packId}/stickers/${stickerId}`, { method: 'PUT', body: form });
  if (!res.ok) throw await toApiError(res);
  return fromJson(StickerPackResponseSchema, (await res.json()) as JsonValue, { ignoreUnknownFields: true });
}

/** Multipart `file` to an avatar route (own profile or a bot); the parsed JSON response. */
async function postAvatar(path: string, file: Blob, name: string): Promise<unknown> {
  const form = new FormData();
  form.append('file', file, name);
  const res = await platform.apiFetch(path, { method: 'POST', body: form });
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

export async function uploadAvatar(file: Blob, name: string): Promise<void> {
  await postAvatar('/api/me/avatar', file, name);
}

/**
 * HEIC → JPEG on the server (POST /api/files/convert?to=jpeg, docs/02 «Изображения»): the
 * last rung of the decode ladder (lib/image/decode). null when the server cannot convert it
 * (501 no ffmpeg, 415 not HEIF, 422 undecodable); other failures (network, 413, 429) throw.
 */
export async function convertImage(file: Blob, name: string): Promise<Blob | null> {
  const form = new FormData();
  form.append('file', file, name);
  const res = await platform.apiFetch('/api/files/convert?to=jpeg', { method: 'POST', body: form });
  if (res.status === 501 || res.status === 415 || res.status === 422) return null;
  if (!res.ok) throw await toApiError(res);
  return res.blob();
}

/** URL usable in <img src>: main attaches the bearer token. */
/** API paths of file bytes; render them through <MediaImg> / useMediaUrl (auth differs per platform). */
export const filePath = (fileId: string): string => `/api/files/${fileId}`;
export const thumbnailPath = (fileId: string): string => `/api/files/${fileId}/thumbnail`;
