/**
 * Deterministic mock of the Calaba API + WS gateway for UI screenshot tests.
 * Replaces apps/server for Playwright visual regression only — see README.md.
 *
 * Contract: proto/calaba/v1 (protojson REST bodies, binary GatewayFrame over WebSocket),
 * docs/05-realtime-protocol.md. Fixtures: ./fixtures.ts.
 *
 * CLI: tsx e2e-support/mock-server.ts --port 3900 --scenario data|empty|marketing --static dist-web
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clone,
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  BoardPermissionsResponseSchema,
  BoardResponseSchema,
  BoardCategoryResponseSchema,
  BoardWebhookPingResponseSchema,
  BoardWebhookResponseSchema,
  ConvertChecklistItemResponseSchema,
  CreateBoardCategoryRequestSchema,
  CreateTaskChecklistItemRequestSchema,
  CreateTaskChecklistRequestSchema,
  ListBoardCategoriesResponseSchema,
  SetBoardOrderRequestSchema,
  SetBoardOrderResponseSchema,
  SetBoardWebhookRequestSchema,
  TaskChecklistResponseSchema,
  UpdateBoardCategoryRequestSchema,
  UpdateTaskChecklistItemRequestSchema,
  UpdateTaskChecklistRequestSchema,
  BoardViewResponseSchema,
  CreateBoardLabelRequestSchema,
  CreateBoardMilestoneRequestSchema,
  CreateBoardRequestSchema,
  CreateBoardStatusRequestSchema,
  CreateBoardViewRequestSchema,
  CreateTaskRequestSchema,
  ListBoardViewsResponseSchema,
  ListBoardsResponseSchema,
  ListTasksResponseSchema,
  MyTasksResponseSchema,
  SearchTasksResponseSchema,
  SetAssigneesRequestSchema,
  SetTaskApproversRequestSchema,
  SetBoardPermissionsRequestSchema,
  SetBoardPositionRequestSchema,
  SetTaskRelationRequestSchema,
  SetTaskSubscriptionRequestSchema,
  SetTaskWatcherRequestSchema,
  TaskActivityPageSchema,
  TaskFilterSchema,
  TaskApprovalRequestSchema,
  TaskResponseSchema,
  TaskSchema,
  UpdateBoardLabelRequestSchema,
  UpdateBoardMilestoneRequestSchema,
  UpdateBoardRequestSchema,
  UpdateBoardStatusRequestSchema,
  UpdateBoardViewRequestSchema,
  UpdateTaskRequestSchema,
  type Task,
  type TaskActivity,
  type TaskFilter,
  type TaskRelationKind,
} from '@calaba/protocol';
import { BoardError, BoardsMock, MANAGE_BOARD } from './mock-boards';
import {
  AdminGetWorkspaceResponseSchema,
  CallActionResponseSchema,
  CallOutcome,
  CallSchema,
  CallState,
  StartCallResponseSchema,
  type Call,
  BadgeSchema,
  CreateBadgeRequestSchema,
  CreateBadgeResponseSchema,
  ListBadgesResponseSchema,
  SetMemberBadgeRequestSchema,
  SetMemberBadgeResponseSchema,
  UpdateBadgeRequestSchema,
  UpdateBadgeResponseSchema,
  type Badge,
  WorkspaceBackgroundSchema,
  ListBackgroundsResponseSchema,
  CreateBackgroundRequestSchema,
  CreateBackgroundResponseSchema,
  UpdateBackgroundRequestSchema,
  UpdateBackgroundResponseSchema,
  type WorkspaceBackground,
  SoundSchema,
  ListSoundsResponseSchema,
  CreateSoundRequestSchema,
  SoundResponseSchema,
  UpdateSoundRequestSchema,
  PlaySoundRequestSchema,
  type Sound,
  AdminPlanLogResponseSchema,
  AdminSearchWorkspacesResponseSchema,
  AdminSetPlanRequestSchema,
  AdminSetSuspensionRequestSchema,
  AdminSetSuspensionResponseSchema,
  CreateBanRequestSchema,
  CreateBanResponseSchema,
  ListBansResponseSchema,
  WorkspaceBanSchema,
  WorkspaceSuspensionSchema,
  AdminSetPlanResponseSchema,
  AdminWorkspaceSchema,
  Plan,
  PlanLimitsSchema,
  PlanLogEntrySchema,
  RequestCameraRequestSchema,
  RequestCameraResponseSchema,
  RoomMediaSettingsSchema,
  SCREEN_SHARE_PRESETS,
  WorkspacePlanSchema,
  type AdminWorkspace,
  type PlanLimits,
  type RoomMediaSettings,
  type Workspace,
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  AddMemberRequestSchema,
  AddMemberResponseSchema,
  CreateEmailInviteRequestSchema,
  CreateEmailInviteResponseSchema,
  EmailInviteSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  InviteLookupRequestSchema,
  InviteLookupResponseSchema,
  ListEmailInvitesResponseSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  GetGptunnelIntegrationResponseSchema,
  GptunnelIntegrationSchema,
  MessageKind,
  PairGptunnelRequestSchema,
  PairGptunnelResponseSchema,
  RecordingCardSchema,
  ForwardSchema,
  BirthdaySchema,
  RecordingStatus,
  RoomRecordingSchema,
  GetSipSettingsResponseSchema,
  ListSipCallsResponseSchema,
  PlaceSipCallRequestSchema,
  PutSipSettingsRequestSchema,
  PutSipSettingsResponseSchema,
  SipCallDirection,
  SipCallResponseSchema,
  SipCallSchema,
  SipCallStatus,
  SipSettingsSchema,
  TestSipResponseSchema,
  type SipCall,
  RoomRecordingState,
  StartRecordingResponseSchema,
  StopRecordingResponseSchema,
  RetryRecordingResponseSchema,
  GetRecordingTranscriptResponseSchema,
  type GptunnelIntegration,
  type RecordingCard,
  type RoomRecording,
  type SipSettings,
  SipTransport,
  ApiErrorSchema,
  AuthTokensSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateMessageRequestSchema,
  CreateStickerPackRequestSchema,
  ListStickerPacksResponseSchema,
  MyStickerPacksResponseSchema,
  SetStickerPackOrderRequestSchema,
  StickerPackResponseSchema,
  AddBotRequestSchema,
  AddBotResponseSchema,
  BotCommandSchema,
  BotSchema,
  BotWebhookSchema,
  CreateBotRequestSchema,
  CreateBotResponseSchema,
  GetBotMeResponseSchema,
  ListBlockedBotsResponseSchema,
  ListBotsResponseSchema,
  ListRoomBotCommandsResponseSchema,
  ReissueBotTokenResponseSchema,
  SetBotAvatarResponseSchema,
  RoomBotCommandsSchema,
  type Bot,
  type RoomBotCommands,
  StickerPackSchema,
  StickerSchema,
  UpdateStickerPackRequestSchema,
  UpdateStickerRequestSchema,
  UploadStickersResponseSchema,
  type Sticker,
  type StickerPack,
  CreateRoomInviteRequestSchema,
  CreateRoomInviteResponseSchema,
  CreateMessageResponseSchema,
  ForwardMessageRequestSchema,
  ForwardMessageResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  CreateTempRoomRequestSchema,
  TempRoomResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DiscoverWorkspacesResponseSchema,
  DispatchEventSchema,
  ErrorCode,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  GetInviteResponseSchema,
  GetMeResponseSchema,
  GetVersionResponseSchema,
  GetRoomInviteResponseSchema,
  GetRoomResponseSchema,
  GetWorkspaceResponseSchema,
  InviteSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  ListRoomAdmissionsResponseSchema,
  DecideRoomAdmissionRequestSchema,
  DecideRoomAdmissionResponseSchema,
  UpdateRoomInviteRequestSchema,
  UpdateRoomInviteResponseSchema,
  RoomAdmissionStatus,
  JoinVoiceResponseSchema,
  JoinWorkspaceResponseSchema,
  ListCategoriesResponseSchema,
  ListDmCandidatesResponseSchema,
  ListDmsResponseSchema,
  ListNotesResponseSchema,
  CreateNotesRequestSchema,
  CreateNotesResponseSchema,
  UpdateNotesRequestSchema,
  UpdateNotesResponseSchema,
  NotesShelfSchema,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  UpdateDmStateRequestSchema,
  UpdateDmStateResponseSchema,
  DmLastMessageSchema,
  DmSummarySchema,
  ListInvitesResponseSchema,
  ListMembersResponseSchema,
  ListBirthdaysResponseSchema,
  ListMemberBirthdaysResponseSchema,
  ListMessagesResponseSchema,
  ListRoomInvitesResponseSchema,
  ListRoomsResponseSchema,
  ListSessionsResponseSchema,
  ListWorkspacesResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  MeSchema,
  MoveMemberRequestSchema,
  MessageSchema,
  MicMode,
  BILLING_PERMISSIONS,
  PERMISSION_BITS,
  PermissionTargetType,
  PresenceSchema,
  PresenceStatus,
  ReactionSchema,
  ReadStateSchema,
  ReadySchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  RequestStreamRequestSchema,
  RequestStreamResponseSchema,
  RoomCategorySchema,
  RoomInviteSchema,
  RoomMediaOverrideSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  ScreenSharePreset,
  SessionSchema,
  SetEmbedsHiddenRequestSchema,
  SetRoomOrderRequestSchema,
  SetRoomOrderResponseSchema,
  SetRoomPermissionsRequestSchema,
  SetRoomPermissionsResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  UpdateMeRequestSchema,
  UpdateMeResponseSchema,
  UsernameAvailabilityResponseSchema,
  UpdateMemberRequestSchema,
  UpdateMemberBirthdayRequestSchema,
  UpdateMemberBirthdayResponseSchema,
  UpdateMemberResponseSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  UnfurlResponseSchema,
  UpdateReadStateRequestSchema,
  UpdateRoomNotificationSettingsRequestSchema,
  UpdateRoomNotificationSettingsResponseSchema,
  UpdateWorkspaceNotificationSettingsRequestSchema,
  UpdateWorkspaceNotificationSettingsResponseSchema,
  WorkspaceNotificationSettingsSchema,
  RoomNotificationSettingsSchema,
  NotificationLevel,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  UpdateVoiceStatusRequestSchema,
  UpdateStatusRequestSchema,
  PutUserNoteRequestSchema,
  UserNoteResponseSchema,
  UpdateVoiceSelfRequestSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  UploadFileResponseSchema,
  VoiceInfoSchema,
  UserSchema,
  UserSettingsSchema,
  WorkHoursSchema,
  VoiceStateSchema,
  VoiceDisconnectReason,
  VoiceStreamStopReason,
  WorkspaceMemberSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  WorkspaceVisibility,
  computeMemberRoomPermissions,
  tempRoomScope,
  computePermissions,
  has,
  workspacePermissions,
  type PermissionName,
  CreateRoleRequestSchema,
  CreateRoleResponseSchema,
  ListRolesResponseSchema,
  RoleSchema,
  SetMemberRolesRequestSchema,
  SetMemberRolesResponseSchema,
  SetRoleOrderRequestSchema,
  SetRoleOrderResponseSchema,
  UpdateRoleRequestSchema,
  UpdateRoleResponseSchema,
  type Role,
  type DispatchEvent,
  type DmLastMessage,
  type DmSummary,
  type NotesShelf,
  type GatewayFrame,
  type Me,
  type FileMeta,
  type Message,
  type Room,
  type RoomNotificationSettings,
  type WorkspaceNotificationSettings,
  type RoomCategory,
  type RoomInvite,
  type RoomAdmission,
  type Session,
  type VoiceState,
  type WorkspaceMember,
  type WorkspaceSnapshot,
  AttendeeStatus,
  CalendarEventAttendeeSchema,
  CalendarEventResponseSchema,
  CalendarEventSchema,
  CreateCalendarEventRequestSchema,
  EventRepeat,
  EventRsvpTokenRequestSchema,
  EventRsvpTokenResponseSchema,
  ListCalendarEventsResponseSchema,
  RsvpCalendarEventRequestSchema,
  TodayCalendarEventsResponseSchema,
  UpdateCalendarEventRequestSchema,
  type CalendarEvent,
  type CalendarEventAttendee,
} from '@calaba/protocol';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_MEDIA,
  ENTERPRISE_PLAN_LIMITS,
  FREE_PLAN_LIMITS,
  IDS,
  TEAM_PLAN_LIMITS,
  MOCK_EMAIL_CODE,
  MOCK_GPTUNNEL_CODE,
  MOCK_GPTUNNEL_DOWN_CODE,
  MOCK_GPTUNNEL_RATE_CODE,
  MOCK_GPTUNNEL_WEB,
  PASSWORD,
  RECORDING_RESULT,
  buildState,
  builtinRoles,
  defaultSettings,
  effectiveMedia,
  fileMeta,
  mockId,
  nextId,
  sha256,
  tick,
  tokensFor,
  ts,
  type BotRec,
  type EmailInviteRec,
  type MemberRec,
  type MockState,
  type Scenario,
  type UserRec,
  UNFURLS,
  SCENARIOS,
} from './fixtures';
import { MARKETING_UNFURLS } from './fixtures-marketing';
import { MOCK_SIP_RATE_NUMBER, MOCK_SIP_REFUSED_HOST, MOCK_SIP_UNREACHABLE_HOST, defaultSipSettings, isLiveSipStatus, normalizeCallee, numberAllowed, sipSettingsError } from './mock-sip';
import {
  ACTIVE_BEFORE_MS,
  DEFAULT_WORK_HOURS,
  REMINDER_CHOICES,
  davCalendars,
  davOut,
  meetingBusy,
  slotsOf,
  externalEventsOut,
  sharedBusy,
  shareLevelIn,
  type CalDavRec,
  type ExternalSpan,
  type Span,
  type WorkHoursRec,
  activeOccurrence,
  counts,
  eventForGuest,
  eventOut,
  involves,
  occurrences,
  parseRsvpToken,
  rsvpToken,
  viewToken,
  type CalEventRec,
  type EmailView,
  type Occurrence,
} from './mock-calendar';
import { cardPicture, encodePng, pngSize } from './png';
import { freeWindows, intersectIntervals, workIntervals } from '../src/renderer/lib/calendar/freebusy';
import { admissionKey, admissionOutcome, deciderView, guestView, requiresApproval, type AdmissionRec } from './mock-admissions';

export {
  IDS,
  GENERAL_MESSAGE_COUNT,
  MOCK_EMAIL_CODE,
  MOCK_GPTUNNEL_CODE,
  MOCK_GPTUNNEL_DOWN_CODE,
  MOCK_GPTUNNEL_RATE_CODE,
  MOCK_GPTUNNEL_WEB,
  PASSWORD,
  RECORDING_FIXTURE,
  RECORDING_RESULT,
  CODE_FIXTURE,
  mockId,
  type Scenario,
} from './fixtures';
export { MARKETING_IDS, MARKETING_VOICE_STARTED_AT } from './fixtures-marketing';

// ---------------------------------------------------------------- public API

/**
 * A recording card's next state. `result: true` = done with the result (docs/09 #47): the
 * fixture summary (RECORDING_RESULT), a transcript and the audio attachment (IDS.files.meeting).
 */
export interface RecordingCardPatch {
  status: RecordingStatus;
  error?: string;
  webUrl?: string;
  result?: boolean;
}

export interface MockServerOptions {
  /** 0 / unset = random free port. */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  scenario?: Scenario;
  /** LiveKit used by POST /api/rooms/{id}/join (default: the dev LiveKit of infra/docker/compose.dev.yml). */
  livekitUrl?: string;
  livekitKey?: string;
  livekitSecret?: string;
  /** Also serve the web client from this directory (SPA fallback to index.html). */
  staticDir?: string;
  /** Request log sink (default: silent). */
  log?: (line: string) => void;
}

type EventInit = MessageInitShape<typeof DispatchEventSchema>;

/** addEvent(): a meeting as its organizer creates it (ADR-0038); times in ms (UTC). */
export interface AddEventArgs {
  workspaceId: string;
  /** Default: Анна. */
  organizerId?: string;
  title: string;
  description?: string;
  startMs: number;
  endMs: number;
  allDay?: boolean;
  tz?: string;
  /** A voice room of the workspace ('' / unset = none). */
  roomId?: string;
  record?: boolean;
  repeat?: EventRepeat;
  repeatUntilMs?: number;
  /** Members (userId) or external addresses (email); `status` sets an answer right away. */
  attendees?: { userId?: string; email?: string; required?: boolean; status?: AttendeeStatus }[];
}

export interface MockServer {
  url: string;
  port: number;
  /** Live in-memory state (replaced by reset()). */
  readonly state: MockState;
  close(): Promise<void>;
  /** Sends a DISPATCH event to every identified gateway session, unfiltered. */
  dispatch(event: DispatchEvent | EventInit): void;
  /** Rebuilds the fixtures (optionally another scenario) and drops gateway sessions (clients re-IDENTIFY). */
  reset(scenario?: Scenario): void;
  /** Creates a message from another user and fans out MESSAGE_CREATE (e.g. to produce a mention badge). */
  /** `attachments`: fixture file ids uploaded by the author (e.g. IDS.files.audio by Вера). */
  injectMessage(args: { roomId: string; authorId: string; content: string; replyToId?: string; attachments?: string[]; stickerId?: string; forward?: MockForward }): Message;
  /** ADR-0057: registers the global built-in «Calab Stikers» pack (workspace-less, `builtin`, usable everywhere); pictures come from the client bundle. */
  addBuiltinStickerPack(manifest: { id: string; name: string; stickers: { id: string; name: string; emoji: string }[] }): StickerPack;
  /**
   * `userId` read `roomId` up to `messageId` (docs/09 #92): READ_STATE_UPDATE to the reader,
   * READ_RECEIPT to the others (e.g. the DM peer reads Анна's message → ✓✓). False = not moved.
   */
  markRead(userId: string, roomId: string, messageId: string): boolean;
  /**
   * Sets a user's voice state (roomId '' = left voice) and fans out VOICE_STATE_UPDATE.
   * `joinedAtMs`: VoiceState.joined_at (client clock — a visual test's page clock is fixed); kept
   * within the same room, none by default.
   */
  setVoiceState(args: { userId: string; roomId: string; muted?: boolean; deafened?: boolean; streaming?: boolean; camera?: boolean; pending?: boolean; joinedAtMs?: number; musician?: boolean }): void;
  /** Sets a user's presence and fans out PRESENCE_UPDATE. */
  setPresence(userId: string, status: PresenceStatus): void;
  /**
   * The server stops a user's camera like the real one (docs/05 «Камеры»): `camera = false` and
   * VOICE_CAMERA_STOP{reason} to the room's viewers — LIMIT_REACHED is what an over-limit
   * `track_published` produces (the mock has no LiveKit webhooks to detect it by itself).
   */
  stopCamera(userId: string, reason: VoiceStreamStopReason): void;
  /**
   * ADR-0023: a user's email state (fixture users start verified). An unverified user gets a live
   * code (MOCK_EMAIL_CODE, «sent» now) and USER_UPDATE {me} like after a sign-up.
   */
  setEmailState(userId: string, st: { verified: boolean; pendingEmail?: string }): void;
  /**
   * ADR-0025: a room is being recorded (`byUserId` started it `agoMs` ago) — ROOM_RECORDING ACTIVE
   * to the room's viewers, READY `recordings[]` from now on; `null` stops it (reason `user`, no card).
   * `nowMs`: the client's clock (a visual test's page clock is fixed), default Date.now().
   */
  setRecording(roomId: string, rec: { byUserId: string; agoMs?: number; nowMs?: number } | null): void;
  /** ADR-0026: the member's custom roles (built-ins follow their role) → WORKSPACE_MEMBER_UPDATE (+ room visibility). */
  setMemberRoles(workspaceId: string, userId: string, roleIds: string[]): void;
  /** docs/09 #82: a badge of the workspace library with a generated square picture → BADGE_CREATE; its id. */
  addBadge(workspaceId: string, name: string, colors: { bg: [number, number, number]; fg: [number, number, number] }): string;
  /** docs/09 #82: the member's badge ('' = none) → WORKSPACE_MEMBER_UPDATE. */
  setMemberBadge(workspaceId: string, userId: string, badgeId: string): void;
  /** ADR-0035 addendum: a camera background of the workspace with a generated 16:9 picture (a diagonal gradient) → BACKGROUND_CREATE; its id. */
  addBackground(workspaceId: string, name: string, colors: { from: [number, number, number]; to: [number, number, number] }): string;
  /** ADR-0036: a sound of the workspace's soundboard (a copy of a built-in clip) → SOUND_CREATE; its id. */
  addSound(workspaceId: string, name: string, emoji: string): string;
  /** ADR-0036: `userId` pressed `soundId` (`builtin:<id>` or a workspace sound) in `roomId` → SOUND_PLAY to the room's call. */
  playSound(roomId: string, userId: string, soundId: string): void;
  /** ADR-0025: connects the workspace to GPTunneL as if an admin paired it (`null` = disconnect). */
  setGptunnel(workspaceId: string, pairedBy: string | null): void;
  /**
   * ADR-0046: the workspace's SIP account as if an admin saved it (LiveKit accepted the trunk) →
   * WORKSPACE_UPDATE with `sip_enabled`; `null` = never saved (telephony off).
   */
  setSip(workspaceId: string, patch: { enabled?: boolean; host?: string; callerId?: string; allowedPrefixes?: string[]; lastError?: string; hasPassword?: boolean } | null): void;
  /**
   * ADR-0046: `byUserId` placed a call from `roomId` (no permission checks) → SIP_CALL_UPDATE to the
   * room's viewers; `status` default DIALING, `answeredAgoMs` sets answered_at for ACTIVE. Its id.
   */
  placeSipCall(roomId: string, byUserId: string, number: string, status?: SipCallStatus, answeredAgoMs?: number): string;
  /** ADR-0046: moves a call (RINGING / ACTIVE / ENDED / FAILED with `reason`) → SIP_CALL_UPDATE. */
  setSipCallStatus(callId: string, status: SipCallStatus, reason?: string): void;
  /**
   * A recording card in the room chat (SYSTEM message, MESSAGE_CREATE) in the given state; the
   * status never advances by itself (unlike a stop through the API).
   */
  injectRecordingCard(a: {
    roomId: string;
    byUserId: string;
    durationSec: number;
    status: RecordingStatus;
    error?: string;
    webUrl?: string;
    /** FAILED (docs/09 #40): the upload did not complete («Отправить снова»); the file is gone. */
    notUploaded?: boolean;
    fileGone?: boolean;
    /** DONE with the result (docs/09 #47): the fixture summary, a transcript, the audio attachment. */
    result?: boolean;
    /** A forwarded copy (ADR-0033): posted by `by`, marked «Переслано от» `authorId`. */
    forward?: MockForward & { by: string };
  }): Message;
  /** Moves a card on (MESSAGE_UPDATE), like the server's upload worker. */
  updateRecordingCard(messageId: string, patch: RecordingCardPatch): void;
  /**
   * docs/09 #76: the user's birthday (USER_UPDATE), and «🎂 Сегодня день рождения у …» in the room
   * chat as the server's worker posts it (SYSTEM message, MESSAGE_CREATE) when `card` is set.
   */
  setBirthday(userId: string, b: { day: number; month: number; year?: number } | null, card?: { roomId: string }): void;
  /** docs/09 #76: «Скрыть от других» of the user, as PATCH /api/me {birthdayHidden} (USER_UPDATE). */
  setBirthdayHidden(userId: string, hidden: boolean): void;
  /** The mock's «now» for date answers (GET …/birthdays): a visual test's page clock; null = real time. */
  setClock(nowMs: number | null): void;
  /**
   * ADR-0044: a temporary voice room as POST …/rooms/temp by `createdBy` (default Анна) → ROOM_CREATE,
   * with its link (members-only unless `guests`); `expiresAtMs` absolute (a visual test's clock).
   */
  addTempRoom(args: { workspaceId: string; name: string; expiresAtMs: number; createdBy?: string; isPrivate?: boolean; guests?: boolean }): Room;
  /** ADR-0044: the sweeper — temporary rooms with expires_at ≤ `nowMs` are archived (ROOM_DELETE). Returns their ids. */
  expireTempRooms(nowMs?: number): string[];
  /**
   * docs/09 #51: a user's own state of a DM, like PATCH /api/dms/{id}/state — archive / «Удалить
   * чат» (for them only) — and DM_STATE_UPDATE to their devices.
   */
  setDmState(userId: string, roomId: string, patch: { archived?: boolean; cleared?: boolean }): void;
  /** ADR-0039: a notes shelf of `userId`, as POST /api/notes (NOTES_CREATE to their devices). Returns its room id. */
  addShelf(userId: string, name: string, emoji: string): string;
  /**
   * ADR-0031: the two bots of «Команда Calab» join it (IDS.bots — «Погода» with commands and a
   * delivering webhook, «Деплой» with a failing one) → WORKSPACE_MEMBER_ADD + BOT_CREATE.
   */
  seedBots(): void;
  /**
   * docs/08 «Композер — подсказка стикеров»: a pack «Смех» of «Команда Calab» with three 😂
   * stickers (the last animated), installed by Анна after «Calab». Call before the client loads
   * its packs (the first emoji typed or the picker opened).
   */
  seedLaughStickers(): void;
  /** docs/09 #87: a picture avatar for a (seeded) bot, as «Загрузить аватар» in «Боты» sets it. */
  setBotAvatar(botUserId: string, colors: { bg: [number, number, number]; fg: [number, number, number] }): void;
  /** Full files (not thumbnails) wait until releaseFiles() or reset(): a slow download (the lightbox's loading state). */
  holdFiles(): void;
  releaseFiles(): void;
  /**
   * docs/09 #71: a gateway outage. Every socket is cut (no close frame, like a network drop) and
   * new ones are refused for `downMs`; the sessions cannot be resumed (the mock keeps no event
   * buffer — as when the server's buffer does not cover the gap), so clients re-IDENTIFY and get
   * a fresh READY. State changed meanwhile (setVoiceState…) reaches them only through that READY.
   */
  dropGateway(downMs?: number): void;
  /**
   * ADR-0034: `fromUserId` calls `toUserId` in their DM, as POST /api/dms/{id}/call — CALL_RING to
   * the callee, CALL_STATE to both; MISSED after MOCK_CALL_RING_MS (default 45 s). Throws the API
   * error (BUSY / IN_CALL …) like the route. Returns the ringing call.
   */
  ringCall(fromUserId: string, toUserId: string): Call;
  /** ADR-0034: the callee answers (POST …/accept): ACTIVE, CALL_STATE to both, presence on_call. */
  acceptCall(callId: string): Call;
  /** ADR-0034: any call action on behalf of a participant (decline / cancel / hangup …). */
  callAction(callId: string, byUserId: string, action: 'accept' | 'decline' | 'cancel' | 'hangup'): Call;
  /**
   * ADR-0038: a meeting, as POST /api/workspaces/{id}/events by `organizerId` (validated the same
   * way) → EVENT_CREATE, and ROOM_EVENT_ACTIVE when it is within 15 minutes of its start (the
   * mock's clock: setClock, else real time). Returns the series.
   */
  addEvent(a: AddEventArgs): CalendarEvent;
  /** ADR-0038: `userId` answers (PUT /api/events/{id}/rsvp) → EVENT_RSVP. */
  rsvp(eventId: string, userId: string, status: AttendeeStatus): CalendarEvent;
  /** ADR-0038 §5: EVENT_REMINDER to `userId` (default occurrence: the next one). */
  emitReminder(eventId: string, userId: string, minutes: number, occurrenceAtMs?: number): void;
  /** ADR-0038 §6: the room badge of an occurrence starts (ROOM_EVENT_ACTIVE) or ends (ROOM_EVENT_ENDED). */
  setEventActive(eventId: string, active: boolean, occurrenceAtMs?: number): void;
  /** ADR-0038 §6: an occurrence's recording (shown in lists / the card; no event is sent). */
  setEventRecording(eventId: string, occurrenceAtMs: number, recordingId: string): void;
  /** ADR-0041: `userId`'s busy time from an external calendar (free / busy kind EXTERNAL), replacing it. */
  setBusy(userId: string, intervals: readonly ExternalSpan[]): void;
  /** ADR-0041 §4 / ADR-0045: a connected CalDAV account of `userId` (calendar «Работа», import on, synced at the clock). */
  setCalDav(userId: string, patch?: Partial<CalDavRec>): void;
  /** ADR-0041: `userId`'s work hours (default 10:00–19:00 Mon–Fri in their zone; the mock's default zone is Moscow). */
  setWorkHours(userId: string, wh: WorkHoursRec): void;
  /** ADR-0041 §4: what the fake CalDAV server holds for `userId`: a sync with import on copies it to their external busy time (default: 11:00–12:00 MSK of the clock's day). */
  setCalDavRemote(userId: string, intervals: readonly Span[]): void;
  /** The answer link token of an external attendee (the page /e/<id>/rsvp?t=…). */
  eventRsvpToken(eventId: string, email: string, status: AttendeeStatus): string;
  /** ADR-0040: the room's «Подтверждение входа гостей» (ROOM_UPDATE), as PATCH /api/rooms/{id}. */
  setGuestApproval(roomId: string, on: boolean): void;
  /**
   * ADR-0040: a new guest account `nickname` knocks on `roomId` (as a link join with approval):
   * `guest` membership without the room, the knock, ROOM_ADMISSION_REQUEST to the deciders.
   * Returns the guest's user id. `inviteId`: the link used (default: none, the author is Анна).
   */
  knock(roomId: string, nickname: string, inviteId?: string): string;
  /**
   * ADR-0040: decides a waiting knock like POST …/admissions/{userId} by `byUserId` (default
   * Анна): `admitted` gives the room (ROOM_CREATE), `declined` / `no_answer` (the server's 30-min
   * sweep) drop the membership when the guest has no other room; `cancelled` = the guest withdrew.
   * ROOM_ADMISSION_DECIDED to the deciders and the guest.
   */
  decideAdmission(roomId: string, userId: string, status: 'admitted' | 'declined' | 'no_answer' | 'cancelled', byUserId?: string): void;
  /** The view token of an external attendee: the meeting link of its mail, /e/<id>?t=… (no answers). */
  eventViewToken(eventId: string, email: string): string;
  /**
   * The guest link of an external attendee into the meeting's room (made on first call, like
   * the server's: single use, from 15 minutes before the next occurrence until 1 h after it).
   * Returns the absolute /r/<code> URL; GET /api/event-rsvp then carries it as guest_url.
   */
  eventGuestLink(eventId: string, email: string): string;
  /**
   * QA fixture (docs/09 #146 screen): the next GET of `roomId`'s messages answers 500 (the chat's
   * «Не удалось загрузить сообщения · Повторить» state), then behaves normally again. Call it more
   * than once to bank several failures — openRoom's unread-window path (services/chat.ts) makes up
   * to two silent requests before the one that surfaces to the UI.
   */
  failMessagesOnce(roomId: string): void;
  /** Task boards (ADR-0042, mock-boards.ts): the live domain (tasks, boards, activity). */
  readonly boards: BoardsMock;
  /** A task change by another user (e.g. a rename during a call): TASK_UPDATE to the board's viewers. */
  updateTaskAs(actorId: string, taskId: string, patch: { title?: string; statusId?: string }): Task;
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const impl = new MockImpl(opts);
  await impl.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  return {
    url: impl.url,
    port: impl.port,
    get state() {
      return impl.state;
    },
    close: () => impl.close(),
    dispatch: (e) => impl.broadcast(create(DispatchEventSchema, e)),
    reset: (sc) => impl.reset(sc ?? impl.state.scenario),
    injectMessage: (a) => impl.injectMessage(a),
    markRead: (u, roomId, messageId) => impl.markRead(u, roomId, messageId),
    setDmState: (u, roomId, patch) => impl.setDmState(u, roomId, patch),
    addShelf: (u, name, emoji) => impl.addShelf(u, name, emoji),
    setVoiceState: (a) => impl.setVoice(a.userId, a.roomId, a),
    setPresence: (u, st) => impl.setPresence(u, st),
    setMemberRoles: (w, u, ids) => impl.setMemberRoles(w, u, ids),
    addBadge: (w, name, colors) => impl.addBadge(w, name, colors),
    setMemberBadge: (w, u, id) => impl.setMemberBadge(w, u, id),
    addBackground: (w, name, colors) => impl.addBackground(w, name, colors),
    addSound: (w, name, emoji) => impl.addSound(w, name, emoji),
    playSound: (roomId, u, soundId) => impl.playSound(roomId, u, soundId),
    stopCamera: (u, r) => impl.stopCamera(u, r),
    setEmailState: (u, st) => impl.setEmailState(u, st),
    setRecording: (roomId, rec) => impl.setRecording(roomId, rec),
    setGptunnel: (ws, by) => impl.setGptunnel(ws, by),
    setSip: (ws, patch) => impl.setSip(ws, patch),
    placeSipCall: (roomId, by, number, status, ago) => impl.placeSipCall(roomId, by, number, status, ago),
    setSipCallStatus: (id, status, reason) => impl.setSipCallStatus(id, status, reason),
    injectRecordingCard: (a) => impl.injectRecordingCard(a),
    updateRecordingCard: (id, patch) => impl.updateRecordingCard(id, patch),
    setBirthday: (u, b, card) => impl.setBirthday(u, b, card),
    setBirthdayHidden: (u, hidden) => impl.setBirthdayHidden(u, hidden),
    setClock: (ms) => impl.setClock(ms),
    addTempRoom: (a) => impl.addTempRoom(a),
    expireTempRooms: (ms) => impl.expireTempRooms(ms),
    seedBots: () => impl.seedBots(),
    addBuiltinStickerPack: (m) => impl.addBuiltinStickerPack(m),
    seedLaughStickers: () => impl.seedLaughStickers(),
    setBotAvatar: (id, colors) => impl.setBotAvatar(id, colors),
    holdFiles: () => impl.holdFiles(),
    releaseFiles: () => impl.releaseFiles(),
    dropGateway: (ms) => impl.dropGateway(ms ?? 0),
    ringCall: (from, to) => impl.ringCall(from, to),
    acceptCall: (id) => impl.callTransition(id, impl.calleeOf(id), 'accept'),
    callAction: (id, by, action) => impl.callTransition(id, by, action),
    addEvent: (a) => impl.addEvent(a),
    rsvp: (id, u, st) => impl.rsvpEvent(id, u, st),
    emitReminder: (id, u, min, at) => impl.emitReminder(id, u, min, at),
    setEventActive: (id, active, at) => impl.setEventActive(id, active, at),
    setBusy: (u, list) => impl.calExternal.set(u, [...list]),
    setCalDav: (u, patch) => impl.seedCalDav(u, patch),
    setWorkHours: (u, wh) => impl.calWorkHours.set(u, { ...wh, days: [...wh.days] }),
    setCalDavRemote: (u, list) => impl.calDavRemote.set(u, [...list]),
    setEventRecording: (id, at, rec) => impl.setEventRecording(id, at, rec),
    eventRsvpToken: (id, email, st) => rsvpToken(id, email, st),
    setGuestApproval: (roomId, on) => impl.setGuestApproval(roomId, on),
    knock: (roomId, nickname, inviteId) => impl.knock(roomId, nickname, inviteId),
    decideAdmission: (roomId, userId, status, by) => impl.decideAdmission(roomId, userId, status, by),
    eventViewToken: (id, email) => viewToken(id, email),
    eventGuestLink: (id, email) => impl.eventGuestLink(id, email),
    get boards() {
      return impl.boards;
    },
    updateTaskAs: (actor, taskId, patch) => impl.updateTaskAs(actor, taskId, patch),
    failMessagesOnce: (roomId) => impl.failMessages.set(roomId, (impl.failMessages.get(roomId) ?? 0) + 1),
  };
}

// ---------------------------------------------------------------- helpers

const JSON_WRITE = { alwaysEmitImplicit: true } as const;
const JSON_READ = { ignoreUnknownFields: true } as const;

/**
 * LiveKit room name prefix (`mock_<roomId>`). MOCK_LIVEKIT_ROOM_PREFIX separates parallel local
 * runs that share one dev LiveKit (their participants would otherwise meet in the same room).
 */
export function livekitRoomPrefix(): string {
  return process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'mock_';
}
/**
 * Recording card after a stop (ADR-0025): UPLOADING, then PROCESSING and DONE this much later each
 * (MOCK_RECORDING_STEP_MS; 0 = the card stays UPLOADING). The server's RECORDING_MAX_CONCURRENT.
 */
const RECORDING_STEP_MS = Number(process.env['MOCK_RECORDING_STEP_MS'] ?? 1500);
const RECORDING_MAX_CONCURRENT = 3;
/** Simulated LiveKit connect after /join: the pending voice state is cleared this much later. */
const JOIN_CONNECT_MS = 250;
/** ADR-0034: an unanswered call becomes MISSED after this (the server: 45 s). */
const CALL_RING_MS = Number(process.env['MOCK_CALL_RING_MS'] ?? 45_000);
/** ADR-0023: a new email code at most every 60 s; 5 attempts; a re-invite at most once a day. */
const RESEND_MS = 60_000;
const CODE_ATTEMPTS = 5;
const REINVITE_MS = 24 * 3600_000;
const FAR_FUTURE = ts('2099-01-01T00:00:00Z');
const REFRESH_COOKIE = 'calaba_refresh';
const { VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES, CONNECT, SPEAK, STREAM, VIDEO, MUTE_MEMBERS, MANAGE_ROOM, MOVE_MEMBERS } =
  PERMISSION_BITS;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
    /** ApiError reason / used / limit (plan limits, ADR-0024). */
    readonly extra: { reason?: string; used?: bigint; limit?: bigint } = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Plan contact of the mock (READY.plan_contact; the server's default). */
export const MOCK_PLAN_CONTACT = 'mailto:it@gptunnel.ai';

/** 429 with Retry-After (seconds), like the server's limits. */
const tooMany = (what: string, seconds: number): HttpError =>
  new HttpError(429, ErrorCode.RATE_LIMITED, what, '', {}, { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) });
const notVerified = (): HttpError => new HttpError(403, ErrorCode.EMAIL_NOT_VERIFIED, 'email address not verified');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Server locales of emails (ADR-0023): BCP 47 → en | ru | es | zh-CN; null = unsupported. */
function mailLocale(tag: string): string | null {
  const l = tag.trim().toLowerCase();
  if (!l) return '';
  if (/^(ru|uk|be|kk)\b/.test(l)) return 'ru';
  if (/^zh\b/.test(l)) return 'zh-CN';
  if (/^es\b/.test(l)) return 'es';
  if (/^en\b/.test(l)) return 'en';
  return null;
}

const RESERVED_USERNAMES = new Set(['here', 'everyone', 'channel', 'all', 'admin', 'support', 'calab', 'system', 'bot']);

/** ADR-0077: a normalized nickname ('' clears), null when the server would refuse it. */
function mockUsername(raw: string): string | null {
  const n = raw.trim().replace(/^@/, '').toLowerCase();
  if (n === '') return '';
  return /^[a-z][a-z0-9_]{2,31}$/.test(n) && !RESERVED_USERNAMES.has(n) ? n : null;
}

const notFound = (what = 'not found'): HttpError => new HttpError(404, ErrorCode.NOT_FOUND, what);
const forbidden = (what = 'forbidden'): HttpError => new HttpError(403, ErrorCode.FORBIDDEN, what);
/** ADR-0044: an archived temporary room — anything but its history. */
const archived = (): HttpError => new HttpError(410, ErrorCode.ROOM_ARCHIVED, 'the room is archived');
const invalid = (field: string, what: string): HttpError => new HttpError(422, ErrorCode.VALIDATION, what, field);

/**
 * The refusals of the server's ValidateWebP (apps/server/internal/stickers/webp.go) that the
 * client maps to texts — signature, canvas size, frames / duration, bytes — on a light chunk walk.
 */
export function mockWebpProblem(b: Buffer): string | null {
  if (b.length < 20 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return 'missing RIFF/WEBP signature';
  let animated = false;
  let frames = 0;
  let durationMs = 0;
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.subarray(off, off + 4).toString('latin1');
    const size = b.readUInt32LE(off + 4);
    const p = off + 8;
    if (id === 'VP8X' && size >= 10 && p + 10 <= b.length) {
      animated = ((b[p] ?? 0) & 0x02) !== 0;
      const w = b.readUIntLE(p + 4, 3) + 1;
      const h = b.readUIntLE(p + 7, 3) + 1;
      if (w > 512 || h > 512) return `canvas ${w}x${h} is larger than 512`;
    } else if (id === 'ANMF' && size >= 16 && p + 16 <= b.length) {
      frames++;
      durationMs += b.readUIntLE(p + 12, 3);
      if (frames > 300) return 'more than 300 frames';
      if (durationMs > 10_000) return 'animation longer than 10000 ms';
    }
    off = p + size + (size & 1);
  }
  const limit = animated ? 1 << 20 : 512 << 10;
  return b.length > limit ? `file is larger than ${limit >> 10} KB` : null;
}

/** A copy of an animated WebP with every frame lasting `frameMs` (a too long animation for tests). */
export function slowWebpAnimation(src: Buffer, frameMs: number): Buffer {
  const b = Buffer.from(src);
  for (let off = 12; off + 8 <= b.length; ) {
    const size = b.readUInt32LE(off + 4);
    if (b.subarray(off, off + 4).toString('latin1') === 'ANMF' && size >= 16) b.writeUIntLE(frameMs, off + 8 + 12, 3);
    off += 8 + size + (size & 1);
  }
  return b;
}
/** The server's messages.MaxReactionsPerUser. */
const MAX_REACTIONS_PER_USER = 3;
const conflict = (what: string, field = ''): HttpError => new HttpError(409, ErrorCode.CONFLICT, what, field);

// Mentions as the server parses them (apps/server/internal/messages/mentions.go).
const MENTION_RE =
  /(?:^|[^\p{L}\p{N}_.@-])@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|everyone|here)(?![A-Za-z0-9_])/giu;

export function parseMentions(content: string): { users: string[]; everyone: boolean } {
  const text = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const users = new Set<string>();
  let everyone = false;
  for (const m of text.matchAll(MENTION_RE)) {
    const tok = (m[1] ?? '').toLowerCase();
    if (tok === 'everyone' || tok === 'here') everyone = true;
    else if (users.size < 50) users.add(tok);
  }
  return { users: [...users], everyone };
}

const isAdminRole = (r: WorkspaceRole): boolean => r === WorkspaceRole.OWNER || r === WorkspaceRole.ADMIN;

/** Built-in role ids (= legacy names in the mock) implied by the member's built-in role (docs/04). */
const IMPLIED_BUILTINS: Record<WorkspaceRole, string[]> = {
  [WorkspaceRole.UNSPECIFIED]: [],
  [WorkspaceRole.OWNER]: ['owner', 'member'],
  [WorkspaceRole.ADMIN]: ['admin', 'member'],
  [WorkspaceRole.MEMBER]: ['member'],
  [WorkspaceRole.GUEST]: ['guest'],
};

/** Permissions a guest role may carry (docs/04). */
const GUEST_ROLE_BITS =
  PERMISSION_BITS.VIEW_ROOM |
  PERMISSION_BITS.SEND_MESSAGES |
  PERMISSION_BITS.ATTACH_FILES |
  PERMISSION_BITS.CONNECT |
  PERMISSION_BITS.SPEAK |
  PERMISSION_BITS.STREAM |
  PERMISSION_BITS.VIDEO;

/** A role name as the server takes it: 1..32 characters after trimming, unique (case-insensitive). */
function roleNameOk(raw: string, roles: readonly Role[] = [], selfId = ''): string {
  const name = raw.trim();
  if (!name || Array.from(name).length > 32) throw invalid('name', 'name must be 1..32 characters');
  if (roles.some((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())) throw conflict('a role with this name exists', 'name');
  return name;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  raw: Buffer;
  web: boolean;
}

type Handler = (c: Ctx) => Promise<void> | void;

interface Conn {
  ws: WebSocket;
  userId: string | null;
  authSessionId: string;
  gatewaySessionId: string;
  seq: bigint;
  subscribed: Set<string>;
}

function rawToBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

let unfurlPng: Buffer | undefined;
/** Deterministic link-preview picture (1.91:1, like og:image). */
function unfurlImage(): Buffer {
  unfurlPng ??= encodePng(382, 200, cardPicture([52, 120, 246], [255, 255, 255], [199, 222, 255], 382 / 200));
  return unfurlPng;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendMsg<S extends DescMessage>(res: ServerResponse, status: number, schema: S, init: MessageInitShape<S>): void {
  const json = toJson(schema, create(schema, init), JSON_WRITE);
  send(res, status, JSON.stringify(json), 'application/json');
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function parseBody<S extends DescMessage>(c: Ctx, schema: S): MessageShape<S> {
  if (c.raw.length === 0) return create(schema);
  try {
    return fromJson(schema, JSON.parse(c.raw.toString('utf8')) as JsonValue, JSON_READ);
  } catch (e) {
    throw new HttpError(400, ErrorCode.BAD_REQUEST, `malformed body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A voice upload (?voice_duration_ms=&voice_waveform=, docs/09 #43): checked like the server (files.go). */
function parseVoice(c: Ctx, f: { mime: string; bytes: Buffer }): { durationMs: number; waveform: Uint8Array } | undefined {
  const d = c.url.searchParams.get('voice_duration_ms');
  const w = c.url.searchParams.get('voice_waveform');
  if (d === null && w === null) return undefined;
  const ms = Number(d);
  if (!Number.isInteger(ms) || ms < 1 || ms > 300_000) throw invalid('voice_duration_ms', 'must be 1..300000');
  const waveform = new Uint8Array(Buffer.from(w ?? '', 'base64url'));
  if (waveform.length > 100) throw invalid('voice_waveform', 'at most 100 bars');
  const segs = f.bytes[26] ?? 0;
  const opus = f.bytes.subarray(0, 4).toString() === 'OggS' && f.bytes.subarray(27 + segs, 35 + segs).toString() === 'OpusHead';
  if (f.mime.split(';')[0] !== 'audio/ogg' || !opus) throw invalid('file', 'a voice message must be Ogg/Opus (audio/ogg)');
  if (f.bytes.length > 1536 * 1024) throw new HttpError(413, ErrorCode.FILE_TOO_LARGE, 'file too large');
  return { durationMs: ms, waveform };
}

async function parseMultipartFile(c: Ctx): Promise<{ name: string; mime: string; bytes: Buffer }> {
  const type = c.req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, ErrorCode.BAD_REQUEST, 'multipart/form-data expected');
  const form = await new Request('http://mock/upload', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(c.raw) }).formData();
  const f = form.get('file');
  if (!f || typeof f === 'string') throw invalid('file', 'field "file" missing');
  return { name: f.name || 'file', mime: f.type || 'application/octet-stream', bytes: Buffer.from(await f.arrayBuffer()) };
}

// ---------------------------------------------------------------- implementation

class MockImpl {
  state: MockState;
  url = '';
  port = 0;
  private readonly conns = new Set<Conn>();
  private readonly routes: { method: string; re: RegExp; h: Handler }[] = [];
  private readonly http = createServer((req, res) => void this.handle(req, res));
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly lk: { url: string; key: string; secret: string };
  /** userId → auth session (device) that joined voice through /join; fixture voice states have none. */
  private readonly voiceSessions = new Map<string, string>();
  private readonly staticDir: string | null;
  private readonly log: (line: string) => void;
  /** Recording card transitions in flight (cleared on reset / close). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private fileGate: { done: Promise<void>; release: () => void } | null = null;
  /** dropGateway(): gateway sessions that cannot be resumed, and the end of the outage (ms). */
  private readonly droppedSessions = new Set<string>();
  private gatewayDownUntil = 0;
  /** One-to-one calls (ADR-0034): calls by id (finished ones stay) and each user's live call. */
  private readonly calls = new Map<string, Call>();
  private readonly userCall = new Map<string, string>();
  private callSeq = 0;
  /** Meetings (ADR-0038) by id; cancelled ones stay (cancelled_at). */
  private readonly calEvents = new Map<string, CalEventRec>();
  /** Task boards (ADR-0042); rebuilt with the state. */
  boards: BoardsMock;
  /** Free / busy (ADR-0041): work hours, external busy time, CalDAV accounts and the fake remote calendars, by user. */
  readonly calWorkHours = new Map<string, WorkHoursRec>();
  readonly calExternal = new Map<string, ExternalSpan[]>();
  readonly calDav = new Map<string, CalDavRec>();
  readonly calDavRemote = new Map<string, Span[]>();
  /** QA fixture (docs/09 #146 screen): room id → banked messages-GET failures left. */
  readonly failMessages = new Map<string, number>();

  constructor(opts: MockServerOptions) {
    this.state = buildState(opts.scenario ?? 'data');
    this.boards = this.newBoards();
    this.lk = {
      url: opts.livekitUrl ?? 'ws://127.0.0.1:7880',
      key: opts.livekitKey ?? 'devkey',
      secret: opts.livekitSecret ?? 'secret',
    };
    this.staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
    this.log = opts.log ?? (() => undefined);
    this.registerRoutes();
    this.registerCallRoutes();
    this.calendarRoutes();
    this.freeBusyRoutes();
    this.admissionRoutes();
    this.boardRoutes();
    this.seedBoards();
    this.http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://mock').pathname;
      if (path !== '/gateway' || Date.now() < this.gatewayDownUntil) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onGateway(ws));
    });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((res, rej) => {
      this.http.once('error', rej);
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        if (!addr || typeof addr === 'string') {
          rej(new Error('no address'));
          return;
        }
        this.port = addr.port;
        this.url = `http://${host}:${addr.port}`;
        res();
      });
    });
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  reset(scenario: Scenario): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.releaseFiles();
    this.state = buildState(scenario);
    this.boards = this.newBoards();
    this.seedBoards();
    this.voiceSessions.clear();
    this.calls.clear();
    this.userCall.clear();
    this.callSeq = 0;
    this.calEvents.clear();
    this.calWorkHours.clear();
    this.calExternal.clear();
    this.calDav.clear();
    this.calDavRemote.clear();
    this.droppedSessions.clear();
    this.gatewayDownUntil = 0;
    this.clockMs = null;
    this.archivedRooms.clear();
    for (const c of this.conns) c.ws.close(GatewayCloseCode.SESSION_TIMED_OUT, 'mock reset');
  }

  /**
   * A LiveKit join token for a voice room (identity `<user_id>:<session_id>`). LiveKit runs with
   * room.auto_create=false (as in production): like the real API, the room is created first
   * (idempotent).
   */
  private async voiceToken(room: Room, identity: string, name: string): Promise<string> {
    const lkRoom = `${livekitRoomPrefix()}${room.id}`;
    await new RoomServiceClient(this.lk.url.replace(/^ws/, 'http'), this.lk.key, this.lk.secret)
      .createRoom({ name: lkRoom, emptyTimeout: 60 })
      .catch((e: unknown) => this.log(`livekit createRoom ${lkRoom}: ${String(e)}`));
    const at = new AccessToken(this.lk.key, this.lk.secret, { identity, name, ttl: '10m' });
    at.addGrant({ roomJoin: true, room: lkRoom, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
  }

  // ------------------------------------------------ lookups

  private userRec(id: string): UserRec {
    const u = this.state.users.get(id);
    if (!u) throw notFound('user not found');
    return u;
  }

  private member(wsId: string, userId: string): MemberRec | undefined {
    return this.state.members.find((m) => m.workspaceId === wsId && m.userId === userId);
  }

  private membersOf(wsId: string): MemberRec[] {
    return this.state.members.filter((m) => m.workspaceId === wsId);
  }

  private workspacesOf(userId: string): string[] {
    return this.state.members.filter((m) => m.userId === userId).map((m) => m.workspaceId);
  }

  private shareWorkspace(a: string, b: string): boolean {
    const mine = new Set(this.workspacesOf(a));
    return this.workspacesOf(b).some((w) => mine.has(w));
  }

  private perms(room: Room, userId: string): bigint {
    // DM (ADR-0020): the fixed set for the two participants, nothing for anyone else.
    if (room.type === RoomType.DM) {
      return computePermissions({ role: WorkspaceRole.UNSPECIFIED, dm: { participant: this.dmPeer(room.id, userId) !== null } });
    }
    // A task's comment room (ADR-0042): rights from the task's board.
    if (room.type === RoomType.TASK) return this.boards.roomPerms(room.id, userId) ?? 0n;
    // A notes shelf (ADR-0039): the DM set for its owner only.
    if (room.type === RoomType.NOTES) {
      return computePermissions({ role: WorkspaceRole.UNSPECIFIED, dm: { participant: this.state.shelves.get(room.id)?.ownerId === userId } });
    }
    const m = this.member(room.workspaceId, userId);
    // ADR-0029: in a restricted room admins count as members; the owner (owner_id) has everything.
    const owner = this.state.workspaces.get(room.workspaceId)?.ownerId === userId;
    return m ? computeMemberRoomPermissions(this.memberRoles(m), userId, room.permissionOverrides, room.restricted, owner, tempRoomScope(room)) : 0n;
  }

  /** The other participant of a DM room, or null when `userId` is not in it (or it is no DM). */
  private dmPeer(roomId: string, userId: string): string | null {
    const pair = this.state.dmMembers.get(roomId);
    if (!pair?.includes(userId)) return null;
    return pair[0] === userId ? pair[1] : pair[0];
  }

  /** Both are full members (not the guest role) of some workspace (who may start a DM). */
  private shareAsMembers(a: string, b: string): boolean {
    const full = (u: string): Set<string> =>
      new Set(this.state.members.filter((m) => m.userId === u && m.role !== WorkspaceRole.GUEST).map((m) => m.workspaceId));
    const mine = full(a);
    return [...full(b)].some((w) => mine.has(w));
  }

  /** A DM as `userId` sees it (docs/05 «Личные сообщения»): own peer and read state. */
  private dmOut(roomId: string, userId: string): DmSummary | null {
    const room = this.state.rooms.get(roomId);
    const peerId = this.dmPeer(roomId, userId);
    const peer = peerId ? this.state.users.get(peerId)?.user : undefined;
    if (!room || !peer) return null;
    const out = this.roomOut(room);
    const lastRead = this.state.readStates.get(userId)?.get(roomId) ?? '';
    // docs/09 #51: the preview and the counts start after the user's «Удалить чат» mark.
    const st = this.dmStateOf(userId, roomId);
    const last = this.visibleMessages(userId, roomId).at(-1);
    const floor = st.clearedBefore > lastRead ? st.clearedBefore : lastRead;
    return create(DmSummarySchema, {
      room: out,
      peer,
      readState: { roomId, lastReadMessageId: lastRead, ...this.readCounts(roomId, userId, floor) },
      ...(out.lastMessageAt ? { lastMessageAt: out.lastMessageAt } : {}),
      ...(st.archivedAt ? { archivedAt: timestampFromMs(st.archivedAt) } : {}),
      clearedBeforeMessageId: st.clearedBefore,
      // docs/09 #92: the peer's read marker (none for a bot peer).
      peerReadMessageId: peer.isBot ? '' : (this.state.readStates.get(peer.id)?.get(roomId) ?? ''),
      // The list preview (server: the first 200 characters of the newest live message).
      ...(last
        ? {
            lastMessage: {
              id: last.id,
              authorId: last.authorId,
              content: Array.from(last.content).slice(0, 200).join(''),
              attachmentCount: last.attachments.length,
              stickerEmoji: last.sticker?.emoji ?? '',
              ...(last.createdAt ? { createdAt: last.createdAt } : {}),
            },
          }
        : {}),
    });
  }

  /** The user's own state of a DM (docs/09 #51; none = not archived, never cleared). */
  private dmStateOf(userId: string, roomId: string): { archivedAt: number; clearedBefore: string } {
    return this.state.dmState.get(userId)?.get(roomId) ?? { archivedAt: 0, clearedBefore: '' };
  }

  /** A room's messages as the user sees them: a DM they cleared starts after the mark. */
  private visibleMessages(userId: string, roomId: string): Message[] {
    const all = this.state.messages.get(roomId) ?? [];
    const floor = this.state.rooms.get(roomId)?.type === RoomType.DM ? this.dmStateOf(userId, roomId).clearedBefore : '';
    return floor ? all.filter((m) => m.id > floor) : all;
  }

  setDmState(userId: string, roomId: string, patch: { archived?: boolean; cleared?: boolean }): void {
    if (this.dmPeer(roomId, userId) === null) throw notFound('dm not found');
    const cur = this.dmStateOf(userId, roomId);
    const next = { ...cur };
    if (patch.cleared) {
      next.clearedBefore = nextId(this.state, 'message'); // after every message so far
      next.archivedAt = 0;
    }
    if (patch.archived !== undefined) next.archivedAt = patch.archived ? cur.archivedAt || Date.now() : 0;
    const mine = this.state.dmState.get(userId) ?? new Map<string, { archivedAt: number; clearedBefore: string }>();
    mine.set(roomId, next);
    this.state.dmState.set(userId, mine);
    this.toUser(userId, {
      event: {
        case: 'dmStateUpdate',
        value: { roomId, clearedBeforeMessageId: next.clearedBefore, ...(next.archivedAt ? { archivedAt: timestampFromMs(next.archivedAt) } : {}) },
      },
    });
  }

  /** The user's DMs, most recent activity first. */
  private dmsOf(userId: string): DmSummary[] {
    const at = (d: DmSummary): number => { const t = d.lastMessageAt ?? d.room?.createdAt; return t ? timestampMs(t) : 0; };
    return [...this.state.dmMembers.keys()]
      .map((id) => this.dmOut(id, userId))
      .filter((d): d is DmSummary => d !== null)
      .sort((a, b) => at(b) - at(a));
  }

  /** A notes shelf as its owner sees it (ADR-0039), or null when not theirs. */
  private shelfOut(roomId: string, userId: string): NotesShelf | null {
    const room = this.state.rooms.get(roomId);
    const sh = this.state.shelves.get(roomId);
    if (!room || !sh || sh.ownerId !== userId) return null;
    const last = this.state.messages.get(roomId)?.at(-1);
    return create(NotesShelfSchema, {
      room: this.roomOut(room),
      emoji: sh.emoji,
      ...(last
        ? {
            lastMessage: {
              id: last.id,
              authorId: last.authorId,
              content: last.content.slice(0, 200),
              attachmentCount: last.attachments.length,
              ...(last.createdAt ? { createdAt: last.createdAt } : {}),
              stickerEmoji: last.sticker?.emoji ?? '',
            },
          }
        : {}),
    });
  }

  /** The user's shelves by position. */
  private notesOf(userId: string): NotesShelf[] {
    return [...this.state.shelves.keys()]
      .map((id) => this.shelfOut(id, userId))
      .filter((n): n is NotesShelf => n !== null)
      .sort((a, b) => (a.room?.position ?? 0) - (b.room?.position ?? 0) || (a.room?.id ?? '').localeCompare(b.room?.id ?? ''));
  }

  addShelf(userId: string, name: string, emoji: string): string {
    if (this.notesOf(userId).length >= 20) throw new HttpError(409, ErrorCode.CONFLICT, 'at most 20 notes shelves', '', { reason: 'NOTES_LIMIT', used: 20n, limit: 20n });
    const id = nextId(this.state, 'room');
    this.state.rooms.set(id, create(RoomSchema, { id, workspaceId: '', type: RoomType.NOTES, name, position: this.notesOf(userId).length, createdAt: tick(this.state) }));
    this.state.shelves.set(id, { ownerId: userId, emoji });
    const shelf = this.shelfOut(id, userId);
    if (shelf) this.toUser(userId, { event: { case: 'notesCreate', value: { shelf } } });
    return id;
  }

  /** @everyone / @here count as mentions only from authors with MENTION_EVERYONE in the room. */
  private mayMentionAll(room: Room, userId: string): boolean {
    return has(this.perms(room, userId), PERMISSION_BITS.MENTION_EVERYONE);
  }

  private canView(room: Room, userId: string): boolean {
    return has(this.perms(room, userId), VIEW_ROOM);
  }

  /** Workspace the caller belongs to; 404 otherwise (existence stays hidden). */
  private workspaceFor(wsId: string, userId: string): { ws: NonNullable<ReturnType<MockState['workspaces']['get']>>; m: MemberRec } {
    const ws = this.state.workspaces.get(wsId);
    const m = this.member(wsId, userId);
    if (!ws || !m) throw notFound('workspace not found');
    return { ws, m };
  }

  /** Room visible to the caller; 404 otherwise; 410 ROOM_ARCHIVED for an archived temporary room it could see (ADR-0044). */
  private roomFor(roomId: string, userId: string): Room {
    const r = this.state.rooms.get(roomId);
    if (!r) {
      const a = this.archivedRooms.get(roomId);
      if (a && this.canView(a, userId)) throw archived();
      throw notFound('room not found');
    }
    if (!this.canView(r, userId)) throw notFound('room not found');
    return r;
  }

  /** A live room, or an archived temporary one — its history stays readable (ADR-0044). */
  private roomOrArchivedFor(roomId: string, userId: string): Room {
    const a = this.archivedRooms.get(roomId);
    if (a && this.canView(a, userId)) return a;
    return this.roomFor(roomId, userId);
  }

  /** ADR-0044 rooms.MayManage: MANAGE_ROOM in the room, or the creator of a temporary room (not a guest). */
  private mayManageRoom(room: Room, userId: string): boolean {
    if (has(this.perms(room, userId), MANAGE_ROOM)) return true;
    const m = this.member(room.workspaceId, userId);
    return !!room.expiresAt && room.createdBy === userId && !!m && m.role !== WorkspaceRole.GUEST;
  }

  private requireManage(room: Room, userId: string): void {
    if (!this.mayManageRoom(room, userId)) throw forbidden('MANAGE_ROOM required');
  }

  private requireRoomPerm(room: Room, userId: string, bit: bigint): void {
    if (!has(this.perms(room, userId), bit)) throw forbidden('missing permission');
  }

  private requireAdmin(m: MemberRec): void {
    if (!isAdminRole(m.role)) throw forbidden('MANAGE_WORKSPACE required');
  }

  /** ADR-0048: a workspace-level bit of the member's roles (ADMINISTRATOR = all); guests never. */
  private requireWsBit(m: MemberRec, bit: PermissionName): void {
    if (m.role === WorkspaceRole.GUEST || !has(workspacePermissions(this.memberRoles(m)), PERMISSION_BITS[bit])) throw forbidden(`${bit} required`);
  }

  // ------------------------------------------------ roles (ADR-0026)

  /** The workspace's roles, highest first; the four built-ins are created on first use. */
  private rolesOfWs(wsId: string): Role[] {
    let list = this.state.roles.get(wsId);
    if (!list) {
      list = builtinRoles(wsId);
      this.state.roles.set(wsId, list);
    }
    return [...list].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
  }

  /** A member's roles: the built-ins implied by `role` (docs/04) + custom `roleIds`. */
  private memberRoles(m: MemberRec): Role[] {
    const ids = new Set([...IMPLIED_BUILTINS[m.role], ...(m.roleIds ?? [])]);
    return this.rolesOfWs(m.workspaceId).filter((r) => ids.has(r.id));
  }

  /** The caller as a role manager; 403 without MANAGE_ROLES. */
  private roleActor(m: MemberRec): { owner: boolean; admin: boolean; perms: bigint; top: number } {
    const roles = this.memberRoles(m);
    const perms = workspacePermissions(roles);
    if (!has(perms, PERMISSION_BITS.MANAGE_ROLES)) throw forbidden('MANAGE_ROLES required');
    return {
      owner: m.role === WorkspaceRole.OWNER,
      admin: has(perms, PERMISSION_BITS.ADMINISTRATOR),
      perms,
      top: Math.max(-1, ...roles.map((r) => r.position)),
    };
  }

  /** Bits a caller may put on / take off a role: never ADMINISTRATOR; a non-admin only its own, never MANAGE_ROLES / MANAGE_WORKSPACE. */
  private checkGrant(a: { owner: boolean; admin: boolean; perms: bigint }, bits: bigint): void {
    if (bits & PERMISSION_BITS.ADMINISTRATOR) throw forbidden('ADMINISTRATOR is not grantable');
    // ADR-0087: the billing bits are the owner's alone to grant or revoke.
    if (bits & BILLING_PERMISSIONS && !a.owner) throw forbidden('only the owner grants billing permissions');
    if (a.admin) return;
    if (bits & (PERMISSION_BITS.MANAGE_ROLES | PERMISSION_BITS.MANAGE_WORKSPACE)) throw forbidden('only admins grant role / workspace management');
    if (bits & ~a.perms) throw forbidden('cannot grant permissions you lack');
  }

  /** Runs `fn`; then ROOM_CREATE / ROOM_DELETE to each member whose room visibility changed (docs/05). */
  private withVisibility(wsId: string, fn: () => void): void {
    const rooms = [...this.state.rooms.values()].filter((r) => r.workspaceId === wsId && r.type !== RoomType.TASK);
    const before = new Map(this.membersOf(wsId).map((m) => [m.userId, new Set(rooms.filter((r) => this.canView(r, m.userId)).map((r) => r.id))]));
    fn();
    for (const m of this.membersOf(wsId)) {
      const was = before.get(m.userId) ?? new Set<string>();
      for (const r of rooms) {
        const now = this.canView(r, m.userId);
        if (now && !was.has(r.id)) this.toUser(m.userId, { event: { case: 'roomCreate', value: { room: this.roomOut(r) } } });
        if (!now && was.has(r.id)) this.toUser(m.userId, { event: { case: 'roomDelete', value: { workspaceId: wsId, roomId: r.id } } });
      }
    }
  }

  // ------------------------------------------------ serialisation

  private me(u: UserRec): Me {
    return create(MeSchema, {
      user: u.user,
      email: u.email,
      // ADR-0041: work hours are kept apart (calWorkHours), like the reminders on the server.
      settings: { ...clone(UserSettingsSchema, u.settings), workHours: create(WorkHoursSchema, this.workHoursOf(u.user.id)) },
      isSuperadmin: this.state.superadmins.has(u.user.id),
      // Guests have no email: always «verified» (user.proto).
      emailVerified: u.user.isGuest || u.emailVerified,
      pendingEmail: u.pendingEmail,
      locale: u.locale,
      birthdayHidden: u.birthdayHidden ?? false,
    });
  }

  private memberOut(m: MemberRec): WorkspaceMember {
    return create(WorkspaceMemberSchema, {
      workspaceId: m.workspaceId,
      user: this.state.users.get(m.userId)?.user ?? create(UserSchema, { id: m.userId }),
      role: m.role,
      roleIds: this.memberRoles(m).map((r) => r.id),
      nickname: m.nickname,
      joinedAt: m.joinedAt,
      badgeId: m.badgeId ?? '',
    });
  }

  /** Room with last_message_* filled (snapshots / list endpoints). */
  private roomOut(r: Room): Room {
    const last = this.state.messages.get(r.id)?.at(-1);
    return create(RoomSchema, {
      ...r,
      lastMessageId: last?.id ?? '',
      ...(last?.createdAt ? { lastMessageAt: last.createdAt } : {}),
    });
  }

  private presenceOut(userId: string): ReturnType<typeof create<typeof PresenceSchema>> {
    const p = this.state.presences.get(userId);
    if (!p || p.status === PresenceStatus.INVISIBLE || p.status === PresenceStatus.OFFLINE || p.status === PresenceStatus.UNSPECIFIED) {
      // Offline keeps the last known app (docs/09 #143); invisible hides it, like the server.
      const last = p?.status === PresenceStatus.OFFLINE ? { clientVersion: p.clientVersion, clientPlatform: p.clientPlatform } : {};
      return create(PresenceSchema, { userId, status: PresenceStatus.OFFLINE, ...last });
    }
    // ADR-0034: «На звонке» while in an ACTIVE call (only with a visible status).
    if (this.liveCall(userId)?.state === CallState.ACTIVE) {
      const out = clone(PresenceSchema, p);
      out.onCall = true;
      return out;
    }
    return p;
  }

  /** Voice state as the recipient sees it (room hidden when not viewable). */
  private voiceOut(v: VoiceState, recipient: string): VoiceState {
    const room = v.roomId ? this.state.rooms.get(v.roomId) : undefined;
    if (!room || this.canView(room, recipient)) return v;
    return create(VoiceStateSchema, { workspaceId: v.workspaceId, userId: v.userId, roomId: '' });
  }

  private snapshot(wsId: string, userId: string): WorkspaceSnapshot {
    const ws = this.state.workspaces.get(wsId);
    const m = this.member(wsId, userId);
    const rooms = [...this.state.rooms.values()]
      .filter((r) => r.workspaceId === wsId && r.type !== RoomType.TASK && this.canView(r, userId))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const members = this.membersOf(wsId);
    const boards = m && m.role !== WorkspaceRole.GUEST ? this.boards.snapshot(wsId, userId) : { boards: [], unreadTaskIds: [], boardCategories: [] };
    return create(WorkspaceSnapshotSchema, {
      ...(ws ? { workspace: ws } : {}),
      role: m?.role ?? WorkspaceRole.UNSPECIFIED,
      rooms: rooms.map((r) => this.roomOut(r)),
      members: members.map((x) => this.memberOut(x)),
      voiceStates: [...this.state.voiceStates.values()]
        .filter((v) => v.workspaceId === wsId && v.roomId)
        .map((v) => this.voiceOut(v, userId))
        .filter((v) => v.roomId),
      presences: members.map((x) => this.presenceOut(x.userId)),
      permissions: Object.fromEntries(rooms.map((r) => [r.id, this.perms(r, userId)])),
      categories: [...this.state.categories.values()]
        .filter((c) => c.workspaceId === wsId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
      recordings: [...this.state.recordings.values()].filter((r) => r.workspaceId === wsId && rooms.some((x) => x.id === r.roomId)),
      sipCalls: [...this.state.sipCalls.values()].filter((c) => c.workspaceId === wsId && isLiveSipStatus(c.status) && rooms.some((x) => x.id === c.roomId)),
      roles: this.rolesOfWs(wsId),
      badges: this.badgesOf(wsId),
      backgrounds: this.backgroundsOf(wsId),
      sounds: this.soundsOf(wsId),
      activeEvents: m ? this.activeEvents(wsId, userId) : [],
      boards: boards.boards,
      unreadTaskIds: boards.unreadTaskIds,
      boardCategories: boards.boardCategories,
      // ADR-0073 §5: the newest live message of every room, as the room-list preview (server: first 200 chars).
      roomLastMessages: Object.fromEntries(
        rooms.flatMap((r): [string, DmLastMessage][] => {
          const last = this.visibleMessages(userId, r.id).at(-1);
          if (!last) return [];
          return [[r.id, create(DmLastMessageSchema, {
            id: last.id,
            authorId: last.authorId,
            content: Array.from(last.content).slice(0, 200).join(''),
            attachmentCount: last.attachments.length,
            stickerEmoji: last.sticker?.emoji ?? '',
            ...(last.createdAt ? { createdAt: last.createdAt } : {}),
          })]];
        }),
      ),
    });
  }

  /** READY read_states counters, as the server counts them (messages.sql ListReadStates). */
  private readCounts(roomId: string, me: string, lastRead: string): { unreadCount: number; mentionCount: number } {
    const room = this.state.rooms.get(roomId);
    const after = (this.state.messages.get(roomId) ?? []).filter((m) => m.id > lastRead && m.authorId !== me);
    // A DM: every message of the peer counts as a mention (docs/05).
    if (room?.type === RoomType.DM) return { unreadCount: Math.min(after.length, 999), mentionCount: Math.min(after.length, 999) };
    const mentions = after.filter((m) => {
      const { users, everyone } = parseMentions(m.content);
      return users.includes(me) || (everyone && !!room && this.mayMentionAll(room, m.authorId));
    });
    return { unreadCount: Math.min(after.length, 999), mentionCount: Math.min(mentions.length, 99) };
  }

  private ready(conn: Conn, u: UserRec): DispatchEvent {
    const wsIds = this.workspacesOf(u.user.id).sort();
    const reads = this.state.readStates.get(u.user.id) ?? new Map<string, string>();
    return create(DispatchEventSchema, {
      event: {
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: conn.gatewaySessionId,
          me: this.me(u),
          planContact: MOCK_PLAN_CONTACT,
          workspaces: wsIds.map((w) => this.withAdmissions(this.snapshot(w, u.user.id), u.user.id)),
          pendingAdmissions: this.ownAdmissions(u.user.id),
          // Every visible room (server contract): never read → empty marker.
          readStates: [...this.state.rooms.values()]
            .filter((r) => r.type !== RoomType.TASK && (wsIds.includes(r.workspaceId) || r.type === RoomType.DM || r.type === RoomType.NOTES) && this.canView(r, u.user.id))
            .map((r): [string, string] => [r.id, reads.get(r.id) ?? ''])
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([roomId, lastReadMessageId]) => create(ReadStateSchema, { roomId, lastReadMessageId, ...this.readCounts(roomId, u.user.id, lastReadMessageId) })),
          notificationSettings: [...(this.state.notifySettings.get(u.user.id)?.values() ?? [])]
            .filter((n) => {
              const r = this.state.rooms.get(n.roomId);
              return r && this.canView(r, u.user.id);
            })
            .sort((a, b) => a.roomId.localeCompare(b.roomId)),
          workspaceNotificationSettings: [...(this.state.wsNotifySettings.get(u.user.id)?.values() ?? [])]
            .filter((n) => wsIds.includes(n.workspaceId))
            .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
          // Read receipts of workspace rooms (docs/09 #92); DMs carry theirs in dms[].
          peerReads: [...this.state.rooms.values()]
            .filter((r) => r.type !== RoomType.DM && r.type !== RoomType.TASK && wsIds.includes(r.workspaceId) && this.canView(r, u.user.id))
            .map((r) => ({ roomId: r.id, lastReadMessageId: this.peerRead(r.id, u.user.id) }))
            .filter((pr) => pr.lastReadMessageId !== '')
            .sort((a, b) => a.roomId.localeCompare(b.roomId)),
          // Guest accounts have no DMs (ADR-0020).
          dms: u.user.isGuest ? [] : this.dmsOf(u.user.id),
          // Notes shelves (ADR-0039): people only.
          notes: u.user.isGuest || u.user.isBot ? [] : this.notesOf(u.user.id),
          // ADR-0034: the user's ringing / active call.
          ...(this.liveCall(u.user.id) ? { call: this.liveCall(u.user.id) } : {}),
        }),
      },
    });
  }

  // ------------------------------------------------ auth

  private findSession(sessionId: string): { userId: string; session: Session } | null {
    if (this.state.revokedSessions.has(sessionId)) return null;
    for (const [userId, list] of this.state.sessions) {
      const session = list.find((x) => x.id === sessionId);
      if (session) return { userId, session };
    }
    return null;
  }

  private byAccessToken(token: string): { user: UserRec; sessionId: string } | null {
    const m = /^mock-access\.(.+)$/.exec(token);
    const found = m?.[1] ? this.findSession(m[1]) : null;
    const user = found ? this.state.users.get(found.userId) : undefined;
    return found && user ? { user, sessionId: found.session.id } : null;
  }

  private auth(c: Ctx): { user: UserRec; sessionId: string } {
    const h = c.req.headers.authorization ?? '';
    const found = h.startsWith('Bearer ') ? this.byAccessToken(h.slice(7).trim()) : null;
    if (!found) throw new HttpError(401, ErrorCode.UNAUTHENTICATED, 'invalid access token');
    return found;
  }

  private uid(c: Ctx): string {
    return this.auth(c).user.user.id;
  }

  private tokensJson(c: Ctx, sessionId: string): MessageInitShape<typeof AuthTokensSchema> {
    const t = tokensFor(sessionId);
    if (c.web) {
      c.res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=${t.refreshToken}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    }
    return {
      accessToken: t.accessToken,
      accessExpiresAt: FAR_FUTURE,
      refreshToken: c.web ? '' : t.refreshToken,
      refreshExpiresAt: FAR_FUTURE,
      sessionId,
    };
  }

  private clearCookie(c: Ctx): void {
    if (c.web) c.res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  /** Session a login lands in: the user's web session for web clients when there is one. */
  private loginSession(userId: string, web: boolean): string {
    const list = this.state.sessions.get(userId) ?? [];
    const pick = (web ? list.find((s) => s.deviceName.endsWith('(web)')) : list.find((s) => !s.deviceName.endsWith('(web)'))) ?? list[0];
    let id = pick?.id;
    if (!id) {
      id = nextId(this.state, 'session');
      const at = tick(this.state);
      list.push(create(SessionSchema, { id, deviceName: 'Mock device', ip: '192.0.2.10', userAgent: 'mock', createdAt: at, lastSeenAt: at, expiresAt: FAR_FUTURE }));
      this.state.sessions.set(userId, list);
    }
    this.state.revokedSessions.delete(id);
    return id;
  }

  private revoke(sessionId: string): void {
    this.state.revokedSessions.add(sessionId);
    for (const c of this.conns) if (c.authSessionId === sessionId) c.ws.close(GatewayCloseCode.SESSION_REVOKED, 'session revoked');
  }

  // ------------------------------------------------ gateway

  private sendFrame(conn: Conn, init: MessageInitShape<typeof GatewayFrameSchema>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, init)));
  }

  private sendDispatch(conn: Conn, ev: DispatchEvent): void {
    conn.seq += 1n;
    this.sendFrame(conn, { op: GatewayOpcode.DISPATCH, seq: conn.seq, payload: { case: 'dispatch', value: ev } });
  }

  /** Per-recipient fan-out: `pick` returns the event this user should see (or null). */
  private fanout(pick: (userId: string) => DispatchEvent | EventInit | null): void {
    const cache = new Map<string, DispatchEvent | null>();
    for (const c of this.conns) {
      if (!c.userId) continue;
      let ev = cache.get(c.userId);
      if (ev === undefined) {
        const p = pick(c.userId);
        ev = p ? create(DispatchEventSchema, p) : null;
        cache.set(c.userId, ev);
      }
      if (ev) this.sendDispatch(c, ev);
    }
  }

  broadcast(ev: DispatchEvent): void {
    this.fanout(() => ev);
  }

  private toUser(userId: string, ev: EventInit): void {
    this.fanout((u) => (u === userId ? ev : null));
  }

  private toWorkspace(wsId: string, ev: EventInit | ((userId: string) => EventInit | null), roomId?: string): void {
    this.fanout((u) => {
      const r = roomId ? this.state.rooms.get(roomId) : undefined;
      // DM rooms (no workspace): the participants' user channels (docs/05).
      if (r?.type === RoomType.DM || r?.type === RoomType.NOTES) {
        if (!this.canView(r, u)) return null;
      } else {
        if (!this.member(wsId, u)) return null;
        if (roomId && (!r || !this.canView(r, u))) return null;
      }
      return typeof ev === 'function' ? ev(u) : ev;
    });
  }

  private onGateway(ws: WebSocket): void {
    const conn: Conn = { ws, userId: null, authSessionId: '', gatewaySessionId: '', seq: 0n, subscribed: new Set() };
    this.conns.add(conn);
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => this.conns.delete(conn));
    this.sendFrame(conn, { op: GatewayOpcode.HELLO, payload: { case: 'hello', value: { heartbeatIntervalMs: 41_000 } } });
    ws.on('message', (data, isBinary) => {
      let frame: GatewayFrame;
      try {
        if (!isBinary) throw new Error('text frame');
        frame = fromBinary(GatewayFrameSchema, rawToBuffer(data));
      } catch {
        ws.close(GatewayCloseCode.DECODE_ERROR, 'decode error');
        return;
      }
      this.onFrame(conn, frame);
    });
  }

  private onFrame(conn: Conn, f: GatewayFrame): void {
    const p = f.payload;
    const expected: Partial<Record<GatewayOpcode, string>> = {
      [GatewayOpcode.HEARTBEAT]: 'heartbeat',
      [GatewayOpcode.IDENTIFY]: 'identify',
      [GatewayOpcode.RESUME]: 'resume',
      [GatewayOpcode.PRESENCE_UPDATE]: 'setPresence',
      [GatewayOpcode.TYPING]: 'typing',
      [GatewayOpcode.SUBSCRIBE]: 'subscribe',
    };
    if (expected[f.op] === undefined) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'unknown opcode');
      return;
    }
    if (expected[f.op] !== p.case) {
      conn.ws.close(GatewayCloseCode.DECODE_ERROR, 'op/payload mismatch');
      return;
    }

    switch (p.case) {
      case 'heartbeat':
        this.sendFrame(conn, { op: GatewayOpcode.HEARTBEAT_ACK, payload: { case: 'heartbeatAck', value: {} } });
        return;
      case 'identify': {
        if (conn.userId) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'already identified');
      return;
    }
        const found = this.byAccessToken(p.value.token);
        if (!found) {
      conn.ws.close(GatewayCloseCode.AUTHENTICATION_FAILED, 'authentication failed');
      return;
    }
        conn.userId = found.user.user.id;
        conn.authSessionId = found.sessionId;
        conn.gatewaySessionId = `mock-gw.${found.sessionId}`;
        conn.seq = 0n;
        this.sendDispatch(conn, this.ready(conn, found.user));
        return;
      }
      case 'resume': {
        if (conn.userId) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'already identified');
      return;
    }
        const found = this.byAccessToken(p.value.token);
        if (!found) {
      conn.ws.close(GatewayCloseCode.AUTHENTICATION_FAILED, 'authentication failed');
      return;
    }
        if (p.value.sessionId !== `mock-gw.${found.sessionId}` || this.droppedSessions.delete(p.value.sessionId)) {
          this.sendFrame(conn, { op: GatewayOpcode.INVALID_SESSION, payload: { case: 'invalidSession', value: { resumable: false } } });
          return;
        }
        // No event buffer in the mock: events missed while disconnected are not replayed.
        conn.userId = found.user.user.id;
        conn.authSessionId = found.sessionId;
        conn.gatewaySessionId = p.value.sessionId;
        conn.seq = p.value.seq;
        this.sendDispatch(conn, create(DispatchEventSchema, { event: { case: 'resumed', value: { replayed: 0 } } }));
        return;
      }
      default:
        break;
    }
    if (!conn.userId) {
      conn.ws.close(GatewayCloseCode.NOT_AUTHENTICATED, 'not authenticated');
      return;
    }
    const me = conn.userId;
    switch (p.case) {
      case 'setPresence':
        this.setPresence(me, p.value.status);
        return;
      case 'subscribe':
        conn.subscribed = new Set(p.value.roomIds.slice(0, 100));
        return;
      case 'typing': {
        const room = this.state.rooms.get(p.value.roomId);
        if (!room || !has(this.perms(room, me), VIEW_ROOM | SEND_MESSAGES)) return;
        const ev = create(DispatchEventSchema, {
          event: { case: 'typingStart', value: { roomId: room.id, userId: me, timestamp: timestampFromMs(Date.now()) } },
        });
        for (const c of this.conns) if (c.userId && c.userId !== me && c.subscribed.has(room.id) && this.canView(room, c.userId)) this.sendDispatch(c, ev);
        return;
      }
      default:
        return;
    }
  }

  stopCamera(userId: string, reason: VoiceStreamStopReason): void {
    const v = this.state.voiceStates.get(userId);
    const room = v?.roomId ? this.state.rooms.get(v.roomId) : undefined;
    if (!room) return;
    this.setVoice(userId, room.id, { camera: false });
    this.toWorkspace(room.workspaceId, { event: { case: 'voiceCameraStop', value: { workspaceId: room.workspaceId, roomId: room.id, userId, trackSid: '', reason } } }, room.id);
  }

  // ------------------------------------------------ bots (ADR-0031)

  private botOut(b: BotRec, manage: boolean): Bot {
    return create(BotSchema, {
      user: this.state.users.get(b.userId)?.user ?? create(UserSchema, { id: b.userId, isBot: true }),
      username: b.username,
      ownerUserId: b.ownerUserId,
      workspaceId: b.workspaceId,
      description: b.description,
      commands: b.commands,
      createdAt: b.createdAt,
      ...(b.revokedAt ? { revokedAt: b.revokedAt } : {}),
      ...(manage ? { tokenPrefix: b.tokenPrefix, webhook: b.webhook ?? create(BotWebhookSchema, {}) } : {}),
    });
  }

  /** A bot token, deterministic per bot and issue (the token dialog is photographed). */
  private botToken(b: BotRec): string {
    const secret = Buffer.from(sha256(Buffer.from(`${b.userId}:${this.state.clock}`)), 'hex').toString('base64url');
    b.tokenPrefix = `calab_bot_${b.userId.slice(0, 8)}`;
    return `calab_bot_${b.userId}_${secret}`;
  }

  /** 409 PLAN_LIMIT when the workspace has as many bots as its plan allows (0 = no limit). */
  private checkBotPlan(wsId: string): void {
    const limit = this.state.workspaces.get(wsId)?.plan?.limits?.bots ?? 0;
    const used = this.membersOf(wsId).filter((m) => this.state.bots.has(m.userId)).length;
    if (limit > 0 && used >= limit) {
      throw new HttpError(409, ErrorCode.CONFLICT, 'the workspace plan allows no more bots', '', { reason: 'PLAN_LIMIT', used: BigInt(used), limit: BigInt(limit) });
    }
  }

  /** The bot becomes a member (member role) → WORKSPACE_MEMBER_ADD + BOT_CREATE. */
  private botJoin(wsId: string, b: BotRec): void {
    const m: MemberRec = { workspaceId: wsId, userId: b.userId, role: WorkspaceRole.MEMBER, nickname: '', joinedAt: tick(this.state) };
    this.state.members.push(m);
    const member = this.memberOut(m);
    this.toWorkspace(wsId, { event: { case: 'workspaceMemberAdd', value: { member } } });
    this.toWorkspace(wsId, { event: { case: 'botCreate', value: { workspaceId: wsId, bot: this.botOut(b, b.workspaceId === wsId) } } });
  }

  private botLeave(wsId: string, botId: string): void {
    this.toWorkspace(wsId, { event: { case: 'workspaceMemberRemove', value: { workspaceId: wsId, userId: botId } } });
    this.toWorkspace(wsId, { event: { case: 'botDelete', value: { workspaceId: wsId, botUserId: botId } } });
    this.state.members = this.state.members.filter((m) => !(m.workspaceId === wsId && m.userId === botId));
  }

  private botUpdate(b: BotRec): void {
    for (const wsId of this.workspacesOf(b.userId)) {
      this.toWorkspace(wsId, { event: { case: 'botUpdate', value: { workspaceId: wsId, bot: this.botOut(b, wsId === b.workspaceId) } } });
    }
  }

  private newBot(a: { id: string; name: string; username: string; owner: string; workspaceId: string; description: string; commands?: Array<[string, string]> }): BotRec {
    const s = this.state;
    s.users.set(a.id, {
      user: create(UserSchema, { id: a.id, displayName: a.name, isBot: true, createdAt: tick(s) }),
      email: '',
      password: '',
      settings: defaultSettings(),
      emailVerified: true,
      pendingEmail: '',
      locale: '',
    });
    const b: BotRec = {
      userId: a.id,
      username: a.username,
      ownerUserId: a.owner,
      workspaceId: a.workspaceId,
      description: a.description,
      commands: (a.commands ?? []).map(([name, description]) => create(BotCommandSchema, { name, description })),
      tokenPrefix: '',
      createdAt: tick(s),
    };
    s.bots.set(a.id, b);
    return b;
  }

  seedLaughStickers(): void {
    const s = this.state;
    const packId = nextId(s, 'stickerPack');
    const at = tick(s);
    const files = [IDS.files.stickerSun, IDS.files.stickerGem, IDS.files.stickerOrbit];
    const stickers = files.map((fileId, i) =>
      create(StickerSchema, { id: nextId(s, 'sticker'), packId, emoji: '😂', url: `/api/files/${fileId}`, width: 160, height: 160, animated: i === 2, size: s.files.get(fileId)?.bytes.length ?? 0 }),
    );
    const pack = create(StickerPackSchema, { id: packId, workspaceId: IDS.workspaces.main, name: 'Смех', shortName: 'laughs', stickers, createdBy: IDS.users.anna, createdAt: at, updatedAt: at });
    s.stickerPacks.set(packId, pack);
    s.userStickerPacks.set(IDS.users.anna, [...(s.userStickerPacks.get(IDS.users.anna) ?? []), packId]);
  }

  seedBots(): void {
    const ws = IDS.workspaces.main;
    const weather = this.newBot({
      id: IDS.bots.weather,
      name: 'Погода',
      username: 'weather_bot',
      owner: IDS.users.anna,
      workspaceId: ws,
      description: 'Погода и прогноз для любого города. Утренняя сводка — в комнату, где её включили.',
      commands: [
        ['weather', 'Погода сейчас: /weather Москва'],
        ['forecast', 'Прогноз на 5 дней'],
        ['subscribe', 'Утренняя сводка в эту комнату'],
        ['help', 'Что я умею'],
      ],
    });
    this.botToken(weather);
    weather.webhook = create(BotWebhookSchema, { url: 'https://hooks.calab.test/weather', enabled: true, lastOkAt: ts('2026-01-15T11:58:00Z') });
    const deploy = this.newBot({
      id: IDS.bots.deploy,
      name: 'Деплой',
      username: 'deploy_bot',
      owner: IDS.users.boris,
      workspaceId: ws,
      description: 'Выкатывает ветки на стенд и пишет, что поменялось.',
    });
    this.botToken(deploy);
    deploy.webhook = create(BotWebhookSchema, {
      url: 'https://ci.calab.test/hooks/calab',
      enabled: true,
      failingSince: ts('2026-01-15T09:12:00Z'),
      lastError: 'HTTP 502 Bad Gateway',
      pending: 7,
    });
    this.botJoin(ws, weather);
    this.botJoin(ws, deploy);
    // «Погода» runs (a gateway socket); «Деплой» is a webhook bot that is down.
    this.setPresence(weather.userId, PresenceStatus.ONLINE);
  }

  setMemberRoles(workspaceId: string, userId: string, roleIds: string[]): void {
    const m = this.member(workspaceId, userId);
    if (!m) throw new Error(`no member ${userId}`);
    this.withVisibility(workspaceId, () => {
      m.roleIds = [...roleIds];
    });
    this.toWorkspace(workspaceId, { event: { case: 'workspaceMemberUpdate', value: { member: this.memberOut(m) } } });
  }

  setBotAvatar(botUserId: string, colors: { bg: [number, number, number]; fg: [number, number, number] }): void {
    const u = this.state.users.get(botUserId);
    if (!u?.user.isBot) throw new Error(`no bot ${botUserId}`);
    const png = encodePng(64, 64, (x, y) => ((x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.09 ? colors.fg : colors.bg));
    u.user.avatarFileId = this.storeFile('', botUserId, { name: 'avatar.png', mime: 'image/png', bytes: png });
    this.emitUserUpdate(u);
  }

  addBadge(workspaceId: string, name: string, colors: { bg: [number, number, number]; fg: [number, number, number] }): string {
    const ws = this.state.workspaces.get(workspaceId);
    if (!ws) throw new Error(`no workspace ${workspaceId}`);
    // A 64×64 «logo»: a filled square with a centred disc (what the client uploads after its crop).
    const png = encodePng(64, 64, (u, v) => ((u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.09 ? colors.fg : colors.bg));
    const fileId = this.storeFile(workspaceId, ws.ownerId, { name: 'badge.png', mime: 'image/png', bytes: png });
    const badge = create(BadgeSchema, { id: nextId(this.state, 'badge'), workspaceId, name, fileId });
    this.state.badges.set(badge.id, badge);
    this.toWorkspace(workspaceId, { event: { case: 'badgeCreate', value: { badge } } });
    return badge.id;
  }

  setMemberBadge(workspaceId: string, userId: string, badgeId: string): void {
    const m = this.member(workspaceId, userId);
    if (!m) throw new Error(`no member ${userId}`);
    if (badgeId) m.badgeId = badgeId;
    else delete m.badgeId;
    this.toWorkspace(workspaceId, { event: { case: 'workspaceMemberUpdate', value: { member: this.memberOut(m) } } });
  }

  addBackground(workspaceId: string, name: string, colors: { from: [number, number, number]; to: [number, number, number] }): string {
    const ws = this.state.workspaces.get(workspaceId);
    if (!ws) throw new Error(`no workspace ${workspaceId}`);
    const mix = (a: number, b: number, k: number): number => Math.round(a + (b - a) * k);
    const png = encodePng(320, 180, (u, v) => {
      const k = (u + v) / 2;
      return [mix(colors.from[0], colors.to[0], k), mix(colors.from[1], colors.to[1], k), mix(colors.from[2], colors.to[2], k)];
    });
    const fileId = this.storeFile(workspaceId, ws.ownerId, { name: 'background.png', mime: 'image/png', bytes: png });
    const background = create(WorkspaceBackgroundSchema, { id: nextId(this.state, 'background'), workspaceId, name, fileId });
    this.state.backgrounds.set(background.id, background);
    this.toWorkspace(workspaceId, { event: { case: 'backgroundCreate', value: { background } } });
    return background.id;
  }

  addSound(workspaceId: string, name: string, emoji: string): string {
    const ws = this.state.workspaces.get(workspaceId);
    if (!ws) throw new Error(`no workspace ${workspaceId}`);
    const bytes = readFileSync(new URL('../src/renderer/assets/sounds/quack.ogg', import.meta.url));
    const fileId = this.storeFile(workspaceId, ws.ownerId, { name: 'sound.ogg', mime: 'audio/ogg', bytes });
    const position = this.soundsOf(workspaceId).length;
    const sound = create(SoundSchema, { id: nextId(this.state, 'sound'), workspaceId, name, emoji, fileId, durationMs: 1097, position });
    this.state.sounds.set(sound.id, sound);
    this.toWorkspace(workspaceId, { event: { case: 'soundCreate', value: { sound } } });
    return sound.id;
  }

  playSound(roomId: string, userId: string, soundId: string): void {
    const at = timestampFromMs(Date.now());
    for (const v of this.state.voiceStates.values()) {
      if (v.roomId === roomId) this.toUser(v.userId, { event: { case: 'soundPlay', value: { roomId, soundId, userId, at } } });
    }
  }

  private soundsOf(wsId: string): Sound[] {
    return [...this.state.sounds.values()].filter((x) => x.workspaceId === wsId).sort((a, b) => a.position - b.position);
  }

  private backgroundsOf(wsId: string): WorkspaceBackground[] {
    return [...this.state.backgrounds.values()].filter((b) => b.workspaceId === wsId);
  }

  private badgesOf(wsId: string): Badge[] {
    return [...this.state.badges.values()].filter((b) => b.workspaceId === wsId);
  }

  setPresence(userId: string, status: PresenceStatus): void {
    const prev = this.state.presences.get(userId);
    this.state.presences.set(userId, create(PresenceSchema, { userId, status, ...(prev?.lastSeen ? { lastSeen: prev.lastSeen } : {}) }));
    this.announcePresence(userId);
  }

  private announcePresence(userId: string): void {
    const presence = this.presenceOut(userId);
    this.fanout((u) => (u === userId || this.shareWorkspace(u, userId) ? { event: { case: 'presenceUpdate', value: { presence } } } : null));
  }

  setVoice(userId: string, roomId: string, patch: { muted?: boolean; deafened?: boolean; streaming?: boolean; serverMuted?: boolean; camera?: boolean; pending?: boolean; joinedAtMs?: number; musician?: boolean }): void {
    const prev = this.state.voiceStates.get(userId);
    const room = roomId ? this.state.rooms.get(roomId) : undefined;
    // ADR-0034: a DM call's voice session — no workspace; its events go to the two participants.
    const prevDm = prev?.roomId ? this.state.rooms.get(prev.roomId)?.type === RoomType.DM : false;
    if (room?.type === RoomType.DM || (!room && prevDm)) {
      this.setDmVoice(userId, room, prev, prevDm, patch);
      return;
    }
    if (prevDm && prev) this.setDmVoice(userId, undefined, prev, true, {}); // a DM call → a workspace room
    const workspaceId = room?.workspaceId ?? prev?.workspaceId ?? '';
    if (!workspaceId) return;
    const sameRoom = prev?.roomId === roomId && !!roomId;
    const v = create(VoiceStateSchema, {
      workspaceId,
      userId,
      roomId: room ? room.id : '',
      muted: patch.muted ?? (sameRoom ? prev.muted : false),
      deafened: patch.deafened ?? (sameRoom ? prev.deafened : false),
      streaming: patch.streaming ?? (sameRoom ? prev.streaming : false),
      serverMuted: patch.serverMuted ?? (sameRoom ? prev.serverMuted : false),
      camera: patch.camera ?? (sameRoom ? prev.camera : false),
      pending: patch.pending ?? (sameRoom ? prev.pending : false),
      musician: patch.musician ?? (sameRoom ? prev.musician : false),
      joinedAt: patch.joinedAtMs !== undefined ? timestampFromMs(patch.joinedAtMs) : sameRoom ? prev.joinedAt : undefined,
    });
    // Moving to another workspace's room: tell the old workspace the user left.
    if (prev?.roomId && prev.workspaceId !== workspaceId) {
      const left = create(VoiceStateSchema, { workspaceId: prev.workspaceId, userId, roomId: '' });
      this.toWorkspace(prev.workspaceId, { event: { case: 'voiceStateUpdate', value: { state: left } } });
    }
    if (room) this.state.voiceStates.set(userId, v);
    else {
      this.state.voiceStates.delete(userId);
      this.voiceSessions.delete(userId);
    }
    // Room.voice_started_at: set when a room gets its first participant, cleared when it
    // empties; the change goes out as ROOM_UPDATE (call timers).
    const timers: Room[] = [];
    for (const rid of new Set([prev?.roomId, room?.id])) {
      const r = rid ? this.state.rooms.get(rid) : undefined;
      if (!r) continue;
      const occupied = [...this.state.voiceStates.values()].some((x) => x.roomId === r.id);
      // The call status (Room.voice_status) belongs to the call: cleared when the room empties.
      if (!occupied && (r.voiceStartedAt || r.voiceStatus)) {
        r.voiceStartedAt = undefined;
        r.voiceStatus = '';
      } else if (occupied && !r.voiceStartedAt) r.voiceStartedAt = tick(this.state);
      else continue;
      timers.push(r);
    }
    this.toWorkspace(workspaceId, (u) => ({ event: { case: 'voiceStateUpdate', value: { state: this.voiceOut(v, u) } } }));
    for (const r of timers) this.toWorkspace(r.workspaceId, { event: { case: 'roomUpdate', value: { room: this.roomOut(r) } } }, r.id);
  }

  // ------------------------------------------------ one-to-one calls (ADR-0034)
  // Same rules as internal/calls: RINGING → ACTIVE → ENDED, RINGING → DECLINED | CANCELLED |
  // MISSED; BUSY / IN_CALL are 409 (BUSY also leaves a card); a CallCard system message in the
  // DM on every end (MISSED unread for the callee). Not simulated: the lost-connection end.

  /** The user's RINGING / ACTIVE call. */
  private liveCall(userId: string): Call | undefined {
    const id = this.userCall.get(userId);
    const c = id ? this.calls.get(id) : undefined;
    return c && (c.state === CallState.RINGING || c.state === CallState.ACTIVE) ? c : undefined;
  }

  calleeOf(callId: string): string {
    return this.calls.get(callId)?.calleeId ?? '';
  }

  private callNow(): Timestamp {
    return timestampFromMs(this.clockMs ?? Date.now());
  }

  private publishCall(c: Call): void {
    for (const u of [c.callerId, c.calleeId]) this.toUser(u, { event: { case: 'callState', value: { call: clone(CallSchema, c) } } });
  }

  /** 403 unless the peer may be called: a person sharing a workspace as a full member. */
  private placeCall(from: string, dmId: string): Call {
    const me = this.userRec(from);
    const peerId = this.dmPeer(dmId, from);
    if (!peerId) throw notFound('dm not found');
    const peer = this.userRec(peerId);
    if (me.user.isGuest || me.user.isBot) throw forbidden('cannot call');
    if (peer.user.isBot || peer.user.isGuest || !this.shareAsMembers(from, peerId)) throw forbidden('this user cannot be called');
    if (this.liveCall(from)) throw new HttpError(409, ErrorCode.IN_CALL, 'you are already in a call');
    const call = create(CallSchema, { id: `00000000-0000-7000-80ff-${(++this.callSeq).toString(16).padStart(12, '0')}`, dmRoomId: dmId, callerId: from, calleeId: peerId, state: CallState.RINGING, createdAt: this.callNow() });
    if (this.liveCall(peerId)) {
      call.state = CallState.BUSY;
      call.endedAt = call.createdAt;
      this.postCallCard(call);
      throw new HttpError(409, ErrorCode.BUSY, 'the user is in another call');
    }
    this.calls.set(call.id, call);
    this.userCall.set(from, call.id);
    this.userCall.set(peerId, call.id);
    this.toUser(peerId, { event: { case: 'callRing', value: { call: clone(CallSchema, call), caller: me.user } } });
    this.publishCall(call);
    this.later(CALL_RING_MS, () => {
      if (call.state === CallState.RINGING) this.finishCall(call, CallState.MISSED, '');
    });
    return call;
  }

  ringCall(fromUserId: string, toUserId: string): Call {
    const dmId = [...this.state.dmMembers.entries()].find(([, pair]) => pair.includes(fromUserId) && pair.includes(toUserId))?.[0];
    if (!dmId) throw notFound('no DM between these users');
    return clone(CallSchema, this.placeCall(fromUserId, dmId));
  }

  callTransition(callId: string, by: string, action: 'accept' | 'decline' | 'cancel' | 'hangup'): Call {
    const c = this.calls.get(callId);
    if (!c || (by !== c.callerId && by !== c.calleeId)) throw notFound('call not found');
    const side = { accept: c.calleeId, decline: c.calleeId, cancel: c.callerId, hangup: '' }[action];
    if (side && by !== side) throw forbidden('only the other side of the call can do this');
    const want = action === 'hangup' ? CallState.ACTIVE : CallState.RINGING;
    if (c.state !== want) throw conflict('the call is not ' + (want === CallState.ACTIVE ? 'active' : 'ringing'));
    if (action === 'accept') {
      c.state = CallState.ACTIVE;
      c.answeredAt = this.callNow();
      this.publishCall(c);
      this.announcePresence(c.callerId);
      this.announcePresence(c.calleeId);
    } else {
      const next = { decline: CallState.DECLINED, cancel: CallState.CANCELLED, hangup: CallState.ENDED }[action];
      this.finishCall(c, next, action === 'hangup' ? 'hangup' : '');
    }
    return clone(CallSchema, c);
  }

  private finishCall(c: Call, state: CallState, reason: string): void {
    const wasActive = c.state === CallState.ACTIVE;
    c.state = state;
    c.reason = reason;
    c.endedAt = this.callNow();
    for (const u of [c.callerId, c.calleeId]) if (this.userCall.get(u) === c.id) this.userCall.delete(u);
    this.publishCall(c);
    this.postCallCard(c);
    if (!wasActive) return;
    for (const u of [c.callerId, c.calleeId]) {
      if (this.state.voiceStates.get(u)?.roomId === c.dmRoomId) this.setVoice(u, '', {});
      this.announcePresence(u);
    }
  }

  /** The DM log line (SystemMessage.call): author = the caller; read at once except MISSED. */
  private postCallCard(c: Call): void {
    const room = this.state.rooms.get(c.dmRoomId);
    if (!room) return;
    const outcomes = new Map<CallState, CallOutcome>([
      [CallState.ENDED, CallOutcome.ENDED],
      [CallState.MISSED, CallOutcome.MISSED],
      [CallState.DECLINED, CallOutcome.DECLINED],
      [CallState.CANCELLED, CallOutcome.CANCELLED],
      [CallState.BUSY, CallOutcome.BUSY],
    ]);
    const outcome = outcomes.get(c.state) ?? CallOutcome.UNSPECIFIED;
    const durationSec =
      c.state === CallState.ENDED && c.answeredAt && c.endedAt ? Math.floor((timestampMs(c.endedAt) - timestampMs(c.answeredAt)) / 1000) : 0;
    const readers = [c.callerId];
    const calleeRead = this.state.readStates.get(c.calleeId)?.get(room.id) ?? '';
    if (c.state !== CallState.MISSED && this.readCounts(room.id, c.calleeId, calleeRead).unreadCount === 0) readers.push(c.calleeId);
    const list = this.state.messages.get(room.id) ?? [];
    const msg = create(MessageSchema, {
      id: nextId(this.state, 'message'),
      roomId: room.id,
      authorId: c.callerId,
      content: '',
      kind: MessageKind.SYSTEM,
      system: {
        payload: {
          case: 'call',
          value: { callerId: c.callerId, outcome, durationSec, callId: c.state === CallState.BUSY ? '' : c.id, ...(c.createdAt ? { startedAt: c.createdAt } : {}) },
        },
      },
      createdAt: tick(this.state),
    });
    list.push(msg);
    this.state.messages.set(room.id, list);
    for (const u of readers) {
      const reads = this.state.readStates.get(u) ?? new Map<string, string>();
      reads.set(room.id, msg.id);
      this.state.readStates.set(u, reads);
    }
    if (c.state === CallState.MISSED && this.dmStateOf(c.calleeId, room.id).archivedAt) this.setDmState(c.calleeId, room.id, { archived: false });
    this.toWorkspace('', { event: { case: 'messageCreate', value: { workspaceId: '', message: msg } } }, room.id);
    for (const u of readers) this.toUser(u, { event: { case: 'readStateUpdate', value: { readState: { roomId: room.id, lastReadMessageId: msg.id } } } });
  }

  /** 409 CALL_NOT_ACTIVE unless `userId` is in the DM's ACTIVE call. */
  private requireCall(dmId: string, userId: string): void {
    const c = this.liveCall(userId);
    if (c?.state !== CallState.ACTIVE || c.dmRoomId !== dmId) {
      throw new HttpError(409, ErrorCode.CALL_NOT_ACTIVE, 'there is no active call of yours in this direct message');
    }
  }

  /**
   * One device in voice at a time (docs/05 «Несколько устройств»): a /join from another session
   * of the user tells the device in voice VOICE_DISCONNECTED{OTHER_DEVICE}; the join that follows
   * moves the (per-user) voice state. The mock's LiveKit connection of that device is left to it.
   */
  private takeOverVoice(userId: string, sessionId: string): void {
    const prev = this.voiceSessions.get(userId);
    const roomId = this.state.voiceStates.get(userId)?.roomId;
    if (!prev || prev === sessionId || !roomId) return;
    const workspaceId = this.state.rooms.get(roomId)?.workspaceId ?? '';
    this.toUser(userId, { event: { case: 'voiceDisconnected', value: { workspaceId, roomId, sessionId: prev, reason: VoiceDisconnectReason.OTHER_DEVICE } } });
  }

  /** POST /api/rooms/{dm}/join: the DM's voice session, for a participant of its ACTIVE call. */
  private async joinCall(c: Ctx, room: Room, name: string, sessionId: string): Promise<void> {
    const me = this.uid(c);
    this.requireCall(room.id, me);
    const identity = `${me}:${sessionId}`;
    const token = await this.voiceToken(room, identity, name);
    this.takeOverVoice(me, sessionId);
    const cur = this.state.voiceStates.get(me);
    const again = cur?.roomId === room.id && this.voiceSessions.get(me) === sessionId;
    const pending = again ? cur.pending : true;
    if (!again) {
      this.setVoice(me, room.id, { muted: false, deafened: false, streaming: false, camera: false, pending: true });
      this.voiceSessions.set(me, sessionId);
      setTimeout(() => {
        const v = this.state.voiceStates.get(me);
        if (v?.roomId === room.id && v.pending && this.voiceSessions.get(me) === sessionId) this.setVoice(me, room.id, { pending: false });
      }, JOIN_CONNECT_MS).unref();
    }
    sendMsg(c.res, 200, JoinVoiceResponseSchema, {
      url: this.lk.url,
      token,
      identity,
      media: { audioBitrateKbps: 48, maxStreamPreset: ScreenSharePreset.H1080, maxStreams: 4, cameraLimit: 4 },
      canSpeak: true,
      canStream: true,
      canVideo: true,
      pending,
    });
  }

  /** setVoice for a DM call's session: workspace_id empty, to the two participants only. */
  private setDmVoice(userId: string, room: Room | undefined, prev: VoiceState | undefined, prevDm: boolean, patch: Parameters<MockImpl['setVoice']>[2]): void {
    if (room && prev?.roomId && !prevDm) this.setVoice(userId, '', {}); // leaves the workspace room first
    const sameRoom = !!room && prev?.roomId === room.id;
    const v = create(VoiceStateSchema, {
      workspaceId: '',
      userId,
      roomId: room?.id ?? '',
      muted: patch.muted ?? (sameRoom ? prev.muted : false),
      deafened: patch.deafened ?? (sameRoom ? prev.deafened : false),
      streaming: patch.streaming ?? (sameRoom ? prev.streaming : false),
      camera: patch.camera ?? (sameRoom ? prev.camera : false),
      pending: patch.pending ?? (sameRoom ? prev.pending : false),
      musician: patch.musician ?? (sameRoom ? prev.musician : false),
    });
    const dmId = room?.id ?? (prevDm ? (prev?.roomId ?? '') : '');
    if (room) this.state.voiceStates.set(userId, v);
    else {
      this.state.voiceStates.delete(userId);
      this.voiceSessions.delete(userId);
    }
    if (prevDm && prev?.roomId && prev.roomId !== dmId) {
      this.toWorkspace('', { event: { case: 'voiceStateUpdate', value: { state: create(VoiceStateSchema, { userId, roomId: '' }) } } }, prev.roomId);
    }
    if (dmId) this.toWorkspace('', { event: { case: 'voiceStateUpdate', value: { state: v } } }, dmId);
  }

  private registerCallRoutes(): void {
    this.route('POST', '/api/dms/:id/call', (c) => {
      const call = this.placeCall(this.uid(c), c.params[0] ?? '');
      sendMsg(c.res, 201, StartCallResponseSchema, { call });
    });
    for (const action of ['accept', 'decline', 'cancel', 'hangup'] as const) {
      this.route('POST', `/api/calls/:id/${action}`, (c) => {
        const call = this.callTransition(c.params[0] ?? '', this.uid(c), action);
        sendMsg(c.res, 200, CallActionResponseSchema, { call });
      });
    }
    // Control endpoints (tests in another process): ringCall / callAction.
    const ctl = (c: Ctx): Record<string, string> => (c.raw.length ? (JSON.parse(c.raw.toString('utf8')) as Record<string, string>) : {});
    this.route('POST', '/__mock/call/ring', (c) => {
      const b = ctl(c);
      sendMsg(c.res, 200, StartCallResponseSchema, { call: this.ringCall(b['fromUserId'] ?? '', b['toUserId'] ?? '') });
    });
    this.route('POST', '/__mock/call/action', (c) => {
      const b = ctl(c);
      const id = b['callId'] ?? '';
      const action = b['action'] as 'accept' | 'decline' | 'cancel' | 'hangup';
      if (!['accept', 'decline', 'cancel', 'hangup'].includes(action)) throw invalid('action', 'accept | decline | cancel | hangup');
      const by = b['userId'] || (action === 'cancel' ? (this.calls.get(id)?.callerId ?? '') : this.calleeOf(id));
      sendMsg(c.res, 200, CallActionResponseSchema, { call: this.callTransition(id, by, action) });
    });
  }

  // ------------------------------------------------ messages

  /** A message as `userId` sees it in REST responses (Reaction.me filled). */
  private msgOut(m: Message, userId: string): Message {
    const byEmoji = this.state.reactions.get(m.id);
    if (!byEmoji?.size) return m;
    return { ...m, reactions: m.reactions.map((r) => ({ ...r, me: byEmoji.get(r.emoji)?.has(userId) ?? false })) };
  }

  /** Full-text search stand-in: case-insensitive substring over rooms, newest first (cursor `before`). */
  private search(c: Ctx, roomIds: string[]): void {
    const me = this.uid(c);
    const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q || q.length > 200) throw invalid('q', 'search query must be 1..200 characters');
    const limit = Math.min(50, Math.max(1, Number(c.url.searchParams.get('limit') ?? '25') || 25));
    const before = c.url.searchParams.get('before') ?? '';
    const author = c.url.searchParams.get('author_id') ?? '';
    const words = q.split(/\s+/);
    const hits = roomIds
      .flatMap((id) => this.visibleMessages(me, id))
      .filter((m) => (!before || m.id < before) && (!author || m.authorId === author))
      .filter((m) => words.every((w) => m.content.toLowerCase().includes(w)))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: hits.slice(0, limit).map((m) => this.msgOut(m, me)), hasMore: hits.length > limit });
  }

  private createMessage(
    room: Room,
    authorId: string,
    content: string,
    replyToId: string,
    nonce: string,
    attachmentIds: string[],
    sticker?: Sticker,
    forward?: MockForward,
  ): Message {
    const attachments = attachmentIds.map((id) => {
      const f = this.state.files.get(id);
      if (!f || f.meta.uploaderId !== authorId) throw invalid('attachmentIds', `unknown attachment ${id}`);
      return f.meta;
    });
    const list = this.state.messages.get(room.id) ?? [];
    if (replyToId && !list.some((m) => m.id === replyToId)) throw invalid('replyToId', 'reply target not found');
    const msg = create(MessageSchema, {
      id: nextId(this.state, 'message'),
      roomId: room.id,
      authorId,
      content,
      attachments,
      replyToId,
      nonce,
      createdAt: tick(this.state),
      ...(sticker ? { sticker } : {}),
      ...(forward ? { forward: forwardOf(forward) } : {}),
    });
    list.push(msg);
    this.state.messages.set(room.id, list);
    // The author has read their own message.
    const reads = this.state.readStates.get(authorId) ?? new Map<string, string>();
    reads.set(room.id, msg.id);
    this.state.readStates.set(authorId, reads);
    // docs/09 #51: an incoming message takes the DM out of the recipient's archive.
    const peer = room.type === RoomType.DM ? this.dmPeer(room.id, authorId) : null;
    if (peer && this.dmStateOf(peer, room.id).archivedAt) this.setDmState(peer, room.id, { archived: false });
    this.toWorkspace(room.workspaceId, { event: { case: 'messageCreate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
    if (room.type === RoomType.TASK) this.boards.onComment(room.id, authorId, msg, parseMentions(content).users);
    return msg;
  }

  /** Read receipts (docs/09 #92): the furthest read marker of the room's other people (bots' reads do not count); '' = none. */
  private peerRead(roomId: string, userId: string): string {
    let best = '';
    for (const [u, reads] of this.state.readStates) {
      if (u === userId || this.state.users.get(u)?.user.isBot) continue;
      const id = reads.get(roomId) ?? '';
      if (id > best) best = id;
    }
    return best;
  }

  /**
   * `userId` read `roomId` up to `messageId` (PUT /api/rooms/{id}/read; tests: someone else reads).
   * The marker only moves forward; the reader's devices get READ_STATE_UPDATE, everyone else
   * whose «others read up to» moved gets READ_RECEIPT (the server's 3 s room throttle is not
   * modelled). Bots' reads send no receipts, bots get none. False = the marker did not move.
   */
  markRead(userId: string, roomId: string, messageId: string): boolean {
    const room = this.state.rooms.get(roomId);
    const reads = this.state.readStates.get(userId) ?? new Map<string, string>();
    if (!room || !(messageId > (reads.get(roomId) ?? ''))) return false;
    const isBot = (u: string): boolean => this.state.users.get(u)?.user.isBot === true;
    const before = new Map([...this.state.users.keys()].map((u) => [u, this.peerRead(roomId, u)]));
    reads.set(roomId, messageId);
    this.state.readStates.set(userId, reads);
    this.toUser(userId, { event: { case: 'readStateUpdate', value: { readState: { roomId, lastReadMessageId: messageId, unreadCount: 0, mentionCount: 0 } } } });
    if (isBot(userId)) return true;
    this.toWorkspace(
      room.workspaceId,
      (u) => {
        if (u === userId || isBot(u)) return null;
        const now = this.peerRead(roomId, u);
        return now > (before.get(u) ?? '') ? { event: { case: 'readReceipt', value: { roomId, lastReadMessageId: now } } } : null;
      },
      roomId,
    );
    return true;
  }

  injectMessage(a: { roomId: string; authorId: string; content: string; replyToId?: string; attachments?: string[]; stickerId?: string; forward?: MockForward }): Message {
    const room = this.state.rooms.get(a.roomId);
    if (!room) throw notFound('room not found');
    const sticker = a.stickerId ? (this.findSticker(a.stickerId)?.sticker ?? this.state.deletedStickers.get(a.stickerId)) : undefined;
    return this.createMessage(room, a.authorId, a.content, a.replyToId ?? '', '', a.attachments ?? [], sticker, a.forward);
  }

  // ------------------------------------------------ sticker packs (ADR-0030)

  /** A live sticker and its pack. */
  private findSticker(id: string): { sticker: Sticker; pack: StickerPack } | null {
    for (const pack of this.state.stickerPacks.values()) {
      const sticker = pack.stickers.find((x) => x.id === id);
      if (sticker) return { sticker, pack };
    }
    return null;
  }

  private stickerManager(wsId: string, userId: string): void {
    const m = this.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (!has(workspacePermissions(this.memberRoles(m)), PERMISSION_BITS.MANAGE_STICKERS)) throw forbidden('MANAGE_STICKERS required');
  }

  private packFor(id: string, userId: string, manage: boolean): StickerPack {
    const p = this.state.stickerPacks.get(id);
    if (!p || !this.member(p.workspaceId, userId)) throw notFound('sticker pack not found');
    if (manage) this.stickerManager(p.workspaceId, userId);
    return p;
  }

  /** Non-guest members of the pack's workspace may use it: its rooms, and DMs of two such members. */
  private stickerUsable(pack: StickerPack, room: Room, userId: string): boolean {
    if (pack.builtin) return true; // ADR-0057: global, every plan, guests too
    const full = (u: string): boolean => {
      const m = this.member(pack.workspaceId, u);
      return !!m && m.role !== WorkspaceRole.GUEST;
    };
    if (room.type === RoomType.DM) return (this.state.dmMembers.get(room.id) ?? []).every(full);
    if (room.type === RoomType.NOTES) return full(this.state.shelves.get(room.id)?.ownerId ?? '');
    return room.workspaceId === pack.workspaceId && full(userId);
  }

  private myPacks(userId: string): MessageInitShape<typeof MyStickerPacksResponseSchema> {
    const mine = (this.state.userStickerPacks.get(userId) ?? []).map((id) => this.state.stickerPacks.get(id)).filter((p): p is StickerPack => !!p && !p.builtin);
    const builtin = [...this.state.stickerPacks.values()].filter((p) => p.builtin);
    const ws = new Set(this.state.members.filter((m) => m.userId === userId && m.role !== WorkspaceRole.GUEST).map((m) => m.workspaceId));
    const installed = [...builtin, ...mine.filter((p) => ws.has(p.workspaceId))];
    const ids = new Set(installed.map((p) => p.id));
    const available = [...this.state.stickerPacks.values()].filter((p) => !p.builtin && ws.has(p.workspaceId) && !ids.has(p.id));
    return { installed, available };
  }

  /** ADR-0057: the global built-in pack (workspace-less, `builtin`); its pictures are bundled with the client, the URL is a placeholder. */
  addBuiltinStickerPack(manifest: { id: string; name: string; stickers: { id: string; name: string; emoji: string }[] }): StickerPack {
    const at = ts('2026-01-01T00:00:00Z');
    const stickers = manifest.stickers.map((x) =>
      create(StickerSchema, { id: x.id, packId: manifest.id, emoji: x.emoji, url: `/api/stickers/builtin/${x.id}.webp`, width: 512, height: 512, animated: false, size: 20_000 }),
    );
    const pack = create(StickerPackSchema, { id: manifest.id, workspaceId: '', name: manifest.name, shortName: 'calab_stikers', stickers, createdBy: '', createdAt: at, updatedAt: at, builtin: true });
    this.state.stickerPacks.set(pack.id, pack);
    return pack;
  }

  private packEvent(p: StickerPack, created = false): void {
    this.toWorkspace(p.workspaceId, { event: created ? { case: 'stickerPackCreate', value: { pack: p } } : { case: 'stickerPackUpdate', value: { pack: p } } });
  }

  private findMessage(id: string): { room: Room; list: Message[]; index: number } {
    for (const [roomId, list] of this.state.messages) {
      const index = list.findIndex((m) => m.id === id);
      const room = this.state.rooms.get(roomId);
      if (index >= 0 && room) return { room, list, index };
    }
    throw notFound('message not found');
  }

  // ------------------------------------------------ room visibility

  /** ROOM_UPDATE / ROOM_PERMISSIONS_UPDATE with visibility recomputation (docs/05, filtering). */
  private emitRoomChange(before: Room, after: Room, original: EventInit): void {
    this.toWorkspace(after.workspaceId, (u) => {
      const was = this.canView(before, u);
      const now = this.canView(after, u);
      if (now && !was) return { event: { case: 'roomCreate', value: { room: this.roomOut(after) } } };
      if (!now && was) return { event: { case: 'roomDelete', value: { workspaceId: after.workspaceId, roomId: after.id } } };
      return now ? original : null;
    });
  }

  // ------------------------------------------------ HTTP

  private route(method: string, pattern: string, h: Handler): void {
    const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.routes.push({ method, re, h });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    try {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const raw = Buffer.concat(chunks);
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mock/');
      if (!isApi) {
        if (url.pathname === '/healthz') {
          send(res, 200, 'ok', 'text/plain');
          return;
        }
        if (this.staticDir && (method === 'GET' || method === 'HEAD')) {
          await this.serveStatic(url.pathname, res);
          return;
        }
        throw notFound();
      }
      let pathMatched = false;
      for (const r of this.routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const ctx: Ctx = { req, res, url, raw, params: m.slice(1).map(decodeURIComponent), web: req.headers['x-client'] === 'web' };
        await r.h(ctx);
        this.log(`${method} ${url.pathname} → ${res.statusCode}`);
        return;
      }
      throw pathMatched ? new HttpError(405, ErrorCode.BAD_REQUEST, 'method not allowed') : notFound('no such endpoint');
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e));
      this.log(`${method} ${url.pathname} → ${err.status} ${err.message}`);
      if (res.headersSent) return void res.end();
      const json = toJson(ApiErrorSchema, create(ApiErrorSchema, { code: err.code, message: err.message, field: err.field, ...err.extra }), JSON_WRITE);
      send(res, err.status, JSON.stringify(json), 'application/json', err.headers);
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const root = this.staticDir ?? '';
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) throw notFound();
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    if (!isFile) file = join(root, 'index.html'); // SPA fallback
    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  }

  private registerRoutes(): void {
    const s = (): MockState => this.state;

    // ---------------- auth
    this.route('POST', '/api/auth/login', (c) => {
      const b = parseBody(c, LoginRequestSchema);
      const email = b.email.trim().toLowerCase();
      const found = [...s().users.values()].find((u) => u.email === email);
      const u = found ?? s().users.get(IDS.users.anna);
      if (!u || (b.password !== PASSWORD && b.password !== u.password)) {
        throw new HttpError(401, ErrorCode.INVALID_CREDENTIALS, 'invalid email or password');
      }
      if (!u.emailVerified && !u.user.isGuest) {
        const key = `verify:${u.user.id}`;
        const last = s().emailCodes.get(key);
        if (!last || Date.now() - last.sentAtMs >= RESEND_MS) s().emailCodes.set(key, { attempts: 0, sentAtMs: Date.now() });
      }
      const sessionId = this.loginSession(u.user.id, c.web);
      sendMsg(c.res, 200, LoginResponseSchema, { tokens: this.tokensJson(c, sessionId), me: this.me(u) });
    });

    this.route('POST', '/api/auth/register', (c) => {
      const b = parseBody(c, RegisterRequestSchema);
      const email = b.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw invalid('email', 'invalid email');
      if (b.password.length < 8) throw invalid('password', 'password must be at least 8 characters');
      if (!b.displayName.trim()) throw invalid('displayName', 'display name required');
      if ([...s().users.values()].some((u) => u.email === email)) throw conflict('email already registered', 'email');
      const emailInvite = b.inviteCode ? this.emailInviteByCode(b.inviteCode) : undefined;
      // An emailed invitation (ADR-0027): a sign-up code for its address only; the user joins once
      // the address is confirmed (POST /api/auth/verify), like the server.
      if (emailInvite?.accepted) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite used up');
      if (emailInvite && emailInvite.email !== email) throw new HttpError(403, ErrorCode.INVITE_EMAIL_MISMATCH, 'invitation for another address');
      const invite = b.inviteCode && !emailInvite ? [...s().invites.values()].find((i) => i.code === b.inviteCode) : undefined;
      if (b.inviteCode && !invite && !emailInvite) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      if (invite?.maxUses && invite.uses >= invite.maxUses) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite used up');
      const locale = mailLocale(b.locale) ?? '';
      const id = nextId(s(), 'user');
      const at = tick(s());
      const rec: UserRec = {
        user: create(UserSchema, { id, displayName: b.displayName.trim(), avatarFileId: '', statusText: '', createdAt: at }),
        email,
        password: b.password,
        settings: defaultSettings(),
        emailVerified: false,
        pendingEmail: '',
        locale,
      };
      s().users.set(id, rec);
      s().presences.set(id, create(PresenceSchema, { userId: id, status: PresenceStatus.ONLINE, lastSeen: at }));
      const sessionId = nextId(s(), 'session');
      s().sessions.set(id, [
        create(SessionSchema, {
          id: sessionId,
          deviceName: b.deviceName || 'Mock device',
          ip: '192.0.2.10',
          userAgent: 'mock',
          createdAt: at,
          lastSeenAt: at,
          expiresAt: FAR_FUTURE,
        }),
      ]);
      if (invite) this.joinWorkspace(invite.workspaceId, id, invite.id);
      s().emailCodes.set(`verify:${id}`, { attempts: 0, sentAtMs: Date.now() }); // the code «mail»
      sendMsg(c.res, 201, RegisterResponseSchema, { tokens: this.tokensJson(c, sessionId), me: this.me(rec) });
    });

    this.route('POST', '/api/auth/refresh', (c) => {
      const b = parseBody(c, RefreshRequestSchema);
      const token = b.refreshToken || (c.web ? (cookies(c.req)[REFRESH_COOKIE] ?? '') : '');
      const m = /^mock-refresh\.(.+)$/.exec(token);
      const found = m?.[1] ? this.findSession(m[1]) : null;
      if (!found) {
        this.clearCookie(c);
        throw new HttpError(401, ErrorCode.INVALID_REFRESH_TOKEN, 'invalid refresh token');
      }
      sendMsg(c.res, 200, RefreshResponseSchema, { tokens: this.tokensJson(c, found.session.id) });
    });

    this.route('POST', '/api/auth/logout', (c) => {
      const b = parseBody(c, LogoutRequestSchema);
      const h = c.req.headers.authorization ?? '';
      let target = h.startsWith('Bearer ') ? this.byAccessToken(h.slice(7).trim()) : null;
      if (!target) {
        const token = b.refreshToken || (c.web ? (cookies(c.req)[REFRESH_COOKIE] ?? '') : '');
        const m = /^mock-refresh\.(.+)$/.exec(token);
        const f = m?.[1] ? this.findSession(m[1]) : null;
        const user = f ? s().users.get(f.userId) : undefined;
        if (f && user) target = { user, sessionId: f.session.id };
      }
      this.clearCookie(c);
      if (target) {
        if (b.allSessions) for (const x of s().sessions.get(target.user.user.id) ?? []) this.revoke(x.id);
        else this.revoke(target.sessionId);
      }
      noContent(c.res);
    });

    this.emailRoutes();
    this.recordingRoutes();
    this.sipRoutes();

    // ---------------- version (public; the web compares its bundle, docs/09 #125)
    this.route('GET', '/api/version', (c) => {
      sendMsg(c.res, 200, GetVersionResponseSchema, { version: this.state.serverVersion, commit: 'mock', license: 'BUSL-1.1', product: 'Calab' });
    });

    // ---------------- me
    this.route('GET', '/api/me', (c) => {
      sendMsg(c.res, 200, GetMeResponseSchema, { me: this.me(this.auth(c).user) });
    });

    this.route('PATCH', '/api/me', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, UpdateMeRequestSchema);
      // ADR-0041: work_hours (validated like the server; guests and bots 403).
      if (b.workHours) {
        if (u.user.isGuest || u.user.isBot) throw forbidden('work hours are not for guests and bots');
        const wh = { startMin: b.workHours.startMin, endMin: b.workHours.endMin, days: [...new Set(b.workHours.days)].sort((x, y) => x - y) };
        if (wh.startMin % 15 || wh.endMin % 15 || wh.startMin < 0 || wh.endMin > 1440 || wh.endMin <= wh.startMin) throw invalid('workHours', 'work hours are 15-minute steps, end after start');
        if (!wh.days.length || wh.days.some((d) => d < 1 || d > 7)) throw invalid('workHours.days', 'days are 1..7, at least one');
        this.calWorkHours.set(u.user.id, wh);
      }
      if (b.displayName !== undefined) {
        if (!b.displayName.trim()) throw invalid('displayName', 'display name required');
        u.user.displayName = b.displayName.trim();
      }
      if (b.statusText !== undefined) u.user.statusText = b.statusText;
      if (b.timezone !== undefined) u.user.timezone = b.timezone;
      // ADR-0077 (the server's rules, users/contacts.go).
      if (b.username !== undefined) {
        if (u.user.isGuest || u.user.isBot) throw forbidden('not for guests and bots');
        const name = mockUsername(b.username);
        if (name === null) throw new HttpError(422, ErrorCode.USERNAME_INVALID, 'bad username', 'username');
        if (name && [...s().users.values()].some((x) => x !== u && x.user.username === name)) throw new HttpError(409, ErrorCode.USERNAME_TAKEN, 'username is taken', 'username');
        u.user.username = name;
      }
      if (b.phone !== undefined) {
        if (u.user.isGuest || u.user.isBot) throw forbidden('not for guests and bots');
        const p = b.phone.trim().replace(/\s+/g, ' ');
        if (p && (p.length > 32 || !/^\+?[0-9() -]+$/.test(p) || p.replace(/\D/g, '').length < 3)) throw invalid('phone', 'bad phone');
        u.user.phone = p;
      }
      if (b.birthday) {
        // docs/09 #76 (the server checks the date too); day = month = 0 clears.
        const { day, month, year } = b.birthday;
        if (!day && !month) delete u.user.birthday;
        else if (month < 1 || month > 12 || day < 1 || day > 31) throw invalid('birthday.day', 'no such day in that month');
        else u.user.birthday = create(BirthdaySchema, { day, month, ...(year !== undefined ? { year } : {}) });
      }
      if (b.birthdayHidden !== undefined) u.birthdayHidden = b.birthdayHidden;
      if (b.locale !== undefined) {
        const l = mailLocale(b.locale);
        if (l === null) throw invalid('locale', 'unsupported locale');
        u.locale = l;
      }
      if (b.avatarFileId !== undefined) {
        if (b.avatarFileId && !s().files.has(b.avatarFileId)) throw invalid('avatarFileId', 'unknown file');
        u.user.avatarFileId = b.avatarFileId;
      }
      if (b.eventReminders) {
        // ADR-0038 §5: ≤ 5 distinct values of REMINDER_CHOICES, largest first.
        const mins = [...new Set(b.eventReminders.minutes)];
        if (mins.some((x) => !REMINDER_CHOICES.includes(x))) throw invalid('eventReminders.minutes', 'reminders are 5, 10, 15, 30, 60, 120 or 1440 minutes');
        if (mins.length > 5) throw invalid('eventReminders.minutes', 'at most 5 reminders');
        u.settings.eventReminders = mins.sort((x, y) => y - x);
        u.settings.eventRemindersDnd = b.eventReminders.dnd;
      }
      if (b.settings) {
        const st = create(UserSettingsSchema, b.settings);
        // Meeting reminders are stored apart: a settings replace keeps them (user.proto).
        st.eventReminders = u.settings.eventReminders;
        st.eventRemindersDnd = u.settings.eventRemindersDnd;
        if (st.micMode === MicMode.UNSPECIFIED) st.micMode = MicMode.VAD;
        // The server keeps the deprecated flag in sync with mic_mode (user.proto).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        st.pushToTalk = st.micMode === MicMode.PUSH_TO_TALK;
        u.settings = st;
      }
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    // ADR-0077: a hint for the profile form (the caller's own nickname is available).
    this.route('GET', '/api/usernames/:name/available', (c) => {
      const me = this.auth(c).user;
      const name = mockUsername(decodeURIComponent(c.params[0] ?? ''));
      const taken = name !== null && [...s().users.values()].some((x) => x !== me && x.user.username === name);
      sendMsg(c.res, 200, UsernameAvailabilityResponseSchema, {
        username: name ?? '',
        available: name !== null && name !== '' && !taken,
        reason: name === null || name === '' ? ErrorCode.USERNAME_INVALID : taken ? ErrorCode.USERNAME_TAKEN : ErrorCode.UNSPECIFIED,
      });
    });

    this.route('PATCH', '/api/me/status', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, UpdateStatusRequestSchema);
      if (b.text.length > 128) throw invalid('text', 'status too long');
      u.user.statusText = b.text;
      u.user.statusEmoji = b.emoji;
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    // ---------------- private notes (docs/09 #20): the author only; 404 without a shared workspace / DM
    const noteSubject = (c: Ctx): { me: string; subject: string } => {
      const me = this.uid(c);
      const subject = c.params[0] ?? '';
      const wsOf = (u: string): Set<string> => new Set(s().members.filter((m) => m.userId === u).map((m) => m.workspaceId));
      const mine = wsOf(me);
      const shared =
        subject === me ||
        [...wsOf(subject)].some((w) => mine.has(w)) ||
        [...s().dmMembers.values()].some(([a, b]) => (a === me && b === subject) || (a === subject && b === me));
      if (!shared || !s().users.has(subject)) throw notFound('user not found');
      return { me, subject };
    };
    const noteOut = (me: string, subject: string): MessageInitShape<typeof UserNoteResponseSchema> => {
      const n = s().notes.get(me)?.get(subject);
      return { note: { subjectId: subject, text: n?.text ?? '', ...(n ? { updatedAt: n.updatedAt } : {}) } };
    };
    this.route('GET', '/api/users/:id/note', (c) => {
      const { me, subject } = noteSubject(c);
      sendMsg(c.res, 200, UserNoteResponseSchema, noteOut(me, subject));
    });
    this.route('PUT', '/api/users/:id/note', (c) => {
      const { me, subject } = noteSubject(c);
      const text = parseBody(c, PutUserNoteRequestSchema).text.trim();
      if (Array.from(text).length > 1000) throw invalid('text', 'note must be at most 1000 characters');
      const mine = s().notes.get(me) ?? new Map<string, { text: string; updatedAt: Timestamp }>();
      s().notes.set(me, mine);
      if (text) mine.set(subject, { text, updatedAt: tick(s()) });
      else mine.delete(subject);
      sendMsg(c.res, 200, UserNoteResponseSchema, noteOut(me, subject));
    });
    this.route('DELETE', '/api/users/:id/note', (c) => {
      const { me, subject } = noteSubject(c);
      s().notes.get(me)?.delete(subject);
      noContent(c.res);
    });

    this.route('POST', '/api/me/avatar', async (c) => {
      const u = this.auth(c).user;
      const f = await parseMultipartFile(c);
      if (!f.mime.startsWith('image/')) throw invalid('file', 'image expected');
      const id = this.storeFile('', u.user.id, f);
      u.user.avatarFileId = id;
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    this.route('GET', '/api/me/sessions', (c) => {
      const { user, sessionId } = this.auth(c);
      const sessions = (s().sessions.get(user.user.id) ?? [])
        .filter((x) => !s().revokedSessions.has(x.id))
        .map((x) => create(SessionSchema, { ...x, current: x.id === sessionId }));
      sendMsg(c.res, 200, ListSessionsResponseSchema, { sessions });
    });

    this.route('DELETE', '/api/me/sessions/:id', (c) => {
      const { user } = this.auth(c);
      const id = c.params[0] ?? '';
      if (!(s().sessions.get(user.user.id) ?? []).some((x) => x.id === id) || s().revokedSessions.has(id)) throw notFound('session not found');
      this.revoke(id);
      noContent(c.res);
    });

    // Password / email change (proto user.proto): the current password is required; a wrong one
    // is 403 INVALID_CREDENTIALS (not an auth failure — the session stays).
    this.route('PATCH', '/api/me/password', (c) => {
      const { user: u, sessionId } = this.auth(c);
      const b = parseBody(c, ChangePasswordRequestSchema);
      if (b.newPassword.length < 8 || b.newPassword.length > 256) throw invalid('newPassword', 'password must be 8..256 characters');
      if (u.user.isGuest) throw forbidden('guest account');
      if (b.currentPassword !== u.password) throw new HttpError(403, ErrorCode.INVALID_CREDENTIALS, 'invalid password');
      u.password = b.newPassword;
      for (const x of s().sessions.get(u.user.id) ?? []) if (x.id !== sessionId && !s().revokedSessions.has(x.id)) this.revoke(x.id);
      noContent(c.res);
    });

    this.route('PATCH', '/api/me/email', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, ChangeEmailRequestSchema);
      const email = b.newEmail.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('newEmail', 'invalid email address');
      if (u.user.isGuest) throw forbidden('guest account');
      if (b.currentPassword !== u.password) throw new HttpError(403, ErrorCode.INVALID_CREDENTIALS, 'invalid password');
      if ([...s().users.values()].some((x) => x !== u && x.email === email)) throw conflict('email is already registered');
      if (email === u.email) {
        u.pendingEmail = ''; // a change to the current address cancels the pending one
        s().emailCodes.delete(`verify:${u.user.id}`);
      } else {
        const key = `verify:${u.user.id}`;
        const last = s().emailCodes.get(key);
        if (u.pendingEmail === email && last && Date.now() - last.sentAtMs < RESEND_MS) {
          throw tooMany('a code was sent less than 60 s ago', (RESEND_MS - (Date.now() - last.sentAtMs)) / 1000);
        }
        u.pendingEmail = email; // ADR-0023: a code to the new address; login stays on the old one
        s().emailCodes.set(key, { attempts: 0, sentAtMs: Date.now() });
      }
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    // ---------------- workspaces
    this.route('GET', '/api/workspaces', (c) => {
      const me = this.uid(c);
      const workspaces = this.workspacesOf(me)
        .sort()
        .map((id) => s().workspaces.get(id))
        .filter((w) => w !== undefined);
      sendMsg(c.res, 200, ListWorkspacesResponseSchema, { workspaces });
    });

    this.route('POST', '/api/workspaces', (c) => {
      const me = this.uid(c);
      this.requireVerified(c);
      const b = parseBody(c, CreateWorkspaceRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      if (b.slug.length < 3 || b.slug.length > 32 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug)) throw invalid('slug', 'invalid slug');
      if ([...s().workspaces.values()].some((w) => w.slug === b.slug)) throw conflict('slug already taken', 'slug');
      const id = nextId(s(), 'workspace');
      const at = tick(s());
      const ws = create(WorkspaceSchema, {
        id,
        slug: b.slug,
        name,
        iconFileId: '',
        visibility: b.visibility === WorkspaceVisibility.UNSPECIFIED ? WorkspaceVisibility.PRIVATE : b.visibility,
        ownerId: me,
        createdAt: at,
        mediaDefaults: DEFAULT_MEDIA,
        storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
        storageUsedBytes: 0n,
      });
      s().workspaces.set(id, ws);
      s().members.push({ workspaceId: id, userId: me, role: WorkspaceRole.OWNER, nickname: '', joinedAt: at });
      this.toUser(me, { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(id, me) } } });
      sendMsg(c.res, 201, CreateWorkspaceResponseSchema, { workspace: ws });
    });

    this.route('GET', '/api/workspaces/discover', (c) => {
      const me = this.uid(c);
      const workspaces = [...s().workspaces.values()]
        .filter((w) => w.visibility === WorkspaceVisibility.OPEN && !this.member(w.id, me))
        .sort((a, b) => a.id.localeCompare(b.id));
      sendMsg(c.res, 200, DiscoverWorkspacesResponseSchema, { workspaces });
    });

    this.route('GET', '/api/workspaces/:id', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, GetWorkspaceResponseSchema, { workspace: ws, role: m.role });
    });

    this.route('PATCH', '/api/workspaces/:id', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const b = parseBody(c, UpdateWorkspaceRequestSchema);
      if (b.name !== undefined) {
        if (!b.name.trim()) throw invalid('name', 'name required');
        ws.name = b.name.trim();
      }
      if (b.slug !== undefined) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug) || b.slug.length < 3 || b.slug.length > 32) throw invalid('slug', 'invalid slug');
        if ([...s().workspaces.values()].some((w) => w.slug === b.slug && w.id !== ws.id)) throw conflict('slug already taken', 'slug');
        ws.slug = b.slug;
      }
      if (b.visibility !== undefined) ws.visibility = b.visibility;
      if (b.iconFileId !== undefined) ws.iconFileId = b.iconFileId;
      if (b.allowSelfNickname !== undefined) ws.allowSelfNickname = b.allowSelfNickname;
      const media = create(RoomMediaOverrideSchema, {});
      if (b.defaultAudioBitrateKbps !== undefined) media.audioBitrateKbps = b.defaultAudioBitrateKbps;
      if (b.defaultMaxStreamPreset !== undefined) media.maxStreamPreset = b.defaultMaxStreamPreset;
      if (b.defaultMaxStreams !== undefined) media.maxStreams = b.defaultMaxStreams;
      if (b.defaultCameraLimit !== undefined) media.cameraLimit = b.defaultCameraLimit;
      const mediaChanged =
        media.audioBitrateKbps !== undefined || media.maxStreamPreset !== undefined || media.maxStreams !== undefined || media.cameraLimit !== undefined;
      if (mediaChanged) ws.mediaDefaults = effectiveMedia(ws, media);
      this.toWorkspace(ws.id, { event: { case: 'workspaceUpdate', value: { workspace: ws } } });
      if (mediaChanged) {
        for (const r of s().rooms.values()) {
          if (r.workspaceId !== ws.id) continue;
          r.media = effectiveMedia(ws, r.mediaOverride);
          this.toWorkspace(ws.id, { event: { case: 'roomUpdate', value: { room: r } } }, r.id);
        }
      }
      sendMsg(c.res, 200, UpdateWorkspaceResponseSchema, { workspace: ws });
    });

    this.route('DELETE', '/api/workspaces/:id', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      if (m.role !== WorkspaceRole.OWNER) throw forbidden('only the owner can delete a workspace');
      this.toWorkspace(ws.id, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
      s().workspaces.delete(ws.id);
      s().members = s().members.filter((x) => x.workspaceId !== ws.id);
      for (const [id, r] of s().rooms) if (r.workspaceId === ws.id) s().rooms.delete(id);
      for (const [id, v] of s().voiceStates) if (v.workspaceId === ws.id) s().voiceStates.delete(id);
      for (const [id, i] of s().invites) if (i.workspaceId === ws.id) s().invites.delete(id);
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/join', (c) => {
      const me = this.uid(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws || ws.visibility !== WorkspaceVisibility.OPEN) throw notFound('workspace not found');
      if (this.member(ws.id, me)) throw conflict('already a member');
      const m = this.joinWorkspace(ws.id, me);
      sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(m) });
    });

    this.route('GET', '/api/workspaces/:id/invites', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const invites = [...s().invites.values()].filter((i) => i.workspaceId === ws.id).sort((a, b) => a.id.localeCompare(b.id));
      sendMsg(c.res, 200, ListInvitesResponseSchema, { invites });
    });

    this.route('POST', '/api/workspaces/:id/invites', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      this.requireVerified(c);
      const b = parseBody(c, CreateInviteRequestSchema);
      const id = nextId(s(), 'invite');
      const at = tick(s());
      const invite = create(InviteSchema, {
        id,
        workspaceId: ws.id,
        code: `mock-invite-${id.slice(-4)}`,
        createdBy: me,
        maxUses: b.maxUses,
        uses: 0,
        ...(b.expiresInSeconds ? { expiresAt: timestampFromMs(timestampMs(at) + b.expiresInSeconds * 1000) } : {}),
        createdAt: at,
      });
      s().invites.set(id, invite);
      sendMsg(c.res, 201, CreateInviteResponseSchema, { invite });
    });

    this.route('DELETE', '/api/workspaces/:id/invites/:inviteId', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const inv = s().invites.get(c.params[1] ?? '');
      if (!inv || inv.workspaceId !== ws.id) throw notFound('invite not found');
      s().invites.delete(inv.id);
      noContent(c.res);
    });

    this.route('GET', '/api/workspaces/:id/members', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListMembersResponseSchema, { members: this.membersOf(ws.id).map((x) => this.memberOut(x)) });
    });

    // docs/09 #76: birthdays in the next `days` days (the mock's today: setClock, else real time; UTC).
    this.route('GET', '/api/workspaces/:id/birthdays', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      const days = Number(c.url.searchParams.get('days') ?? '7');
      const now = new Date(this.clockMs ?? Date.now());
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const out = this.membersOf(ws.id).flatMap((m) => {
        const u = this.userRec(m.userId);
        const b = u.user.birthday;
        if (!b || u.birthdayHidden) return [];
        let next = Date.UTC(now.getUTCFullYear(), b.month - 1, b.day);
        if (next < today) next = Date.UTC(now.getUTCFullYear() + 1, b.month - 1, b.day);
        const inDays = Math.round((next - today) / 86_400_000);
        return inDays < days ? [{ userId: m.userId, birthday: b, inDays }] : [];
      });
      out.sort((a, b) => a.inDays - b.inDays);
      sendMsg(c.res, 200, ListBirthdaysResponseSchema, { birthdays: out });
    });

    // docs/09 #77: every member's birthday for the admin table (hidden ones marked), and an
    // admin setting one (MANAGE_NICKNAMES = admins by default; not the owner by an admin).
    this.route('GET', '/api/workspaces/:id/members/birthdays', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const birthdays = this.membersOf(ws.id).flatMap((x) => {
        const u = this.userRec(x.userId);
        if (!u.user.birthday || u.user.isBot || x.role === WorkspaceRole.GUEST) return [];
        return [{ userId: x.userId, birthday: u.user.birthday, hidden: u.birthdayHidden ?? false }];
      });
      sendMsg(c.res, 200, ListMemberBirthdaysResponseSchema, { birthdays });
    });

    this.route('PATCH', '/api/workspaces/:id/members/:userId/birthday', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const target = this.member(ws.id, c.params[1] ?? '');
      if (!target) throw notFound('member not found');
      if (target.role === WorkspaceRole.OWNER && m.role !== WorkspaceRole.OWNER) throw forbidden('cannot act on a member at or above your highest role');
      const u = this.userRec(target.userId);
      if (u.user.isBot || target.role === WorkspaceRole.GUEST) throw forbidden('no birthday');
      const b = parseBody(c, UpdateMemberBirthdayRequestSchema).birthday;
      if (!b || (!b.day && !b.month)) delete u.user.birthday;
      else if (b.month < 1 || b.month > 12 || b.day < 1 || b.day > 31) throw invalid('birthday.day', 'no such day in that month');
      else u.user.birthday = create(BirthdaySchema, { day: b.day, month: b.month, ...(b.year !== undefined ? { year: b.year } : {}) });
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMemberBirthdayResponseSchema, {
        birthday: { userId: u.user.id, birthday: u.user.birthday, hidden: u.birthdayHidden ?? false },
      });
    });

    this.route('PATCH', '/api/workspaces/:id/members/:userId', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      const b = parseBody(c, UpdateMemberRequestSchema);
      const before = target.role;
      if (b.role !== undefined && b.role !== target.role) {
        this.requireWsBit(caller, 'MANAGE_MEMBERS');
        if (b.role === WorkspaceRole.OWNER || b.role === WorkspaceRole.UNSPECIFIED) throw invalid('role', 'role cannot be granted');
        if (target.role === WorkspaceRole.OWNER) throw forbidden('cannot change the owner role');
        if ((b.role === WorkspaceRole.ADMIN || target.role === WorkspaceRole.ADMIN) && caller.role !== WorkspaceRole.OWNER) {
          throw forbidden('only the owner manages admins');
        }
      }
      if (b.nickname !== undefined) {
        // MANAGE_NICKNAMES = admins by default; one's own nickname when the workspace allows it.
        if (targetId !== me) this.requireAdmin(caller);
        else if (!ws.allowSelfNickname && !isAdminRole(caller.role)) throw forbidden('nicknames are set by admins in this workspace');
        if (Array.from(b.nickname.trim()).length > 64) throw invalid('nickname', 'nickname must be at most 64 characters');
      }
      // Visibility before the change, for ROOM_CREATE / ROOM_DELETE to the target.
      const rooms = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id);
      const visibleBefore = new Set(rooms.filter((r) => this.canView(r, targetId)).map((r) => r.id));
      if (b.role !== undefined) target.role = b.role;
      if (b.nickname !== undefined) target.nickname = b.nickname.trim();
      if (before !== target.role) {
        for (const r of rooms) {
          const now = this.canView(r, targetId);
          if (now && !visibleBefore.has(r.id)) this.toUser(targetId, { event: { case: 'roomCreate', value: { room: this.roomOut(r) } } });
          if (!now && visibleBefore.has(r.id)) this.toUser(targetId, { event: { case: 'roomDelete', value: { workspaceId: ws.id, roomId: r.id } } });
        }
      }
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, UpdateMemberResponseSchema, { member });
    });

    this.route('DELETE', '/api/workspaces/:id/members/:userId', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      if (target.role === WorkspaceRole.OWNER) throw conflict('the owner cannot leave; transfer or delete the workspace');
      if (targetId !== me) {
        this.requireWsBit(caller, 'MANAGE_MEMBERS');
        if (target.role === WorkspaceRole.ADMIN && caller.role !== WorkspaceRole.OWNER) throw forbidden('only the owner removes admins');
      }
      if (s().voiceStates.get(targetId)?.workspaceId === ws.id) this.setVoice(targetId, '', {});
      this.toUser(targetId, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
      s().members = s().members.filter((x) => x !== target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberRemove', value: { workspaceId: ws.id, userId: targetId } } });
      noContent(c.res);
    });

    // ---------------- bans (docs/09 #32): MANAGE_MEMBERS (ADR-0048), the rules of a kick
    this.route('GET', '/api/workspaces/:id/bans', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireWsBit(caller, 'MANAGE_MEMBERS');
      sendMsg(c.res, 200, ListBansResponseSchema, { bans: s().bans.get(ws.id) ?? [] });
    });
    this.route('POST', '/api/workspaces/:id/bans', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireWsBit(caller, 'MANAGE_MEMBERS');
      const b = parseBody(c, CreateBanRequestSchema);
      const u = s().users.get(b.userId);
      if (!u) throw notFound('user not found');
      if (b.userId === me) throw forbidden('cannot ban yourself');
      const target = this.member(ws.id, b.userId);
      if (target?.role === WorkspaceRole.OWNER) throw forbidden('the owner cannot be banned');
      if (target?.role === WorkspaceRole.ADMIN && caller.role !== WorkspaceRole.OWNER) throw forbidden('only the owner can ban an admin');
      if (target) {
        if (s().voiceStates.get(b.userId)?.workspaceId === ws.id) this.setVoice(b.userId, '', {});
        this.toUser(b.userId, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
        s().members = s().members.filter((x) => x !== target);
        this.toWorkspace(ws.id, { event: { case: 'workspaceMemberRemove', value: { workspaceId: ws.id, userId: b.userId } } });
      }
      const ban = create(WorkspaceBanSchema, {
        workspaceId: ws.id,
        user: u.user,
        email: u.email,
        reason: b.reason.trim().slice(0, 500),
        bannedBy: me,
        createdAt: tick(s()),
      });
      s().bans.set(ws.id, [ban, ...(s().bans.get(ws.id) ?? []).filter((x) => x.user?.id !== b.userId)]);
      this.toWorkspace(ws.id, { event: { case: 'workspaceBanAdd', value: { ban } } });
      sendMsg(c.res, 201, CreateBanResponseSchema, { ban });
    });
    this.route('DELETE', '/api/workspaces/:id/bans/:userId', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireWsBit(caller, 'MANAGE_MEMBERS');
      const list = s().bans.get(ws.id) ?? [];
      const userId = c.params[1] ?? '';
      if (!list.some((x) => x.user?.id === userId)) throw notFound('ban not found');
      s().bans.set(ws.id, list.filter((x) => x.user?.id !== userId));
      this.toWorkspace(ws.id, { event: { case: 'workspaceBanRemove', value: { workspaceId: ws.id, userId } } });
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/members/:userId/promote', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireWsBit(caller, 'MANAGE_MEMBERS');
      const target = this.member(ws.id, c.params[1] ?? '');
      if (target?.role !== WorkspaceRole.GUEST) throw notFound('guest not found');
      target.role = WorkspaceRole.MEMBER;
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, UpdateMemberResponseSchema, { member });
    });

    // ---------------- camera backgrounds of a workspace (ADR-0035 addendum): the list for members, the rest MANAGE_WORKSPACE.
    // The server makes a new 1280×720 WebP from the upload; the mock keeps the uploaded file.
    this.route('GET', '/api/workspaces/:id/backgrounds', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListBackgroundsResponseSchema, { backgrounds: this.backgroundsOf(ws.id) });
    });
    const backgroundName = (raw: string): string => {
      const name = raw.trim();
      if (!name || Array.from(name).length > 40) throw invalid('name', 'name must be 1..40 characters');
      return name;
    };
    const backgroundManager = (c: Ctx): Workspace => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      if (!isAdminRole(m.role)) throw forbidden('MANAGE_WORKSPACE required');
      return ws;
    };
    this.route('POST', '/api/workspaces/:id/backgrounds', (c) => {
      const ws = backgroundManager(c);
      const b = parseBody(c, CreateBackgroundRequestSchema);
      if (this.backgroundsOf(ws.id).length >= 20) throw conflict('a workspace has at most 20 camera backgrounds');
      const f = s().files.get(b.fileId);
      if (!f || f.meta.workspaceId !== ws.id || f.meta.uploaderId !== this.uid(c) || !['image/png', 'image/webp', 'image/jpeg'].includes(f.meta.mime) || f.bytes.length > 10 * 1024 * 1024) {
        throw invalid('fileId', 'a JPEG, PNG or WebP image you uploaded to this workspace, at most 10 MB');
      }
      const background = create(WorkspaceBackgroundSchema, { id: nextId(s(), 'background'), workspaceId: ws.id, name: backgroundName(b.name), fileId: b.fileId });
      s().backgrounds.set(background.id, background);
      this.toWorkspace(ws.id, { event: { case: 'backgroundCreate', value: { background } } });
      sendMsg(c.res, 201, CreateBackgroundResponseSchema, { background });
    });
    this.route('PATCH', '/api/workspaces/:id/backgrounds/:bgId', (c) => {
      const ws = backgroundManager(c);
      const background = s().backgrounds.get(c.params[1] ?? '');
      if (!background || background.workspaceId !== ws.id) throw notFound('background not found');
      const b = parseBody(c, UpdateBackgroundRequestSchema);
      if (b.name !== undefined) background.name = backgroundName(b.name);
      this.toWorkspace(ws.id, { event: { case: 'backgroundUpdate', value: { background } } });
      sendMsg(c.res, 200, UpdateBackgroundResponseSchema, { background });
    });
    this.route('DELETE', '/api/workspaces/:id/backgrounds/:bgId', (c) => {
      const ws = backgroundManager(c);
      const background = s().backgrounds.get(c.params[1] ?? '');
      if (!background || background.workspaceId !== ws.id) throw notFound('background not found');
      s().backgrounds.delete(background.id);
      this.toWorkspace(ws.id, { event: { case: 'backgroundDelete', value: { workspaceId: ws.id, backgroundId: background.id } } });
      noContent(c.res);
    });

    // ---------------- soundboard (ADR-0036): the library for members, the rest MANAGE_STICKERS; play for the call.
    // The server converts the upload to an Ogg/Opus clip; the mock keeps the uploaded file.
    this.route('GET', '/api/workspaces/:id/sounds', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListSoundsResponseSchema, { sounds: this.soundsOf(ws.id) });
    });
    const soundName = (raw: string): string => {
      const name = raw.trim();
      if (!name || Array.from(name).length > 32) throw invalid('name', 'name must be 1..32 characters');
      return name;
    };
    const soundManager = (c: Ctx): Workspace => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.stickerManager(ws.id, this.uid(c));
      return ws;
    };
    const soundFile = (c: Ctx, wsId: string, id: string): string => {
      const f = s().files.get(id);
      if (!f || f.meta.workspaceId !== wsId || f.meta.uploaderId !== this.uid(c) || f.bytes.length > 2 * 1024 * 1024) {
        throw invalid('fileId', 'an MP3, Ogg or WAV file you uploaded to this workspace, at most 2 MB');
      }
      return id;
    };
    this.route('POST', '/api/workspaces/:id/sounds', (c) => {
      const ws = soundManager(c);
      const b = parseBody(c, CreateSoundRequestSchema);
      if (this.soundsOf(ws.id).length >= 50) throw conflict('a workspace has at most 50 sounds');
      const sound = create(SoundSchema, {
        id: nextId(s(), 'sound'),
        workspaceId: ws.id,
        name: soundName(b.name),
        emoji: b.emoji.trim(),
        fileId: soundFile(c, ws.id, b.fileId),
        durationMs: 1500,
        position: this.soundsOf(ws.id).length,
      });
      s().sounds.set(sound.id, sound);
      this.toWorkspace(ws.id, { event: { case: 'soundCreate', value: { sound } } });
      sendMsg(c.res, 201, SoundResponseSchema, { sound });
    });
    this.route('PATCH', '/api/workspaces/:id/sounds/:soundId', (c) => {
      const ws = soundManager(c);
      const sound = s().sounds.get(c.params[1] ?? '');
      if (!sound || sound.workspaceId !== ws.id) throw notFound('sound not found');
      const b = parseBody(c, UpdateSoundRequestSchema);
      if (b.name !== undefined) sound.name = soundName(b.name);
      if (b.emoji !== undefined) sound.emoji = b.emoji.trim();
      if (b.fileId !== undefined) sound.fileId = soundFile(c, ws.id, b.fileId);
      const changed = [sound];
      if (b.position !== undefined) {
        const order = this.soundsOf(ws.id).filter((x) => x.id !== sound.id);
        order.splice(Math.min(b.position, order.length), 0, sound);
        order.forEach((x, i) => {
          if (x.position !== i && x !== sound) changed.push(x);
          x.position = i;
        });
      }
      for (const x of changed) this.toWorkspace(ws.id, { event: { case: 'soundUpdate', value: { sound: x } } });
      sendMsg(c.res, 200, SoundResponseSchema, { sound });
    });
    this.route('DELETE', '/api/workspaces/:id/sounds/:soundId', (c) => {
      const ws = soundManager(c);
      const sound = s().sounds.get(c.params[1] ?? '');
      if (!sound || sound.workspaceId !== ws.id) throw notFound('sound not found');
      s().sounds.delete(sound.id);
      this.toWorkspace(ws.id, { event: { case: 'soundDelete', value: { workspaceId: ws.id, soundId: sound.id } } });
      noContent(c.res);
    });
    const lastPress = new Map<string, number>();
    this.route('POST', '/api/rooms/:id/sounds/play', (c) => {
      const me = this.uid(c);
      const roomId = c.params[0] ?? '';
      const room = s().rooms.get(roomId);
      if (!room || !room.workspaceId || !this.canView(room, me)) throw notFound('room not found');
      if (s().voiceStates.get(me)?.roomId !== roomId) throw forbidden('join the voice call of this room first');
      const b = parseBody(c, PlaySoundRequestSchema);
      const ok = /^builtin:[a-z0-9_]{1,32}$/.test(b.soundId) || s().sounds.get(b.soundId)?.workspaceId === room.workspaceId;
      if (!ok) throw notFound('sound not found');
      const now = Date.now();
      if (now - (lastPress.get(me) ?? 0) < 2000) throw tooMany('too many requests', 2);
      lastPress.set(me, now);
      this.playSound(roomId, me, b.soundId);
      noContent(c.res);
    });

    // ---------------- member badges (docs/09 #82): the library with MANAGE_WORKSPACE, assigning with MANAGE_NICKNAMES
    this.route('GET', '/api/workspaces/:id/badges', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListBadgesResponseSchema, { badges: this.badgesOf(ws.id) });
    });
    const badgeName = (raw: string): string => {
      const name = raw.trim();
      if (!name || Array.from(name).length > 32) throw invalid('name', 'name must be 1..32 characters');
      return name;
    };
    const badgeFile = (wsId: string, id: string): string => {
      const f = s().files.get(id);
      if (!f || f.meta.workspaceId !== wsId || !['image/png', 'image/webp', 'image/jpeg'].includes(f.meta.mime) || f.bytes.length > 128 * 1024) {
        throw invalid('fileId', 'a PNG, WebP or JPEG image of this workspace, at most 128 KB');
      }
      return id;
    };
    const badgeManager = (c: Ctx): Workspace => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireWsBit(m, 'MANAGE_MEMBERS'); // ADR-0048
      return ws;
    };
    this.route('POST', '/api/workspaces/:id/badges', (c) => {
      const ws = badgeManager(c);
      const b = parseBody(c, CreateBadgeRequestSchema);
      if (this.badgesOf(ws.id).length >= 20) throw conflict('a workspace has at most 20 badges');
      const badge = create(BadgeSchema, { id: nextId(s(), 'badge'), workspaceId: ws.id, name: badgeName(b.name), fileId: badgeFile(ws.id, b.fileId) });
      s().badges.set(badge.id, badge);
      this.toWorkspace(ws.id, { event: { case: 'badgeCreate', value: { badge } } });
      sendMsg(c.res, 201, CreateBadgeResponseSchema, { badge });
    });
    this.route('PATCH', '/api/workspaces/:id/badges/:badgeId', (c) => {
      const ws = badgeManager(c);
      const badge = s().badges.get(c.params[1] ?? '');
      if (!badge || badge.workspaceId !== ws.id) throw notFound('badge not found');
      const b = parseBody(c, UpdateBadgeRequestSchema);
      if (b.name !== undefined) badge.name = badgeName(b.name);
      if (b.fileId !== undefined) badge.fileId = badgeFile(ws.id, b.fileId);
      this.toWorkspace(ws.id, { event: { case: 'badgeUpdate', value: { badge } } });
      sendMsg(c.res, 200, UpdateBadgeResponseSchema, { badge });
    });
    this.route('DELETE', '/api/workspaces/:id/badges/:badgeId', (c) => {
      const ws = badgeManager(c);
      const badge = s().badges.get(c.params[1] ?? '');
      if (!badge || badge.workspaceId !== ws.id) throw notFound('badge not found');
      for (const m of this.membersOf(ws.id)) {
        if (m.badgeId !== badge.id) continue;
        delete m.badgeId;
        this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member: this.memberOut(m) } } });
      }
      s().badges.delete(badge.id);
      this.toWorkspace(ws.id, { event: { case: 'badgeDelete', value: { workspaceId: ws.id, badgeId: badge.id } } });
      noContent(c.res);
    });
    this.route('PUT', '/api/workspaces/:id/members/:userId/badge', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      if (!has(workspacePermissions(this.memberRoles(caller)), PERMISSION_BITS.MANAGE_NICKNAMES)) throw forbidden('MANAGE_NICKNAMES required');
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      if (s().users.get(targetId)?.user.isBot) throw forbidden('bots have no badge');
      if (targetId !== me && target.role === WorkspaceRole.OWNER) throw forbidden('the member is not below you');
      const b = parseBody(c, SetMemberBadgeRequestSchema);
      if (b.badgeId) {
        const badge = s().badges.get(b.badgeId);
        if (!badge || badge.workspaceId !== ws.id) throw invalid('badgeId', 'unknown badge');
        target.badgeId = b.badgeId;
      } else delete target.badgeId;
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, SetMemberBadgeResponseSchema, { member });
    });

    // ---------------- roles (ADR-0026, docs/04 «Роли»): MANAGE_ROLES, roles below the caller's top one
    this.route('GET', '/api/workspaces/:id/roles', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListRolesResponseSchema, { roles: this.rolesOfWs(ws.id) });
    });
    this.route('POST', '/api/workspaces/:id/roles', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      const a = this.roleActor(caller);
      const b = parseBody(c, CreateRoleRequestSchema);
      if (!a.owner && a.top <= 2) throw forbidden('your highest role is too low to create roles');
      const name = roleNameOk(b.name);
      const all = this.rolesOfWs(ws.id);
      if (all.length >= 50) throw conflict('at most 50 roles per workspace');
      if (b.color > 0xffffff) throw invalid('color', 'color must be 0xRRGGBB');
      this.checkGrant(a, b.permissions);
      const role = create(RoleSchema, {
        id: nextId(s(), 'role'),
        workspaceId: ws.id,
        name,
        color: b.color,
        position: 2,
        permissions: b.permissions,
        builtin: WorkspaceRole.UNSPECIFIED,
        mentionable: b.mentionable,
        createdAt: tick(s()),
      });
      // The new role goes to the bottom of the custom ones: the others move up.
      for (const r of all) {
        if (r.builtin !== WorkspaceRole.UNSPECIFIED) continue;
        r.position += 1;
        this.toWorkspace(ws.id, { event: { case: 'roleUpdate', value: { role: r } } });
      }
      s().roles.set(ws.id, [...all, role]);
      this.toWorkspace(ws.id, { event: { case: 'roleCreate', value: { role } } });
      sendMsg(c.res, 201, CreateRoleResponseSchema, { role });
    });
    this.route('PATCH', '/api/workspaces/:id/roles/:roleId', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      const a = this.roleActor(caller);
      const role = this.rolesOfWs(ws.id).find((r) => r.id === c.params[1]);
      if (!role) throw notFound('role not found');
      if (!a.owner && role.position >= a.top) throw forbidden('the role is not below your highest role');
      const b = parseBody(c, UpdateRoleRequestSchema);
      const custom = role.builtin === WorkspaceRole.UNSPECIFIED;
      const name = b.name !== undefined ? (custom ? roleNameOk(b.name, this.rolesOfWs(ws.id), role.id) : b.name === role.name ? role.name : null) : role.name;
      if (name === null) throw invalid('name', 'built-in roles keep their name');
      if (b.color !== undefined && b.color > 0xffffff) throw invalid('color', 'color must be 0xRRGGBB');
      if (b.permissions !== undefined && b.permissions !== role.permissions) {
        if (role.builtin === WorkspaceRole.OWNER || role.builtin === WorkspaceRole.ADMIN) throw invalid('permissions', 'owner / admin permissions are fixed');
        if (role.builtin === WorkspaceRole.GUEST && (b.permissions & ~GUEST_ROLE_BITS) !== 0n) throw invalid('permissions', 'guest permissions are limited');
        this.checkGrant(a, b.permissions ^ role.permissions);
      }
      this.withVisibility(ws.id, () => {
        role.name = name;
        if (b.color !== undefined) role.color = b.color;
        if (b.mentionable !== undefined) role.mentionable = b.mentionable;
        if (b.permissions !== undefined) role.permissions = b.permissions;
      });
      this.toWorkspace(ws.id, { event: { case: 'roleUpdate', value: { role } } });
      sendMsg(c.res, 200, UpdateRoleResponseSchema, { role });
    });
    this.route('DELETE', '/api/workspaces/:id/roles/:roleId', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      const a = this.roleActor(caller);
      const all = this.rolesOfWs(ws.id);
      const role = all.find((r) => r.id === c.params[1]);
      if (!role) throw notFound('role not found');
      if (role.builtin !== WorkspaceRole.UNSPECIFIED) throw invalid('role', 'built-in roles cannot be deleted');
      if (!a.owner && role.position >= a.top) throw forbidden('the role is not below your highest role');
      if (!a.owner && (role.permissions & BILLING_PERMISSIONS) !== 0n) throw forbidden('only the owner deletes billing roles');
      const touched: Room[] = [];
      this.withVisibility(ws.id, () => {
        s().roles.set(ws.id, all.filter((r) => r !== role));
        for (const m of this.membersOf(ws.id)) if (m.roleIds?.includes(role.id)) m.roleIds = m.roleIds.filter((x) => x !== role.id);
        for (const r of s().rooms.values()) {
          if (r.workspaceId !== ws.id) continue;
          const kept = r.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.ROLE && o.targetId === role.id));
          if (kept.length !== r.permissionOverrides.length) {
            r.permissionOverrides = kept;
            touched.push(r);
          }
        }
      });
      this.toWorkspace(ws.id, { event: { case: 'roleDelete', value: { workspaceId: ws.id, roleId: role.id } } });
      for (const r of touched) {
        this.toWorkspace(ws.id, { event: { case: 'roomPermissionsUpdate', value: { workspaceId: ws.id, roomId: r.id, permissions: r.permissionOverrides } } }, r.id);
      }
      noContent(c.res);
    });
    this.route('PUT', '/api/workspaces/:id/roles/order', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      const a = this.roleActor(caller);
      const b = parseBody(c, SetRoleOrderRequestSchema);
      const all = this.rolesOfWs(ws.id);
      const customs = all.filter((r) => r.builtin === WorkspaceRole.UNSPECIFIED);
      if (b.roleIds.length !== customs.length || new Set(b.roleIds).size !== customs.length || !customs.every((r) => b.roleIds.includes(r.id))) {
        throw invalid('role_ids', 'all custom roles, each once');
      }
      const next = new Map(b.roleIds.map((id, i) => [id, b.roleIds.length + 1 - i]));
      for (const r of customs) {
        const pos = next.get(r.id) ?? r.position;
        if (pos !== r.position && !a.owner && (r.position >= a.top || pos >= a.top)) throw forbidden('roles at or above your highest role keep their place');
      }
      this.withVisibility(ws.id, () => {
        for (const r of customs) {
          const pos = next.get(r.id) ?? r.position;
          if (pos === r.position) continue;
          r.position = pos;
          this.toWorkspace(ws.id, { event: { case: 'roleUpdate', value: { role: r } } });
        }
      });
      sendMsg(c.res, 200, SetRoleOrderResponseSchema, { roles: this.rolesOfWs(ws.id) });
    });
    this.route('PUT', '/api/workspaces/:id/members/:userId/roles', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const a = this.roleActor(caller);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      const b = parseBody(c, SetMemberRolesRequestSchema);
      const all = this.rolesOfWs(ws.id);
      const want = new Set(b.roleIds);
      for (const id of want) if (!all.some((r) => r.id === id)) throw invalid('role_ids', 'unknown role');
      const have = new Set(this.memberRoles(target).map((r) => r.id));
      const self = targetId === me;
      const targetTop = Math.max(-1, ...this.memberRoles(target).map((r) => r.position));
      if (!self && !a.owner && targetTop >= a.top) throw forbidden('the member is not below you');
      let role = target.role;
      const customIds: string[] = [];
      for (const r of all) {
        const on = want.has(r.id);
        const changed = on !== have.has(r.id);
        // MEMBER / GUEST follow the member itself (listed or not); OWNER never changes here.
        if (r.builtin === WorkspaceRole.MEMBER || r.builtin === WorkspaceRole.GUEST) continue;
        if (r.builtin === WorkspaceRole.OWNER) {
          if (changed) throw forbidden('the owner role is not granted here');
          continue;
        }
        if (changed) {
          if (r.builtin === WorkspaceRole.ADMIN) {
            if (!a.owner) throw forbidden('only the owner manages admins');
            if (target.role === WorkspaceRole.GUEST) throw forbidden('a guest is promoted first');
          } else {
            if (!a.owner && (r.permissions & BILLING_PERMISSIONS) !== 0n) throw forbidden('only the owner assigns billing roles');
            if (!a.owner && r.position >= a.top) throw forbidden('the role is not below your highest role');
            if (!a.admin && (r.permissions & ~a.perms) !== 0n) throw forbidden('the role has permissions you lack');
          }
        }
        if (r.builtin === WorkspaceRole.ADMIN) {
          if (target.role !== WorkspaceRole.OWNER) role = on ? WorkspaceRole.ADMIN : target.role === WorkspaceRole.ADMIN ? WorkspaceRole.MEMBER : target.role;
        } else if (on) customIds.push(r.id);
      }
      this.withVisibility(ws.id, () => {
        target.role = role;
        target.roleIds = customIds;
      });
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, SetMemberRolesResponseSchema, { member });
    });

    this.route('GET', '/api/invites/:code', (c) => {
      // Invitation by email: public preview with the address (the sign-up form locks it).
      // An accepted one stays previewable (its invitee may open the link again, docs/09 #36).
      const ei = this.emailInviteByCode(c.params[0] ?? '');
      const inv = ei ? undefined : [...s().invites.values()].find((i) => i.code === c.params[0]);
      const ws = s().workspaces.get(ei?.workspaceId ?? inv?.workspaceId ?? '');
      if ((!ei && !inv) || !ws) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      if (inv?.maxUses && inv.uses >= inv.maxUses) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite used up');
      // Public (no token, server 260e8d9): the public subset of the workspace + member count.
      const memberCount = this.membersOf(ws.id).filter((m) => m.role !== WorkspaceRole.GUEST).length;
      const expiresAt = ei?.expiresAt ?? inv?.expiresAt;
      sendMsg(c.res, 200, GetInviteResponseSchema, {
        workspace: { id: ws.id, slug: ws.slug, name: ws.name, iconFileId: ws.iconFileId },
        memberCount,
        ...(expiresAt ? { expiresAt } : {}),
        ...(ei ? { email: ei.email } : {}),
      });
    });

    this.route('POST', '/api/invites/:code/join', (c) => {
      const me = this.uid(c);
      const ei = this.emailInviteByCode(c.params[0] ?? '');
      // Like the server: an existing member gets the membership (200); an emailed code needs the
      // invited address (403 INVITE_EMAIL_MISMATCH), confirmed (403 EMAIL_NOT_VERIFIED).
      if (ei) {
        const u = s().users.get(me);
        const ws = s().workspaces.get(ei.workspaceId);
        if (!u || !ws) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
        const existing = this.member(ws.id, me);
        if (existing) {
          sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(existing) });
          return;
        }
        if (u.email !== ei.email) throw new HttpError(403, ErrorCode.INVITE_EMAIL_MISMATCH, 'invitation for another address');
        if (ei.accepted) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite used up');
        if (!u.emailVerified) throw notVerified();
        const m = this.joinWorkspace(ws.id, me);
        m.role = ei.role;
        ei.accepted = true;
        sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(m) });
        return;
      }
      const inv = [...s().invites.values()].find((i) => i.code === c.params[0]);
      const ws = inv ? s().workspaces.get(inv.workspaceId) : undefined;
      if (!inv || !ws) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      const existing = this.member(ws.id, me);
      if (existing) {
        sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(existing) });
        return;
      }
      if (inv.maxUses && inv.uses >= inv.maxUses) throw new HttpError(410, ErrorCode.INVITE_INVALID, 'invite used up');
      const m = this.joinWorkspace(ws.id, me, inv.id);
      sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(m) });
    });

    // ---------------- rooms
    this.route('POST', '/api/workspaces/:id/rooms', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, CreateRoomRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      if (b.topic.length > 1024) throw invalid('topic', 'topic too long');
      if (b.type === RoomType.UNSPECIFIED) throw invalid('type', 'room type required');
      const positions = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id).map((r) => r.position);
      const mediaOverride = b.mediaOverride ?? create(RoomMediaOverrideSchema, {});
      const room = create(RoomSchema, {
        id: nextId(s(), 'room'),
        workspaceId: ws.id,
        type: b.type,
        name,
        topic: b.topic,
        position: b.position ?? (positions.length ? Math.max(...positions) + 1 : 0),
        isPrivate: b.isPrivate,
        media: effectiveMedia(ws, mediaOverride),
        mediaOverride,
        permissionOverrides: b.isPrivate
          ? [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_ROOM })]
          : [],
        createdAt: tick(s()),
        categoryId: b.categoryId && s().categories.get(b.categoryId)?.workspaceId === ws.id ? b.categoryId : '',
        userLimit: b.type === RoomType.VOICE ? Math.min(99, b.userLimit) : 0,
        allowRecording: true,
      });
      s().rooms.set(room.id, room);
      this.toWorkspace(ws.id, { event: { case: 'roomCreate', value: { room } } }, room.id);
      sendMsg(c.res, 201, CreateRoomResponseSchema, { room });
    });

    // ---------------- temporary rooms (ADR-0044)
    this.route('POST', '/api/workspaces/:id/rooms/temp', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireActive(ws.id);
      const wsPerms = workspacePermissions(this.memberRoles(m));
      if (m.role === WorkspaceRole.GUEST || !has(wsPerms, PERMISSION_BITS.CREATE_TEMP_ROOMS)) throw forbidden('CREATE_TEMP_ROOMS required');
      const b = parseBody(c, CreateTempRoomRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      if (b.ttlSeconds < 900 || b.ttlSeconds > 604800) throw invalid('ttlSeconds', 'ttl_seconds must be 900..604800');
      const guests = b.guests ?? true;
      if (guests && !has(wsPerms, PERMISSION_BITS.INVITE_GUESTS)) throw forbidden('INVITE_GUESTS required for a link that admits guests (guests=false: members only)');
      if (b.memberIds.length > 50) throw invalid('memberIds', 'at most 50 members');
      const live = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id && r.expiresAt);
      if (live.length >= 20) throw new HttpError(409, ErrorCode.TEMP_ROOM_LIMIT, 'temporary room limit', '', { used: BigInt(live.length), limit: 20n });
      const mine = live.filter((r) => r.createdBy === me).length;
      if (mine >= 5) throw new HttpError(409, ErrorCode.TEMP_ROOM_LIMIT, 'temporary room limit', '', { reason: 'PER_USER', used: BigInt(mine), limit: 5n });
      const expiresAtMs = this.calNow() + b.ttlSeconds * 1000;
      const { room, invite } = this.createTempRoom({ workspaceId: ws.id, name, createdBy: me, expiresAtMs, isPrivate: b.private, memberIds: b.memberIds, guests });
      const step = 5 * 60_000;
      const event = b.withEvent
        ? this.addEvent({ workspaceId: ws.id, organizerId: me, title: name, startMs: Math.ceil(this.calNow() / step) * step, endMs: expiresAtMs, roomId: room.id })
        : undefined;
      sendMsg(c.res, 201, TempRoomResponseSchema, { room, inviteUrl: `${this.url}/r/${invite.code}`, inviteCode: invite.code, ...(event ? { event } : {}) });
    });

    // ---------------- categories (MANAGE_ROOM at workspace level = admins)
    this.route('GET', '/api/workspaces/:id/categories', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      sendMsg(c.res, 200, ListCategoriesResponseSchema, { categories: this.snapshot(ws.id, me).categories });
    });
    this.route('POST', '/api/workspaces/:id/categories', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, CreateCategoryRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      const positions = [...s().categories.values()].filter((x) => x.workspaceId === ws.id).map((x) => x.position);
      const category = create(RoomCategorySchema, {
        id: nextId(s(), 'category'),
        workspaceId: ws.id,
        name,
        position: b.position ?? (positions.length ? Math.max(...positions) + 1 : 0),
      });
      s().categories.set(category.id, category);
      this.toWorkspace(ws.id, { event: { case: 'categoryCreate', value: { category } } });
      sendMsg(c.res, 201, CreateCategoryResponseSchema, { category });
    });
    const categoryFor = (c: Ctx): RoomCategory => {
      const me = this.uid(c);
      const cat = s().categories.get(c.params[0] ?? '');
      if (!cat) throw notFound('category not found');
      this.requireAdmin(this.workspaceFor(cat.workspaceId, me).m);
      return cat;
    };
    this.route('PATCH', '/api/categories/:id', (c) => {
      const cat = categoryFor(c);
      const b = parseBody(c, UpdateCategoryRequestSchema);
      if (b.name !== undefined) {
        if (!b.name.trim() || b.name.length > 100) throw invalid('name', 'name must be 1..100 characters');
        cat.name = b.name.trim();
      }
      if (b.position !== undefined) cat.position = b.position;
      this.toWorkspace(cat.workspaceId, { event: { case: 'categoryUpdate', value: { category: cat } } });
      sendMsg(c.res, 200, UpdateCategoryResponseSchema, { category: cat });
    });
    this.route('DELETE', '/api/categories/:id', (c) => {
      const cat = categoryFor(c);
      s().categories.delete(cat.id);
      this.toWorkspace(cat.workspaceId, { event: { case: 'categoryDelete', value: { workspaceId: cat.workspaceId, categoryId: cat.id } } });
      // Like the server (DeleteCategory): the rooms go to the top level after the rooms there, in their order.
      const all = [...s().rooms.values()].filter((r) => r.workspaceId === cat.workspaceId);
      const base = Math.max(-1, ...all.filter((r) => !r.categoryId).map((r) => r.position)) + 1;
      const moved = all.filter((r) => r.categoryId === cat.id).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      moved.forEach((r, i) => {
        r.categoryId = '';
        r.position = base + i;
        this.toWorkspace(r.workspaceId, { event: { case: 'roomUpdate', value: { room: r } } }, r.id);
      });
      noContent(c.res);
    });
    // Drag & drop result (docs/09 P1 #19): one batch, all or nothing, like the server's transaction.
    this.route('PUT', '/api/workspaces/:id/rooms/order', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, SetRoomOrderRequestSchema);
      if (b.rooms.length > 500 || b.categories.length > 200) throw invalid('rooms', 'too many items');
      const cats = b.categories.map((p) => {
        const cat = s().categories.get(p.categoryId);
        if (!cat || cat.workspaceId !== ws.id) throw invalid('categories', `category ${p.categoryId} not found in this workspace`);
        return { cat, position: p.position };
      });
      const rooms = b.rooms.map((p) => {
        const room = s().rooms.get(p.roomId);
        if (!room || room.workspaceId !== ws.id) throw invalid('rooms', `room ${p.roomId} not found in this workspace`);
        if (p.categoryId && s().categories.get(p.categoryId)?.workspaceId !== ws.id) throw invalid('categoryId', 'category not found in this workspace');
        return { room, position: p.position, categoryId: p.categoryId };
      });
      for (const x of cats) x.cat.position = x.position;
      for (const x of rooms) {
        x.room.position = x.position;
        x.room.categoryId = x.categoryId;
      }
      for (const x of cats) this.toWorkspace(ws.id, { event: { case: 'categoryUpdate', value: { category: x.cat } } });
      for (const x of rooms) this.toWorkspace(ws.id, { event: { case: 'roomUpdate', value: { room: x.room } } }, x.room.id);
      sendMsg(c.res, 200, SetRoomOrderResponseSchema, { rooms: rooms.map((x) => this.roomOut(x.room)), categories: cats.map((x) => x.cat) });
    });

    this.route('GET', '/api/workspaces/:id/rooms', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      // ADR-0044: the archive of temporary rooms — MANAGE_ROOM at workspace level, rooms I may view, newest first.
      if (c.url.searchParams.get('archived') === '1') {
        if (!has(workspacePermissions(this.memberRoles(m)), MANAGE_ROOM)) throw forbidden('MANAGE_ROOM required');
        const rooms = [...this.archivedRooms.values()]
          .filter((r) => r.workspaceId === ws.id && this.canView(r, me))
          .sort((a, b) => (b.archivedAt ? timestampMs(b.archivedAt) : 0) - (a.archivedAt ? timestampMs(a.archivedAt) : 0));
        sendMsg(c.res, 200, ListRoomsResponseSchema, { rooms });
        return;
      }
      sendMsg(c.res, 200, ListRoomsResponseSchema, { rooms: this.snapshot(ws.id, me).rooms });
    });

    this.route('GET', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      sendMsg(c.res, 200, GetRoomResponseSchema, { room: this.roomOut(room), permissions: this.perms(room, me) });
    });

    this.route('PATCH', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      // ADR-0044: a temporary room's creator too.
      this.requireManage(room, me);
      const b = parseBody(c, UpdateRoomRequestSchema);
      const before = create(RoomSchema, room);
      if (b.expiresAt !== undefined) {
        if (!room.expiresAt) throw invalid('expiresAt', 'only temporary rooms expire');
        const at = timestampMs(b.expiresAt);
        const now = this.calNow();
        if (at <= now || at > now + 7 * 86_400_000) throw invalid('expiresAt', 'expires_at must be within 7 days from now');
        room.expiresAt = b.expiresAt;
        for (const inv of s().roomInvites.values()) if (inv.roomId === room.id) inv.expiresAt = b.expiresAt;
      }
      if (b.makePermanent) {
        if (!has(this.perms(room, me), MANAGE_ROOM)) throw forbidden('MANAGE_ROOM required');
        delete room.expiresAt;
      }
      if (b.isPrivate !== undefined) {
        if (!room.expiresAt) throw invalid('isPrivate', 'only temporary rooms');
        if (!b.isPrivate && room.restricted && b.restricted !== false) throw invalid('isPrivate', 'lift restricted first');
        room.isPrivate = b.isPrivate;
        const rest = room.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.ROLE && o.targetId === 'member'));
        room.permissionOverrides = b.isPrivate
          ? [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_ROOM }), ...rest]
          : rest;
      }
      if (b.name !== undefined) {
        if (!b.name.trim() || b.name.length > 100) throw invalid('name', 'name must be 1..100 characters');
        room.name = b.name.trim();
      }
      if (b.topic !== undefined) room.topic = b.topic;
      if (b.position !== undefined) room.position = b.position;
      if (b.mediaOverride !== undefined) {
        room.mediaOverride = b.mediaOverride;
        room.media = effectiveMedia(s().workspaces.get(room.workspaceId), b.mediaOverride);
      }
      if (b.userLimit !== undefined) {
        if (b.userLimit > 99) throw invalid('userLimit', 'user limit must be 0..99');
        room.userLimit = b.userLimit;
      }
      if (b.categoryId !== undefined) {
        if (b.categoryId && s().categories.get(b.categoryId)?.workspaceId !== room.workspaceId) throw invalid('categoryId', 'unknown category');
        room.categoryId = b.categoryId;
      }
      // ADR-0025, ADR-0048: MANAGE_RECORDINGS besides MANAGE_ROOM; switching it off stops a running recording.
      if (b.allowRecording !== undefined) {
        this.requireWsBit(this.workspaceFor(room.workspaceId, me).m, 'MANAGE_RECORDINGS');
        room.allowRecording = b.allowRecording;
      }
      // ADR-0048: MANAGE_ROOM in the room (requireManage above; the owner always); private rooms only.
      // Switching it on gives the caller (unless the owner) a personal allow VIEW_ROOM | MANAGE_ROOM.
      if (b.restricted !== undefined) {
        if (b.restricted && !room.isPrivate) throw invalid('restricted', 'only private rooms can be restricted');
        if (b.restricted && !room.restricted && s().workspaces.get(room.workspaceId)?.ownerId !== me) {
          const mine = room.permissionOverrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === me);
          if (mine) mine.allow |= VIEW_ROOM | MANAGE_ROOM;
          else room.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: me, allow: VIEW_ROOM | MANAGE_ROOM, deny: 0n }));
        }
        room.restricted = b.restricted;
      }
      if (b.guestApproval !== undefined) room.guestApproval = b.guestApproval; // ADR-0040
      this.emitRoomChange(before, room, { event: { case: 'roomUpdate', value: { room } } });
      if (b.allowRecording === false && s().recordings.has(room.id)) this.stopRecording(room, 'disabled', '');
      sendMsg(c.res, 200, UpdateRoomResponseSchema, { room });
    });

    this.route('DELETE', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireManage(room, me);
      // ADR-0044: a temporary room goes to the archive (history readable, links revoked).
      if (room.expiresAt) {
        this.archiveTempRoom(room);
        noContent(c.res);
        return;
      }
      for (const v of [...s().voiceStates.values()]) if (v.roomId === room.id) this.setVoice(v.userId, '', {});
      this.toWorkspace(room.workspaceId, { event: { case: 'roomDelete', value: { workspaceId: room.workspaceId, roomId: room.id } } }, room.id);
      s().rooms.delete(room.id);
      noContent(c.res);
    });

    this.route('PUT', '/api/rooms/:id/permissions', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const b = parseBody(c, SetRoomPermissionsRequestSchema);
      const before = create(RoomSchema, room);
      room.permissionOverrides = b.overrides;
      this.emitRoomChange(before, room, {
        event: { case: 'roomPermissionsUpdate', value: { workspaceId: room.workspaceId, roomId: room.id, permissions: room.permissionOverrides } },
      });
      sendMsg(c.res, 200, SetRoomPermissionsResponseSchema, { room });
    });

    // ---------------- messages
    this.route('GET', '/api/rooms/:id/messages', (c) => {
      const room = this.roomOrArchivedFor(c.params[0] ?? '', this.uid(c));
      const failLeft = this.failMessages.get(room.id) ?? 0;
      if (failLeft > 0) {
        if (failLeft > 1) this.failMessages.set(room.id, failLeft - 1);
        else this.failMessages.delete(room.id);
        throw new HttpError(500, ErrorCode.INTERNAL, 'mock: forced messages load failure');
      }
      if (c.url.searchParams.has('q')) {
        this.search(c, [room.id]);
        return;
      }
      const all = this.visibleMessages(this.uid(c), room.id);
      const limit = Math.min(100, Math.max(1, Number(c.url.searchParams.get('limit') ?? '50') || 50));
      const before = c.url.searchParams.get('before') ?? '';
      const after = c.url.searchParams.get('after') ?? '';
      let messages: Message[];
      let hasMore: boolean;
      if (after) {
        const newer = all.filter((m) => m.id > after);
        messages = newer.slice(0, limit);
        hasMore = newer.length > limit;
      } else {
        const older = before ? all.filter((m) => m.id < before) : all;
        messages = older.slice(-limit).reverse();
        hasMore = older.length > limit;
      }
      const me = this.uid(c);
      sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: messages.map((m) => this.msgOut(m, me)), hasMore });
    });

    this.route('POST', '/api/rooms/:id/messages', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireActive(room.workspaceId);
      this.requireRoomPerm(room, me, SEND_MESSAGES);
      const b = parseBody(c, CreateMessageRequestSchema);
      if (b.attachmentIds.length) this.requireRoomPerm(room, me, ATTACH_FILES);
      if (b.content.length > 4000) throw invalid('content', 'message too long');
      // A sticker message (ADR-0030): no text, no attachments, a pack usable here.
      let sticker: Sticker | undefined;
      if (b.stickerId) {
        if (b.content || b.attachmentIds.length) throw invalid('stickerId', 'a sticker message has no text or attachments');
        const found = this.findSticker(b.stickerId);
        if (!found) throw invalid('stickerId', 'sticker not found');
        if (!this.stickerUsable(found.pack, room, me)) throw forbidden('this sticker pack cannot be used here');
        sticker = found.sticker;
      } else if (!b.content.trim() && !b.attachmentIds.length) throw invalid('content', 'empty message');
      if (b.attachmentIds.length > 20) throw invalid('attachmentIds', 'too many attachments');
      if (b.nonce.length > 64) throw invalid('nonce', 'nonce too long');
      if (b.nonce) {
        const dup = (s().messages.get(room.id) ?? []).find((m) => m.authorId === me && m.nonce === b.nonce);
        if (dup) {
          sendMsg(c.res, 200, CreateMessageResponseSchema, { message: dup });
          return;
        }
      }
      const message = this.createMessage(room, me, b.content, b.replyToId, b.nonce, b.attachmentIds, sticker);
      sendMsg(c.res, 201, CreateMessageResponseSchema, { message });
    });

    // ADR-0033: a copy of the message in another room / DM, by the caller, with `forward`.
    this.route('POST', '/api/rooms/:id/messages/:mid/forward', (c) => {
      const me = this.uid(c);
      const src = this.roomFor(c.params[0] ?? '', me);
      const orig = (s().messages.get(src.id) ?? []).find((m) => m.id === c.params[1]);
      if (!orig) throw notFound('message not found');
      const b = parseBody(c, ForwardMessageRequestSchema);
      const room = this.roomFor(b.toRoomId, me);
      this.requireActive(room.workspaceId);
      this.requireRoomPerm(room, me, SEND_MESSAGES);
      const fwd = orig.forward ?? { authorId: orig.authorId, roomId: src.type === RoomType.DM || src.type === RoomType.NOTES ? '' : src.id, messageId: orig.id, sentAt: orig.createdAt };
      const message = create(MessageSchema, {
        id: nextId(this.state, 'message'),
        roomId: room.id,
        authorId: me,
        content: orig.content,
        attachments: orig.attachments,
        kind: orig.kind,
        ...(orig.system ? { system: orig.system } : {}),
        ...(orig.sticker ? { sticker: orig.sticker } : {}),
        embedsHidden: orig.embedsHidden,
        forward: fwd,
        createdAt: tick(this.state),
      });
      const list = s().messages.get(room.id) ?? [];
      list.push(message);
      s().messages.set(room.id, list);
      this.toWorkspace(room.workspaceId, { event: { case: 'messageCreate', value: { workspaceId: room.workspaceId, message } } }, room.id);
      sendMsg(c.res, 201, ForwardMessageResponseSchema, { message });
    });

    this.route('PATCH', '/api/messages/:id', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg || msg.authorId !== me) throw forbidden('only the author can edit');
      if (msg.sticker) throw forbidden('sticker messages cannot be edited');
      const b = parseBody(c, UpdateMessageRequestSchema);
      if (b.content.length > 4000) throw invalid('content', 'message too long');
      if (!b.content.trim() && !msg.attachments.length) throw invalid('content', 'empty message');
      msg.content = b.content;
      msg.editedAt = tick(s());
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      sendMsg(c.res, 200, UpdateMessageResponseSchema, { message: msg });
    });

    // Hide / show the link previews of a message (author or MANAGE_MESSAGES); not an edit.
    this.route('PUT', '/api/messages/:id/embeds-hidden', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (msg.authorId !== me) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      msg.embedsHidden = parseBody(c, SetEmbedsHiddenRequestSchema).hidden;
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      sendMsg(c.res, 200, UpdateMessageResponseSchema, { message: this.msgOut(msg, me) });
    });

    this.route('DELETE', '/api/messages/:id', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (msg.authorId !== me) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      list.splice(index, 1);
      this.toWorkspace(
        room.workspaceId,
        { event: { case: 'messageDelete', value: { workspaceId: room.workspaceId, roomId: room.id, messageId: msg.id } } },
        room.id,
      );
      if (room.type === RoomType.TASK) this.boards.onCommentDeleted(room.id);
      noContent(c.res);
    });

    this.route('PUT', '/api/rooms/:id/read', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateReadStateRequestSchema);
      if (!b.messageId) throw invalid('messageId', 'message id required');
      this.markRead(me, room.id, b.messageId);
      noContent(c.res);
    });

    // ---------------- mentions and room notification settings (docs/05)
    this.route('GET', '/api/me/mentions', (c) => {
      const me = this.uid(c);
      const q = c.url.searchParams;
      if (q.get('after')) throw invalid('after', 'only before is supported');
      const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? '50') || 50));
      const before = q.get('before') ?? '';
      const only = q.get('workspace_id') ?? '';
      const hits = [...this.state.rooms.values()]
        .filter((r) => (!only || r.workspaceId === only) && this.member(r.workspaceId, me) && this.canView(r, me))
        .flatMap((r) =>
          (s().messages.get(r.id) ?? []).filter((m) => {
            if (m.authorId === me || (before && m.id >= before)) return false;
            const { users, everyone } = parseMentions(m.content);
            return users.includes(me) || (everyone && this.mayMentionAll(r, m.authorId));
          }),
        )
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      sendMsg(c.res, 200, ListMessagesResponseSchema, {
        messages: hits.slice(0, limit).map((m) => this.msgOut(m, me)),
        hasMore: hits.length > limit,
      });
    });

    this.route('PUT', '/api/rooms/:id/notifications', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateRoomNotificationSettingsRequestSchema);
      if (b.mutedUntil && timestampMs(b.mutedUntil) > Date.now() + 366 * 86_400_000) throw invalid('mutedUntil', 'at most 1 year ahead');
      // The room default is INHERIT: follow the workspace level (docs/09 item 22).
      const level = b.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.INHERIT : b.level;
      const settings = create(RoomNotificationSettingsSchema, { roomId: room.id, level, ...(b.mutedUntil ? { mutedUntil: b.mutedUntil } : {}) });
      const mine = s().notifySettings.get(me) ?? new Map<string, RoomNotificationSettings>();
      if (level === NotificationLevel.INHERIT && !b.mutedUntil) mine.delete(room.id);
      else mine.set(room.id, settings);
      s().notifySettings.set(me, mine);
      this.toUser(me, { event: { case: 'roomNotificationUpdate', value: { settings } } });
      sendMsg(c.res, 200, UpdateRoomNotificationSettingsResponseSchema, { settings });
    });

    // Workspace level (docs/09 item 22): members only; default MENTIONS = no row; INHERIT → 422.
    this.route('PUT', '/api/workspaces/:id/notifications', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateWorkspaceNotificationSettingsRequestSchema);
      if (b.level === NotificationLevel.INHERIT) throw invalid('level', 'unknown notification level');
      if (b.mutedUntil && timestampMs(b.mutedUntil) > Date.now() + 366 * 86_400_000) throw invalid('mutedUntil', 'at most 1 year ahead');
      const level = b.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.MENTIONS : b.level;
      const settings = create(WorkspaceNotificationSettingsSchema, { workspaceId: ws.id, level, ...(b.mutedUntil ? { mutedUntil: b.mutedUntil } : {}) });
      const mine = s().wsNotifySettings.get(me) ?? new Map<string, WorkspaceNotificationSettings>();
      if (level === NotificationLevel.MENTIONS && !b.mutedUntil) mine.delete(ws.id);
      else mine.set(ws.id, settings);
      s().wsNotifySettings.set(me, mine);
      this.toUser(me, { event: { case: 'workspaceNotificationUpdate', value: { settings } } });
      sendMsg(c.res, 200, UpdateWorkspaceNotificationSettingsResponseSchema, { settings });
    });

    // ---------------- chat: search, reactions, pins, link previews
    this.route('GET', '/api/workspaces/:id/messages/search', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      const roomId = c.url.searchParams.get('room_id') ?? '';
      const ids = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id && this.canView(r, me) && (!roomId || r.id === roomId)).map((r) => r.id);
      this.search(c, ids);
    });

    const reaction = (c: Ctx, add: boolean): void => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      if (add) this.requireRoomPerm(room, me, SEND_MESSAGES);
      const msg = list[index];
      const emoji = c.params[1] ?? '';
      if (!msg || !emoji || emoji.length > 32) throw invalid('emoji', 'bad emoji');
      const byEmoji = s().reactions.get(msg.id) ?? new Map<string, Set<string>>();
      const users = byEmoji.get(emoji) ?? new Set<string>();
      // At most MAX_REACTIONS_PER_USER different emojis per user per message (docs/09 #27);
      // a repeat is idempotent, removal is never limited.
      if (add && !users.has(me)) {
        const mine = [...byEmoji.values()].filter((u) => u.has(me)).length;
        if (mine >= MAX_REACTIONS_PER_USER)
          throw new HttpError(409, ErrorCode.CONFLICT, 'at most 3 different reactions per message', '', {
            reason: 'REACTION_LIMIT',
            used: BigInt(mine),
            limit: BigInt(MAX_REACTIONS_PER_USER),
          });
      }
      const changed = add ? !users.has(me) : users.has(me);
      if (add) users.add(me);
      else users.delete(me);
      if (users.size) byEmoji.set(emoji, users);
      else byEmoji.delete(emoji);
      s().reactions.set(msg.id, byEmoji);
      msg.reactions = [...byEmoji].map(([e, u]) => create(ReactionSchema, { emoji: e, count: u.size }));
      if (changed) {
        const value = { workspaceId: room.workspaceId, roomId: room.id, messageId: msg.id, userId: me, emoji };
        this.toWorkspace(room.workspaceId, { event: add ? { case: 'messageReactionAdd', value } : { case: 'messageReactionRemove', value } }, room.id);
      }
      noContent(c.res);
    };
    this.route('PUT', '/api/messages/:id/reactions/:emoji', (c) => reaction(c, true));
    this.route('DELETE', '/api/messages/:id/reactions/:emoji', (c) => reaction(c, false));

    const pin = (c: Ctx, on: boolean): void => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      // Both DM participants may pin (docs/04); rooms need MANAGE_MESSAGES.
      if (room.type !== RoomType.DM && room.type !== RoomType.NOTES) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (on === !!msg.pinnedAt) {
        noContent(c.res);
        return;
      }
      if (on) {
        msg.pinnedAt = tick(s());
        msg.pinnedBy = me;
      } else {
        msg.pinnedAt = undefined;
        msg.pinnedBy = '';
      }
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      noContent(c.res);
    };
    this.route('PUT', '/api/messages/:id/pin', (c) => pin(c, true));
    this.route('DELETE', '/api/messages/:id/pin', (c) => pin(c, false));
    this.route('GET', '/api/rooms/:id/pins', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const pinned = this.visibleMessages(me, room.id)
        .filter((m) => m.pinnedAt)
        .sort((a, b) => (a.pinnedAt && b.pinnedAt ? timestampMs(b.pinnedAt) - timestampMs(a.pinnedAt) : 0));
      sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: pinned.map((m) => this.msgOut(m, me)), hasMore: false });
    });

    this.route('GET', '/api/unfurl', (c) => {
      const me = this.uid(c);
      const url = c.url.searchParams.get('url') ?? '';
      // Own links (ADR-0042): /t/<KEY-N> and /b/<id> from the boards, 404 when not visible.
      const ownTask = /\/t\/([A-Za-z][A-Za-z0-9]{1,5}-[0-9]+)\/?$/.exec(url);
      const ownBoard = /\/b\/([0-9a-f-]{36})\/?$/.exec(url);
      if (ownTask?.[1] || ownBoard?.[1]) {
        try {
          if (ownTask?.[1]) {
            const rec = this.boards.tasks.get(this.boards.byKey(ownTask[1], me));
            if (!rec) throw new Error('gone');
            const task = this.boards.taskOut(rec, me, false);
            const board = this.boards.getBoard(task.boardId, me);
            sendMsg(c.res, 200, UnfurlResponseSchema, { url, title: `${task.key} ${task.title}`, siteName: board.name, task, board });
          } else {
            const board = this.boards.getBoard(ownBoard?.[1] ?? '', me);
            sendMsg(c.res, 200, UnfurlResponseSchema, { url, title: board.name, board });
          }
        } catch {
          throw notFound('preview not found');
        }
        return;
      }
      const card = UNFURLS[url] ?? MARKETING_UNFURLS[url];
      if (!card) throw notFound('preview not found');
      sendMsg(c.res, 200, UnfurlResponseSchema, {
        url,
        title: card.title,
        description: card.description,
        siteName: card.siteName,
        imageUrl: card.image ? `/api/unfurl/image?${new URLSearchParams({ url: `${url}/og.png`, sig: 'mock' }).toString()}` : '',
      });
    });
    this.route('GET', '/api/unfurl/image', (c) => {
      this.uid(c);
      send(c.res, 200, unfurlImage(), 'image/png', { 'Cache-Control': 'private, max-age=31536000' });
    });

    // ---------------- files
    this.route('POST', '/api/workspaces/:id/files', async (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      const f = await parseMultipartFile(c);
      if (f.bytes.length > 50 * 1024 * 1024) throw new HttpError(413, ErrorCode.FILE_TOO_LARGE, 'file too large');
      // Quota = min(workspace quota, plan storage_mb) (ADR-0024).
      const planBytes = this.planLimits(ws.id).storageMb * 1024n * 1024n;
      const byPlan = planBytes > 0n && planBytes < ws.storageQuotaBytes;
      const quota = byPlan ? planBytes : ws.storageQuotaBytes;
      if (ws.storageUsedBytes + BigInt(f.bytes.length) > quota) {
        throw new HttpError(413, ErrorCode.FILE_QUOTA_EXCEEDED, 'storage quota exceeded', '', { ...(byPlan ? { reason: 'PLAN_LIMIT' } : {}), used: ws.storageUsedBytes, limit: quota });
      }
      const id = this.storeFile(ws.id, me, f, parseVoice(c, f));
      ws.storageUsedBytes += BigInt(f.bytes.length);
      sendMsg(c.res, 201, UploadFileResponseSchema, { file: s().files.get(id)?.meta });
    });

    // ---------------- direct messages (ADR-0020, docs/05 «Личные сообщения»)
    const noGuest = (u: UserRec): void => {
      if (u.user.isGuest) throw forbidden('guests have no direct messages');
    };
    // Notes shelves (ADR-0039): people only; another user's shelf is 404.
    const shelfOwner = (u: UserRec): void => {
      if (u.user.isGuest || u.user.isBot) throw forbidden('notes are not available for guest accounts and bots');
    };
    const myShelf = (roomId: string, me: string): Room => {
      const room = s().rooms.get(roomId);
      if (!room || s().shelves.get(roomId)?.ownerId !== me) throw notFound('notes not found');
      return room;
    };
    this.route('GET', '/api/notes', (c) => {
      const { user } = this.auth(c);
      shelfOwner(user);
      sendMsg(c.res, 200, ListNotesResponseSchema, { shelves: this.notesOf(user.user.id), storage: { quotaBytes: 1n << 30n, usedBytes: 0n, isDefault: true } });
    });
    this.route('POST', '/api/notes', (c) => {
      const { user } = this.auth(c);
      shelfOwner(user);
      const b = parseBody(c, CreateNotesRequestSchema);
      const name = b.name.trim();
      if (!name || Array.from(name).length > 40) throw invalid('name', 'name must be 1 to 40 characters');
      const id = this.addShelf(user.user.id, name, b.emoji.trim());
      sendMsg(c.res, 201, CreateNotesResponseSchema, { shelf: this.shelfOut(id, user.user.id) ?? undefined });
    });
    this.route('PATCH', '/api/notes/:id', (c) => {
      const { user } = this.auth(c);
      shelfOwner(user);
      const me = user.user.id;
      const room = myShelf(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateNotesRequestSchema);
      const sh = s().shelves.get(room.id);
      if (b.name !== undefined) {
        const name = b.name.trim();
        if (!name || Array.from(name).length > 40) throw invalid('name', 'name must be 1 to 40 characters');
        room.name = name;
      }
      if (b.emoji !== undefined && sh) sh.emoji = b.emoji.trim();
      const moved = new Set([room.id]);
      if (b.position !== undefined) {
        const order = this.notesOf(me).map((n) => n.room?.id ?? '').filter((id) => id !== room.id);
        order.splice(Math.min(b.position, order.length), 0, room.id);
        order.forEach((id, i) => {
          const r = s().rooms.get(id);
          if (r && r.position !== i) {
            r.position = i;
            moved.add(id);
          }
        });
      }
      for (const id of moved) {
        const shelf = this.shelfOut(id, me);
        if (shelf) this.toUser(me, { event: { case: 'notesUpdate', value: { shelf } } });
      }
      sendMsg(c.res, 200, UpdateNotesResponseSchema, { shelf: this.shelfOut(room.id, me) ?? undefined });
    });
    this.route('DELETE', '/api/notes/:id', (c) => {
      const { user } = this.auth(c);
      shelfOwner(user);
      const room = myShelf(c.params[0] ?? '', user.user.id);
      s().rooms.delete(room.id);
      s().shelves.delete(room.id);
      s().messages.delete(room.id);
      this.toUser(user.user.id, { event: { case: 'notesDelete', value: { roomId: room.id } } });
      noContent(c.res);
    });
    this.route('GET', '/api/dms', (c) => {
      const { user } = this.auth(c);
      noGuest(user);
      sendMsg(c.res, 200, ListDmsResponseSchema, { dms: this.dmsOf(user.user.id) });
    });
    this.route('GET', '/api/dms/candidates', (c) => {
      const { user } = this.auth(c);
      noGuest(user);
      const me = user.user.id;
      const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q.length > 64) throw invalid('q', 'at most 64 characters');
      const names = (id: string): string[] => [
        s().users.get(id)?.user.displayName ?? '',
        ...s().members.filter((m) => m.userId === id && m.nickname).map((m) => m.nickname),
      ];
      const users = [...s().users.values()]
        .filter((u) => u.user.id !== me && !u.user.isGuest && this.shareAsMembers(me, u.user.id))
        .filter((u) => !q || names(u.user.id).some((n) => n.toLowerCase().includes(q)))
        .map((u) => u.user)
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.id.localeCompare(b.id))
        .slice(0, 20);
      sendMsg(c.res, 200, ListDmCandidatesResponseSchema, { users });
    });
    this.route('POST', '/api/dms', (c) => {
      const { user } = this.auth(c);
      const me = user.user.id;
      const b = parseBody(c, CreateDmRequestSchema);
      if (b.userId === me) throw invalid('userId', 'cannot message yourself');
      const peer = s().users.get(b.userId);
      if (!peer) throw notFound('user not found');
      if (user.user.isGuest || peer.user.isGuest) throw forbidden('guests have no direct messages');
      const existing = [...s().dmMembers.entries()].find(([, pair]) => pair.includes(me) && pair.includes(b.userId))?.[0];
      if (existing) {
        sendMsg(c.res, 200, CreateDmResponseSchema, { dm: this.dmOut(existing, me) ?? undefined });
        return;
      }
      if (!this.shareAsMembers(me, b.userId)) throw notFound('no common workspace');
      this.requireVerified(c); // a NEW DM needs a verified address (ADR-0023)
      const id = nextId(s(), 'room');
      s().rooms.set(id, create(RoomSchema, { id, workspaceId: '', type: RoomType.DM, name: '', createdAt: tick(s()) }));
      s().dmMembers.set(id, [me, b.userId]);
      // DM_CREATE to both participants, each with their own peer.
      for (const u of [me, b.userId]) {
        const dm = this.dmOut(id, u);
        if (dm) this.toUser(u, { event: { case: 'dmCreate', value: { dm } } });
      }
      sendMsg(c.res, 201, CreateDmResponseSchema, { dm: this.dmOut(id, me) ?? undefined });
    });
    this.route('PATCH', '/api/dms/:id/state', (c) => {
      const { user } = this.auth(c);
      noGuest(user);
      const me = user.user.id;
      const roomId = c.params[0] ?? '';
      if (this.dmPeer(roomId, me) === null) throw notFound('dm not found');
      const b = parseBody(c, UpdateDmStateRequestSchema);
      if (b.archived === undefined && !b.cleared) throw invalid('archived', 'set archived or cleared');
      this.setDmState(me, roomId, { cleared: b.cleared, ...(b.archived !== undefined ? { archived: b.archived } : {}) });
      sendMsg(c.res, 200, UpdateDmStateResponseSchema, { dm: this.dmOut(roomId, me) ?? undefined });
    });
    this.route('POST', '/api/dms/:id/files', async (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type !== RoomType.DM && room.type !== RoomType.NOTES) throw notFound('dm not found');
      const f = await parseMultipartFile(c);
      if (f.bytes.length > 50 * 1024 * 1024) throw new HttpError(413, ErrorCode.FILE_TOO_LARGE, 'file too large');
      const id = this.storeFile('', me, f, parseVoice(c, f));
      sendMsg(c.res, 201, UploadFileResponseSchema, { file: s().files.get(id)?.meta });
    });

    const serveFile = (c: Ctx, thumb: boolean): void => {
      this.auth(c);
      const f = s().files.get(c.params[0] ?? '');
      if (!f) throw notFound('file not found');
      if (thumb) {
        if (!f.thumbnail) throw notFound('no thumbnail');
        send(c.res, 200, f.thumbnail.bytes, f.thumbnail.mime, { ETag: `"${f.meta.sha256}-thumb"`, 'Cache-Control': 'private, max-age=31536000' });
        return;
      }
      // Byte ranges like the server's http.ServeContent (media elements stream and seek with them).
      const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.headers.range ?? '');
      const total = f.bytes.length;
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(total - 1, Number(range[2])) : total - 1;
        if (start >= total || start > end) {
          send(c.res, 416, Buffer.alloc(0), f.meta.mime, { 'Content-Range': `bytes */${total}` });
          return;
        }
        send(c.res, 206, f.bytes.subarray(start, end + 1), f.meta.mime, {
          ETag: `"${f.meta.sha256}"`,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Cache-Control': 'private, max-age=31536000',
        });
        return;
      }
      send(c.res, 200, f.bytes, f.meta.mime, {
        'Accept-Ranges': 'bytes',
        ETag: `"${f.meta.sha256}"`,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
        'Cache-Control': 'private, max-age=31536000',
      });
    };
    this.route('GET', '/api/files/:id', async (c) => {
      // holdFiles(): the full file waits (thumbnails do not) — a slow download in visual tests.
      if (this.fileGate) await this.fileGate.done;
      serveFile(c, false);
    });
    this.route('GET', '/api/files/:id/thumbnail', (c) => serveFile(c, true));

    // ---------------- bots (ADR-0031)
    const botManager = (c: Ctx): { wsId: string; me: string } => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      const { m } = this.workspaceFor(wsId, me);
      this.requireWsBit(m, 'MANAGE_BOTS'); // ADR-0048
      return { wsId, me };
    };
    const botIn = (wsId: string, botId: string): BotRec => {
      const b = s().bots.get(botId);
      if (!b || !this.member(wsId, botId)) throw notFound('bot not found');
      return b;
    };
    const findBot = (ref: string): BotRec => {
      const r = ref.trim().toLowerCase();
      const b = s().bots.get(ref) ?? [...s().bots.values()].find((x) => x.username === r);
      if (!b) throw notFound('bot not found');
      return b;
    };
    this.route('GET', '/api/workspaces/:id/bots', (c) => {
      const { wsId } = botManager(c);
      const bots = this.membersOf(wsId)
        .map((m) => s().bots.get(m.userId))
        .filter((b): b is BotRec => !!b)
        .map((b) => this.botOut(b, b.workspaceId === wsId));
      sendMsg(c.res, 200, ListBotsResponseSchema, { bots });
    });
    this.route('POST', '/api/workspaces/:id/bots', (c) => {
      const { wsId, me } = botManager(c);
      this.requireActive(wsId);
      const b = parseBody(c, CreateBotRequestSchema);
      const name = b.displayName.trim();
      if (!name || Array.from(name).length > 64) throw invalid('display_name', 'display name must be 1..64 characters');
      const username = b.username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) throw invalid('username', 'username must be 3..32 characters of a-z, 0-9 and _');
      if ([...s().bots.values()].some((x) => x.username === username)) throw conflict('username is taken', 'username');
      if (Array.from(b.description).length > 512) throw invalid('description', 'description must be at most 512 characters');
      this.checkBotPlan(wsId);
      const bot = this.newBot({ id: nextId(s(), 'user'), name, username, owner: me, workspaceId: wsId, description: b.description.trim() });
      const token = this.botToken(bot);
      this.botJoin(wsId, bot);
      sendMsg(c.res, 201, CreateBotResponseSchema, { bot: this.botOut(bot, true), token });
    });
    this.route('POST', '/api/workspaces/:id/bots/add', (c) => {
      const { wsId } = botManager(c);
      this.requireActive(wsId);
      const req = parseBody(c, AddBotRequestSchema);
      const bot = findBot(req.botUserId || req.username);
      if (this.member(wsId, bot.userId)) throw conflict('the bot is already a member');
      this.checkBotPlan(wsId);
      this.botJoin(wsId, bot);
      sendMsg(c.res, 201, AddBotResponseSchema, { bot: this.botOut(bot, false) });
    });
    this.route('DELETE', '/api/workspaces/:id/bots/:botId', (c) => {
      const { wsId } = botManager(c);
      const bot = botIn(wsId, c.params[1] ?? '');
      if (bot.workspaceId !== wsId) {
        this.botLeave(wsId, bot.userId);
      } else {
        for (const w of this.workspacesOf(bot.userId)) this.botLeave(w, bot.userId);
        s().bots.delete(bot.userId);
      }
      noContent(c.res);
    });
    this.route('POST', '/api/workspaces/:id/bots/:botId/token', (c) => {
      const { wsId } = botManager(c);
      const bot = botIn(wsId, c.params[1] ?? '');
      if (bot.workspaceId !== wsId) throw forbidden('the bot is managed in the workspace where it was created');
      tick(s());
      const token = this.botToken(bot);
      delete bot.revokedAt;
      this.botUpdate(bot);
      sendMsg(c.res, 200, ReissueBotTokenResponseSchema, { bot: this.botOut(bot, true), token });
    });
    this.route('DELETE', '/api/workspaces/:id/bots/:botId/token', (c) => {
      const { wsId } = botManager(c);
      const bot = botIn(wsId, c.params[1] ?? '');
      if (bot.workspaceId !== wsId) throw forbidden('the bot is managed in the workspace where it was created');
      bot.revokedAt = tick(s());
      this.botUpdate(bot);
      noContent(c.res);
    });
    // docs/09 #87: the avatar of a home bot, from «Боты» or its profile.
    const botAvatar = (c: Ctx, fileId: string): void => {
      const bot = homeBot(c);
      const u = s().users.get(bot.userId);
      if (!u) throw notFound('bot not found');
      u.user.avatarFileId = fileId;
      this.emitUserUpdate(u);
      this.botUpdate(bot);
      sendMsg(c.res, 200, SetBotAvatarResponseSchema, { bot: this.botOut(bot, true) });
    };
    const homeBot = (c: Ctx): BotRec => {
      const { wsId } = botManager(c);
      const bot = botIn(wsId, c.params[1] ?? '');
      if (bot.workspaceId !== wsId) throw forbidden('the bot is managed in the workspace where it was created');
      return bot;
    };
    this.route('POST', '/api/workspaces/:id/bots/:botId/avatar', async (c) => {
      const bot = homeBot(c);
      const f = await parseMultipartFile(c);
      if (!f.mime.startsWith('image/')) throw invalid('file', 'must be a JPEG, PNG, GIF or WebP image');
      botAvatar(c, this.storeFile('', bot.userId, f));
    });
    this.route('DELETE', '/api/workspaces/:id/bots/:botId/avatar', (c) => botAvatar(c, ''));
    this.route('GET', '/api/bots/:ref', (c) => {
      this.uid(c);
      const bot = this.botOut(findBot(c.params[0] ?? ''), false);
      bot.ownerUserId = '';
      bot.workspaceId = '';
      sendMsg(c.res, 200, GetBotMeResponseSchema, { bot });
    });
    this.route('GET', '/api/rooms/:id/bot-commands', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const ids = room.type === RoomType.DM ? (s().dmMembers.get(room.id) ?? []).filter((u) => u !== me) : this.membersOf(room.workspaceId).map((m) => m.userId);
      const bots: RoomBotCommands[] = [];
      for (const id of ids) {
        const b = s().bots.get(id);
        if (!b || b.revokedAt || !b.commands.length || !this.canView(room, id)) continue;
        bots.push(create(RoomBotCommandsSchema, { botUserId: b.userId, username: b.username, commands: b.commands }));
      }
      sendMsg(c.res, 200, ListRoomBotCommandsResponseSchema, { bots });
    });
    this.route('GET', '/api/me/blocked-bots', (c) => {
      sendMsg(c.res, 200, ListBlockedBotsResponseSchema, { botUserIds: [...(s().blockedBots.get(this.uid(c)) ?? [])] });
    });
    this.route('POST', '/api/me/blocked-bots/:id', (c) => {
      const me = this.uid(c);
      const id = c.params[0] ?? '';
      if (!s().users.get(id)?.user.isBot) throw notFound('bot not found');
      const set = s().blockedBots.get(me) ?? new Set<string>();
      set.add(id);
      s().blockedBots.set(me, set);
      noContent(c.res);
    });
    this.route('DELETE', '/api/me/blocked-bots/:id', (c) => {
      s().blockedBots.get(this.uid(c))?.delete(c.params[0] ?? '');
      noContent(c.res);
    });

    // ---------------- sticker packs (ADR-0030)
    this.route('GET', '/api/workspaces/:id/sticker-packs', (c) => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      if (!this.member(wsId, me)) throw notFound('workspace not found');
      const packs = [...s().stickerPacks.values()].filter((p) => p.workspaceId === wsId);
      sendMsg(c.res, 200, ListStickerPacksResponseSchema, { packs });
    });
    this.route('POST', '/api/workspaces/:id/sticker-packs', (c) => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      this.stickerManager(wsId, me);
      this.requireActive(wsId);
      const b = parseBody(c, CreateStickerPackRequestSchema);
      const name = b.name.trim();
      if (!name || Array.from(name).length > 64) throw invalid('name', 'name must be 1..64 characters');
      const id = nextId(s(), 'stickerPack');
      const at = tick(s());
      const pack = create(StickerPackSchema, { id, workspaceId: wsId, name, shortName: b.shortName || `p_${id.slice(-8)}`, stickers: [], createdBy: me, createdAt: at, updatedAt: at });
      s().stickerPacks.set(id, pack);
      s().userStickerPacks.set(me, [id, ...(s().userStickerPacks.get(me) ?? [])]);
      this.packEvent(pack, true);
      sendMsg(c.res, 201, StickerPackResponseSchema, { pack });
    });
    this.route('GET', '/api/sticker-packs/:id', (c) => {
      const pack = this.packFor(c.params[0] ?? '', this.uid(c), false);
      sendMsg(c.res, 200, StickerPackResponseSchema, { pack });
    });
    this.route('PATCH', '/api/sticker-packs/:id', (c) => {
      const pack = this.packFor(c.params[0] ?? '', this.uid(c), true);
      const b = parseBody(c, UpdateStickerPackRequestSchema);
      if (b.name !== undefined) {
        const name = b.name.trim();
        if (!name || Array.from(name).length > 64) throw invalid('name', 'name must be 1..64 characters');
        pack.name = name;
      }
      if (b.coverStickerId !== undefined) {
        if (b.coverStickerId && !pack.stickers.some((x) => x.id === b.coverStickerId)) throw invalid('coverStickerId', 'not a sticker of this pack');
        pack.coverStickerId = b.coverStickerId;
      }
      if (b.stickerIds.length) {
        const byId = new Map(pack.stickers.map((x) => [x.id, x]));
        if (b.stickerIds.length !== pack.stickers.length || b.stickerIds.some((id) => !byId.has(id))) throw invalid('stickerIds', 'must list every sticker of the pack once');
        pack.stickers = b.stickerIds.map((id) => byId.get(id)).filter((x): x is Sticker => !!x);
      }
      pack.updatedAt = tick(s());
      this.packEvent(pack);
      sendMsg(c.res, 200, StickerPackResponseSchema, { pack });
    });
    this.route('DELETE', '/api/sticker-packs/:id', (c) => {
      const pack = this.packFor(c.params[0] ?? '', this.uid(c), true);
      for (const x of pack.stickers) s().deletedStickers.set(x.id, create(StickerSchema, { ...x, deleted: true }));
      s().stickerPacks.delete(pack.id);
      for (const [u, ids] of s().userStickerPacks) s().userStickerPacks.set(u, ids.filter((id) => id !== pack.id));
      this.toWorkspace(pack.workspaceId, { event: { case: 'stickerPackDelete', value: { workspaceId: pack.workspaceId, packId: pack.id } } });
      noContent(c.res);
    });
    this.route('POST', '/api/sticker-packs/:id/stickers', async (c) => {
      const me = this.uid(c);
      const pack = this.packFor(c.params[0] ?? '', me, true);
      const type = c.req.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data')) throw new HttpError(400, ErrorCode.BAD_REQUEST, 'multipart/form-data expected');
      const form = await new Request('http://mock/upload', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(c.raw) }).formData();
      const emojis = form.getAll('emoji').map(String);
      const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
      if (!files.length) throw invalid('file', 'no sticker files');
      if (pack.stickers.length + files.length > 120) throw invalid('file', 'a pack holds at most 120 stickers');
      const added: Sticker[] = [];
      for (const [i, f] of files.entries()) {
        const bytes = Buffer.from(await f.arrayBuffer());
        const emoji = (emojis[i] ?? '').trim();
        if (!emoji || /^[ -~]+$/.test(emoji)) throw invalid(`emoji[${i}]`, 'must be one emoji');
        const why = mockWebpProblem(bytes);
        if (why) throw invalid(`file[${i}]`, `not a valid WebP sticker: ${why}`);
        const animated = bytes.includes(Buffer.from('ANIM'));
        const fileId = this.storeFile(pack.workspaceId, me, { name: f.name || 'sticker.webp', mime: 'image/webp', bytes });
        added.push(create(StickerSchema, { id: nextId(s(), 'sticker'), packId: pack.id, emoji, url: `/api/files/${fileId}`, width: 160, height: 160, animated, size: bytes.length }));
      }
      pack.stickers = [...pack.stickers, ...added];
      pack.updatedAt = tick(s());
      this.packEvent(pack);
      sendMsg(c.res, 201, UploadStickersResponseSchema, { pack, added });
    });
    // Replace a sticker's picture and / or emoji in place (same id and position).
    this.route('PUT', '/api/sticker-packs/:id/stickers/:sid', async (c) => {
      const me = this.uid(c);
      const pack = this.packFor(c.params[0] ?? '', me, true);
      const sticker = pack.stickers.find((x) => x.id === c.params[1]);
      if (!sticker) throw notFound('sticker not found');
      const type = c.req.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data')) throw new HttpError(400, ErrorCode.BAD_REQUEST, 'multipart/form-data expected');
      const form = await new Request('http://mock/upload', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(c.raw) }).formData();
      const rawEmoji = form.get('emoji');
      const file = form.get('file');
      if (rawEmoji === null && !(file instanceof File)) throw invalid('file', 'expected a "file" and / or an "emoji" field');
      const emoji = typeof rawEmoji === 'string' ? rawEmoji.trim() : null;
      if (emoji !== null && (!emoji || /^[ -~]+$/.test(emoji))) throw invalid('emoji', 'must be one emoji');
      if (file instanceof File) {
        const bytes = Buffer.from(await file.arrayBuffer());
        const why = mockWebpProblem(bytes);
        if (why) throw invalid('file', `not a valid WebP sticker: ${why}`);
        const fileId = this.storeFile(pack.workspaceId, me, { name: file.name || 'sticker.webp', mime: 'image/webp', bytes });
        Object.assign(sticker, { url: `/api/files/${fileId}`, animated: bytes.includes(Buffer.from('ANIM')), size: bytes.length });
      }
      if (emoji !== null) sticker.emoji = emoji;
      pack.updatedAt = tick(s());
      this.packEvent(pack);
      sendMsg(c.res, 200, StickerPackResponseSchema, { pack });
    });
    this.route('PATCH', '/api/stickers/:id', (c) => {
      const me = this.uid(c);
      const found = this.findSticker(c.params[0] ?? '');
      if (!found || !this.member(found.pack.workspaceId, me)) throw notFound('sticker not found');
      this.stickerManager(found.pack.workspaceId, me);
      const b = parseBody(c, UpdateStickerRequestSchema);
      const emoji = b.emoji.trim();
      if (!emoji || /^[ -~]+$/.test(emoji)) throw invalid('emoji', 'must be one emoji');
      found.sticker.emoji = emoji;
      found.pack.updatedAt = tick(s());
      this.packEvent(found.pack);
      sendMsg(c.res, 200, StickerPackResponseSchema, { pack: found.pack });
    });
    this.route('DELETE', '/api/stickers/:id', (c) => {
      const me = this.uid(c);
      const found = this.findSticker(c.params[0] ?? '');
      if (!found || !this.member(found.pack.workspaceId, me)) throw notFound('sticker not found');
      this.stickerManager(found.pack.workspaceId, me);
      const { pack, sticker } = found;
      s().deletedStickers.set(sticker.id, create(StickerSchema, { ...sticker, deleted: true }));
      pack.stickers = pack.stickers.filter((x) => x.id !== sticker.id);
      if (pack.coverStickerId === sticker.id) pack.coverStickerId = '';
      pack.updatedAt = tick(s());
      this.packEvent(pack);
      sendMsg(c.res, 200, StickerPackResponseSchema, { pack });
    });
    this.route('GET', '/api/me/sticker-packs', (c) => {
      sendMsg(c.res, 200, MyStickerPacksResponseSchema, this.myPacks(this.uid(c)));
    });
    // Before …/:id: the same path shape.
    this.route('PUT', '/api/me/sticker-packs/order', (c) => {
      const me = this.uid(c);
      const b = parseBody(c, SetStickerPackOrderRequestSchema);
      const have = s().userStickerPacks.get(me) ?? [];
      if (b.packIds.length !== have.length || b.packIds.some((id) => !have.includes(id))) throw invalid('packIds', 'must list every installed pack once');
      s().userStickerPacks.set(me, [...b.packIds]);
      sendMsg(c.res, 200, MyStickerPacksResponseSchema, this.myPacks(me));
    });
    this.route('PUT', '/api/me/sticker-packs/:id', (c) => {
      const me = this.uid(c);
      const pack = s().stickerPacks.get(c.params[0] ?? '');
      const m = pack ? this.member(pack.workspaceId, me) : undefined;
      if (!pack || !m || m.role === WorkspaceRole.GUEST) throw notFound('sticker pack not found');
      const have = s().userStickerPacks.get(me) ?? [];
      if (!have.includes(pack.id)) {
        if (have.length >= 50) throw invalid('id', 'at most 50 installed sticker packs');
        s().userStickerPacks.set(me, [pack.id, ...have]);
      }
      sendMsg(c.res, 200, MyStickerPacksResponseSchema, this.myPacks(me));
    });
    this.route('DELETE', '/api/me/sticker-packs/:id', (c) => {
      const me = this.uid(c);
      s().userStickerPacks.set(me, (s().userStickerPacks.get(me) ?? []).filter((id) => id !== c.params[0]));
      sendMsg(c.res, 200, MyStickerPacksResponseSchema, this.myPacks(me));
    });

    // ---------------- voice
    // Call status (docs/09 #48): a participant of the call (CONNECT + in the room now) or MANAGE_ROOM.
    this.route('PATCH', '/api/rooms/:id/voice-status', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type !== RoomType.VOICE) throw invalid('id', 'only voice rooms have a call status');
      const b = parseBody(c, UpdateVoiceStatusRequestSchema);
      const status = b.status.trim();
      if (Array.from(status).length > 60) throw invalid('status', 'status must be at most 60 characters');
      if (!has(this.perms(room, me), MANAGE_ROOM)) {
        this.requireRoomPerm(room, me, CONNECT);
        if (s().voiceStates.get(me)?.roomId !== room.id) throw forbidden('join the call to set its status (or MANAGE_ROOM)');
      }
      const before = create(RoomSchema, room);
      room.voiceStatus = status;
      this.emitRoomChange(before, room, { event: { case: 'roomUpdate', value: { room } } });
      sendMsg(c.res, 200, UpdateRoomResponseSchema, { room });
    });
    this.route('POST', '/api/rooms/:id/join', async (c) => {
      const { user, sessionId } = this.auth(c);
      const me = user.user.id;
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type === RoomType.DM) {
        await this.joinCall(c, room, user.user.displayName, sessionId);
        return;
      }
      if (room.type !== RoomType.VOICE) throw conflict('not a voice room');
      this.requireActive(room.workspaceId);
      this.requireRoomPerm(room, me, CONNECT);
      const perms = this.perms(room, me);
      if (s().voiceStates.get(me)?.roomId !== room.id) {
        const inRoom = [...s().voiceStates.values()].filter((v) => v.roomId === room.id).length;
        // The plan's room_members applies to everyone, admins and the owner too (ADR-0024).
        const planMax = this.planLimits(room.workspaceId).roomMembers;
        if (planMax > 0 && inRoom >= planMax) {
          throw new HttpError(409, ErrorCode.ROOM_FULL, 'the room is full (plan limit)', '', { reason: 'PLAN_LIMIT', used: BigInt(inRoom), limit: BigInt(planMax) });
        }
        if (room.userLimit > 0 && !has(perms, MOVE_MEMBERS) && inRoom >= room.userLimit) throw new HttpError(409, ErrorCode.ROOM_FULL, 'the room is full');
      }
      const identity = `${me}:${sessionId}`;
      const token = await this.voiceToken(room, identity, user.user.displayName);
      // Optimistic join (docs/05): the device is recorded as pending at once; a repeated /join
      // of the same device changes nothing. The mock has no LiveKit webhooks: participant_joined
      // is simulated JOIN_CONNECT_MS later.
      this.takeOverVoice(me, sessionId);
      const cur = s().voiceStates.get(me);
      const again = cur?.roomId === room.id && this.voiceSessions.get(me) === sessionId;
      const pending = again ? cur.pending : true;
      if (!again) {
        this.setVoice(me, room.id, { muted: false, deafened: false, streaming: false, camera: false, pending: true });
        this.voiceSessions.set(me, sessionId);
        setTimeout(() => {
          const v = s().voiceStates.get(me);
          if (v?.roomId === room.id && v.pending && this.voiceSessions.get(me) === sessionId) this.setVoice(me, room.id, { pending: false });
        }, JOIN_CONNECT_MS).unref();
      }
      sendMsg(c.res, 200, JoinVoiceResponseSchema, {
        url: this.lk.url,
        token,
        identity,
        media: this.cappedMedia(room),
        planLimits: this.planLimits(room.workspaceId),
        canSpeak: has(perms, SPEAK),
        canStream: has(perms, STREAM),
        canVideo: has(perms, VIDEO) && (room.media ?? DEFAULT_MEDIA).cameraLimit > 0,
        pending,
      });
    });

    // Leave (docs/05): this device's state in the room goes at once, pending or connected.
    this.route('POST', '/api/rooms/:id/voice/leave', (c) => {
      const { user, sessionId } = this.auth(c);
      const me = user.user.id;
      const roomId = c.params[0] ?? '';
      if (s().voiceStates.get(me)?.roomId === roomId && this.voiceSessions.get(me) === sessionId) this.setVoice(me, '', {});
      noContent(c.res);
    });

    // Webcams (docs/05 «Камеры»). No LiveKit webhooks here: the request itself marks the camera
    // on (VoiceState.camera), /camera/stop marks it off.
    this.route('POST', '/api/rooms/:id/camera/request', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type === RoomType.DM) {
        this.requireCall(room.id, me);
        this.setVoice(me, room.id, { camera: true });
        const b = parseBody(c, RequestCameraRequestSchema);
        sendMsg(c.res, 200, RequestCameraResponseSchema, { preset: b.preset || ScreenSharePreset.H720, fps: b.fps });
        return;
      }
      this.requireRoomPerm(room, me, VIDEO);
      if (s().voiceStates.get(me)?.roomId !== room.id) throw conflict('not in this voice room');
      const limit = (room.media ?? DEFAULT_MEDIA).cameraLimit;
      const on = [...s().voiceStates.values()].filter((v) => v.roomId === room.id && v.camera && v.userId !== me).length;
      if (limit === 0 || on >= limit) throw conflict('camera limit reached');
      this.setVoice(me, room.id, { camera: true });
      // The granted quality: min(asked, plan camera_max_*) (ADR-0024); UNSPECIFIED / 0 = no cap.
      const b = parseBody(c, RequestCameraRequestSchema);
      const pl = this.planLimits(room.workspaceId);
      const minNz = (x: number, y: number): number => (x && y ? Math.min(x, y) : x || y);
      sendMsg(c.res, 200, RequestCameraResponseSchema, { preset: minNz(b.preset, pl.cameraMaxPreset), fps: minNz(b.fps, pl.cameraMaxFps) });
    });
    this.route('POST', '/api/rooms/:id/camera/stop', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (s().voiceStates.get(me)?.roomId === room.id) this.setVoice(me, room.id, { camera: false });
      noContent(c.res);
    });

    this.route('POST', '/api/rooms/:id/stream/request', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type === RoomType.DM) {
        this.requireCall(room.id, me);
        const b = parseBody(c, RequestStreamRequestSchema);
        const preset = b.preset === ScreenSharePreset.UNSPECIFIED ? ScreenSharePreset.H1080 : Math.min(b.preset, ScreenSharePreset.H1080);
        const own = Object.entries(SCREEN_SHARE_PRESETS).find(([k]) => Number(k) === preset)?.[1].fps ?? 0;
        sendMsg(c.res, 200, RequestStreamResponseSchema, { preset, fps: b.fps > 0 ? Math.min(b.fps, own) : own });
        return;
      }
      this.requireRoomPerm(room, me, STREAM);
      if (s().voiceStates.get(me)?.roomId !== room.id) throw conflict('not in this voice room');
      const b = parseBody(c, RequestStreamRequestSchema);
      const max = this.cappedMedia(room).maxStreamPreset || ScreenSharePreset.H1080;
      const preset = b.preset === ScreenSharePreset.UNSPECIFIED ? max : Math.min(b.preset, max);
      // fps: min(wanted, the preset's own, the plan's stream_max_fps) (docs/05, ADR-0024).
      const own = Object.entries(SCREEN_SHARE_PRESETS).find(([k]) => Number(k) === preset)?.[1].fps ?? 0;
      const planFps = this.planLimits(room.workspaceId).streamMaxFps;
      const fps = [b.fps, planFps].filter((x) => x > 0).reduce((a, x) => Math.min(a, x), own);
      sendMsg(c.res, 200, RequestStreamResponseSchema, { preset, fps });
    });

    this.route('PATCH', '/api/voice/self', (c) => {
      const me = this.uid(c);
      const v = s().voiceStates.get(me);
      if (!v?.roomId) throw conflict('device is not in voice');
      const b = parseBody(c, UpdateVoiceSelfRequestSchema);
      this.setVoice(me, v.roomId, { ...(b.muted !== undefined ? { muted: b.muted } : {}), ...(b.deafened !== undefined ? { deafened: b.deafened } : {}), ...(b.musician !== undefined ? { musician: b.musician } : {}) });
      noContent(c.res);
    });

    const moderate = (c: Ctx): { room: Room; target: string } => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MUTE_MEMBERS);
      const target = c.params[1] ?? '';
      if (s().voiceStates.get(target)?.roomId !== room.id) throw notFound('user is not in this room');
      return { room, target };
    };
    // MOVE_MEMBERS in both rooms; the target's user_limit applies unless the actor is an admin.
    // App-level move (ADR-0019, open-source LiveKit): the moved device gets a join token for the
    // target room in VOICE_MOVED and reconnects itself; everyone sees VOICE_STATE_UPDATE.
    this.route('POST', '/api/rooms/:id/voice/:userId/move', async (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MOVE_MEMBERS);
      const target = c.params[1] ?? '';
      const b = parseBody(c, MoveMemberRequestSchema);
      const dst = s().rooms.get(b.targetRoomId);
      if (!dst || dst.id === room.id || dst.workspaceId !== room.workspaceId || dst.type !== RoomType.VOICE) {
        throw invalid('targetRoomId', 'target must be another voice room of the same workspace');
      }
      this.requireRoomPerm(dst, me, MOVE_MEMBERS);
      if (s().voiceStates.get(target)?.roomId !== room.id) throw notFound('member in this voice room');
      const actor = this.member(room.workspaceId, me);
      if (dst.userLimit > 0 && !(actor && isAdminRole(actor.role))) {
        const inDst = [...s().voiceStates.values()].filter((v) => v.roomId === dst.id).length;
        if (inDst >= dst.userLimit) throw new HttpError(409, ErrorCode.ROOM_FULL, 'the room is full');
      }
      const base = { workspaceId: room.workspaceId, fromRoomId: room.id, toRoomId: dst.id, byUserId: me };
      // The device that joined through /join. Fixture voice states have none (no client is
      // connected): they get the token-less event, as after an SFU move.
      const sessionId = this.voiceSessions.get(target);
      const identity = sessionId ? `${target}:${sessionId}` : '';
      const token = sessionId ? await this.voiceToken(dst, identity, s().users.get(target)?.user.displayName ?? '') : '';
      const prev = s().voiceStates.get(target);
      if (prev?.roomId !== room.id) throw notFound('member in this voice room'); // left while minting
      // The stream and the camera end with the old connection (the client requests them again;
      // an SFU move without a session keeps them — ADR-0019, review L6).
      this.setVoice(target, dst.id, {
        muted: prev.muted,
        deafened: prev.deafened,
        streaming: sessionId ? false : prev.streaming,
        camera: sessionId ? false : prev.camera,
      });
      // To every device of the user, as the server does; only the one with this session_id acts on it.
      const value = sessionId ? { ...base, url: this.lk.url, token, sessionId, identity } : base;
      this.toUser(target, { event: { case: 'voiceMoved', value } });
      noContent(c.res);
    });

    this.route('POST', '/api/rooms/:id/voice/:userId/mute', (c) => {
      const { room, target } = moderate(c);
      this.setVoice(target, room.id, { muted: true, serverMuted: true });
      noContent(c.res);
    });
    // The moderator lifts the server mute; the user's own mute stays until they unmute.
    this.route('POST', '/api/rooms/:id/voice/:userId/unmute', (c) => {
      const { room, target } = moderate(c);
      this.setVoice(target, room.id, { serverMuted: false });
      noContent(c.res);
    });
    this.route('POST', '/api/rooms/:id/voice/:userId/disconnect', (c) => {
      const { target } = moderate(c);
      this.setVoice(target, '', {});
      noContent(c.res);
    });
    this.route('POST', '/api/rooms/:id/voice/:userId/stop-camera', (c) => {
      const { room, target } = moderate(c);
      if (!s().voiceStates.get(target)?.camera) throw notFound('no camera');
      this.setVoice(target, room.id, { camera: false });
      this.toWorkspace(
        room.workspaceId,
        {
          event: {
            case: 'voiceCameraStop',
            value: { workspaceId: room.workspaceId, roomId: room.id, userId: target, trackSid: '', reason: VoiceStreamStopReason.MODERATOR },
          },
        },
        room.id,
      );
      noContent(c.res);
    });
    this.route('POST', '/api/rooms/:id/voice/:userId/stop-stream', (c) => {
      const { room, target } = moderate(c);
      if (!s().voiceStates.get(target)?.streaming) throw notFound('no streams');
      this.setVoice(target, room.id, { streaming: false });
      this.toWorkspace(
        room.workspaceId,
        {
          event: {
            case: 'voiceStreamStop',
            value: { workspaceId: room.workspaceId, roomId: room.id, userId: target, trackSid: '', reason: VoiceStreamStopReason.MODERATOR },
          },
        },
        room.id,
      );
      noContent(c.res);
    });

    // ---------------- room links (ADR-0016)
    const roomInvite = (code: string): { inv: RoomInvite; room: Room; ws: NonNullable<ReturnType<MockState['workspaces']['get']>> } => {
      const inv = [...s().roomInvites.values()].find((i) => i.code === code);
      const room = inv ? s().rooms.get(inv.roomId) : undefined;
      const ws = inv ? s().workspaces.get(inv.workspaceId) : undefined;
      if (!inv || !room || !ws || (inv.maxUses && inv.uses >= inv.maxUses)) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      return { inv, room, ws };
    };
    this.route('GET', '/api/rooms/:id/invites', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireManage(room, me);
      const invites = [...s().roomInvites.values()].filter((i) => i.roomId === room.id).sort((a, b) => b.id.localeCompare(a.id));
      sendMsg(c.res, 200, ListRoomInvitesResponseSchema, { invites });
    });
    this.route('POST', '/api/rooms/:id/invites', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      this.requireVerified(c);
      const b = parseBody(c, CreateRoomInviteRequestSchema);
      const expiresIn = b.expiresInSeconds ?? 7 * 86400;
      if (expiresIn > 365 * 86400) throw invalid('expiresInSeconds', 'at most 365 days');
      const id = nextId(s(), 'invite');
      const at = tick(s());
      const invite = create(RoomInviteSchema, {
        id,
        roomId: room.id,
        workspaceId: room.workspaceId,
        code: `mock-room-${id.slice(-4)}`,
        createdBy: me,
        maxUses: b.maxUses,
        uses: 0,
        allowGuests: b.allowGuests ?? true,
        allowSpeak: b.allowSpeak ?? true,
        allowMessages: b.allowMessages ?? true,
        allowFiles: b.allowFiles ?? false,
        allowStream: b.allowStream ?? false,
        ...(b.requireApproval !== undefined ? { requireApproval: b.requireApproval } : {}),
        ...(expiresIn ? { expiresAt: timestampFromMs(timestampMs(at) + expiresIn * 1000) } : {}),
        createdAt: at,
      });
      s().roomInvites.set(id, invite);
      sendMsg(c.res, 201, CreateRoomInviteResponseSchema, { invite });
    });
    // ADR-0040: the link's approval setting (inherit_approval = back to the room's).
    this.route('PATCH', '/api/rooms/:id/invites/:inviteId', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const inv = s().roomInvites.get(c.params[1] ?? '');
      if (inv?.roomId !== room.id) throw notFound('invite not found');
      const b = parseBody(c, UpdateRoomInviteRequestSchema);
      if (b.inheritApproval && b.requireApproval !== undefined) throw invalid('requireApproval', 'requireApproval and inheritApproval exclude each other');
      if (!b.inheritApproval && b.requireApproval === undefined) throw invalid('requireApproval', 'nothing to change');
      if (b.inheritApproval) delete inv.requireApproval;
      else inv.requireApproval = b.requireApproval;
      sendMsg(c.res, 200, UpdateRoomInviteResponseSchema, { invite: inv });
    });
    this.route('DELETE', '/api/rooms/:id/invites/:inviteId', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const inv = s().roomInvites.get(c.params[1] ?? '');
      if (inv?.roomId !== room.id) throw notFound('invite not found');
      s().roomInvites.delete(inv.id);
      noContent(c.res);
    });
    // Public preview for the /r/<code> page (no auth).
    this.route('GET', '/api/room-invites/:code', (c) => {
      const { inv, room, ws } = roomInvite(c.params[0] ?? '');
      sendMsg(c.res, 200, GetRoomInviteResponseSchema, {
        roomName: room.name,
        roomType: room.type,
        workspaceName: ws.name,
        workspaceIconFileId: ws.iconFileId,
        allowGuests: inv.allowGuests,
        ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}),
        requiresApproval: requiresApproval(room.guestApproval, inv.requireApproval),
      });
    });
    // With a bearer: join as the current user; without one (allow_guests): a guest account.
    this.route('POST', '/api/room-invites/:code/join', (c) => {
      const { inv, room, ws } = roomInvite(c.params[0] ?? '');
      const b = parseBody(c, JoinRoomInviteRequestSchema);
      if ((c.req.headers.authorization ?? '').startsWith('Bearer ')) {
        const admission = this.joinByLink(inv, this.uid(c));
        sendMsg(c.res, 200, JoinRoomInviteResponseSchema, { roomId: room.id, workspaceId: ws.id, ...(admission ? { admission } : {}) });
        return;
      }
      if (!inv.allowGuests) throw new HttpError(401, ErrorCode.UNAUTHENTICATED, 'sign in to use this link');
      const name = b.nickname.trim();
      if (!name || Array.from(name).length > 64) throw invalid('nickname', 'name must be 1..64 characters');
      const id = nextId(s(), 'user');
      const at = tick(s());
      const rec: UserRec = {
        user: create(UserSchema, { id, displayName: name, avatarFileId: '', statusText: '', createdAt: at, isGuest: true }),
        email: '',
        password: '',
        settings: defaultSettings(),
        emailVerified: true,
        pendingEmail: '',
        locale: '',
      };
      s().users.set(id, rec);
      s().presences.set(id, create(PresenceSchema, { userId: id, status: PresenceStatus.ONLINE, lastSeen: at }));
      const sessionId = nextId(s(), 'session');
      s().sessions.set(id, [
        create(SessionSchema, { id: sessionId, deviceName: b.deviceName || 'Guest', ip: '192.0.2.10', userAgent: 'mock', createdAt: at, lastSeenAt: at, expiresAt: FAR_FUTURE }),
      ]);
      const admission = this.joinByLink(inv, id);
      sendMsg(c.res, 201, JoinRoomInviteResponseSchema, {
        roomId: room.id,
        workspaceId: ws.id,
        tokens: this.tokensJson(c, sessionId),
        me: this.me(rec),
        ...(admission ? { admission } : {}),
      });
    });

    // ---------------- mock control (tests; no auth)
    const ctl = (c: Ctx): Record<string, unknown> => (c.raw.length ? (JSON.parse(c.raw.toString('utf8')) as Record<string, unknown>) : {});
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

    // ---------------- superadmin (ADR-0024, docs/05 «Тарифы»): 404 for everyone else
    this.route('GET', '/api/admin/workspaces', (c) => {
      this.requireSuperadmin(c);
      const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
      const all = [...s().workspaces.values()].filter((w) => {
        if (!q) return true;
        const email = s().users.get(w.ownerId)?.email ?? '';
        return [w.name, w.slug, email].some((x) => x.toLowerCase().includes(q));
      });
      // Newest first, at most 50 (like the server).
      all.sort((a, b) => (b.createdAt ? timestampMs(b.createdAt) : 0) - (a.createdAt ? timestampMs(a.createdAt) : 0));
      sendMsg(c.res, 200, AdminSearchWorkspacesResponseSchema, { workspaces: all.slice(0, 50).map((w) => this.adminOut(w)) });
    });
    this.route('GET', '/api/admin/workspaces/:id', (c) => {
      this.requireSuperadmin(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws) throw notFound('workspace not found');
      sendMsg(c.res, 200, AdminGetWorkspaceResponseSchema, { workspace: this.adminOut(ws) });
    });
    this.route('PUT', '/api/admin/workspaces/:id/plan', (c) => {
      const me = this.requireSuperadmin(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws) throw notFound('workspace not found');
      const b = parseBody(c, AdminSetPlanRequestSchema);
      if (b.plan !== Plan.FREE && b.plan !== Plan.TEAM && b.plan !== Plan.ENTERPRISE && b.plan !== Plan.CUSTOM) throw invalid('plan', 'plan must be FREE, TEAM, ENTERPRISE or CUSTOM');
      if (b.plan !== Plan.CUSTOM && b.limits) throw invalid('limits', 'limits only with CUSTOM');
      if (b.note.length > 500) throw invalid('note', 'note at most 500 characters');
      const now = tick(s());
      if (b.validUntil && timestampMs(b.validUntil) <= timestampMs(now)) throw invalid('validUntil', 'valid_until must be in the future');
      const limits =
        b.plan === Plan.CUSTOM
          ? create(PlanLimitsSchema, b.limits ?? {})
          : b.plan === Plan.TEAM
            ? TEAM_PLAN_LIMITS
            : b.plan === Plan.ENTERPRISE
              ? ENTERPRISE_PLAN_LIMITS
              : FREE_PLAN_LIMITS;
      // ADR-0086: a custom plan's name and description (trimmed, CUSTOM only, like the server).
      if (b.plan !== Plan.CUSTOM && (b.displayName.trim() || b.description.trim())) throw invalid('displayName', 'a name and description are only set for PLAN_CUSTOM');
      const displayName = b.plan === Plan.CUSTOM ? b.displayName.replace(/\s+/g, ' ').trim() : '';
      const description = b.plan === Plan.CUSTOM ? b.description.replace(/\s+/g, ' ').trim() : '';
      if (Array.from(displayName).length > 40) throw invalid('displayName', 'the plan name must be at most 40 characters');
      if (Array.from(description).length > 140) throw invalid('description', 'the plan description must be at most 140 characters');
      ws.plan = create(WorkspacePlanSchema, { plan: b.plan, limits, ...(b.validUntil ? { validUntil: b.validUntil } : {}), expired: false, displayName, description });
      s().planMeta.set(ws.id, { note: b.note, updatedBy: me, updatedAt: now });
      const log = s().planLog.get(ws.id) ?? [];
      log.unshift(
        create(PlanLogEntrySchema, {
          id: `${ws.id}-log-${log.length + 1}`,
          workspaceId: ws.id,
          actorId: me,
          actorEmail: s().users.get(me)?.email ?? '',
          plan: b.plan,
          limits,
          ...(b.validUntil ? { validUntil: b.validUntil } : {}),
          note: b.note,
          createdAt: now,
          displayName,
          description,
        }),
      );
      s().planLog.set(ws.id, log.slice(0, 100));
      this.toWorkspace(ws.id, { event: { case: 'workspaceUpdate', value: { workspace: ws } } });
      sendMsg(c.res, 200, AdminSetPlanResponseSchema, { workspace: this.adminOut(ws) });
    });
    this.route('PUT', '/api/admin/workspaces/:id/suspension', (c) => {
      const me = this.requireSuperadmin(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws) throw notFound('workspace not found');
      const b = parseBody(c, AdminSetSuspensionRequestSchema);
      const reason = b.reason.trim();
      if (b.suspended) {
        if (!reason) throw invalid('reason', 'a reason is required to suspend a workspace');
        if (reason.length > 500) throw invalid('reason', 'reason must be at most 500 characters');
        ws.suspension = create(WorkspaceSuspensionSchema, { at: ws.suspension?.at ?? tick(s()), reason });
        s().suspendedBy.set(ws.id, me);
        // Calls end (the server removes every LiveKit participant).
        for (const [uid, v] of s().voiceStates) if (v.workspaceId === ws.id && v.roomId) this.setVoice(uid, '', {});
      } else {
        delete ws.suspension;
        s().suspendedBy.delete(ws.id);
      }
      this.toWorkspace(ws.id, { event: { case: 'workspaceUpdate', value: { workspace: ws } } });
      sendMsg(c.res, 200, AdminSetSuspensionResponseSchema, { workspace: this.adminOut(ws) });
    });
    this.route('GET', '/api/admin/workspaces/:id/plan/log', (c) => {
      this.requireSuperadmin(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws) throw notFound('workspace not found');
      sendMsg(c.res, 200, AdminPlanLogResponseSchema, { entries: s().planLog.get(ws.id) ?? [] });
    });

    this.route('GET', '/__mock/ids', (c) => send(c.res, 200, JSON.stringify(IDS), 'application/json'));
    this.route('POST', '/__mock/email', (c) => {
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { userId?: string; verified?: boolean; pendingEmail?: string };
      this.setEmailState(b.userId ?? IDS.users.anna, { verified: b.verified ?? false, ...(b.pendingEmail ? { pendingEmail: b.pendingEmail } : {}) });
      noContent(c.res);
    });
    /**
     * Invitations as the e2e needs them (docs/09 #36): `{email}` → an emailed invitation of anna's
     * workspace (the «mail» with the code is not sent anywhere: the code comes back here); no email
     * → a plain link. Answers `{code}`.
     */
    this.route('POST', '/__mock/invite', (c) => {
      const b = ctl(c);
      const email = str(b['email']).trim().toLowerCase();
      const wsId = str(b['workspaceId']) || IDS.workspaces.main;
      const id = nextId(s(), 'invite');
      const at = tick(s());
      if (email) {
        const code = `mock-mail-${id.slice(-4)}`;
        s().emailInvites.set(id, {
          id,
          workspaceId: wsId,
          email,
          role: WorkspaceRole.MEMBER,
          invitedBy: IDS.users.anna,
          code,
          createdAt: at,
          expiresAt: timestampFromMs(timestampMs(at) + 7 * 86400_000),
          lastSentAt: at,
          lastSentMs: Date.now(),
        });
        send(c.res, 201, JSON.stringify({ code }), 'application/json');
        return;
      }
      const code = `mock-invite-${id.slice(-4)}`;
      s().invites.set(id, create(InviteSchema, { id, workspaceId: wsId, code, createdBy: IDS.users.anna, maxUses: 0, uses: 0, createdAt: at }));
      send(c.res, 201, JSON.stringify({ code }), 'application/json');
    });
    this.route('POST', '/__mock/reset', (c) => {
      const scenario = str(ctl(c)['scenario']);
      this.reset(SCENARIOS.find((x) => x === scenario) ?? s().scenario);
      noContent(c.res);
    });
    this.route('POST', '/__mock/message', (c) => {
      const b = ctl(c);
      const msg = this.injectMessage({ roomId: str(b['roomId']), authorId: str(b['authorId']), content: str(b['content']), replyToId: str(b['replyToId']) });
      send(c.res, 201, JSON.stringify(toJson(MessageSchema, msg, JSON_WRITE)), 'application/json');
    });
    this.route('POST', '/__mock/read', (c) => {
      const b = ctl(c);
      this.markRead(str(b['userId']), str(b['roomId']), str(b['messageId']));
      noContent(c.res);
    });
    this.route('POST', '/__mock/dispatch', (c) => {
      const ev = fromJson(DispatchEventSchema, JSON.parse(c.raw.toString('utf8')) as JsonValue, JSON_READ);
      this.broadcast(ev);
      noContent(c.res);
    });
    this.route('POST', '/__mock/voice', (c) => {
      const b = ctl(c);
      const muted = bool(b['muted']);
      const deafened = bool(b['deafened']);
      const streaming = bool(b['streaming']);
      const pending = bool(b['pending']);
      this.setVoice(str(b['userId']), str(b['roomId']), {
        ...(pending !== undefined ? { pending } : {}),
        ...(muted !== undefined ? { muted } : {}),
        ...(deafened !== undefined ? { deafened } : {}),
        ...(streaming !== undefined ? { streaming } : {}),
      });
      noContent(c.res);
    });
    // docs/09 #71: a gateway outage of `downMs` (dropGateway) and the voice states as the server holds them.
    this.route('POST', '/__mock/gateway/drop', (c) => {
      this.dropGateway(Number(ctl(c)['downMs'] ?? 0));
      noContent(c.res);
    });
    this.route('GET', '/__mock/voice', (c) => {
      const out: Record<string, { roomId: string; pending: boolean }> = {};
      for (const [userId, v] of s().voiceStates) out[userId] = { roomId: v.roomId, pending: v.pending };
      send(c.res, 200, JSON.stringify(out), 'application/json');
    });
    this.route('POST', '/__mock/presence', (c) => {
      const b = ctl(c);
      const key = str(b['status']).replace(/^PRESENCE_STATUS_/, '');
      if (!(key in PresenceStatus) || /^\d+$/.test(key)) throw invalid('status', 'unknown status');
      this.setPresence(str(b['userId']), PresenceStatus[key as keyof typeof PresenceStatus]);
      noContent(c.res);
    });
    this.route('POST', '/__mock/typing', (c) => {
      const b = ctl(c);
      const roomId = str(b['roomId']);
      const ev = create(DispatchEventSchema, {
        event: { case: 'typingStart', value: { roomId, userId: str(b['userId']), timestamp: timestampFromMs(Date.now()) } },
      });
      for (const conn of this.conns) if (conn.userId && conn.subscribed.has(roomId)) this.sendDispatch(conn, ev);
      noContent(c.res);
    });
  }

  // ------------------------------------------------ shared mutations

  // ------------------------------------------------ email (ADR-0023)

  /** 403 EMAIL_NOT_VERIFIED for an unverified (non-guest) caller. */
  private requireVerified(c: Ctx): void {
    const u = this.auth(c).user;
    if (!u.user.isGuest && !u.emailVerified) throw notVerified();
  }

  private emailInviteByCode(code: string): EmailInviteRec | undefined {
    return [...this.state.emailInvites.values()].find((i) => i.code === code);
  }

  /**
   * A confirmed address accepts every pending invitation to it (WORKSPACE_CREATE per workspace);
   * returns the joined workspaces (VerifyEmailResponse.joined_workspace_ids).
   */
  private acceptEmailInvites(u: UserRec): string[] {
    const joined: string[] = [];
    for (const inv of [...this.state.emailInvites.values()]) {
      if (inv.email !== u.email || inv.accepted) continue;
      inv.accepted = true;
      if (this.member(inv.workspaceId, u.user.id) || !this.state.workspaces.has(inv.workspaceId)) continue;
      const m = this.joinWorkspace(inv.workspaceId, u.user.id);
      m.role = inv.role;
      joined.push(inv.workspaceId);
    }
    return joined;
  }

  setEmailState(userId: string, st: { verified: boolean; pendingEmail?: string }): void {
    const u = this.state.users.get(userId);
    if (!u) throw notFound('user not found');
    u.emailVerified = st.verified;
    u.pendingEmail = st.pendingEmail ?? '';
    if (!st.verified || u.pendingEmail) this.state.emailCodes.set(`verify:${userId}`, { attempts: 0, sentAtMs: Date.now() });
    else this.state.emailCodes.delete(`verify:${userId}`);
    this.emitUserUpdate(u);
  }

  /**
   * Checks a code like the server: the attempt is spent first; wrong → CODE_INVALID with the
   * attempts left, none left / no code → CODE_EXPIRED. `reset` answers CODE_INVALID for both.
   */
  private checkCode(key: string, code: string, reset = false): void {
    const rec = this.state.emailCodes.get(key);
    if (!rec) throw new HttpError(422, reset ? ErrorCode.CODE_INVALID : ErrorCode.CODE_EXPIRED, reset ? 'wrong or expired code' : 'no active code');
    rec.attempts += 1;
    if (code.trim() === MOCK_EMAIL_CODE) {
      this.state.emailCodes.delete(key);
      return;
    }
    const left = CODE_ATTEMPTS - rec.attempts;
    if (left <= 0) this.state.emailCodes.delete(key);
    if (reset) throw new HttpError(422, ErrorCode.CODE_INVALID, 'wrong or expired code');
    if (left <= 0) throw new HttpError(422, ErrorCode.CODE_EXPIRED, 'no active code');
    throw new HttpError(422, ErrorCode.CODE_INVALID, `wrong code, ${left} attempt(s) left`);
  }

  private emailInviteOut(i: EmailInviteRec): MessageInitShape<typeof EmailInviteSchema> {
    return {
      id: i.id,
      workspaceId: i.workspaceId,
      email: i.email,
      role: i.role,
      invitedBy: i.invitedBy,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      lastSentAt: i.lastSentAt,
    };
  }

  /** MANAGE_WORKSPACE (admins) + a verified caller, in the path workspace. */
  private inviter(c: Ctx): { wsId: string; m: MemberRec; me: UserRec } {
    const me = this.auth(c).user;
    const { ws, m } = this.workspaceFor(c.params[0] ?? '', me.user.id);
    this.requireAdmin(m);
    this.requireVerified(c);
    return { wsId: ws.id, m, me };
  }

  // ------------------------------------------------ telephony (ADR-0046, mock-sip.ts)

  private sipSettingsOf(wsId: string): SipSettings {
    return this.state.sipSettings.get(wsId) ?? defaultSipSettings();
  }

  /** Workspace.sip_enabled follows the account (enabled + trunk saved) → WORKSPACE_UPDATE. */
  private syncSipEnabled(wsId: string): void {
    const ws = this.state.workspaces.get(wsId);
    if (!ws) return;
    const s = this.state.sipSettings.get(wsId);
    const on = !!s && s.enabled && s.trunkSaved;
    if (ws.sipEnabled === on) return;
    ws.sipEnabled = on;
    this.toWorkspace(ws.id, { event: { case: 'workspaceUpdate', value: { workspace: ws } } });
    // Telephony off lays down the live lines of the workspace (reason «disabled»).
    if (!on) for (const c of this.state.sipCalls.values()) if (c.workspaceId === wsId && isLiveSipStatus(c.status)) this.setSipCallStatus(c.id, SipCallStatus.ENDED, 'disabled');
  }

  setSip(workspaceId: string, patch: { enabled?: boolean; host?: string; callerId?: string; allowedPrefixes?: string[]; lastError?: string; hasPassword?: boolean } | null): void {
    if (!this.state.workspaces.get(workspaceId)) throw notFound('workspace not found');
    if (!patch) {
      this.state.sipSettings.delete(workspaceId);
      this.state.sipPasswords.delete(workspaceId);
    } else {
      const enabled = patch.enabled ?? true;
      this.state.sipSettings.set(
        workspaceId,
        create(SipSettingsSchema, {
          ...this.sipSettingsOf(workspaceId),
          enabled,
          provider: 'Zadarma',
          host: patch.host ?? 'sip.zadarma.com',
          username: '100200',
          hasPassword: patch.hasPassword ?? true,
          callerId: patch.callerId ?? '+74951234567',
          outboundPrefix: '+',
          allowedPrefixes: patch.allowedPrefixes ?? ['+7'],
          lastError: patch.lastError ?? '',
          trunkSaved: enabled,
          updatedAt: tick(this.state),
        }),
      );
    }
    this.syncSipEnabled(workspaceId);
  }

  private announceSipCall(c: SipCall): void {
    if (c.roomId) this.toWorkspace(c.workspaceId, { event: { case: 'sipCallUpdate', value: { call: c } } }, c.roomId);
  }

  placeSipCall(roomId: string, byUserId: string, number: string, status = SipCallStatus.DIALING, answeredAgoMs?: number): string {
    const room = this.state.rooms.get(roomId);
    if (!room) throw notFound('room not found');
    const id = nextId(this.state, 'file');
    const c = create(SipCallSchema, {
      id,
      workspaceId: room.workspaceId,
      roomId,
      number: normalizeCallee(number) ?? number,
      direction: SipCallDirection.OUT,
      startedBy: byUserId,
      status,
      startedAt: timestampFromMs(Date.now() - (answeredAgoMs ?? 0) - 5000),
      participantIdentity: `sip:${id}`,
      ...(status === SipCallStatus.ACTIVE ? { answeredAt: timestampFromMs(Date.now() - (answeredAgoMs ?? 0)) } : {}),
    });
    this.state.sipCalls.set(id, c);
    this.announceSipCall(c);
    return id;
  }

  setSipCallStatus(callId: string, status: SipCallStatus, reason = ''): void {
    const c = this.state.sipCalls.get(callId);
    if (!c) throw notFound('call not found');
    c.status = status;
    if (status === SipCallStatus.ACTIVE && !c.answeredAt) c.answeredAt = timestampFromMs(Date.now());
    if (!isLiveSipStatus(status)) {
      c.reason = reason || (status === SipCallStatus.FAILED ? 'no_answer' : 'remote');
      c.endedAt = timestampFromMs(Date.now());
    }
    this.announceSipCall(c);
  }

  private sipAdmin(c: Ctx): { wsId: string; me: string } {
    const me = this.uid(c);
    const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
    this.requireAdmin(m);
    return { wsId: ws.id, me };
  }

  private sipRoutes(): void {
    this.route('GET', '/api/workspaces/:id/sip', (c) => {
      const { wsId } = this.sipAdmin(c);
      sendMsg(c.res, 200, GetSipSettingsResponseSchema, { settings: this.sipSettingsOf(wsId) });
    });

    this.route('PUT', '/api/workspaces/:id/sip', (c) => {
      const { wsId, me } = this.sipAdmin(c);
      const b = parseBody(c, PutSipSettingsRequestSchema);
      const err = sipSettingsError(b);
      if (err) throw invalid(err.field, err.message);
      const cur = this.sipSettingsOf(wsId);
      if (b.enabled && b.host === MOCK_SIP_REFUSED_HOST) {
        const msg = 'twirp error unknown: sip trunk: address rejected';
        this.state.sipSettings.set(wsId, create(SipSettingsSchema, { ...cur, lastError: msg }));
        throw new HttpError(502, ErrorCode.SIP_PROVIDER_ERROR, msg);
      }
      if (b.password !== undefined) {
        if (b.password) this.state.sipPasswords.set(wsId, b.password);
        else this.state.sipPasswords.delete(wsId);
      }
      this.state.sipSettings.set(
        wsId,
        create(SipSettingsSchema, {
          enabled: b.enabled,
          provider: b.provider,
          host: b.host,
          transport: b.transport || SipTransport.UDP,
          username: b.username,
          authUsername: b.authUsername,
          port: b.port || 5060,
          hasPassword: this.state.sipPasswords.has(wsId) || (b.password === undefined && cur.hasPassword),
          callerId: b.callerId ? (normalizeCallee(b.callerId) ?? b.callerId) : '',
          outboundPrefix: b.outboundPrefix,
          allowedPrefixes: b.allowedPrefixes,
          lastError: '',
          updatedAt: tick(this.state),
          updatedBy: me,
          trunkSaved: b.enabled,
        }),
      );
      this.syncSipEnabled(wsId);
      sendMsg(c.res, 200, PutSipSettingsResponseSchema, { settings: this.sipSettingsOf(wsId) });
    });

    this.route('POST', '/api/workspaces/:id/sip/test', (c) => {
      const { wsId, me } = this.sipAdmin(c);
      const s = this.sipSettingsOf(wsId);
      if (!s.enabled || !s.trunkSaved) throw new HttpError(409, ErrorCode.SIP_DISABLED, 'telephony is off');
      const ok = s.host !== MOCK_SIP_UNREACHABLE_HOST;
      const id = nextId(this.state, 'file');
      const now = Date.now();
      this.state.sipCalls.set(
        id,
        create(SipCallSchema, {
          id,
          workspaceId: wsId,
          number: s.callerId,
          direction: SipCallDirection.OUT,
          startedBy: me,
          status: ok ? SipCallStatus.ENDED : SipCallStatus.FAILED,
          reason: ok ? 'hangup' : 'unavailable',
          startedAt: timestampFromMs(now - 8000),
          ...(ok ? { answeredAt: timestampFromMs(now - 5000) } : {}),
          endedAt: timestampFromMs(now),
          participantIdentity: `sip:${id}`,
        }),
      );
      const message = ok ? 'answered' : 'no answer from the provider';
      this.state.sipSettings.set(wsId, create(SipSettingsSchema, { ...s, lastError: ok ? '' : message }));
      sendMsg(c.res, 200, TestSipResponseSchema, { ok, message, sipStatus: 0 });
    });

    this.route('GET', '/api/workspaces/:id/calls', (c) => {
      const { wsId } = this.sipAdmin(c);
      const all = [...this.state.sipCalls.values()].filter((x) => x.workspaceId === wsId).reverse();
      const cursor = Number(c.url.searchParams.get('cursor') || '0');
      const page = all.slice(cursor, cursor + 100);
      const next = cursor + 100 < all.length ? String(cursor + 100) : '';
      sendMsg(c.res, 200, ListSipCallsResponseSchema, { calls: page, nextCursor: next });
    });

    this.route('POST', '/api/rooms/:id/calls', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type === RoomType.DM || room.type === RoomType.NOTES) throw notFound('room not found');
      const m = this.member(room.workspaceId, me);
      if (!m || m.role === WorkspaceRole.GUEST) throw forbidden('guests cannot place calls');
      this.requireRoomPerm(room, me, PERMISSION_BITS.PLACE_CALLS | CONNECT);
      if (room.type !== RoomType.VOICE) throw invalid('id', 'not a voice room');
      const number = normalizeCallee(parseBody(c, PlaceSipCallRequestSchema).number);
      if (!number) throw invalid('number', 'not a phone number');
      const s = this.sipSettingsOf(room.workspaceId);
      if (!s.enabled || !s.trunkSaved) throw new HttpError(409, ErrorCode.SIP_DISABLED, 'telephony is off');
      if (this.state.voiceStates.get(me)?.roomId !== room.id) throw conflict('join the call first');
      if ([...this.state.sipCalls.values()].some((x) => x.roomId === room.id && isLiveSipStatus(x.status))) throw new HttpError(409, ErrorCode.SIP_CALL_ACTIVE, 'a call is already active in this room');
      if (!numberAllowed(number, s.allowedPrefixes)) throw new HttpError(422, ErrorCode.SIP_NUMBER_NOT_ALLOWED, 'the number is not in the allowed prefixes', 'number');
      if (number === MOCK_SIP_RATE_NUMBER) throw new HttpError(429, ErrorCode.SIP_RATE_LIMITED, 'too many calls', '', {}, { 'Retry-After': '600' });
      const id = this.placeSipCall(room.id, me, number);
      sendMsg(c.res, 201, SipCallResponseSchema, { call: this.state.sipCalls.get(id) });
    });

    this.route('DELETE', '/api/rooms/:id/calls/:cid', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const call = this.state.sipCalls.get(c.params[1] ?? '');
      if (!call || call.roomId !== room.id) throw notFound('call not found');
      const moderator = has(this.perms(room, me), MUTE_MEMBERS);
      if (call.startedBy !== me && !moderator) throw forbidden('not your call');
      if (!isLiveSipStatus(call.status)) throw conflict('the call has ended');
      const answered = call.status === SipCallStatus.ACTIVE;
      call.endedBy = me;
      this.setSipCallStatus(call.id, SipCallStatus.ENDED, !answered ? 'cancelled' : call.startedBy === me ? 'hangup' : 'hangup_moderator');
      sendMsg(c.res, 200, SipCallResponseSchema, { call });
    });
  }

  // ------------------------------------------------ meeting recording (ADR-0025)

  private announceRecording(rec: RoomRecording): void {
    this.toWorkspace(rec.workspaceId, { event: { case: 'roomRecording', value: rec } }, rec.roomId);
  }

  setRecording(roomId: string, rec: { byUserId: string; agoMs?: number; nowMs?: number } | null): void {
    const room = this.state.rooms.get(roomId);
    if (!room) throw notFound('room not found');
    if (!rec) {
      if (this.state.recordings.has(roomId)) this.stopRecording(room, 'user', '', false);
      return;
    }
    const r = create(RoomRecordingSchema, {
      workspaceId: room.workspaceId,
      roomId,
      recordingId: nextId(this.state, 'file'),
      state: RoomRecordingState.ACTIVE,
      byUserId: rec.byUserId,
      since: timestampFromMs((rec.nowMs ?? Date.now()) - (rec.agoMs ?? 0)),
    });
    this.state.recordings.set(roomId, r);
    this.announceRecording(r);
  }

  /**
   * Full files (GET /api/files/:id, not thumbnails) wait until releaseFiles() or reset(): the
   * lightbox's loading state (thumbnail + spinner) for a screenshot.
   */
  dropGateway(downMs: number): void {
    this.gatewayDownUntil = Date.now() + downMs;
    for (const c of this.conns) {
      if (c.gatewaySessionId) this.droppedSessions.add(c.gatewaySessionId);
      c.ws.terminate();
    }
    this.conns.clear();
  }

  holdFiles(): void {
    if (this.fileGate) return;
    let release = (): void => undefined;
    const done = new Promise<void>((r) => (release = r));
    this.fileGate = { done, release };
  }

  releaseFiles(): void {
    this.fileGate?.release();
    this.fileGate = null;
  }

  setGptunnel(workspaceId: string, pairedBy: string | null): void {
    const ws = this.state.workspaces.get(workspaceId);
    if (!ws) throw notFound('workspace not found');
    if (!pairedBy) {
      this.state.gptunnel.delete(workspaceId);
      return;
    }
    this.state.gptunnel.set(
      workspaceId,
      create(GptunnelIntegrationSchema, {
        paired: true,
        deviceName: `Calab · ${ws.name}`,
        account: this.state.users.get(pairedBy)?.email ?? '',
        pairedBy,
        pairedAt: tick(this.state),
        webUrl: MOCK_GPTUNNEL_WEB,
      }),
    );
  }

  /** Stops a room's recording: ROOM_RECORDING STOPPED and (unless `card` is false) the chat card. */
  private stopRecording(room: Room, reason: string, stoppedBy: string, card = true): RoomRecording {
    const cur = this.state.recordings.get(room.id);
    if (!cur) throw notFound('recording of this room');
    this.state.recordings.delete(room.id);
    const stopped = create(RoomRecordingSchema, { ...cur, state: RoomRecordingState.STOPPED, stopReason: reason, stoppedBy });
    this.announceRecording(stopped);
    if (card) {
      const durationSec = Math.max(0, Math.round((Date.now() - (cur.since ? timestampMs(cur.since) : Date.now())) / 1000));
      const msg = this.injectRecordingCard({ roomId: room.id, byUserId: cur.byUserId, durationSec, status: RecordingStatus.UPLOADING, recordingId: cur.recordingId });
      // The upload worker's steps: UPLOADING → PROCESSING (a page) → DONE.
      if (RECORDING_STEP_MS > 0) {
        const web = `${MOCK_GPTUNNEL_WEB}/meetings/${cur.recordingId}`;
        this.later(RECORDING_STEP_MS, () => this.updateRecordingCard(msg.id, { status: RecordingStatus.PROCESSING, webUrl: web }));
        this.later(RECORDING_STEP_MS * 2, () => this.updateRecordingCard(msg.id, { status: RecordingStatus.DONE, webUrl: web, result: true }));
      }
    }
    return stopped;
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (e) {
        this.log(`recording timer: ${String(e)}`);
      }
    }, ms);
    this.timers.add(timer);
  }

  private clockMs: number | null = null;

  // ------------------------------------------------ temporary rooms (ADR-0044)

  /** Archived temporary rooms (not in `state.rooms`): their history stays readable. */
  private readonly archivedRooms = new Map<string, Room>();

  /** The room and its link, as the server's one transaction; ROOM_CREATE to whoever sees it. */
  private createTempRoom(a: { workspaceId: string; name: string; createdBy: string; expiresAtMs: number; isPrivate: boolean; memberIds: readonly string[]; guests: boolean }): { room: Room; invite: RoomInvite } {
    const s = this.state;
    const ws = s.workspaces.get(a.workspaceId);
    const positions = [...s.rooms.values()].filter((r) => r.workspaceId === a.workspaceId).map((r) => r.position);
    const mediaOverride = create(RoomMediaOverrideSchema, {});
    const bits = VIEW_ROOM | PERMISSION_BITS.CONNECT | PERMISSION_BITS.SPEAK | PERMISSION_BITS.VIDEO | PERMISSION_BITS.STREAM | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.ATTACH_FILES;
    const expiresAt = timestampFromMs(a.expiresAtMs);
    const room = create(RoomSchema, {
      id: nextId(s, 'room'),
      workspaceId: a.workspaceId,
      type: RoomType.VOICE,
      name: a.name,
      position: positions.length ? Math.max(...positions) + 1 : 0,
      isPrivate: a.isPrivate,
      media: effectiveMedia(ws, mediaOverride),
      mediaOverride,
      permissionOverrides: a.isPrivate
        ? [
            create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_ROOM }),
            ...[a.createdBy, ...a.memberIds.filter((id) => id !== a.createdBy)].map((id) =>
              create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: id, allow: bits, deny: 0n }),
            ),
          ]
        : [],
      createdAt: tick(s),
      allowRecording: true,
      createdBy: a.createdBy,
      expiresAt,
    });
    s.rooms.set(room.id, room);
    this.toWorkspace(a.workspaceId, { event: { case: 'roomCreate', value: { room } } }, room.id);
    const id = nextId(s, 'invite');
    const invite = create(RoomInviteSchema, {
      id,
      roomId: room.id,
      workspaceId: a.workspaceId,
      code: `mock-temp-${id.slice(-4)}`,
      createdBy: a.createdBy,
      allowGuests: a.guests,
      membersOnly: !a.guests,
      allowSpeak: true,
      allowMessages: true,
      allowFiles: true,
      allowStream: true,
      expiresAt,
      createdAt: room.createdAt,
    });
    s.roomInvites.set(id, invite);
    return { room, invite };
  }

  addTempRoom(a: { workspaceId: string; name: string; expiresAtMs: number; createdBy?: string; isPrivate?: boolean; guests?: boolean }): Room {
    return this.createTempRoom({ workspaceId: a.workspaceId, name: a.name, createdBy: a.createdBy ?? IDS.users.anna, expiresAtMs: a.expiresAtMs, isPrivate: a.isPrivate ?? false, memberIds: [], guests: a.guests ?? true }).room;
  }

  /** Closing (DELETE or expiry): archived, links revoked, voice emptied, ROOM_DELETE to whoever saw it. */
  private archiveTempRoom(room: Room): void {
    const s = this.state;
    for (const v of [...s.voiceStates.values()]) if (v.roomId === room.id) this.setVoice(v.userId, '', {});
    this.toWorkspace(room.workspaceId, { event: { case: 'roomDelete', value: { workspaceId: room.workspaceId, roomId: room.id } } }, room.id);
    for (const [id, inv] of s.roomInvites) if (inv.roomId === room.id) s.roomInvites.delete(id);
    s.rooms.delete(room.id);
    room.archivedAt = timestampFromMs(this.calNow());
    room.messageCount = (s.messages.get(room.id) ?? []).length;
    this.archivedRooms.set(room.id, room);
  }

  expireTempRooms(nowMs?: number): string[] {
    const now = nowMs ?? this.calNow();
    const due = [...this.state.rooms.values()].filter((r) => r.expiresAt && timestampMs(r.expiresAt) <= now);
    for (const r of due) this.archiveTempRoom(r);
    return due.map((r) => r.id);
  }

  setClock(nowMs: number | null): void {
    this.clockMs = nowMs;
  }

  setBirthdayHidden(userId: string, hidden: boolean): void {
    const u = this.userRec(userId);
    u.birthdayHidden = hidden;
    this.emitUserUpdate(u);
  }

  setBirthday(userId: string, b: { day: number; month: number; year?: number } | null, card?: { roomId: string }): void {
    const u = this.userRec(userId);
    if (b) u.user.birthday = create(BirthdaySchema, b);
    else delete u.user.birthday;
    this.emitUserUpdate(u);
    if (!b || !card) return;
    const room = this.state.rooms.get(card.roomId);
    if (!room) throw notFound('room not found');
    const list = this.state.messages.get(room.id) ?? [];
    const msg = create(MessageSchema, {
      id: nextId(this.state, 'message'),
      roomId: room.id,
      authorId: userId,
      content: '',
      kind: MessageKind.SYSTEM,
      system: { payload: { case: 'birthday', value: { day: b.day, month: b.month } } },
      createdAt: tick(this.state),
    });
    list.push(msg);
    this.state.messages.set(room.id, list);
    this.toWorkspace(room.workspaceId, { event: { case: 'messageCreate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
  }

  injectRecordingCard(a: {
    roomId: string;
    byUserId: string;
    durationSec: number;
    status: RecordingStatus;
    error?: string;
    webUrl?: string;
    recordingId?: string;
    notUploaded?: boolean;
    fileGone?: boolean;
    /** DONE with the result (docs/09 #47): summary, transcript, audio attachment. */
    result?: boolean;
    /** A forwarded copy of the card (ADR-0033): posted by `authorId`, marked «Переслано от». */
    forward?: MockForward & { by: string };
  }): Message {
    const room = this.state.rooms.get(a.roomId);
    if (!room) throw notFound('room not found');
    const list = this.state.messages.get(room.id) ?? [];
    const createdAt = tick(this.state);
    const card: MessageInitShape<typeof RecordingCardSchema> = {
      recordingId: a.recordingId ?? nextId(this.state, 'file'),
      startedBy: a.byUserId,
      startedAt: timestampFromMs(timestampMs(createdAt) - a.durationSec * 1000),
      durationSec: a.durationSec,
      status: a.status,
      webUrl: a.webUrl ?? '',
      error: a.error ?? '',
      notUploaded: a.notUploaded ?? false,
      fileGone: a.fileGone ?? false,
      ...(a.result ? this.recordingResult(timestampMs(createdAt)) : {}),
    };
    // The server posts it as the one who started the recording, content empty (docs/05).
    const msg = create(MessageSchema, {
      id: nextId(this.state, 'message'),
      roomId: room.id,
      authorId: a.forward?.by ?? a.byUserId,
      content: '',
      kind: MessageKind.SYSTEM,
      system: { payload: { case: 'recording', value: card } },
      attachments: a.result ? this.recordingAudio() : [],
      createdAt,
      ...(a.forward ? { forward: forwardOf(a.forward) } : {}),
    });
    list.push(msg);
    this.state.messages.set(room.id, list);
    const reads = this.state.readStates.get(a.byUserId) ?? new Map<string, string>();
    reads.set(room.id, msg.id);
    this.state.readStates.set(a.byUserId, reads);
    this.toWorkspace(room.workspaceId, { event: { case: 'messageCreate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
    return msg;
  }

  updateRecordingCard(messageId: string, patch: RecordingCardPatch): void {
    const { room, list, index } = this.findMessage(messageId);
    const msg = list[index];
    const p = msg?.system?.payload;
    if (!msg || p?.case !== 'recording') throw notFound('recording card not found');
    const value: RecordingCard = p.value;
    value.status = patch.status;
    if (patch.error !== undefined) value.error = patch.error;
    if (patch.webUrl !== undefined) value.webUrl = patch.webUrl;
    if (patch.result) {
      Object.assign(value, this.recordingResult(Date.now()));
      msg.attachments = this.recordingAudio();
    }
    this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
  }

  /** The card fields of a done recording with its result (the audio kept 30 days from `doneMs`). */
  private recordingResult(doneMs: number): Pick<RecordingCard, 'summary' | 'hasTranscript' | 'resultPending' | 'audioUntil'> {
    return { summary: RECORDING_RESULT.summary, hasTranscript: true, resultPending: false, audioUntil: timestampFromMs(doneMs + 30 * 86_400_000) };
  }

  private recordingAudio(): FileMeta[] {
    const f = this.state.files.get(IDS.files.meeting);
    return f ? [f.meta] : [];
  }

  /** The recording card with this recording id in a room, or 404. */
  private recordingCard(roomId: string, recordingId: string): { msg: Message; card: RecordingCard } {
    const msg = (this.state.messages.get(roomId) ?? []).find((m) => m.system?.payload.case === 'recording' && m.system.payload.value.recordingId === recordingId);
    const p = msg?.system?.payload;
    if (!msg || p?.case !== 'recording' || p.value.deletedAt) throw notFound('recording not found');
    return { msg, card: p.value };
  }

  /** Who may start / stop (docs/05): a member, not a guest, with VIEW_ROOM + CONNECT, voice room. */
  private recordingRoom(c: Ctx): { room: Room; me: string } {
    const me = this.uid(c);
    const room = this.roomFor(c.params[0] ?? '', me);
    if (room.type === RoomType.DM) throw notFound('room not found');
    const m = this.member(room.workspaceId, me);
    if (!m || m.role === WorkspaceRole.GUEST) throw forbidden('guests cannot record meetings');
    this.requireRoomPerm(room, me, CONNECT);
    if (room.type !== RoomType.VOICE) throw invalid('id', 'only voice rooms can be recorded');
    return { room, me };
  }

  private recordingRoutes(): void {
    const s = (): MockState => this.state;
    const integration = (wsId: string): GptunnelIntegration => s().gptunnel.get(wsId) ?? create(GptunnelIntegrationSchema, { paired: false });

    this.route('GET', '/api/workspaces/:id/integrations/gptunnel', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      if (m.role === WorkspaceRole.GUEST) throw forbidden('not available to guests');
      sendMsg(c.res, 200, GetGptunnelIntegrationResponseSchema, { integration: integration(ws.id) });
    });

    this.route('POST', '/api/workspaces/:id/integrations/gptunnel', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireWsBit(m, 'MANAGE_INTEGRATIONS'); // ADR-0048
      const code = parseBody(c, PairGptunnelRequestSchema).code.trim().toUpperCase().replace(/[-\s]/g, '');
      if (!/^[A-Z0-9]{8}$/.test(code)) throw invalid('code', 'the code has 8 letters and digits, e.g. ABCD-EFGH');
      const norm = (x: string): string => x.replace(/-/g, '');
      if (code === norm(MOCK_GPTUNNEL_RATE_CODE)) throw tooMany('too many attempts', 60);
      if (code === norm(MOCK_GPTUNNEL_DOWN_CODE)) throw new HttpError(503, ErrorCode.UNAVAILABLE, 'GPTunneL unreachable');
      if (code !== norm(MOCK_GPTUNNEL_CODE)) throw new HttpError(422, ErrorCode.CODE_INVALID, 'the code is wrong or expired: get a new one in GPTunneL');
      this.setGptunnel(ws.id, me);
      sendMsg(c.res, 200, PairGptunnelResponseSchema, { integration: integration(ws.id) });
    });

    this.route('DELETE', '/api/workspaces/:id/integrations/gptunnel', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireWsBit(m, 'MANAGE_INTEGRATIONS'); // ADR-0048
      this.setGptunnel(ws.id, null);
      noContent(c.res);
    });

    this.route('POST', '/api/rooms/:id/recording/start', (c) => {
      const { room, me } = this.recordingRoom(c);
      if (!room.allowRecording) throw forbidden('recording is not allowed in this room');
      if (!s().gptunnel.get(room.workspaceId)?.paired)
        throw new HttpError(409, ErrorCode.NOT_PAIRED, 'the workspace is not connected to GPTunneL: an owner or admin connects it in the workspace settings');
      if (s().recordings.has(room.id)) throw new HttpError(409, ErrorCode.ALREADY_RECORDING, 'the room is already being recorded');
      const used = s().recordings.size;
      if (used >= RECORDING_MAX_CONCURRENT)
        throw new HttpError(409, ErrorCode.RECORDING_LIMIT, 'too many meetings are being recorded on this server; try again later', '', {
          used: BigInt(used),
          limit: BigInt(RECORDING_MAX_CONCURRENT),
        });
      if (![...s().voiceStates.values()].some((v) => v.roomId === room.id)) throw conflict('nobody is in the call');
      this.setRecording(room.id, { byUserId: me });
      sendMsg(c.res, 200, StartRecordingResponseSchema, { recording: s().recordings.get(room.id) });
    });

    // Retry of a failed card (docs/09 #40): recheck → PROCESSING, reupload → UPLOADING; the card
    // moves on by MESSAGE_UPDATE.
    for (const action of ['recheck', 'reupload'] as const) {
      this.route('POST', `/api/rooms/:id/recordings/:rid/${action}`, (c) => {
        const { room } = this.recordingRoom(c);
        const msg = (s().messages.get(room.id) ?? []).find((m) => m.system?.payload.case === 'recording' && m.system.payload.value.recordingId === c.params[1]);
        const p = msg?.system?.payload;
        if (!msg || p?.case !== 'recording') throw notFound('recording not found');
        const card = p.value;
        if (card.status !== RecordingStatus.FAILED) throw conflict('the recording has not failed');
        if (action === 'recheck' && card.notUploaded) throw conflict('the recording never reached GPTunneL: send it again');
        if (action === 'reupload' && !card.notUploaded) throw new HttpError(409, ErrorCode.ALREADY_UPLOADED, 'the recording was delivered to GPTunneL');
        if (action === 'reupload' && card.fileGone) throw new HttpError(409, ErrorCode.FILE_GONE, 'the recording file is no longer kept');
        this.updateRecordingCard(msg.id, { status: action === 'recheck' ? RecordingStatus.PROCESSING : RecordingStatus.UPLOADING, error: '' });
        sendMsg(c.res, 200, RetryRecordingResponseSchema, { recording: card });
      });
    }

    // The transcript kept on the server (docs/09 #47): VIEW_ROOM; 404 without one.
    this.route('GET', '/api/rooms/:id/recordings/:rid/transcript', (c) => {
      const room = this.roomFor(c.params[0] ?? '', this.uid(c));
      const { card } = this.recordingCard(room.id, c.params[1] ?? '');
      if (!card.hasTranscript) throw notFound('transcript');
      sendMsg(c.res, 200, GetRecordingTranscriptResponseSchema, {
        recordingId: card.recordingId,
        language: RECORDING_RESULT.language,
        segments: RECORDING_RESULT.transcript.map((x) => ({ ...x })),
      });
    });

    // «Удалить запись» (docs/09 #50): who started it, the owner or MANAGE_MESSAGES; not while recording.
    this.route('DELETE', '/api/rooms/:id/recordings/:rid', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const { msg, card } = this.recordingCard(room.id, c.params[1] ?? '');
      const m = this.member(room.workspaceId, me);
      const ws = this.state.workspaces.get(room.workspaceId);
      const owner = !!ws && ws.ownerId === me;
      if (card.startedBy !== me && !owner && !has(this.perms(room, me), MANAGE_MESSAGES)) throw forbidden('not allowed to delete this recording');
      if (!m) throw notFound('room not found');
      if (card.status === RecordingStatus.RECORDING) throw conflict('the meeting is still being recorded');
      Object.assign(card, {
        deletedAt: tick(this.state),
        deletedBy: me,
        summary: '',
        hasTranscript: false,
        resultPending: false,
        webUrl: '',
        error: '',
        fileGone: true,
        notUploaded: true,
      });
      delete card.audioUntil;
      msg.attachments = [];
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      noContent(c.res);
    });

    this.route('POST', '/api/rooms/:id/recording/stop', (c) => {
      const { room, me } = this.recordingRoom(c);
      const stopped = this.stopRecording(room, 'user', me);
      sendMsg(c.res, 200, StopRecordingResponseSchema, { recording: stopped });
    });

    // e2e control: a card's next state ({messageId, status: "RECORDING_STATUS_FAILED", error}).
    this.route('POST', '/__mock/recording-card', (c) => {
      const b = (c.raw.length ? JSON.parse(c.raw.toString('utf8')) : {}) as Record<string, unknown>;
      const key = (typeof b['status'] === 'string' ? b['status'] : '').replace(/^RECORDING_STATUS_/, '');
      const status = key in RecordingStatus && !/^\d+$/.test(key) ? RecordingStatus[key as keyof typeof RecordingStatus] : undefined;
      if (status === undefined) throw invalid('status', 'unknown status');
      this.updateRecordingCard(typeof b['messageId'] === 'string' ? b['messageId'] : '', {
        status,
        ...(typeof b['error'] === 'string' ? { error: b['error'] } : {}),
        ...(typeof b['webUrl'] === 'string' ? { webUrl: b['webUrl'] } : {}),
      });
      noContent(c.res);
    });
  }

  private emailRoutes(): void {
    const s = (): MockState => this.state;

    this.route('POST', '/api/auth/verify/send', (c) => {
      const u = this.auth(c).user;
      if (u.user.isGuest) throw forbidden('guest account');
      if (u.emailVerified && !u.pendingEmail) throw conflict('email already verified');
      const key = `verify:${u.user.id}`;
      const last = s().emailCodes.get(key);
      const since = last ? Date.now() - last.sentAtMs : Infinity;
      if (since < RESEND_MS) throw tooMany('a code was sent less than 60 s ago', (RESEND_MS - since) / 1000);
      s().emailCodes.set(key, { attempts: 0, sentAtMs: Date.now() });
      noContent(c.res);
    });

    this.route('POST', '/api/auth/verify', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, VerifyEmailRequestSchema);
      this.checkCode(`verify:${u.user.id}`, b.code);
      if (u.pendingEmail) {
        u.email = u.pendingEmail;
        u.pendingEmail = '';
      }
      u.emailVerified = true;
      this.emitUserUpdate(u);
      const joinedWorkspaceIds = this.acceptEmailInvites(u);
      sendMsg(c.res, 200, VerifyEmailResponseSchema, { me: this.me(u), joinedWorkspaceIds });
    });

    this.route('POST', '/api/auth/password/forgot', (c) => {
      const email = parseBody(c, ForgotPasswordRequestSchema).email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw invalid('email', 'invalid email address');
      const users = [...s().users.values()];
      const u = users.find((x) => x.email === email && !x.user.isGuest);
      if (u) s().emailCodes.set(`reset:${email}`, { attempts: 0, sentAtMs: Date.now() });
      // Same answer whether or not the address has an account, except the hint (docs/09 #137):
      // no exact account, but the same login at a sibling domain (owner@calaba.ru ↔ owner@calaba.test).
      const at = email.lastIndexOf('@');
      const name = (e: string): string => e.slice(e.lastIndexOf('@') + 1).replace(/\.[^.]*$/, '');
      const similarAccount =
        !users.some((x) => x.email === email) &&
        users.some((x) => !x.user.isGuest && x.email.slice(0, x.email.lastIndexOf('@')) === email.slice(0, at) && name(x.email) === name(email));
      sendMsg(c.res, 200, ForgotPasswordResponseSchema, { similarAccount });
    });

    this.route('POST', '/api/auth/password/reset', (c) => {
      const b = parseBody(c, ResetPasswordRequestSchema);
      const email = b.email.trim().toLowerCase();
      if (b.password.length < 8 || b.password.length > 256) throw invalid('password', 'password must be 8..256 characters');
      const u = [...s().users.values()].find((x) => x.email === email && !x.user.isGuest);
      if (!u) throw new HttpError(422, ErrorCode.CODE_INVALID, 'wrong or expired code');
      this.checkCode(`reset:${email}`, b.code, true);
      u.password = b.password;
      u.emailVerified = true;
      for (const x of s().sessions.get(u.user.id) ?? []) if (!s().revokedSessions.has(x.id)) this.revoke(x.id);
      this.acceptEmailInvites(u);
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/invites/lookup', (c) => {
      const { wsId } = this.inviter(c);
      const email = parseBody(c, InviteLookupRequestSchema).email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw invalid('email', 'invalid email address');
      const u = [...s().users.values()].find((x) => x.email === email && x.emailVerified && !x.user.isGuest);
      if (!u) {
        sendMsg(c.res, 200, InviteLookupResponseSchema, {});
        return;
      }
      sendMsg(c.res, 200, InviteLookupResponseSchema, { user: u.user, member: !!this.member(wsId, u.user.id) });
    });

    this.route('POST', '/api/workspaces/:id/members', (c) => {
      const { wsId } = this.inviter(c);
      const userId = parseBody(c, AddMemberRequestSchema).userId;
      const u = s().users.get(userId);
      if (!u || !u.emailVerified || u.user.isGuest) throw notFound('user not found');
      if (this.member(wsId, userId)) throw conflict('already a member');
      const m = this.joinWorkspace(wsId, userId);
      sendMsg(c.res, 201, AddMemberResponseSchema, { member: this.memberOut(m) });
    });

    this.route('POST', '/api/workspaces/:id/invites/email', (c) => {
      const { wsId, m, me } = this.inviter(c);
      const b = parseBody(c, CreateEmailInviteRequestSchema);
      const email = b.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw invalid('email', 'invalid email address');
      const role = b.role ?? WorkspaceRole.MEMBER;
      if (role !== WorkspaceRole.MEMBER && role !== WorkspaceRole.ADMIN) throw invalid('role', 'member or admin');
      if (role === WorkspaceRole.ADMIN && m.role !== WorkspaceRole.OWNER) throw forbidden('only the owner invites admins');
      const existing = [...s().users.values()].find((x) => x.email === email);
      if (existing && this.member(wsId, existing.user.id)) throw conflict('already a member');
      const prev = [...s().emailInvites.values()].find((i) => i.workspaceId === wsId && i.email === email && !i.accepted);
      if (prev && Date.now() - prev.lastSentMs < REINVITE_MS) {
        throw tooMany('invited less than 24 h ago', (REINVITE_MS - (Date.now() - prev.lastSentMs)) / 1000);
      }
      if (prev) s().emailInvites.delete(prev.id);
      const id = nextId(s(), 'invite');
      const at = tick(s());
      const rec: EmailInviteRec = {
        id,
        workspaceId: wsId,
        email,
        role,
        invitedBy: me.user.id,
        code: `mock-mail-${id.slice(-4)}`,
        createdAt: at,
        expiresAt: timestampFromMs(timestampMs(at) + 7 * 86400_000),
        lastSentAt: at,
        lastSentMs: Date.now(),
      };
      s().emailInvites.set(id, rec);
      sendMsg(c.res, 201, CreateEmailInviteResponseSchema, { invite: this.emailInviteOut(rec) });
    });

    this.route('GET', '/api/workspaces/:id/invites/email', (c) => {
      const { wsId } = this.inviter(c);
      const invites = [...s().emailInvites.values()]
        .filter((i) => i.workspaceId === wsId && !i.accepted)
        .sort((a, b) => b.id.localeCompare(a.id))
        .map((i) => this.emailInviteOut(i));
      sendMsg(c.res, 200, ListEmailInvitesResponseSchema, { invites });
    });

    this.route('DELETE', '/api/workspaces/:id/invites/email/:inviteId', (c) => {
      const { wsId } = this.inviter(c);
      const inv = s().emailInvites.get(c.params[1] ?? '');
      if (!inv || inv.workspaceId !== wsId || inv.accepted) throw notFound('invite not found');
      s().emailInvites.delete(inv.id);
      noContent(c.res);
    });
  }

  private joinWorkspace(wsId: string, userId: string, inviteId?: string): MemberRec {
    const m: MemberRec = { workspaceId: wsId, userId, role: WorkspaceRole.MEMBER, nickname: '', joinedAt: tick(this.state) };
    this.state.members.push(m);
    if (inviteId) {
      const inv = this.state.invites.get(inviteId);
      if (inv) inv.uses += 1;
    }
    const member = this.memberOut(m);
    this.fanout((u) =>
      u === userId
        ? { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(wsId, userId) } } }
        : this.member(wsId, u)
          ? { event: { case: 'workspaceMemberAdd', value: { member } } }
          : null,
    );
    return m;
  }

  /**
   * Room link join (ADR-0016): non-members become `guest`; a user override grants the room with
   * the link's rights. A use is counted only when access actually changes.
   */
  private grantRoomLink(inv: RoomInvite, userId: string): void {
    const room = this.state.rooms.get(inv.roomId);
    if (!room) return;
    const existing = this.member(inv.workspaceId, userId);
    if (existing && this.canView(room, userId)) return;
    inv.uses += 1;
    if (!existing) this.addGuestMember(inv.workspaceId, userId);
    this.grantOverride(room, userId, inv);
  }

  /** A new `guest` member: WORKSPACE_CREATE to them, WORKSPACE_MEMBER_ADD to the others. */
  private addGuestMember(wsId: string, userId: string): void {
    const m: MemberRec = { workspaceId: wsId, userId, role: WorkspaceRole.GUEST, nickname: '', joinedAt: tick(this.state) };
    this.state.members.push(m);
    const member = this.memberOut(m);
    this.fanout((u) =>
      u === userId
        ? { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(wsId, userId) } } }
        : this.member(wsId, u)
          ? { event: { case: 'workspaceMemberAdd', value: { member } } }
          : null,
    );
  }

  /** The user override a link grants (its rights; no link = a default link's) → ROOM_PERMISSIONS_UPDATE. */
  private grantOverride(room: Room, userId: string, inv: RoomInvite | undefined): void {
    const allow =
      VIEW_ROOM |
      CONNECT |
      ((inv?.allowSpeak ?? true) ? SPEAK : 0n) |
      ((inv?.allowMessages ?? true) ? SEND_MESSAGES : 0n) |
      (inv?.allowFiles ? ATTACH_FILES : 0n) |
      (inv?.allowStream ? STREAM : 0n);
    const before = clone(RoomSchema, room); // create() would return the same instance
    room.permissionOverrides = [
      ...room.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.USER && o.targetId === userId)),
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow, deny: 0n }),
    ];
    this.emitRoomChange(before, room, {
      event: { case: 'roomPermissionsUpdate', value: { workspaceId: room.workspaceId, roomId: room.id, permissions: room.permissionOverrides } },
    });
  }

  // ------------------------------------------------ guest admission (ADR-0040)

  /**
   * A link join (ADR-0016) that may wait (ADR-0040): guests on a link requiring approval (its
   * own setting, else the room's) become `guest` without the room and knock. Returns the guest's
   * view of the knock, or undefined when the join granted the room (or nothing changed).
   */
  private joinByLink(inv: RoomInvite, userId: string): RoomAdmission | undefined {
    const room = this.state.rooms.get(inv.roomId);
    const ws = this.state.workspaces.get(inv.workspaceId);
    if (!room || !ws) return undefined;
    const existing = this.member(inv.workspaceId, userId);
    if (existing && this.canView(room, userId)) return undefined;
    const wait = requiresApproval(room.guestApproval, inv.requireApproval) && (!existing || existing.role === WorkspaceRole.GUEST);
    if (!wait) {
      this.grantRoomLink(inv, userId);
      return undefined;
    }
    const cur = this.state.admissions.get(admissionKey(room.id, userId));
    if (cur) return guestView(cur, room.name, ws.name); // knocking again while waiting
    inv.uses += 1;
    if (!existing) this.addGuestMember(inv.workspaceId, userId);
    return this.addKnock(room, userId, inv.id, inv.createdBy);
  }

  private addKnock(room: Room, userId: string, inviteId: string, inviteCreatedBy: string): RoomAdmission {
    const a: AdmissionRec = { roomId: room.id, workspaceId: room.workspaceId, userId, inviteId, inviteCreatedBy, requestedAt: tick(this.state) };
    this.state.admissions.set(admissionKey(room.id, userId), a);
    const out = deciderView(a, this.state.users.get(userId)?.user);
    this.fanout((u) => (this.decides(a, u) ? { event: { case: 'roomAdmissionRequest', value: { admission: out } } } : null));
    return guestView(a, room.name, this.state.workspaces.get(room.workspaceId)?.name ?? '');
  }

  /** Deciders of a knock: MANAGE_ROOM in the room, or the link's author (not a guest). */
  private decides(a: AdmissionRec, userId: string): boolean {
    const m = this.member(a.workspaceId, userId);
    const room = this.state.rooms.get(a.roomId);
    if (!m || !room) return false;
    return has(this.perms(room, userId), MANAGE_ROOM) || (userId === a.inviteCreatedBy && m.role !== WorkspaceRole.GUEST);
  }

  /** READY: the user's own waiting knocks (declines are not kept by the mock). */
  private ownAdmissions(userId: string): RoomAdmission[] {
    return [...this.state.admissions.values()]
      .filter((a) => a.userId === userId)
      .map((a) => guestView(a, this.state.rooms.get(a.roomId)?.name ?? '', this.state.workspaces.get(a.workspaceId)?.name ?? ''));
  }

  /** READY: the knocks the recipient decides, in each workspace snapshot. */
  private withAdmissions(snap: WorkspaceSnapshot, userId: string): WorkspaceSnapshot {
    const wsId = snap.workspace?.id ?? '';
    snap.admissions = [...this.state.admissions.values()]
      .filter((a) => a.workspaceId === wsId && this.decides(a, userId))
      .map((a) => deciderView(a, this.state.users.get(a.userId)?.user));
    return snap;
  }

  setGuestApproval(roomId: string, on: boolean): void {
    const room = this.state.rooms.get(roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    room.guestApproval = on;
    this.toWorkspace(room.workspaceId, { event: { case: 'roomUpdate', value: { room: this.roomOut(room) } } }, room.id);
  }

  knock(roomId: string, nickname: string, inviteId?: string): string {
    const room = this.state.rooms.get(roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    const id = nextId(this.state, 'user');
    const at = tick(this.state);
    this.state.users.set(id, {
      user: create(UserSchema, { id, displayName: nickname, avatarFileId: '', statusText: '', createdAt: at, isGuest: true }),
      email: '',
      password: '',
      settings: defaultSettings(),
      emailVerified: true,
      pendingEmail: '',
      locale: '',
    });
    this.state.presences.set(id, create(PresenceSchema, { userId: id, status: PresenceStatus.ONLINE, lastSeen: at }));
    this.addGuestMember(room.workspaceId, id);
    const inv = inviteId ? this.state.roomInvites.get(inviteId) : undefined;
    this.addKnock(room, id, inv?.id ?? '', inv?.createdBy ?? IDS.users.anna);
    return id;
  }

  decideAdmission(roomId: string, userId: string, status: 'admitted' | 'declined' | 'no_answer' | 'cancelled', byUserId: string = IDS.users.anna): void {
    const key = admissionKey(roomId, userId);
    const a = this.state.admissions.get(key);
    const room = this.state.rooms.get(roomId);
    if (!a || !room) throw new Error(`no knock of ${userId} on ${roomId}`);
    const outcome = admissionOutcome(status, byUserId, tick(this.state));
    // Deciders are computed before the knock goes (the link's author may decide it).
    const deciders = new Set([...this.conns].map((c) => c.userId).filter((u): u is string => !!u && this.decides(a, u)));
    this.state.admissions.delete(key);
    if (status === 'admitted') this.grantOverride(room, userId, this.state.roomInvites.get(a.inviteId));
    const dv = deciderView(a, create(UserSchema, { id: userId }), outcome);
    this.fanout((u) => (deciders.has(u) ? { event: { case: 'roomAdmissionDecided', value: { admission: dv } } } : null));
    this.toUser(userId, {
      event: { case: 'roomAdmissionDecided', value: { admission: guestView(a, room.name, this.state.workspaces.get(a.workspaceId)?.name ?? '', outcome) } },
    });
    if (status !== 'admitted') this.dropIdleGuest(a.workspaceId, userId);
  }

  /** A guest membership with no room left (no personal override, no other knock) goes. */
  private dropIdleGuest(wsId: string, userId: string): void {
    const m = this.member(wsId, userId);
    if (m?.role !== WorkspaceRole.GUEST) return;
    const hasRoom = [...this.state.rooms.values()].some(
      (r) => r.workspaceId === wsId && r.permissionOverrides.some((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
    );
    const knocks = [...this.state.admissions.values()].some((x) => x.workspaceId === wsId && x.userId === userId);
    if (hasRoom || knocks) return;
    this.toUser(userId, { event: { case: 'workspaceDelete', value: { workspaceId: wsId } } });
    this.state.members = this.state.members.filter((x) => x !== m);
    this.toWorkspace(wsId, { event: { case: 'workspaceMemberRemove', value: { workspaceId: wsId, userId } } });
  }

  private admissionRoutes(): void {
    const s = (): MockState => this.state;
    const knockOf = (roomId: string, userId: string): AdmissionRec => {
      const a = s().admissions.get(admissionKey(roomId, userId));
      if (!a) throw notFound('admission not found');
      return a;
    };
    // MANAGE_ROOM in the room, or the author of one of its links (a member, not a guest).
    const deciderRoom = (roomId: string, me: string): Room => {
      const room = s().rooms.get(roomId);
      const m = room ? this.member(room.workspaceId, me) : undefined;
      if (!room || room.type === RoomType.DM || !m) throw notFound('room not found');
      const author = m.role !== WorkspaceRole.GUEST && [...s().roomInvites.values()].some((i) => i.roomId === room.id && i.createdBy === me);
      if (!has(this.perms(room, me), MANAGE_ROOM) && !author) {
        if (!this.canView(room, me)) throw notFound('room not found');
        throw forbidden('MANAGE_ROOM required');
      }
      return room;
    };
    this.route('GET', '/api/rooms/:id/admissions', (c) => {
      const me = this.uid(c);
      const room = deciderRoom(c.params[0] ?? '', me);
      const admissions = [...s().admissions.values()]
        .filter((a) => a.roomId === room.id && this.decides(a, me))
        .sort((a, b) => timestampMs(a.requestedAt) - timestampMs(b.requestedAt))
        .map((a) => deciderView(a, s().users.get(a.userId)?.user));
      sendMsg(c.res, 200, ListRoomAdmissionsResponseSchema, { admissions });
    });
    this.route('POST', '/api/rooms/:id/admissions/:userId', (c) => {
      const me = this.uid(c);
      if (s().users.get(me)?.user.isBot) throw new HttpError(403, ErrorCode.FORBIDDEN, 'not available for bots', '', { reason: 'BOT_NOT_ALLOWED' });
      const room = deciderRoom(c.params[0] ?? '', me);
      const target = c.params[1] ?? '';
      const b = parseBody(c, DecideRoomAdmissionRequestSchema);
      const admit = b.status === RoomAdmissionStatus.ADMITTED;
      if (!admit && b.status !== RoomAdmissionStatus.DECLINED) throw invalid('status', 'status must be ADMITTED or DECLINED');
      const name = admit && b.displayName !== undefined ? b.displayName.trim() : undefined;
      if (name !== undefined && (!name || Array.from(name).length > 40)) throw invalid('displayName', 'name must be 1..40 characters');
      const a = knockOf(room.id, target);
      if (!this.decides(a, me)) throw forbidden('MANAGE_ROOM required');
      const guest = s().users.get(target);
      if (name !== undefined && !guest?.user.isGuest) throw invalid('displayName', 'only a guest account can be renamed');
      if (admit && b.badgeId && !this.badgesOf(room.workspaceId).some((x) => x.id === b.badgeId)) throw invalid('badgeId', 'unknown badge');
      if (name !== undefined && guest) {
        guest.user.displayName = name;
        const user = guest.user;
        this.fanout((u) => (u === target || this.shareWorkspace(u, target) ? { event: { case: 'userUpdate', value: { user } } } : null));
      }
      if (admit && b.badgeId !== undefined) this.setMemberBadge(room.workspaceId, target, b.badgeId);
      this.decideAdmission(room.id, target, admit ? 'admitted' : 'declined', me);
      const outcome = admissionOutcome(admit ? 'admitted' : 'declined', me, tick(s()));
      sendMsg(c.res, 200, DecideRoomAdmissionResponseSchema, { admission: deciderView(a, guest?.user, outcome) });
    });
    this.route('DELETE', '/api/rooms/:id/admissions/me', (c) => {
      const me = this.uid(c);
      const roomId = c.params[0] ?? '';
      knockOf(roomId, me);
      this.decideAdmission(roomId, me, 'cancelled', me);
      noContent(c.res);
    });
  }

  // ------------------------------------------------ free / busy, find a time, CalDAV (ADR-0041)

  private workHoursOf(userId: string): WorkHoursRec {
    return this.calWorkHours.get(userId) ?? DEFAULT_WORK_HOURS;
  }

  /** The mock's zone of a user: User.timezone, else Moscow (the visual tests' zone). */
  private zoneOf(userId: string): string {
    return this.state.users.get(userId)?.user.timezone || 'Europe/Moscow';
  }

  /** A connected account of `userId` (visual fixtures): «Работа» picked, import on, synced now. */
  seedCalDav(userId: string, patch: Partial<CalDavRec> = {}): void {
    const url = 'https://caldav.example.com';
    this.calDav.set(userId, { url, username: 'anna@example.com', calendarHref: davCalendars(url)[0]?.href ?? '', import: true, push: false, lastSyncAt: this.calNow(), lastError: '', shareLevel: 'busy', ...patch });
  }

  /** A member of `wsId` (a person, not a guest) with this address: their id, else ''. */
  private memberByEmail(wsId: string, email: string): string {
    for (const u of this.state.users.values()) {
      if (u.email.toLowerCase() !== email || u.user.isBot || u.user.isGuest) continue;
      const m = this.member(wsId, u.user.id);
      if (m && m.role !== WorkspaceRole.GUEST) return u.user.id;
    }
    return '';
  }

  /** One person's busy time for `viewer` (ADR-0041 §1): event_id only for meetings the viewer sees; external titles by the owner's share level (ADR-0045 §4). */
  private busyOf(wsId: string, userId: string, viewer: string, fromMs: number, toMs: number): Array<{ startsAt: string; endsAt: string; eventId?: string; kind: string; allDay: boolean; title?: string; attendeeUserIds?: string[] }> {
    const iso = (t: number): string => new Date(t).toISOString();
    const out: Array<{ startsAt: string; endsAt: string; eventId?: string; kind: string; allDay: boolean; title?: string; attendeeUserIds?: string[] }> = [];
    const level = this.calDav.get(userId)?.shareLevel ?? 'busy';
    for (const o of meetingBusy(this.calEvents.values(), wsId, userId, fromMs, toMs)) {
      const seen = !!this.calView(o.rec, viewer);
      out.push({ startsAt: iso(o.startMs), endsAt: iso(o.endMs), ...(seen ? { eventId: o.rec.ev.id } : {}), kind: 'BUSY_KIND_MEETING', allDay: o.rec.ev.allDay });
    }
    for (const x of this.calExternal.get(userId) ?? []) {
      if (x.endMs > fromMs && x.startMs < toMs) {
        out.push({ startsAt: iso(x.startMs), endsAt: iso(x.endMs), kind: 'BUSY_KIND_EXTERNAL', allDay: false, ...sharedBusy(x, level, (e) => this.memberByEmail(wsId, e)) });
      }
    }
    return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  }

  private freeBusyRoutes(): void {
    const DAY = 86_400_000;
    const asker = (wsId: string, me: string): void => {
      const { m } = this.workspaceFor(wsId, me);
      if (m.role === WorkspaceRole.GUEST || this.state.users.get(me)?.user.isBot) throw forbidden('free / busy is not available for guests and bots');
    };
    const people = (wsId: string, ids: readonly string[]): string[] => {
      const list = [...new Set(ids.filter(Boolean))];
      if (!list.length || list.length > 20) throw invalid('users', '1..20 users');
      for (const u of list) {
        const m = this.member(wsId, u);
        if (!m || m.role === WorkspaceRole.GUEST || this.state.users.get(u)?.user.isBot) throw invalid('users', 'users must be members of the workspace');
      }
      return list;
    };
    const span = (from: number, to: number): void => {
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 14 * DAY) throw invalid('to', 'from / to: RFC 3339, to after from, at most 14 days');
    };

    this.route('GET', '/api/workspaces/:id/freebusy', (c) => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      asker(wsId, me);
      const list = people(wsId, (c.url.searchParams.get('users') ?? '').split(','));
      const from = Date.parse(c.url.searchParams.get('from') ?? '');
      const to = Date.parse(c.url.searchParams.get('to') ?? '');
      span(from, to);
      const users = list.map((u) => ({ userId: u, timezone: this.zoneOf(u), workHours: this.workHoursOf(u), busy: this.busyOf(wsId, u, me, from, to) }));
      send(c.res, 200, JSON.stringify({ users }), 'application/json');
    });

    this.route('POST', '/api/workspaces/:id/freebusy/suggest', (c) => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      asker(wsId, me);
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { users?: string[]; durationMin?: unknown; from?: string; to?: string; withinWorkHours?: boolean; roomId?: string };
      const list = people(wsId, b.users ?? []);
      const dur = Number(b.durationMin ?? 0);
      if (!(dur >= 15 && dur <= 480) || dur % 15) throw invalid('durationMin', 'duration is 15..480 minutes in 15-minute steps');
      const from = Date.parse(b.from ?? '');
      const to = Date.parse(b.to ?? '');
      span(from, to);
      const toSpans = (x: ReturnType<MockImpl['busyOf']>): Array<{ start: number; end: number }> => x.map((i) => ({ start: Date.parse(i.startsAt), end: Date.parse(i.endsAt) }));
      const busy = list.map((u) => toSpans(this.busyOf(wsId, u, me, from, to)));
      if (b.roomId) {
        const roomBusy: Array<{ start: number; end: number }> = [];
        for (const rec of this.calEvents.values()) {
          if (rec.ev.roomId !== b.roomId || rec.ev.cancelledAt) continue;
          for (const o of occurrences(rec, from, to)) roomBusy.push({ start: o.startMs, end: o.endMs });
        }
        busy.push(roomBusy);
      }
      let work: Array<Array<{ start: number; end: number }>> | null = null;
      if (b.withinWorkHours) {
        work = list.map((u) => workIntervals(this.workHoursOf(u), this.zoneOf(u), from, to));
        let common: Array<{ start: number; end: number }> = [{ start: from, end: to }];
        for (const w of work) common = intersectIntervals(common, w);
        if (!common.length) throw new HttpError(409, ErrorCode.NO_COMMON_HOURS, 'the work hours of these people never overlap');
      }
      const slots = slotsOf(freeWindows({ from, to, busy, work, minMinutes: dur }), dur);
      send(c.res, 200, JSON.stringify({ slots: slots.map((x) => ({ startsAt: new Date(x.startMs).toISOString(), endsAt: new Date(x.endMs).toISOString() })) }), 'application/json');
    });

    // CalDAV (ADR-0041 §4): one fake account per user; any https address «discovers» two calendars,
    // an address with «fail» answers 422 like a server that refused the login.
    const davUser = (c: Ctx): string => {
      const u = this.auth(c).user;
      if (u.user.isGuest || u.user.isBot) throw forbidden('CalDAV is not for guests and bots');
      return u.user.id;
    };
    const syncDav = (userId: string, a: CalDavRec): void => {
      a.lastSyncAt = this.calNow();
      a.lastError = '';
      if (!a.import) return;
      const clock = this.calNow();
      const day = new Date(clock);
      day.setUTCHours(8, 0, 0, 0); // 11:00 MSK
      this.calExternal.set(userId, [...(this.calDavRemote.get(userId) ?? [{ startMs: day.getTime(), endMs: day.getTime() + 3_600_000 }])]);
    };
    this.route('GET', '/api/me/caldav', (c) => {
      send(c.res, 200, JSON.stringify(davOut(this.calDav.get(davUser(c)))), 'application/json');
    });
    this.route('POST', '/api/me/caldav', (c) => {
      const me = davUser(c);
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { url?: string; username?: string; password?: string };
      const url = (b.url ?? '').trim();
      if (!/^https:\/\/[^\s/]+/.test(url)) throw invalid('url', 'the address must be https');
      if (!b.username || !b.password) throw invalid('username', 'login and password are required');
      if (url.includes('fail')) throw invalid('password', 'the server refused the login');
      const a: CalDavRec = { url, username: b.username, calendarHref: '', import: false, push: false, lastSyncAt: null, lastError: '' };
      this.calDav.set(me, a);
      send(c.res, 200, JSON.stringify(davOut(a)), 'application/json');
    });
    this.route('PUT', '/api/me/caldav', (c) => {
      const me = davUser(c);
      const a = this.calDav.get(me);
      if (!a) throw notFound('no CalDAV account');
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { calendarHref?: string; import?: boolean; push?: boolean };
      if (b.calendarHref !== undefined) a.calendarHref = b.calendarHref;
      a.import = !!b.import;
      a.push = !!b.push;
      if (!a.import) this.calExternal.delete(me);
      else if (a.calendarHref) syncDav(me, a);
      send(c.res, 200, JSON.stringify(davOut(a)), 'application/json');
    });
    this.route('PATCH', '/api/me/caldav', (c) => {
      const me = davUser(c);
      const a = this.calDav.get(me);
      if (!a) throw notFound('no CalDAV account');
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { shareLevel?: unknown; remind?: unknown };
      const remind = typeof b.remind === 'boolean' ? b.remind : undefined;
      const level = b.shareLevel === undefined && remind !== undefined ? null : shareLevelIn(b.shareLevel);
      if (!level && remind === undefined) throw invalid('shareLevel', 'one of busy, title, details');
      if (level) a.shareLevel = level;
      if (remind !== undefined) a.remind = remind;
      send(c.res, 200, JSON.stringify(davOut(a)), 'application/json');
    });
    this.route('GET', '/api/me/external-events', (c) => {
      const me = davUser(c);
      const from = Date.parse(c.url.searchParams.get('from') ?? '');
      const to = Date.parse(c.url.searchParams.get('to') ?? '');
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 14 * 86_400_000) throw invalid('to', 'from / to: RFC 3339, to after from, at most 14 days');
      const wsId = c.url.searchParams.get('workspace') ?? '';
      if (wsId) {
        const m = this.member(wsId, me);
        if (!m || m.role === WorkspaceRole.GUEST) throw forbidden('not a member of this workspace');
      }
      const match = (e: string): string => (wsId ? this.memberByEmail(wsId, e) : '');
      send(c.res, 200, JSON.stringify(externalEventsOut(this.calExternal.get(me) ?? [], from, to, match)), 'application/json');
    });
    // ADR-0045 amendment 1: the event (THIS: that occurrence; SERIES or no repeats: the uid) out of
    // the fake calendar; an href ending in «readonly.ics» answers 422 like a read-only calendar.
    this.route('DELETE', '/api/me/external-events', (c) => {
      const me = davUser(c);
      const b = JSON.parse(c.raw.toString('utf8') || '{}') as { uid?: string; href?: string; start?: string; scope?: string };
      const list = this.calExternal.get(me) ?? [];
      const start = Date.parse(b.start ?? '');
      const at = list.findIndex((x, i) => (x.uid ?? `ext${i}`) === b.uid && x.href === b.href && x.startMs === start);
      const target = list[at];
      if (!target || !b.href) throw notFound('external event not found');
      if (b.href.endsWith('readonly.ics')) throw invalid('href', 'the calendar is read-only');
      const whole = b.scope === 'EXTERNAL_DELETE_SCOPE_SERIES' || !target.recurring;
      this.calExternal.set(me, list.filter((x, i) => (whole ? (x.uid ?? `ext${i}`) !== b.uid : i !== at)));
      noContent(c.res);
    });
    this.route('POST', '/api/me/caldav/sync', (c) => {
      const me = davUser(c);
      const a = this.calDav.get(me);
      if (!a) throw notFound('no CalDAV account');
      syncDav(me, a);
      send(c.res, 200, JSON.stringify(davOut(a)), 'application/json');
    });
    this.route('DELETE', '/api/me/caldav', (c) => {
      const me = davUser(c);
      this.calDav.delete(me);
      this.calExternal.delete(me);
      noContent(c.res);
    });
  }

  // ------------------------------------------------ calendar (ADR-0038)

  /** How `userId` sees `rec` in its workspace: null = not at all (guests, strangers, other rooms). */
  private calView(rec: CalEventRec, userId: string): { view: EmailView; canEdit: boolean } | null {
    const ev = rec.ev;
    const m = this.member(ev.workspaceId, userId);
    if (!m || m.role === WorkspaceRole.GUEST) return null;
    const bot = this.state.users.get(userId)?.user.isBot ?? false;
    const room = ev.roomId ? this.state.rooms.get(ev.roomId) : undefined;
    const inv = !bot && involves(ev, userId);
    if (!inv && !(room && this.canView(room, userId))) return null;
    // ADR-0048: MANAGE_EVENTS — a meeting without a room, or in a room the caller sees.
    const manageEvents = has(workspacePermissions(this.memberRoles(m)), PERMISSION_BITS.MANAGE_EVENTS);
    const canEdit = !bot && (ev.organizerId === userId || (room ? has(this.perms(room, userId), MANAGE_ROOM) || (manageEvents && this.canView(room, userId)) : manageEvents));
    return { view: bot ? 'none' : inv || canEdit ? 'full' : 'masked', canEdit };
  }

  /** A guest of the workspace who can view the meeting's room (ADR-0038 «Диплинки для приглашённых»). */
  private calGuestSees(rec: CalEventRec, userId: string): boolean {
    const m = this.member(rec.ev.workspaceId, userId);
    const room = rec.ev.roomId ? this.state.rooms.get(rec.ev.roomId) : undefined;
    return !!m && m.role === WorkspaceRole.GUEST && !!room && !rec.ev.cancelledAt && this.canView(room, userId);
  }

  /** The event for a member; a guest who sees its room → 403, anyone else → 404. */
  private calRec(id: string, userId: string): { rec: CalEventRec; view: EmailView; canEdit: boolean } {
    const rec = this.calEvents.get(id);
    const v = rec ? this.calView(rec, userId) : null;
    if (rec && !v && this.calGuestSees(rec, userId)) throw forbidden('the calendar is not available for guests');
    if (!rec || !v) throw notFound('event not found');
    return { rec, ...v };
  }

  eventGuestLink(eventId: string, email: string): string {
    const rec = this.calEvents.get(eventId);
    const addr = email.trim().toLowerCase();
    if (!rec?.ev.roomId || !rec.ev.attendees.some((a) => a.email === addr)) throw notFound('external attendee of a meeting with a room not found');
    rec.guestLinks ??= new Map();
    let inv = this.state.roomInvites.get(rec.guestLinks.get(addr) ?? '');
    if (!inv) {
      if (!this.state.rooms.has(rec.ev.roomId)) throw notFound('room not found');
      const occ = occurrences(rec, this.calNow(), Infinity)[0] ?? { startMs: timestampMs(rec.ev.startsAt ?? timestampFromMs(0)), endMs: timestampMs(rec.ev.endsAt ?? timestampFromMs(0)) };
      const id = nextId(this.state, 'invite');
      inv = create(RoomInviteSchema, {
        id, roomId: rec.ev.roomId, workspaceId: rec.ev.workspaceId, code: `mock-meet-${id.slice(-4)}`, createdBy: rec.ev.organizerId,
        maxUses: 1, uses: 0, allowGuests: true, allowSpeak: true, allowMessages: true, allowFiles: false, allowStream: false,
        notBefore: timestampFromMs(occ.startMs - ACTIVE_BEFORE_MS), expiresAt: timestampFromMs(occ.endMs + 3_600_000), eventId: rec.ev.id,
        createdAt: tick(this.state),
      });
      this.state.roomInvites.set(id, inv);
      rec.guestLinks.set(addr, id);
    }
    return `${this.url}/r/${inv.code}`;
  }

  /** EVENT_* to everyone who may see the event, each with their view of the addresses. */
  private calPublish(rec: CalEventRec, kind: 'eventCreate' | 'eventUpdate' | 'eventDelete'): void {
    this.fanout((u) => {
      const v = this.calView(rec, u);
      if (!v) return null;
      return { event: { case: kind, value: { event: eventOut(rec, null, v.view, '', false) } } };
    });
  }

  private calActive(rec: CalEventRec, occ: Occurrence): void {
    const ev = rec.ev;
    this.fanout((u) => {
      const room = this.state.rooms.get(ev.roomId);
      if (this.calGuestSees(rec, u)) {
        return { event: { case: 'roomEventActive', value: { workspaceId: ev.workspaceId, roomId: ev.roomId, event: eventForGuest(eventOut(rec, occ, 'none', '', false)) } } };
      }
      const v = this.calView(rec, u);
      if (!room || !v || !this.canView(room, u)) return null;
      return { event: { case: 'roomEventActive', value: { workspaceId: ev.workspaceId, roomId: ev.roomId, event: eventOut(rec, occ, v.view, '', false) } } };
    });
  }

  private calEnded(rec: CalEventRec, occ: Occurrence): void {
    const ev = rec.ev;
    this.fanout((u) => {
      const room = this.state.rooms.get(ev.roomId);
      const m = this.member(ev.workspaceId, u);
      if (!room || !m || !this.canView(room, u)) return null; // guests of the room too
      return { event: { case: 'roomEventEnded', value: { workspaceId: ev.workspaceId, roomId: ev.roomId, eventId: ev.id, occurrenceAt: timestampFromMs(occ.startMs) } } };
    });
  }

  private calNow(): number {
    return this.clockMs ?? Date.now();
  }

  /** Validates a request's timing / room / attendees like the server (calendar/input.go, simplified). */
  private calCheck(wsId: string, me: string, f: { title: string; description: string; startMs: number; endMs: number; roomId: string; repeatUntilMs: number },
    attendees: readonly { userId: string; email: string; required: boolean }[]): CalendarEventAttendee[] {
    const title = f.title.trim();
    if (!title || Array.from(title).length > 120) throw invalid('title', 'title must be 1..120 characters');
    if (Array.from(f.description).length > 4000) throw invalid('description', 'description must be at most 4000 characters');
    if (!f.startMs || !f.endMs) throw invalid('startsAt', 'startsAt and endsAt are required');
    if (f.endMs <= f.startMs) throw invalid('endsAt', 'endsAt must be after startsAt');
    if (f.endMs - f.startMs > 7 * 86_400_000 + 3_600_000) throw invalid('endsAt', 'a meeting lasts at most 7 days');
    if (f.repeatUntilMs && f.repeatUntilMs < f.startMs) throw invalid('repeatUntil', 'repeatUntil must not be before startsAt');
    if (f.roomId) {
      const room = this.state.rooms.get(f.roomId);
      if (!room || room.workspaceId !== wsId || !this.canView(room, me)) throw invalid('roomId', 'no such room in this workspace');
      if (room.type !== RoomType.VOICE) throw invalid('roomId', 'a meeting room must be a voice room');
    }
    const out: CalendarEventAttendee[] = [];
    const seen = new Set<string>();
    let externals = 0;
    for (const a of attendees) {
      if (a.userId && a.email) throw invalid('attendees', 'an attendee is a user or an email, not both');
      if (a.userId) {
        const u = this.state.users.get(a.userId);
        const m = this.member(wsId, a.userId);
        if (!u || !m || u.user.isBot || m.role === WorkspaceRole.GUEST) throw invalid('attendees', 'attendees must be members of the workspace (not bots or guests)');
      } else {
        if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a.email.trim())) throw invalid('attendees', 'invalid email address');
        externals++;
      }
      const key = a.userId ? `u:${a.userId}` : `e:${a.email.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(create(CalendarEventAttendeeSchema, { userId: a.userId, email: a.userId ? '' : a.email.trim().toLowerCase(), required: a.required, status: AttendeeStatus.PENDING }));
    }
    if (externals > 20) throw invalid('attendees', 'at most 20 external email addresses');
    if (out.length + (out.some((a) => a.userId === me) ? 0 : 1) > 100) throw invalid('attendees', 'at most 100 attendees');
    return out;
  }

  /** Creates a meeting (POST …/events and addEvent()): EVENT_CREATE, ROOM_EVENT_ACTIVE when active now. */
  addEvent(a: AddEventArgs): CalendarEvent {
    const organizer = a.organizerId ?? IDS.users.anna;
    const attendees = this.calCheck(a.workspaceId, organizer,
      { title: a.title, description: a.description ?? '', startMs: a.startMs, endMs: a.endMs, roomId: a.roomId ?? '', repeatUntilMs: a.repeatUntilMs ?? 0 },
      (a.attendees ?? []).map((x) => ({ userId: x.userId ?? '', email: x.email ?? '', required: x.required ?? true })));
    const nowMs = this.calNow();
    for (const [i, x] of (a.attendees ?? []).entries()) {
      const at = attendees[i];
      if (at && x.status !== undefined) {
        at.status = x.status;
        at.respondedAt = timestampFromMs(nowMs);
      }
    }
    const me = attendees.find((x) => x.userId === organizer);
    if (me) {
      me.status = AttendeeStatus.ACCEPTED;
      me.required = true;
    } else {
      attendees.unshift(create(CalendarEventAttendeeSchema, { userId: organizer, required: true, status: AttendeeStatus.ACCEPTED, respondedAt: timestampFromMs(nowMs) }));
    }
    const id = nextId(this.state, 'event');
    const ev = create(CalendarEventSchema, {
      id, workspaceId: a.workspaceId, roomId: a.roomId ?? '', title: a.title.trim(), description: a.description ?? '',
      startsAt: timestampFromMs(a.startMs), endsAt: timestampFromMs(a.endMs), allDay: a.allDay ?? false, tz: a.tz ?? 'UTC',
      organizerId: organizer, record: a.record ?? false, repeat: a.repeat ?? EventRepeat.UNSPECIFIED,
      ...(a.repeatUntilMs ? { repeatUntil: timestampFromMs(a.repeatUntilMs) } : {}),
      attendees, createdAt: timestampFromMs(nowMs), updatedAt: timestampFromMs(nowMs),
    });
    const rec: CalEventRec = { ev, exceptions: new Set(), recordings: new Map() };
    this.calEvents.set(id, rec);
    this.calPublish(rec, 'eventCreate');
    const occ = activeOccurrence(rec, nowMs);
    if (occ) this.calActive(rec, occ);
    return eventOut(rec, null, 'full', '', false);
  }

  /** An attendee's answer (PUT …/rsvp and rsvp()): EVENT_RSVP to everyone who sees the event. */
  rsvpEvent(eventId: string, userId: string, status: AttendeeStatus): CalendarEvent {
    const rec = this.calEvents.get(eventId);
    if (!rec || rec.ev.cancelledAt) throw notFound('event not found');
    const a = rec.ev.attendees.find((x) => x.userId === userId);
    if (!a) throw forbidden('only attendees answer');
    if (![AttendeeStatus.ACCEPTED, AttendeeStatus.DECLINED, AttendeeStatus.MAYBE].includes(status)) throw invalid('status', 'status must be ACCEPTED, DECLINED or MAYBE');
    a.status = status;
    a.respondedAt = timestampFromMs(this.calNow());
    this.calRsvpEvent(rec, a);
    return eventOut(rec, null, 'full', userId, false);
  }

  private calRsvpEvent(rec: CalEventRec, a: CalendarEventAttendee): void {
    this.fanout((u) => {
      const v = this.calView(rec, u);
      if (!v) return null;
      const out = eventOut(rec, null, v.view, '', false);
      const attendee = out.attendees.find((x) => (a.userId ? x.userId === a.userId : x.email && (v.view === 'full' ? x.email === a.email : true))) ?? a;
      return { event: { case: 'eventRsvp', value: { workspaceId: rec.ev.workspaceId, eventId: rec.ev.id, attendee, counts: counts(rec.ev.attendees), event: out } } };
    });
  }

  /** EVENT_REMINDER to one user (the server's sweeper, `minutes` before the occurrence). */
  emitReminder(eventId: string, userId: string, minutes: number, occurrenceAtMs?: number): void {
    const rec = this.calEvents.get(eventId);
    if (!rec) throw notFound('event not found');
    const first = occurrences(rec, occurrenceAtMs ?? this.calNow(), Infinity)[0];
    const occ = occurrenceAtMs !== undefined ? { startMs: occurrenceAtMs, endMs: occurrenceAtMs + (first ? first.endMs - first.startMs : 0) } : first;
    if (!occ) throw notFound('no occurrence ahead');
    const v = this.calView(rec, userId);
    this.toUser(userId, {
      event: { case: 'eventReminder', value: { event: eventOut(rec, occ, v?.view ?? 'full', userId, v?.canEdit ?? false), occurrenceAt: timestampFromMs(occ.startMs), minutes } },
    });
  }

  /** ROOM_EVENT_ACTIVE (true) / ROOM_EVENT_ENDED (false) of an occurrence, like the sweeper. */
  setEventActive(eventId: string, active: boolean, occurrenceAtMs?: number): void {
    const rec = this.calEvents.get(eventId);
    if (!rec?.ev.roomId) throw notFound('event with a room not found');
    const first = occurrences(rec, occurrenceAtMs ?? this.calNow() - 86_400_000, Infinity)[0];
    if (!first) throw notFound('no occurrence');
    const occ = occurrenceAtMs !== undefined ? { startMs: occurrenceAtMs, endMs: occurrenceAtMs + first.endMs - first.startMs } : first;
    if (active) this.calActive(rec, occ);
    else this.calEnded(rec, occ);
  }

  /** The recording of an occurrence (the organizer started it in the meeting window, ADR-0038 §6). */
  setEventRecording(eventId: string, occurrenceAtMs: number, recordingId: string): void {
    const rec = this.calEvents.get(eventId);
    if (!rec) throw notFound('event not found');
    rec.recordings.set(occurrenceAtMs, recordingId);
  }

  /** Meetings active now in the rooms a member sees (WorkspaceSnapshot.active_events); guests: without attendees. */
  private activeEvents(wsId: string, userId: string): CalendarEvent[] {
    const now = this.calNow();
    const out: CalendarEvent[] = [];
    for (const rec of this.calEvents.values()) {
      if (rec.ev.workspaceId !== wsId) continue;
      const v = this.calView(rec, userId);
      const room = this.state.rooms.get(rec.ev.roomId);
      const occ = activeOccurrence(rec, now);
      if (occ && this.calGuestSees(rec, userId)) out.push(eventForGuest(eventOut(rec, occ, 'none', '', false)));
      else if (v && occ && room && this.canView(room, userId)) out.push(eventOut(rec, occ, v.view, userId, v.canEdit));
    }
    return out;
  }

  // ------------------------------------------------ task boards (ADR-0042, mock-boards.ts)

  /** A board route: BoardError → the HTTP error the server would send. */
  private boardRoute(method: string, pattern: string, h: (c: Ctx, me: string) => void | Promise<void>): void {
    this.route(method, pattern, async (c) => {
      const me = this.uid(c);
      try {
        await h(c, me);
      } catch (e) {
        if (e instanceof BoardError) {
          const extra = {
            ...(e.reason ? { reason: e.reason } : {}),
            ...(e.counts.used !== undefined ? { used: BigInt(e.counts.used) } : {}),
            ...(e.counts.limit !== undefined ? { limit: BigInt(e.counts.limit) } : {}),
          };
          throw new HttpError(e.status, e.code, e.message, e.field, extra);
        }
        throw e;
      }
    });
  }

  private boardRoutes(): void {
    const b = (): BoardsMock => this.boards;
    const q = (c: Ctx, k: string): string => c.url.searchParams.get(k) ?? '';
    const taskRes = (id: string, me: string, full = false): MessageInitShape<typeof TaskResponseSchema> => {
      if (!full) {
        const t = b().tasks.get(id);
        return t ? { task: b().taskOut(t, me, true) } : {};
      }
      const g = b().getTask(id, me);
      return { task: g.task, subtasks: g.subtasks, related: g.related, ...(g.parent ? { parent: g.parent } : {}), ...(g.room ? { room: this.roomOut(g.room) } : {}), board: g.board };
    };
    const filterOf = (c: Ctx): TaskFilter | undefined => {
      const raw = q(c, 'filter');
      if (!raw) return undefined;
      try {
        return fromJson(TaskFilterSchema, JSON.parse(raw) as JsonValue, JSON_READ);
      } catch {
        throw invalid('filter', 'malformed filter');
      }
    };

    this.boardRoute('GET', '/api/workspaces/:id/boards', (c, me) => {
      sendMsg(c.res, 200, ListBoardsResponseSchema, { boards: b().listBoards(c.params[0] ?? '', me, q(c, 'archived') === '1') });
    });
    this.boardRoute('POST', '/api/workspaces/:id/boards', (c, me) => {
      const r = parseBody(c, CreateBoardRequestSchema);
      const rec = b().createBoard(c.params[0] ?? '', me, r);
      sendMsg(c.res, 201, BoardResponseSchema, { board: b().boardOut(rec, me, { personal: true }) });
    });
    this.boardRoute('GET', '/api/boards/:id', (c, me) => sendMsg(c.res, 200, BoardResponseSchema, { board: b().getBoard(c.params[0] ?? '', me) }));
    this.boardRoute('PATCH', '/api/boards/:id', (c, me) => {
      const r = parseBody(c, UpdateBoardRequestSchema);
      sendMsg(c.res, 200, BoardResponseSchema, { board: b().updateBoard(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('DELETE', '/api/boards/:id', (c, me) => {
      b().removeBoard(c.params[0] ?? '', me, q(c, 'purge') === '1');
      noContent(c.res);
    });
    this.boardRoute('POST', '/api/boards/:id/restore', (c, me) => sendMsg(c.res, 200, BoardResponseSchema, { board: b().restoreBoard(c.params[0] ?? '', me) }));
    this.boardRoute('PUT', '/api/boards/:id/position', (c, me) => {
      const r = parseBody(c, SetBoardPositionRequestSchema);
      sendMsg(c.res, 200, BoardResponseSchema, { board: b().moveBoard(c.params[0] ?? '', me, r.position, r.categoryId) });
    });
    // ADR-0058 §1: board categories and one-drop ordering.
    this.boardRoute('GET', '/api/workspaces/:id/board-categories', (c, me) => sendMsg(c.res, 200, ListBoardCategoriesResponseSchema, { categories: b().listCategories(c.params[0] ?? '', me) }));
    this.boardRoute('POST', '/api/workspaces/:id/board-categories', (c, me) => {
      const r = parseBody(c, CreateBoardCategoryRequestSchema);
      sendMsg(c.res, 201, BoardCategoryResponseSchema, { category: b().createCategory(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('PATCH', '/api/board-categories/:id', (c, me) => {
      const r = parseBody(c, UpdateBoardCategoryRequestSchema);
      sendMsg(c.res, 200, BoardCategoryResponseSchema, { category: b().updateCategory(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('DELETE', '/api/board-categories/:id', (c, me) => {
      b().deleteCategory(c.params[0] ?? '', me);
      noContent(c.res);
    });
    this.boardRoute('PUT', '/api/workspaces/:id/boards/order', (c, me) => {
      const r = parseBody(c, SetBoardOrderRequestSchema);
      sendMsg(c.res, 200, SetBoardOrderResponseSchema, b().setOrder(c.params[0] ?? '', me, r));
    });
    // ADR-0058 §4: the board webhook (people only — the mock has no bot tokens on these routes).
    this.boardRoute('GET', '/api/boards/:id/webhook', (c, me) => sendMsg(c.res, 200, BoardWebhookResponseSchema, b().getWebhook(c.params[0] ?? '', me)));
    this.boardRoute('PUT', '/api/boards/:id/webhook', (c, me) => {
      const r = parseBody(c, SetBoardWebhookRequestSchema);
      sendMsg(c.res, 200, BoardWebhookResponseSchema, b().setWebhook(c.params[0] ?? '', me, r));
    });
    this.boardRoute('DELETE', '/api/boards/:id/webhook', (c, me) => {
      b().deleteWebhook(c.params[0] ?? '', me);
      noContent(c.res);
    });
    this.boardRoute('POST', '/api/boards/:id/webhook/ping', (c, me) => sendMsg(c.res, 200, BoardWebhookPingResponseSchema, b().pingWebhook(c.params[0] ?? '', me)));
    // ADR-0058 §2: checklists (TASK_CHECKLIST_* events, no TASK_UPDATE).
    this.boardRoute('POST', '/api/tasks/:id/checklists', (c, me) => {
      const r = parseBody(c, CreateTaskChecklistRequestSchema);
      sendMsg(c.res, 201, TaskChecklistResponseSchema, b().createChecklist(c.params[0] ?? '', me, r));
    });
    this.boardRoute('PATCH', '/api/checklists/:id', (c, me) => {
      const r = parseBody(c, UpdateTaskChecklistRequestSchema);
      sendMsg(c.res, 200, TaskChecklistResponseSchema, b().updateChecklist(c.params[0] ?? '', me, r));
    });
    this.boardRoute('DELETE', '/api/checklists/:id', (c, me) => sendMsg(c.res, 200, TaskChecklistResponseSchema, b().deleteChecklist(c.params[0] ?? '', me)));
    this.boardRoute('POST', '/api/checklists/:id/items', (c, me) => {
      const r = parseBody(c, CreateTaskChecklistItemRequestSchema);
      sendMsg(c.res, 201, TaskChecklistResponseSchema, b().addChecklistItem(c.params[0] ?? '', me, r));
    });
    this.boardRoute('PATCH', '/api/checklist-items/:id', (c, me) => {
      const r = parseBody(c, UpdateTaskChecklistItemRequestSchema);
      sendMsg(c.res, 200, TaskChecklistResponseSchema, b().updateChecklistItem(c.params[0] ?? '', me, r));
    });
    this.boardRoute('DELETE', '/api/checklist-items/:id', (c, me) => sendMsg(c.res, 200, TaskChecklistResponseSchema, b().deleteChecklistItem(c.params[0] ?? '', me)));
    this.boardRoute('POST', '/api/checklist-items/:id/convert', (c, me) => sendMsg(c.res, 201, ConvertChecklistItemResponseSchema, b().convertChecklistItem(c.params[0] ?? '', me)));
    this.boardRoute('GET', '/api/boards/:id/permissions', (c, me) => {
      const board = b().getBoard(c.params[0] ?? '', me);
      if (!(board.permissions & MANAGE_BOARD)) throw forbidden('MANAGE_BOARD required');
      sendMsg(c.res, 200, BoardPermissionsResponseSchema, { overrides: board.permissionOverrides, board });
    });
    this.boardRoute('PUT', '/api/boards/:id/permissions', (c, me) => {
      const r = parseBody(c, SetBoardPermissionsRequestSchema);
      const board = b().setPermissions(c.params[0] ?? '', me, r.overrides);
      sendMsg(c.res, 200, BoardPermissionsResponseSchema, { overrides: board.permissionOverrides, board });
    });
    // statuses / labels / milestones
    this.boardRoute('POST', '/api/boards/:id/statuses', (c, me) => {
      const r = parseBody(c, CreateBoardStatusRequestSchema);
      sendMsg(c.res, 201, BoardResponseSchema, { board: b().createStatus(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('PATCH', '/api/boards/:id/statuses/:sid', (c, me) => {
      const r = parseBody(c, UpdateBoardStatusRequestSchema);
      sendMsg(c.res, 200, BoardResponseSchema, { board: b().updateStatus(c.params[0] ?? '', me, c.params[1] ?? '', r) });
    });
    this.boardRoute('DELETE', '/api/boards/:id/statuses/:sid', (c, me) => {
      b().deleteStatus(c.params[0] ?? '', me, c.params[1] ?? '', q(c, 'move_to'));
      noContent(c.res);
    });
    this.boardRoute('POST', '/api/boards/:id/labels', (c, me) => {
      const r = parseBody(c, CreateBoardLabelRequestSchema);
      sendMsg(c.res, 201, BoardResponseSchema, { board: b().createLabel(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('PATCH', '/api/boards/:id/labels/:lid', (c, me) => {
      const r = parseBody(c, UpdateBoardLabelRequestSchema);
      sendMsg(c.res, 200, BoardResponseSchema, { board: b().updateLabel(c.params[0] ?? '', me, c.params[1] ?? '', r) });
    });
    this.boardRoute('DELETE', '/api/boards/:id/labels/:lid', (c, me) => {
      b().deleteLabel(c.params[0] ?? '', me, c.params[1] ?? '');
      noContent(c.res);
    });
    this.boardRoute('POST', '/api/boards/:id/milestones', (c, me) => {
      const r = parseBody(c, CreateBoardMilestoneRequestSchema);
      sendMsg(c.res, 201, BoardResponseSchema, { board: b().createMilestone(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('PATCH', '/api/boards/:id/milestones/:mid', (c, me) => {
      const r = parseBody(c, UpdateBoardMilestoneRequestSchema);
      sendMsg(c.res, 200, BoardResponseSchema, { board: b().updateMilestone(c.params[0] ?? '', me, c.params[1] ?? '', r) });
    });
    this.boardRoute('DELETE', '/api/boards/:id/milestones/:mid', (c, me) => {
      b().deleteMilestone(c.params[0] ?? '', me, c.params[1] ?? '');
      noContent(c.res);
    });
    // views
    this.boardRoute('GET', '/api/boards/:id/views', (c, me) => sendMsg(c.res, 200, ListBoardViewsResponseSchema, { views: b().getBoard(c.params[0] ?? '', me).views }));
    this.boardRoute('POST', '/api/boards/:id/views', (c, me) => {
      const r = parseBody(c, CreateBoardViewRequestSchema);
      sendMsg(c.res, 201, BoardViewResponseSchema, { view: b().createView(c.params[0] ?? '', me, r) });
    });
    this.boardRoute('PATCH', '/api/boards/:id/views/:vid', (c, me) => {
      const r = parseBody(c, UpdateBoardViewRequestSchema);
      sendMsg(c.res, 200, BoardViewResponseSchema, { view: b().updateView(c.params[0] ?? '', me, c.params[1] ?? '', r) });
    });
    this.boardRoute('DELETE', '/api/boards/:id/views/:vid', (c, me) => {
      b().deleteView(c.params[0] ?? '', me, c.params[1] ?? '');
      noContent(c.res);
    });
    // files of task descriptions and comments (quota of the workspace)
    this.boardRoute('POST', '/api/boards/:id/files', async (c, me) => {
      const board = b().getBoard(c.params[0] ?? '', me);
      const ws = this.state.workspaces.get(board.workspaceId);
      if (!ws) throw notFound('board not found');
      const f = await parseMultipartFile(c);
      if (f.bytes.length > 50 * 1024 * 1024) throw new HttpError(413, ErrorCode.FILE_TOO_LARGE, 'file too large');
      const id = this.storeFile(ws.id, me, f, parseVoice(c, f));
      ws.storageUsedBytes += BigInt(f.bytes.length);
      sendMsg(c.res, 201, UploadFileResponseSchema, { file: this.state.files.get(id)?.meta });
    });
    // tasks
    this.boardRoute('GET', '/api/boards/:id/tasks', (c, me) => {
      const r = b().listTasks(c.params[0] ?? '', me, {
        filter: filterOf(c),
        archived: q(c, 'archived') === '1',
        cursor: q(c, 'cursor'),
        limit: Number(q(c, 'limit')) || 500,
        nowMs: timestampMs(this.callNow()),
      });
      sendMsg(c.res, 200, ListTasksResponseSchema, r);
    });
    this.boardRoute('POST', '/api/boards/:id/tasks', (c, me) => {
      const r = parseBody(c, CreateTaskRequestSchema);
      const t = b().createTask(c.params[0] ?? '', me, r);
      sendMsg(c.res, 201, TaskResponseSchema, taskRes(t.task.id, me));
    });
    this.boardRoute('GET', '/api/tasks/:id', (c, me) => sendMsg(c.res, 200, TaskResponseSchema, taskRes(c.params[0] ?? '', me, true)));
    this.boardRoute('GET', '/api/t/:key', (c, me) => sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().byKey(c.params[0] ?? '', me), me, true)));
    this.boardRoute('PATCH', '/api/tasks/:id', (c, me) => {
      const r = parseBody(c, UpdateTaskRequestSchema);
      const t = b().updateTask(c.params[0] ?? '', me, r);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(t.task.id, me));
    });
    this.boardRoute('POST', '/api/tasks/:id/archive', (c, me) => sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().archiveTask(c.params[0] ?? '', me, true).task.id, me)));
    this.boardRoute('POST', '/api/tasks/:id/restore', (c, me) => sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().archiveTask(c.params[0] ?? '', me, false).task.id, me)));
    this.boardRoute('PUT', '/api/tasks/:id/assignees', (c, me) => {
      const r = parseBody(c, SetAssigneesRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setAssignees(c.params[0] ?? '', me, r.assignees).task.id, me));
    });
    // ADR-0049: approvers + quorum, and my vote.
    this.boardRoute('PUT', '/api/tasks/:id/approvers', (c, me) => {
      const r = parseBody(c, SetTaskApproversRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setApprovers(c.params[0] ?? '', me, r.userIds, r.required).task.id, me));
    });
    this.boardRoute('POST', '/api/tasks/:id/approval', (c, me) => {
      const r = parseBody(c, TaskApprovalRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().vote(c.params[0] ?? '', me, r.decision, r.comment).task.id, me));
    });
    this.boardRoute('PUT', '/api/tasks/:id/relations', (c, me) => {
      const r = parseBody(c, SetTaskRelationRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setRelation(c.params[0] ?? '', me, r.relatedId, r.kind, true).task.id, me, true));
    });
    this.boardRoute('DELETE', '/api/tasks/:id/relations', (c, me) => {
      const kind: TaskRelationKind = Number(q(c, 'kind'));
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setRelation(c.params[0] ?? '', me, q(c, 'related_id'), kind, false).task.id, me, true));
    });
    // ADR-0076: watchers.
    this.boardRoute('PUT', '/api/tasks/:id/watchers', (c, me) => {
      const r = parseBody(c, SetTaskWatcherRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setWatcher(c.params[0] ?? '', me, r.userId, true).task.id, me));
    });
    this.boardRoute('DELETE', '/api/tasks/:id/watchers', (c, me) => {
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setWatcher(c.params[0] ?? '', me, q(c, 'user_id'), false).task.id, me));
    });
    this.boardRoute('PUT', '/api/tasks/:id/subscription', (c, me) => {
      const r = parseBody(c, SetTaskSubscriptionRequestSchema);
      sendMsg(c.res, 200, TaskResponseSchema, taskRes(b().setSubscription(c.params[0] ?? '', me, r.muted).task.id, me));
    });
    this.boardRoute('PUT', '/api/tasks/:id/read', (c, me) => {
      b().markRead(c.params[0] ?? '', me);
      noContent(c.res);
    });
    this.boardRoute('GET', '/api/tasks/:id/activity', (c, me) => {
      const r = b().feed(c.params[0] ?? '', me, q(c, 'before'), Number(q(c, 'limit')) || 50);
      sendMsg(c.res, 200, TaskActivityPageSchema, {
        items: r.items.map((x) => (x.message ? { item: { case: 'message' as const, value: this.msgOut(x.message, me) } } : { item: { case: 'activity' as const, value: x.activity as TaskActivity } })),
        hasMore: r.hasMore,
      });
    });
    this.boardRoute('GET', '/api/me/tasks', (c, me) => {
      sendMsg(c.res, 200, MyTasksResponseSchema, { tasks: b().mine(q(c, 'workspace_id'), me, q(c, 'scope') || 'assigned', q(c, 'open') === '1'), nextCursor: '' });
    });
    this.boardRoute('GET', '/api/workspaces/:id/tasks/search', (c, me) => {
      sendMsg(c.res, 200, SearchTasksResponseSchema, { tasks: b().search(c.params[0] ?? '', me, q(c, 'q'), Number(q(c, 'limit')) || 20) });
    });
    // Test control: an update of a task by another user (TASK_UPDATE fan-out as the server would).
    this.route('POST', '/__mock/task', (c) => {
      const body = JSON.parse(c.raw.toString('utf8') || '{}') as { taskId?: string; key?: string; actorId?: string; title?: string; statusId?: string };
      const id = body.taskId ?? this.boards.taskByKey(body.key ?? '')?.task.id ?? '';
      const task = this.updateTaskAs(body.actorId ?? IDS.users.boris, id, { ...(body.title ? { title: body.title } : {}), ...(body.statusId ? { statusId: body.statusId } : {}) });
      send(c.res, 200, JSON.stringify(toJson(TaskSchema, task, JSON_WRITE)), 'application/json');
    });
  }

  /** A task change by `actorId` (tests: «someone else edits a task»); fans out TASK_UPDATE. */
  updateTaskAs(actorId: string, taskId: string, patch: { title?: string; statusId?: string }): Task {
    return this.boards.updateAs(actorId, taskId, patch);
  }

  /** Scenario `data`: comments on CAL-3 in its task room (Борис, Анна, a reaction). */
  private seedBoards(): void {
    if (this.state.scenario !== 'data') return;
    this.boards.seed();
    const t3 = this.boards.taskByKey('CAL-3');
    if (!t3) return;
    const room = this.state.rooms.get(t3.task.roomId);
    if (!room) return;
    const list: Message[] = [];
    // Own id range: the fixture message counter (runtime messages) is not shifted.
    const add = (authorId: string, content: string, at: string): Message => {
      const m = create(MessageSchema, { id: mockId('message', 0xb000 + list.length), roomId: room.id, authorId, content, createdAt: ts(at) });
      list.push(m);
      return m;
    };
    add(IDS.users.boris, 'Воспроизвёл: Windows 11, колонки Logitech, эхо появляется через ~10 секунд после входа.', '2026-01-14T09:10:00Z');
    const m2 = add(IDS.users.anna, `@${IDS.users.boris} проверю на Mac со встроенными динамиками сегодня.`, '2026-01-14T09:25:00Z');
    this.state.messages.set(room.id, list);
    this.state.reactions.set(m2.id, new Map([['👍', new Set([IDS.users.boris])]]));
    m2.reactions = [create(ReactionSchema, { emoji: '👍', count: 1, me: false })];
    t3.task.commentCount = list.length;
  }

  private newBoards(): BoardsMock {
    return new BoardsMock({
      state: this.state,
      member: (w, u) => this.member(w, u),
      rolesOf: (m) => this.memberRoles(m),
      ownerOf: (w) => this.state.workspaces.get(w)?.ownerId ?? '',
      fanout: (pick) => this.fanout(pick),
      tick: () => tick(this.state),
    });
  }

  private calendarRoutes(): void {
    const ms = (t: Timestamp | undefined): number => (t ? timestampMs(t) : 0);
    const viewer = (wsId: string, userId: string): void => {
      const { m } = this.workspaceFor(wsId, userId);
      if (m.role === WorkspaceRole.GUEST) throw forbidden('the calendar is not available for guests');
    };
    const notBot = (userId: string): void => {
      if (this.state.users.get(userId)?.user.isBot) throw new HttpError(403, ErrorCode.FORBIDDEN, 'not available for bots', '', { reason: 'BOT_NOT_ALLOWED' });
    };

    this.route('GET', '/api/workspaces/:id/events', (c) => {
      const me = this.uid(c);
      const wsId = c.params[0] ?? '';
      viewer(wsId, me);
      const from = Date.parse(c.url.searchParams.get('from') ?? '');
      const to = Date.parse(c.url.searchParams.get('to') ?? '');
      if (Number.isNaN(from) || Number.isNaN(to)) throw invalid('from', 'from and to are RFC 3339 times');
      if (to <= from || to - from > 62 * 86_400_000) throw invalid('to', 'to must be after from, at most 62 days later');
      const rows: { rec: CalEventRec; occ: Occurrence; v: { view: EmailView; canEdit: boolean } }[] = [];
      for (const rec of this.calEvents.values()) {
        if (rec.ev.workspaceId !== wsId || rec.ev.cancelledAt) continue;
        const v = this.calView(rec, me);
        if (!v) continue;
        for (const occ of occurrences(rec, from, to)) rows.push({ rec, occ, v });
      }
      rows.sort((a, b) => a.occ.startMs - b.occ.startMs || a.occ.endMs - b.occ.endMs);
      sendMsg(c.res, 200, ListCalendarEventsResponseSchema, { events: rows.map((r) => eventOut(r.rec, r.occ, r.v.view, me, r.v.canEdit)) });
    });

    this.route('POST', '/api/workspaces/:id/events', (c) => {
      const me = this.uid(c);
      notBot(me);
      const wsId = c.params[0] ?? '';
      viewer(wsId, me);
      const b = parseBody(c, CreateCalendarEventRequestSchema);
      const created = this.addEvent({
        workspaceId: wsId, organizerId: me, title: b.title, description: b.description, startMs: ms(b.startsAt), endMs: ms(b.endsAt),
        allDay: b.allDay, tz: b.tz || 'UTC', record: b.record, roomId: b.roomId, repeat: b.repeat, repeatUntilMs: ms(b.repeatUntil),
        attendees: b.attendees.map((x) => ({ userId: x.userId, email: x.email, required: x.required })),
      });
      const { rec, canEdit } = this.calRec(created.id, me);
      sendMsg(c.res, 201, CalendarEventResponseSchema, { event: eventOut(rec, null, 'full', me, canEdit) });
    });

    this.route('GET', '/api/events/:id', (c) => {
      const me = this.uid(c);
      const g = this.calEvents.get(c.params[0] ?? '');
      if (g && this.calGuestSees(g, me)) {
        // A guest: the occurrence active now in a room it sees, without attendees; else 404.
        const occ = activeOccurrence(g, this.calNow());
        if (!occ) throw notFound('event not found');
        sendMsg(c.res, 200, CalendarEventResponseSchema, { event: eventForGuest(eventOut(g, occ, 'none', '', false)) });
        return;
      }
      const { rec, view, canEdit } = this.calRec(c.params[0] ?? '', me);
      sendMsg(c.res, 200, CalendarEventResponseSchema, { event: eventOut(rec, null, view, me, canEdit) });
    });

    this.route('PATCH', '/api/events/:id', (c) => {
      const me = this.uid(c);
      notBot(me);
      const { rec, canEdit } = this.calRec(c.params[0] ?? '', me);
      if (rec.ev.cancelledAt) throw notFound('event not found');
      if (!canEdit) throw forbidden('only the organizer or a room manager may change the meeting');
      const b = parseBody(c, UpdateCalendarEventRequestSchema);
      const ev = rec.ev;
      const next = {
        title: b.title ?? ev.title, description: b.description ?? ev.description,
        startMs: b.startsAt ? ms(b.startsAt) : ms(ev.startsAt), endMs: b.endsAt ? ms(b.endsAt) : ms(ev.endsAt),
        roomId: b.roomId ?? ev.roomId, repeatUntilMs: b.clearRepeatUntil ? 0 : b.repeatUntil ? ms(b.repeatUntil) : ms(ev.repeatUntil),
      };
      const organizer = ev.organizerId;
      const wanted = b.setAttendees
        ? this.calCheck(ev.workspaceId, me, next, b.attendees.map((x) => ({ userId: x.userId, email: x.email, required: x.required })))
        : this.calCheck(ev.workspaceId, me, next, []);
      const before = eventOut(rec, null, 'full', '', false);
      const hadActive = activeOccurrence(rec, this.calNow());
      let removed = false;
      if (b.setAttendees) {
        const keep = new Map(ev.attendees.map((a) => [a.userId ? `u:${a.userId}` : `e:${a.email}`, a]));
        const out: CalendarEventAttendee[] = [];
        if (!wanted.some((a) => a.userId === organizer)) out.push(keep.get(`u:${organizer}`) ?? create(CalendarEventAttendeeSchema, { userId: organizer, required: true, status: AttendeeStatus.ACCEPTED }));
        for (const w of wanted) {
          const old = keep.get(w.userId ? `u:${w.userId}` : `e:${w.email}`);
          out.push(old ? Object.assign(old, { required: w.userId === organizer ? true : w.required }) : w);
        }
        removed = ev.attendees.some((a) => !out.includes(a));
        ev.attendees = out;
      }
      const significant = next.title.trim() !== ev.title || next.description !== ev.description || next.startMs !== ms(ev.startsAt) ||
        next.endMs !== ms(ev.endsAt) || next.roomId !== ev.roomId || (b.repeat !== undefined && b.repeat !== ev.repeat) || next.repeatUntilMs !== ms(ev.repeatUntil);
      const roomChanged = next.roomId !== ev.roomId;
      Object.assign(ev, {
        title: next.title.trim(), description: next.description, startsAt: timestampFromMs(next.startMs), endsAt: timestampFromMs(next.endMs),
        roomId: next.roomId, allDay: b.allDay ?? ev.allDay, tz: b.tz ?? ev.tz, record: b.record ?? ev.record, repeat: b.repeat ?? ev.repeat,
        updatedAt: timestampFromMs(this.calNow()), sequence: ev.sequence + (significant || removed ? 1 : 0),
      });
      if (next.repeatUntilMs) ev.repeatUntil = timestampFromMs(next.repeatUntilMs);
      else delete ev.repeatUntil;
      if (roomChanged || removed) {
        const old: CalEventRec = { ev: before, exceptions: rec.exceptions, recordings: rec.recordings };
        this.fanout((u) => {
          const v = this.calView(old, u);
          return v ? { event: { case: 'eventDelete', value: { event: eventOut(old, null, v.view, '', false) } } } : null;
        });
      }
      this.calPublish(rec, 'eventUpdate');
      const nowActive = activeOccurrence(rec, this.calNow());
      if (hadActive && (!nowActive || nowActive.startMs !== hadActive.startMs || roomChanged)) this.calEnded({ ...rec, ev: before }, hadActive);
      if (nowActive) this.calActive(rec, nowActive);
      const { canEdit: ce } = this.calRec(ev.id, me);
      sendMsg(c.res, 200, CalendarEventResponseSchema, { event: eventOut(rec, null, 'full', me, ce) });
    });

    this.route('DELETE', '/api/events/:id', (c) => {
      const me = this.uid(c);
      notBot(me);
      const { rec, canEdit } = this.calRec(c.params[0] ?? '', me);
      if (rec.ev.cancelledAt) throw notFound('event not found');
      if (!canEdit) throw forbidden('only the organizer or a room manager may cancel the meeting');
      const active = activeOccurrence(rec, this.calNow());
      const occStr = c.url.searchParams.get('occurrence');
      if (occStr) {
        const at = Date.parse(occStr);
        const all = rec.ev.repeat === EventRepeat.UNSPECIFIED ? [] : occurrences({ ...rec, exceptions: new Set() }, at, at + 1);
        if (Number.isNaN(at) || !all.some((o) => o.startMs === at)) throw invalid('occurrence', 'not an occurrence of this series');
        if (!rec.exceptions.has(at)) {
          rec.exceptions.add(at);
          rec.ev.sequence += 1;
          this.calPublish(rec, 'eventUpdate');
          if (active?.startMs === at) this.calEnded(rec, active);
        }
        noContent(c.res);
        return;
      }
      rec.ev.cancelledAt = timestampFromMs(this.calNow());
      rec.ev.sequence += 1;
      this.calPublish(rec, 'eventDelete');
      if (active) this.calEnded(rec, active);
      noContent(c.res);
    });

    this.route('PUT', '/api/events/:id/rsvp', (c) => {
      const me = this.uid(c);
      notBot(me);
      const { rec, canEdit } = this.calRec(c.params[0] ?? '', me);
      this.rsvpEvent(rec.ev.id, me, parseBody(c, RsvpCalendarEventRequestSchema).status);
      sendMsg(c.res, 200, CalendarEventResponseSchema, { event: eventOut(rec, null, 'full', me, canEdit) });
    });

    this.route('GET', '/api/me/events/today', (c) => {
      const me = this.uid(c);
      notBot(me);
      const now = this.calNow();
      const d = new Date(now);
      const dayEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); // the mock's day is UTC
      const rows: { rec: CalEventRec; occ: Occurrence; v: { view: EmailView; canEdit: boolean } }[] = [];
      for (const rec of this.calEvents.values()) {
        if (rec.ev.cancelledAt || !involves(rec.ev, me)) continue;
        if (rec.ev.attendees.find((a) => a.userId === me)?.status === AttendeeStatus.DECLINED) continue;
        const v = this.calView(rec, me);
        if (!v) continue;
        for (const occ of occurrences(rec, now, dayEnd)) rows.push({ rec, occ, v });
      }
      rows.sort((a, b) => a.occ.startMs - b.occ.startMs);
      const events = rows.map((r) => eventOut(r.rec, r.occ, r.v.view, me, r.v.canEdit));
      sendMsg(c.res, 200, TodayCalendarEventsResponseSchema, { count: events.length, events });
    });

    // External attendees' answer page (/e/<id>/rsvp?t=…): preview and answer, no login.
    // The meeting link of that mail (/e/<id>?t=<view token>) opens the same page; a view token
    // answers nothing (POST → 400), the page answers with the response's answer tokens.
    const endedAt = (rec: CalEventRec): number => {
      const last = occurrences(rec, 0, Infinity).at(-1);
      return rec.ev.repeat === EventRepeat.UNSPECIFIED && last ? last.endMs : Infinity;
    };
    const byToken = (tok: string): { rec: CalEventRec; a: CalendarEventAttendee; status: AttendeeStatus; view: boolean } => {
      const t = parseRsvpToken(tok);
      const rec = t ? this.calEvents.get(t.eventId) : undefined;
      const a = rec?.ev.attendees.find((x) => x.email && x.email === t?.email);
      if (!t || !rec || !a) throw notFound('invitation not found');
      if (endedAt(rec) + (t.view ? 3_600_000 : 0) <= this.calNow()) throw new HttpError(410, ErrorCode.EVENT_OVER, 'the meeting is over');
      return { rec, a, status: t.status, view: t.view };
    };
    const rsvpOut = (rec: CalEventRec, a: CalendarEventAttendee, status: AttendeeStatus): MessageInitShape<typeof EventRsvpTokenResponseSchema> => {
      const occ = occurrences(rec, this.calNow(), Infinity)[0] ?? { startMs: ms(rec.ev.startsAt), endMs: ms(rec.ev.endsAt) };
      const org = this.state.users.get(rec.ev.organizerId);
      const open = !rec.ev.cancelledAt && this.calNow() < endedAt(rec);
      const inv = this.state.roomInvites.get(rec.guestLinks?.get(a.email) ?? '');
      return {
        eventId: rec.ev.id, title: rec.ev.title, startsAt: timestampFromMs(occ.startMs), endsAt: timestampFromMs(occ.endMs), allDay: rec.ev.allDay,
        tz: rec.ev.tz, organizerName: org?.user.displayName ?? '',
        workspaceName: this.state.workspaces.get(rec.ev.workspaceId)?.name ?? '', status, email: a.email, cancelled: !!rec.ev.cancelledAt,
        description: rec.ev.description, roomName: rec.ev.roomId ? (this.state.rooms.get(rec.ev.roomId)?.name ?? '') : '', myStatus: a.status,
        acceptToken: open ? rsvpToken(rec.ev.id, a.email, AttendeeStatus.ACCEPTED) : '',
        maybeToken: open ? rsvpToken(rec.ev.id, a.email, AttendeeStatus.MAYBE) : '',
        declineToken: open ? rsvpToken(rec.ev.id, a.email, AttendeeStatus.DECLINED) : '',
        ...(inv && rec.ev.roomId ? { guestUrl: `${this.url}/r/${inv.code}`, guestFrom: inv.notBefore, guestUntil: inv.expiresAt } : {}),
        repeat: rec.ev.repeat, ...(rec.ev.repeatUntil ? { repeatUntil: rec.ev.repeatUntil } : {}),
        organizerEmail: org?.emailVerified ? org.email : '',
      };
    };
    this.route('GET', '/api/event-rsvp', (c) => {
      const { rec, a, status } = byToken(c.url.searchParams.get('t') ?? '');
      sendMsg(c.res, 200, EventRsvpTokenResponseSchema, rsvpOut(rec, a, status));
    });
    this.route('POST', '/api/event-rsvp', (c) => {
      const { rec, a, status, view } = byToken(parseBody(c, EventRsvpTokenRequestSchema).token);
      if (view) throw new HttpError(400, ErrorCode.BAD_REQUEST, 'a view token cannot answer: use an answer token');
      if (rec.ev.cancelledAt) throw new HttpError(410, ErrorCode.EVENT_OVER, 'the meeting is over');
      if (a.status !== status) {
        a.status = status;
        a.respondedAt = timestampFromMs(this.calNow());
        this.calRsvpEvent(rec, a);
      }
      sendMsg(c.res, 200, EventRsvpTokenResponseSchema, rsvpOut(rec, a, status));
    });
  }

  private emitUserUpdate(u: UserRec): void {
    const me = this.me(u);
    this.fanout((recipient) =>
      recipient === u.user.id
        ? { event: { case: 'userUpdate', value: { me } } }
        : this.shareWorkspace(recipient, u.user.id)
          ? { event: { case: 'userUpdate', value: { user: u.birthdayHidden ? { ...u.user, birthday: undefined } : u.user } } }
          : null,
    );
  }

  // ------------------------------------------------ plans (ADR-0024)

  /** Effective limits of a workspace (no plan recorded = FREE, like the server). */
  private planLimits(wsId: string): PlanLimits {
    return this.state.workspaces.get(wsId)?.plan?.limits ?? FREE_PLAN_LIMITS;
  }

  /** Room media capped by the plan: what /join and /stream/request apply. */
  private cappedMedia(room: Room): RoomMediaSettings {
    const media = create(RoomMediaSettingsSchema, room.media ?? DEFAULT_MEDIA);
    const pl = this.planLimits(room.workspaceId);
    if (pl.streamMaxPreset && (!media.maxStreamPreset || media.maxStreamPreset > pl.streamMaxPreset)) media.maxStreamPreset = pl.streamMaxPreset;
    if (pl.streamsPerRoom && media.maxStreams > pl.streamsPerRoom) media.maxStreams = pl.streamsPerRoom;
    return media;
  }

  private requireSuperadmin(c: Ctx): string {
    const me = this.uid(c);
    // Like the server: the admin API does not exist for anyone else.
    if (!this.state.superadmins.has(me)) throw notFound('no such endpoint');
    return me;
  }

  /** 403 WORKSPACE_SUSPENDED on writes to a suspended workspace (docs/09 #32). */
  private requireActive(wsId: string): void {
    if (this.state.workspaces.get(wsId)?.suspension) throw new HttpError(403, ErrorCode.WORKSPACE_SUSPENDED, 'the workspace is suspended');
  }

  private adminOut(ws: Workspace): AdminWorkspace {
    const owner = this.state.users.get(ws.ownerId);
    const meta = this.state.planMeta.get(ws.id);
    const members = this.membersOf(ws.id).filter((m) => m.role !== WorkspaceRole.GUEST).length;
    const rooms = [...this.state.rooms.values()].filter((r) => r.workspaceId === ws.id).length;
    const bots = this.membersOf(ws.id).filter((m) => this.state.users.get(m.userId)?.user.isBot).length;
    const stickerPacks = [...this.state.stickerPacks.values()].filter((p) => p.workspaceId === ws.id).length;
    let last: Timestamp | undefined;
    for (const r of this.state.rooms.values()) {
      if (r.workspaceId !== ws.id) continue;
      const at = this.state.messages.get(r.id)?.at(-1)?.createdAt;
      if (at && (!last || timestampMs(at) > timestampMs(last))) last = at;
    }
    const mb = (ws.storageUsedBytes + 1024n * 1024n - 1n) / (1024n * 1024n);
    return create(AdminWorkspaceSchema, {
      workspace: ws,
      ...(owner ? { owner: owner.user } : {}),
      ownerEmail: owner?.email ?? '',
      usage: { members, rooms, bots, stickerPacks, storageMb: mb, storageBytes: ws.storageUsedBytes, ...(last ? { lastActivity: last } : {}) },
      planNote: meta?.note ?? '',
      planUpdatedBy: meta?.updatedBy ?? '',
      ...(meta?.updatedAt ? { planUpdatedAt: meta.updatedAt } : {}),
      suspendedBy: this.state.suspendedBy.get(ws.id) ?? '',
      suspendedByEmail: this.state.users.get(this.state.suspendedBy.get(ws.id) ?? '')?.email ?? '',
    });
  }

  private storeFile(wsId: string, uploaderId: string, f: { name: string; mime: string; bytes: Buffer }, voice?: { durationMs: number; waveform: Uint8Array }): string {
    const id = nextId(this.state, 'file');
    const size = f.mime === 'image/png' ? pngSize(f.bytes) : null;
    const meta = fileMeta(id, wsId, uploaderId, f.name, voice ? 'audio/ogg' : f.mime, f.bytes, tick(this.state), size);
    if (voice) meta.voice = create(VoiceInfoSchema, voice);
    this.state.files.set(id, { meta, bytes: f.bytes, ...(f.mime.startsWith('image/') ? { thumbnail: { bytes: f.bytes, mime: f.mime } } : {}) });
    return id;
  }
}

// ---------------------------------------------------------------- CLI

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = process.env;
  const name = arg(argv, 'scenario') ?? env['MOCK_SCENARIO'] ?? 'data';
  const scenario = SCENARIOS.find((x) => x === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const staticDir = arg(argv, 'static') ?? env['MOCK_STATIC_DIR'];
  const livekitUrl = arg(argv, 'livekit-url') ?? env['MOCK_LIVEKIT_URL'];
  const livekitKey = arg(argv, 'livekit-key') ?? env['MOCK_LIVEKIT_KEY'];
  const livekitSecret = arg(argv, 'livekit-secret') ?? env['MOCK_LIVEKIT_SECRET'];
  const server = await startMockServer({
    port: Number(arg(argv, 'port') ?? env['MOCK_PORT'] ?? 3900),
    host: arg(argv, 'host') ?? env['MOCK_HOST'] ?? '127.0.0.1',
    scenario,
    ...(staticDir ? { staticDir } : {}),
    ...(livekitUrl ? { livekitUrl } : {}),
    ...(livekitKey ? { livekitKey } : {}),
    ...(livekitSecret ? { livekitSecret } : {}),
    ...(argv.includes('--quiet') ? {} : { log: (l: string) => console.log(l) }),
  });
  console.log(`Calaba mock server (${scenario}) on ${server.url}${staticDir ? `, static: ${resolve(staticDir)}` : ''}`);
  const stop = (): void => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

/** A forwarded copy in the mock feed (ADR-0033): the original's author and time. */
export interface MockForward {
  authorId: string;
  sentAtMs: number;
  roomId?: string;
  messageId?: string;
}

function forwardOf(f: MockForward): MessageInitShape<typeof ForwardSchema> {
  return { authorId: f.authorId, roomId: f.roomId ?? '', messageId: f.messageId ?? '', sentAt: timestampFromMs(f.sentAtMs) };
}
