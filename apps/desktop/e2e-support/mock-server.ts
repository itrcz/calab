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
  AdminGetWorkspaceResponseSchema,
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
  RecordingStatus,
  RoomRecordingSchema,
  RoomRecordingState,
  StartRecordingResponseSchema,
  StopRecordingResponseSchema,
  RetryRecordingResponseSchema,
  GetRecordingTranscriptResponseSchema,
  type GptunnelIntegration,
  type RecordingCard,
  type RoomRecording,
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
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
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
  GetRoomInviteResponseSchema,
  GetRoomResponseSchema,
  GetWorkspaceResponseSchema,
  InviteSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  JoinVoiceResponseSchema,
  JoinWorkspaceResponseSchema,
  ListCategoriesResponseSchema,
  ListDmCandidatesResponseSchema,
  ListDmsResponseSchema,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  UpdateDmStateRequestSchema,
  UpdateDmStateResponseSchema,
  DmSummarySchema,
  ListInvitesResponseSchema,
  ListMembersResponseSchema,
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
  UpdateMemberRequestSchema,
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
  VoiceStateSchema,
  VoiceStreamStopReason,
  WorkspaceMemberSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  WorkspaceVisibility,
  computeMemberRoomPermissions,
  computePermissions,
  has,
  workspacePermissions,
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
  type DmSummary,
  type GatewayFrame,
  type Me,
  type FileMeta,
  type Message,
  type Room,
  type RoomNotificationSettings,
  type WorkspaceNotificationSettings,
  type RoomCategory,
  type RoomInvite,
  type Session,
  type VoiceState,
  type WorkspaceMember,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_MEDIA,
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
import { cardPicture, encodePng, pngSize } from './png';

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
  injectMessage(args: { roomId: string; authorId: string; content: string; replyToId?: string; attachments?: string[]; stickerId?: string }): Message;
  /** Sets a user's voice state (roomId '' = left voice) and fans out VOICE_STATE_UPDATE. */
  setVoiceState(args: { userId: string; roomId: string; muted?: boolean; deafened?: boolean; streaming?: boolean; camera?: boolean; pending?: boolean }): void;
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
  /** ADR-0025: connects the workspace to GPTunneL as if an admin paired it (`null` = disconnect). */
  setGptunnel(workspaceId: string, pairedBy: string | null): void;
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
  }): Message;
  /** Moves a card on (MESSAGE_UPDATE), like the server's upload worker. */
  updateRecordingCard(messageId: string, patch: RecordingCardPatch): void;
  /**
   * docs/09 #51: a user's own state of a DM, like PATCH /api/dms/{id}/state — archive / «Удалить
   * чат» (for them only) — and DM_STATE_UPDATE to their devices.
   */
  setDmState(userId: string, roomId: string, patch: { archived?: boolean; cleared?: boolean }): void;
  /**
   * ADR-0031: the two bots of «Команда Calab» join it (IDS.bots — «Погода» with commands and a
   * delivering webhook, «Деплой» with a failing one) → WORKSPACE_MEMBER_ADD + BOT_CREATE.
   */
  seedBots(): void;
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
    setDmState: (u, roomId, patch) => impl.setDmState(u, roomId, patch),
    setVoiceState: (a) => impl.setVoice(a.userId, a.roomId, a),
    setPresence: (u, st) => impl.setPresence(u, st),
    setMemberRoles: (w, u, ids) => impl.setMemberRoles(w, u, ids),
    stopCamera: (u, r) => impl.stopCamera(u, r),
    setEmailState: (u, st) => impl.setEmailState(u, st),
    setRecording: (roomId, rec) => impl.setRecording(roomId, rec),
    setGptunnel: (ws, by) => impl.setGptunnel(ws, by),
    injectRecordingCard: (a) => impl.injectRecordingCard(a),
    updateRecordingCard: (id, patch) => impl.updateRecordingCard(id, patch),
    seedBots: () => impl.seedBots(),
    holdFiles: () => impl.holdFiles(),
    releaseFiles: () => impl.releaseFiles(),
    dropGateway: (ms) => impl.dropGateway(ms ?? 0),
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

const notFound = (what = 'not found'): HttpError => new HttpError(404, ErrorCode.NOT_FOUND, what);
const forbidden = (what = 'forbidden'): HttpError => new HttpError(403, ErrorCode.FORBIDDEN, what);
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

  constructor(opts: MockServerOptions) {
    this.state = buildState(opts.scenario ?? 'data');
    this.lk = {
      url: opts.livekitUrl ?? 'ws://127.0.0.1:7880',
      key: opts.livekitKey ?? 'devkey',
      secret: opts.livekitSecret ?? 'secret',
    };
    this.staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
    this.log = opts.log ?? (() => undefined);
    this.registerRoutes();
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
    this.voiceSessions.clear();
    this.droppedSessions.clear();
    this.gatewayDownUntil = 0;
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
    const m = this.member(room.workspaceId, userId);
    // ADR-0029: in a restricted room admins count as members; the owner (owner_id) has everything.
    const owner = this.state.workspaces.get(room.workspaceId)?.ownerId === userId;
    return m ? computeMemberRoomPermissions(this.memberRoles(m), userId, room.permissionOverrides, room.restricted, owner) : 0n;
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

  /** Room visible to the caller; 404 otherwise. */
  private roomFor(roomId: string, userId: string): Room {
    const r = this.state.rooms.get(roomId);
    if (!r || !this.canView(r, userId)) throw notFound('room not found');
    return r;
  }

  private requireRoomPerm(room: Room, userId: string, bit: bigint): void {
    if (!has(this.perms(room, userId), bit)) throw forbidden('missing permission');
  }

  private requireAdmin(m: MemberRec): void {
    if (!isAdminRole(m.role)) throw forbidden('MANAGE_WORKSPACE required');
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
  private checkGrant(a: { admin: boolean; perms: bigint }, bits: bigint): void {
    if (bits & PERMISSION_BITS.ADMINISTRATOR) throw forbidden('ADMINISTRATOR is not grantable');
    if (a.admin) return;
    if (bits & (PERMISSION_BITS.MANAGE_ROLES | PERMISSION_BITS.MANAGE_WORKSPACE)) throw forbidden('only admins grant role / workspace management');
    if (bits & ~a.perms) throw forbidden('cannot grant permissions you lack');
  }

  /** Runs `fn`; then ROOM_CREATE / ROOM_DELETE to each member whose room visibility changed (docs/05). */
  private withVisibility(wsId: string, fn: () => void): void {
    const rooms = [...this.state.rooms.values()].filter((r) => r.workspaceId === wsId);
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
      settings: u.settings,
      isSuperadmin: this.state.superadmins.has(u.user.id),
      // Guests have no email: always «verified» (user.proto).
      emailVerified: u.user.isGuest || u.emailVerified,
      pendingEmail: u.pendingEmail,
      locale: u.locale,
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
      return create(PresenceSchema, { userId, status: PresenceStatus.OFFLINE });
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
      .filter((r) => r.workspaceId === wsId && this.canView(r, userId))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const members = this.membersOf(wsId);
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
      roles: this.rolesOfWs(wsId),
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
          workspaces: wsIds.map((w) => this.snapshot(w, u.user.id)),
          // Every visible room (server contract): never read → empty marker.
          readStates: [...this.state.rooms.values()]
            .filter((r) => (wsIds.includes(r.workspaceId) || r.type === RoomType.DM) && this.canView(r, u.user.id))
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
          // Guest accounts have no DMs (ADR-0020).
          dms: u.user.isGuest ? [] : this.dmsOf(u.user.id),
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
      if (r?.type === RoomType.DM) {
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

  setPresence(userId: string, status: PresenceStatus): void {
    const prev = this.state.presences.get(userId);
    this.state.presences.set(userId, create(PresenceSchema, { userId, status, ...(prev?.lastSeen ? { lastSeen: prev.lastSeen } : {}) }));
    const presence = this.presenceOut(userId);
    this.fanout((u) => (u === userId || this.shareWorkspace(u, userId) ? { event: { case: 'presenceUpdate', value: { presence } } } : null));
  }

  setVoice(userId: string, roomId: string, patch: { muted?: boolean; deafened?: boolean; streaming?: boolean; serverMuted?: boolean; camera?: boolean; pending?: boolean }): void {
    const prev = this.state.voiceStates.get(userId);
    const room = roomId ? this.state.rooms.get(roomId) : undefined;
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

  private createMessage(room: Room, authorId: string, content: string, replyToId: string, nonce: string, attachmentIds: string[], sticker?: Sticker): Message {
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
    return msg;
  }

  injectMessage(a: { roomId: string; authorId: string; content: string; replyToId?: string; attachments?: string[]; stickerId?: string }): Message {
    const room = this.state.rooms.get(a.roomId);
    if (!room) throw notFound('room not found');
    const sticker = a.stickerId ? (this.findSticker(a.stickerId)?.sticker ?? this.state.deletedStickers.get(a.stickerId)) : undefined;
    return this.createMessage(room, a.authorId, a.content, a.replyToId ?? '', '', a.attachments ?? [], sticker);
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
    const full = (u: string): boolean => {
      const m = this.member(pack.workspaceId, u);
      return !!m && m.role !== WorkspaceRole.GUEST;
    };
    if (room.type === RoomType.DM) return (this.state.dmMembers.get(room.id) ?? []).every(full);
    return room.workspaceId === pack.workspaceId && full(userId);
  }

  private myPacks(userId: string): MessageInitShape<typeof MyStickerPacksResponseSchema> {
    const mine = (this.state.userStickerPacks.get(userId) ?? []).map((id) => this.state.stickerPacks.get(id)).filter((p): p is StickerPack => !!p);
    const ws = new Set(this.state.members.filter((m) => m.userId === userId && m.role !== WorkspaceRole.GUEST).map((m) => m.workspaceId));
    const installed = mine.filter((p) => ws.has(p.workspaceId));
    const ids = new Set(installed.map((p) => p.id));
    const available = [...this.state.stickerPacks.values()].filter((p) => ws.has(p.workspaceId) && !ids.has(p.id));
    return { installed, available };
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

    // ---------------- me
    this.route('GET', '/api/me', (c) => {
      sendMsg(c.res, 200, GetMeResponseSchema, { me: this.me(this.auth(c).user) });
    });

    this.route('PATCH', '/api/me', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, UpdateMeRequestSchema);
      if (b.displayName !== undefined) {
        if (!b.displayName.trim()) throw invalid('displayName', 'display name required');
        u.user.displayName = b.displayName.trim();
      }
      if (b.statusText !== undefined) u.user.statusText = b.statusText;
      if (b.timezone !== undefined) u.user.timezone = b.timezone;
      if (b.locale !== undefined) {
        const l = mailLocale(b.locale);
        if (l === null) throw invalid('locale', 'unsupported locale');
        u.locale = l;
      }
      if (b.avatarFileId !== undefined) {
        if (b.avatarFileId && !s().files.has(b.avatarFileId)) throw invalid('avatarFileId', 'unknown file');
        u.user.avatarFileId = b.avatarFileId;
      }
      if (b.settings) {
        const st = create(UserSettingsSchema, b.settings);
        if (st.micMode === MicMode.UNSPECIFIED) st.micMode = MicMode.VAD;
        // The server keeps the deprecated flag in sync with mic_mode (user.proto).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        st.pushToTalk = st.micMode === MicMode.PUSH_TO_TALK;
        u.settings = st;
      }
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
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

    this.route('PATCH', '/api/workspaces/:id/members/:userId', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      const b = parseBody(c, UpdateMemberRequestSchema);
      const before = target.role;
      if (b.role !== undefined && b.role !== target.role) {
        this.requireAdmin(caller);
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
        this.requireAdmin(caller);
        if (target.role === WorkspaceRole.ADMIN && caller.role !== WorkspaceRole.OWNER) throw forbidden('only the owner removes admins');
      }
      if (s().voiceStates.get(targetId)?.workspaceId === ws.id) this.setVoice(targetId, '', {});
      this.toUser(targetId, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
      s().members = s().members.filter((x) => x !== target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberRemove', value: { workspaceId: ws.id, userId: targetId } } });
      noContent(c.res);
    });

    // ---------------- bans (docs/09 #32): MANAGE_WORKSPACE, the rules of a kick
    this.route('GET', '/api/workspaces/:id/bans', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(caller);
      sendMsg(c.res, 200, ListBansResponseSchema, { bans: s().bans.get(ws.id) ?? [] });
    });
    this.route('POST', '/api/workspaces/:id/bans', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(caller);
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
      this.requireAdmin(caller);
      const list = s().bans.get(ws.id) ?? [];
      const userId = c.params[1] ?? '';
      if (!list.some((x) => x.user?.id === userId)) throw notFound('ban not found');
      s().bans.set(ws.id, list.filter((x) => x.user?.id !== userId));
      this.toWorkspace(ws.id, { event: { case: 'workspaceBanRemove', value: { workspaceId: ws.id, userId } } });
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/members/:userId/promote', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(caller);
      const target = this.member(ws.id, c.params[1] ?? '');
      if (target?.role !== WorkspaceRole.GUEST) throw notFound('guest not found');
      target.role = WorkspaceRole.MEMBER;
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, UpdateMemberResponseSchema, { member });
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
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
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
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const b = parseBody(c, UpdateRoomRequestSchema);
      const before = create(RoomSchema, room);
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
      // ADR-0025: MANAGE_WORKSPACE besides MANAGE_ROOM; switching it off stops a running recording.
      if (b.allowRecording !== undefined) {
        this.requireAdmin(this.workspaceFor(room.workspaceId, me).m);
        room.allowRecording = b.allowRecording;
      }
      // ADR-0029: the workspace owner only (owner_id, not a bit); private rooms only.
      if (b.restricted !== undefined) {
        if (s().workspaces.get(room.workspaceId)?.ownerId !== me) throw forbidden('only the workspace owner may change restricted');
        if (b.restricted && !room.isPrivate) throw invalid('restricted', 'only private rooms can be restricted');
        room.restricted = b.restricted;
      }
      this.emitRoomChange(before, room, { event: { case: 'roomUpdate', value: { room } } });
      if (b.allowRecording === false && s().recordings.has(room.id)) this.stopRecording(room, 'disabled', '');
      sendMsg(c.res, 200, UpdateRoomResponseSchema, { room });
    });

    this.route('DELETE', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
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
      const room = this.roomFor(c.params[0] ?? '', this.uid(c));
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
      noContent(c.res);
    });

    this.route('PUT', '/api/rooms/:id/read', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateReadStateRequestSchema);
      if (!b.messageId) throw invalid('messageId', 'message id required');
      const reads = s().readStates.get(me) ?? new Map<string, string>();
      const cur = reads.get(room.id) ?? '';
      if (b.messageId > cur) {
        reads.set(room.id, b.messageId);
        s().readStates.set(me, reads);
        this.toUser(me, { event: { case: 'readStateUpdate', value: { readState: { roomId: room.id, lastReadMessageId: b.messageId, unreadCount: 0, mentionCount: 0 } } } });
      }
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
      if (room.type !== RoomType.DM) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
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
      this.uid(c);
      const url = c.url.searchParams.get('url') ?? '';
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
      if (room.type !== RoomType.DM) throw notFound('dm not found');
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
      this.requireAdmin(m);
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
      this.setVoice(me, v.roomId, { ...(b.muted !== undefined ? { muted: b.muted } : {}), ...(b.deafened !== undefined ? { deafened: b.deafened } : {}) });
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
      this.requireRoomPerm(room, me, MANAGE_ROOM);
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
        ...(expiresIn ? { expiresAt: timestampFromMs(timestampMs(at) + expiresIn * 1000) } : {}),
        createdAt: at,
      });
      s().roomInvites.set(id, invite);
      sendMsg(c.res, 201, CreateRoomInviteResponseSchema, { invite });
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
      });
    });
    // With a bearer: join as the current user; without one (allow_guests): a guest account.
    this.route('POST', '/api/room-invites/:code/join', (c) => {
      const { inv, room, ws } = roomInvite(c.params[0] ?? '');
      const b = parseBody(c, JoinRoomInviteRequestSchema);
      if ((c.req.headers.authorization ?? '').startsWith('Bearer ')) {
        this.grantRoomLink(inv, this.uid(c));
        sendMsg(c.res, 200, JoinRoomInviteResponseSchema, { roomId: room.id, workspaceId: ws.id });
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
      this.grantRoomLink(inv, id);
      sendMsg(c.res, 201, JoinRoomInviteResponseSchema, { roomId: room.id, workspaceId: ws.id, tokens: this.tokensJson(c, sessionId), me: this.me(rec) });
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
      if (b.plan !== Plan.FREE && b.plan !== Plan.TEAM && b.plan !== Plan.CUSTOM) throw invalid('plan', 'plan must be FREE, TEAM or CUSTOM');
      if (b.plan !== Plan.CUSTOM && b.limits) throw invalid('limits', 'limits only with CUSTOM');
      if (b.note.length > 500) throw invalid('note', 'note at most 500 characters');
      const now = tick(s());
      if (b.validUntil && timestampMs(b.validUntil) <= timestampMs(now)) throw invalid('validUntil', 'valid_until must be in the future');
      const limits = b.plan === Plan.CUSTOM ? create(PlanLimitsSchema, b.limits ?? {}) : b.plan === Plan.TEAM ? TEAM_PLAN_LIMITS : FREE_PLAN_LIMITS;
      ws.plan = create(WorkspacePlanSchema, { plan: b.plan, limits, ...(b.validUntil ? { validUntil: b.validUntil } : {}), expired: false });
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
      authorId: a.byUserId,
      content: '',
      kind: MessageKind.SYSTEM,
      system: { payload: { case: 'recording', value: card } },
      attachments: a.result ? this.recordingAudio() : [],
      createdAt,
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
      this.requireAdmin(m);
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
      this.requireAdmin(m);
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
      const u = [...s().users.values()].find((x) => x.email === email && !x.user.isGuest);
      if (u) s().emailCodes.set(`reset:${email}`, { attempts: 0, sentAtMs: Date.now() });
      noContent(c.res); // always 204: no account enumeration
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
    const allow =
      VIEW_ROOM |
      CONNECT |
      (inv.allowSpeak ? SPEAK : 0n) |
      (inv.allowMessages ? SEND_MESSAGES : 0n) |
      (inv.allowFiles ? ATTACH_FILES : 0n) |
      (inv.allowStream ? STREAM : 0n);
    const before = clone(RoomSchema, room); // create() would return the same instance
    room.permissionOverrides = [
      ...room.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.USER && o.targetId === userId)),
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow, deny: 0n }),
    ];
    inv.uses += 1;
    if (!existing) {
      const m: MemberRec = { workspaceId: inv.workspaceId, userId, role: WorkspaceRole.GUEST, nickname: '', joinedAt: tick(this.state) };
      this.state.members.push(m);
      const member = this.memberOut(m);
      this.fanout((u) =>
        u === userId
          ? { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(inv.workspaceId, userId) } } }
          : this.member(inv.workspaceId, u)
            ? { event: { case: 'workspaceMemberAdd', value: { member } } }
            : null,
      );
    }
    this.emitRoomChange(before, room, {
      event: { case: 'roomPermissionsUpdate', value: { workspaceId: room.workspaceId, roomId: room.id, permissions: room.permissionOverrides } },
    });
  }

  private emitUserUpdate(u: UserRec): void {
    const me = this.me(u);
    this.fanout((recipient) =>
      recipient === u.user.id
        ? { event: { case: 'userUpdate', value: { me } } }
        : this.shareWorkspace(recipient, u.user.id)
          ? { event: { case: 'userUpdate', value: { user: u.user } } }
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
      usage: { members, rooms, storageMb: mb, storageBytes: ws.storageUsedBytes, ...(last ? { lastActivity: last } : {}) },
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
