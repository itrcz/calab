import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  FileMetaSchema,
  VoiceInfoSchema,
  InviteSchema,
  MessageSchema,
  NotificationLevel,
  MicMode,
  Plan,
  PlanLimitsSchema,
  PlanLogEntrySchema,
  WorkspacePlanSchema,
  BUILTIN_ROLE_POSITION,
  PERMISSION_BITS,
  PermissionTargetType,
  ROLE_DEFAULTS,
  ROLE_TARGET_ID,
  RoleSchema,
  PresenceSchema,
  PresenceStatus,
  RoomCategorySchema,
  RoomMediaOverrideSchema,
  RoomInviteSchema,
  RoomMediaSettingsSchema,
  RoomNotificationSettingsSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  StickerPackSchema,
  StickerSchema,
  type Sticker,
  type StickerPack,
  type BotCommand,
  type BotWebhook,
  ScreenSharePreset,
  SessionSchema,
  UserSchema,
  UserSettingsSchema,
  VoiceStateSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceVisibility,
  type FileMeta,
  type Invite,
  type GptunnelIntegration,
  type Message,
  type PlanLimits,
  type PlanLogEntry,
  type WorkspaceBan,
  type Presence,
  type Role,
  type Room,
  type RoomCategory,
  type RoomInvite,
  type RoomMediaOverride,
  type RoomMediaSettings,
  type RoomNotificationSettings,
  type WorkspaceNotificationSettings,
  type RoomPermissionOverride,
  type RoomRecording,
  type SipCall,
  type SipSettings,
  type Badge,
  type WorkspaceBackground,
  type Sound,
  type Session,
  type User,
  type UserSettings,
  type VoiceState,
  type Workspace,
} from '@calaba/protocol';
import { buildMarketingState } from './fixtures-marketing';
import type { AdmissionRec } from './mock-admissions';
import { avatarPicture, cardPicture, encodePng } from './png';

/**
 * Deterministic fixtures for the mock API (UI screenshot tests).
 * Every id, timestamp, token and byte is fixed: two runs produce identical data.
 *
 * Ids look like uuidv7 and are fixed-length, so string order = creation order (the client
 * compares message ids as strings for unread state): `00000000-0000-7000-80KK-NNNNNNNNNNNN`,
 * KK = entity kind, N = sequence number (hex).
 */

/** `marketing`: README / landing screenshots only (fixtures-marketing.ts). */
export type Scenario = 'data' | 'empty' | 'marketing';
export const SCENARIOS: readonly Scenario[] = ['data', 'empty', 'marketing'];

const KIND = { user: 1, workspace: 2, room: 3, message: 4, file: 5, invite: 6, session: 7, category: 8, role: 9, sticker: 10, stickerPack: 11, badge: 12, background: 13, sound: 14, event: 15 } as const;
export type IdKind = keyof typeof KIND;

export function mockId(kind: IdKind, n: number): string {
  return `00000000-0000-7000-80${KIND[kind].toString(16).padStart(2, '0')}-${n.toString(16).padStart(12, '0')}`;
}

export const ts = (iso: string): Timestamp => timestampFromMs(Date.parse(iso));

/**
 * The four built-in roles of a workspace (ADR-0026), highest first. The mock uses their legacy
 * names as ids («owner» …), so room overrides by name and by id are the same thing.
 */
export function builtinRoles(workspaceId: string): Role[] {
  return [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.GUEST].map((b) =>
    create(RoleSchema, {
      id: ROLE_TARGET_ID[b],
      workspaceId,
      name: ROLE_TARGET_ID[b],
      position: BUILTIN_ROLE_POSITION[b],
      permissions: ROLE_DEFAULTS[b],
      builtin: b,
    }),
  );
}

/** Mutations made at runtime get timestamps from this clock: 2026-01-15T12:00Z + 1 min per tick. */
export const RUNTIME_CLOCK_START_MS = Date.parse('2026-01-15T12:00:00Z');

export const PASSWORD = 'password123';

/** Stable ids / names screenshot tests may rely on. */
export const IDS = {
  users: {
    anna: mockId('user', 1),
    boris: mockId('user', 2),
    vera: mockId('user', 3),
    grigory: mockId('user', 4),
    dina: mockId('user', 5),
  },
  workspaces: {
    main: mockId('workspace', 1),
    design: mockId('workspace', 2),
    community: mockId('workspace', 3),
  },
  rooms: {
    general: mockId('room', 1),
    dev: mockId('room', 2),
    longPrivate: mockId('room', 3),
    call: mockId('room', 4),
    meeting: mockId('room', 5),
    designMockups: mockId('room', 6),
    designReview: mockId('room', 7),
    communityWelcome: mockId('room', 8),
  },
  /** Anna's direct messages (ADR-0020), by peer. */
  dms: {
    boris: mockId('room', 0x21),
    vera: mockId('room', 0x22),
    grigory: mockId('room', 0x23),
  },
  categories: {
    dev: mockId('category', 1),
    voice: mockId('category', 2),
  },
  files: {
    image: mockId('file', 1),
    pdf: mockId('file', 2),
    veraAvatar: mockId('file', 3),
    /** Chat media player (docs/09 #41): fixtures/release-jingle.mp3 (6 s), fixtures/demo-clip.mp4 (3 s, 320×180). */
    audio: mockId('file', 4),
    video: mockId('file', 5),
    /** Voice message (docs/09 #43): fixtures/voice-note.ogg (5 s Ogg/Opus 24 kbit/s), waveform VOICE_WAVEFORM. */
    voice: mockId('file', 6),
    /** A phone photo (720×1280 portrait, issues #7/#9): not in any message, injectMessage posts it. */
    portrait: mockId('file', 7),
    /** A meeting recording's audio (docs/09 #47): fixtures/meeting-recording.m4a (6 s AAC in MP4, as LiveKit Egress writes). */
    meeting: mockId('file', 8),
    /** Sticker files (ADR-0030): fixtures/sticker-*.webp, 160×160 (orbit is animated, 6 frames). */
    stickerSun: mockId('file', 9),
    stickerGem: mockId('file', 10),
    stickerOrbit: mockId('file', 11),
    stickerSun2: mockId('file', 12),
    stickerGem2: mockId('file', 13),
  },
  /**
   * Sticker packs of «Команда Calab» (ADR-0030): «Calab» (☀️ 💎 🌀, installed by Анна) and
   * «Эмоции» (not installed: «Паки пространств» in the picker). No message shows a sticker —
   * the sticker tests post one (injectMessage({ stickerId })).
   */
  stickerPacks: { calab: mockId('stickerPack', 1), moods: mockId('stickerPack', 2) },
  stickers: {
    sun: mockId('sticker', 1),
    gem: mockId('sticker', 2),
    orbit: mockId('sticker', 3),
    wave: mockId('sticker', 4),
    heart: mockId('sticker', 5),
  },
  sessions: {
    annaDesktop: mockId('session', 1),
    annaWeb: mockId('session', 2),
  },
  /**
   * Bots of «Команда Calab» (ADR-0031) — not in the fixture until MockServer.seedBots() (so the
   * other screens keep their member lists): «Погода» @weather_bot (Анна's, commands, webhook
   * delivering) and «Деплой» @deploy_bot (Бориса, no commands, webhook failing).
   */
  bots: {
    weather: mockId('user', 0x31),
    deploy: mockId('user', 0x32),
  },
  /** Custom roles of the main workspace (ADR-0026); nobody holds them in the fixture. */
  roles: {
    design: mockId('role', 1),
    moderator: mockId('role', 2),
  },
} as const;

/**
 * Meeting recording of «Переговорка» (docs/09 #30, ADR-0025): Борис started it 12:34 ago
 * (MockServer.setRecording → ROOM_RECORDING, READY `recordings[]`).
 */
export const RECORDING_FIXTURE = { roomId: IDS.rooms.meeting, byUserId: IDS.users.boris, agoMs: 754_000 } as const;

/**
 * The result of a recorded meeting (docs/09 #47, docs/17): GPTunneL's summary (Markdown) and
 * transcript, as the server keeps them. Deterministic.
 */
export const RECORDING_RESULT = {
  summary: [
    '## Темы',
    '- Релиз **0.7**: что попадает и что переносим',
    '- Эталоны скриншотов после правок островка',
    '## Решения',
    '- Выпускаем в пятницу, *без* новых фич',
    '- Запись встреч v2 — в этот релиз',
    '## Задачи',
    '1. **Аня** — переснять эталоны карточки записи',
    '2. **Борис** — проверить загрузку в GPTunneL на стенде',
    '3. **Вера** — тексты для es и zh-CN',
    '## Открытые вопросы',
    '- Сколько дней хранить аудио: 30 или 90?',
  ].join('\n'),
  language: 'ru',
  transcript: [
    { speaker: 0, startMs: 1_200, endMs: 6_800, text: 'Коллеги, начнём. Сегодня релиз и запись встреч.' },
    { speaker: 1, startMs: 7_400, endMs: 15_100, text: 'По релизу: всё, что в main до четверга, едет. Остальное — после тега.' },
    { speaker: 2, startMs: 15_600, endMs: 22_000, text: 'Эталоны карточки записи надо переснять, она теперь во всю ширину ленты.' },
    { speaker: 0, startMs: 22_300, endMs: 27_900, text: 'Хорошо, Аня берёт эталоны. Борис, что со стендом?' },
    { speaker: 1, startMs: 28_400, endMs: 38_000, text: 'Загрузка в GPTunneL работает, саммари приходит через пару минут после остановки.' },
    { speaker: 3, startMs: 38_500, endMs: 44_200, text: 'Я подготовлю переводы для испанского и китайского.' },
    { speaker: 0, startMs: 44_800, endMs: 52_000, text: 'Остался вопрос хранения аудио: тридцать дней или девяносто?' },
    { speaker: 2, startMs: 52_300, endMs: 58_400, text: 'Давайте начнём с тридцати и посмотрим на диск.' },
    { speaker: -1, startMs: 58_900, endMs: 60_000, text: 'Договорились.' },
  ],
} as const;

/**
 * Code blocks (docs/09 #45, docs/08 «Код в сообщениях»): a highlighted js block and a log longer
 * than 400 lines (collapsed behind «Показать всё»; unknown language — no highlighting). Deterministic.
 */
export const CODE_FIXTURE = {
  js: [
    'Вот обработчик для поиска:',
    '```js',
    '// Debounce the search field',
    'export function debounce(fn, ms = 200) {',
    '  let timer = null;',
    '  return (...args) => {',
    '    clearTimeout(timer);',
    '    timer = setTimeout(() => fn(...args), ms);',
    "    console.debug('debounced', ms);",
    '  };',
    '}',
    '```',
  ].join('\n'),
  long: [
    'Лог сборки:',
    '```log',
    ...Array.from(
      { length: 420 },
      (_, i) => `12:00:${String(i % 60).padStart(2, '0')} build step ${i + 1}: compile packages/protocol/src/gen/calaba_pb.ts -> out/chunk-${i + 1}.js (ok, ${(i * 37) % 900} ms)`,
    ),
    '```',
  ].join('\n'),
} as const;

/**
 * GPTunneL pairing in the mock (ADR-0025): this code pairs; MOCK_GPTUNNEL_RATE_CODE answers 429,
 * MOCK_GPTUNNEL_DOWN_CODE 503; any other well-formed code is 422 CODE_INVALID.
 */
export const MOCK_GPTUNNEL_CODE = 'ABCD-EFGH';
export const MOCK_GPTUNNEL_RATE_CODE = 'RATE-RATE';
export const MOCK_GPTUNNEL_DOWN_CODE = 'DOWN-DOWN';
/** The GPTunneL web base the mock reports (never a real host). */
export const MOCK_GPTUNNEL_WEB = 'https://gptunnel.test';

// ---------------------------------------------------------------- state

export interface UserRec {
  user: User;
  email: string;
  password: string;
  settings: UserSettings;
  /** ADR-0023. Fixture accounts are verified (the screens stay as they were); sign-ups are not. */
  emailVerified: boolean;
  /** Requested new address waiting for its code ('' = none). */
  pendingEmail: string;
  /** Language of emails ('' = not set). */
  locale: string;
  /** docs/09 #76: the birthday (user.birthday) is kept to its owner. */
  birthdayHidden?: boolean;
}

/** A live email code (ADR-0023): the mock's code is always MOCK_EMAIL_CODE. */
export interface EmailCodeRec {
  attempts: number;
  /** Real time (Date.now()) of the send: the 60 s resend rule. */
  sentAtMs: number;
}

/** An invitation sent to an address (ADR-0023); `code` is its single-use /join/<code> link. */
export interface EmailInviteRec {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  code: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  lastSentAt: Timestamp;
  /** Real time of the last send: the once-a-day rule. */
  lastSentMs: number;
  /** Accepted (the invitee joined): kept for the preview of the link until it expires (docs/09 #36). */
  accepted?: boolean;
}

/** A bot (ADR-0031): its account is a UserRec (`user.isBot`); this is what only bots have. */
export interface BotRec {
  userId: string;
  username: string;
  ownerUserId: string;
  /** Home workspace (where it was created; tokens and deletion are managed there). */
  workspaceId: string;
  description: string;
  commands: BotCommand[];
  tokenPrefix: string;
  createdAt: Timestamp;
  revokedAt?: Timestamp;
  webhook?: BotWebhook;
}

/** The code every mock email «contains» (verification, email change, password reset). */
export const MOCK_EMAIL_CODE = '123456';

export interface MemberRec {
  workspaceId: string;
  userId: string;
  /** The highest built-in role (owner / admin / member / guest). */
  role: WorkspaceRole;
  /** Custom roles (ADR-0026); the built-ins follow `role`. */
  roleIds?: string[];
  nickname: string;
  /** Member badge (docs/09 #82): an id of `MockState.badges`; unset = none. */
  badgeId?: string;
  joinedAt: Timestamp;
}

export interface FileRec {
  meta: FileMeta;
  bytes: Buffer;
  /** Served by /thumbnail (PNG for fixtures, the original bytes for uploaded images). */
  thumbnail?: { bytes: Buffer; mime: string };
}

export interface MockState {
  scenario: Scenario;
  /** GET /api/version `version` ('dev' = never newer than a bundle; a test sets e.g. '99.0.0'). */
  serverVersion: string;
  users: Map<string, UserRec>;
  workspaces: Map<string, Workspace>;
  members: MemberRec[];
  /** Rooms without last_message_* (computed from `messages` when serialised). */
  rooms: Map<string, Room>;
  /** Live messages per room, ascending by id. */
  messages: Map<string, Message[]>;
  /** userId → roomId → last read message id. */
  readStates: Map<string, Map<string, string>>;
  /** userId → voice state (room_id set = in voice). */
  voiceStates: Map<string, VoiceState>;
  /** Room categories (collapsible groups in the room list). */
  categories: Map<string, RoomCategory>;
  presences: Map<string, Presence>;
  invites: Map<string, Invite>;
  /** Room links (ADR-0016), by id. */
  roomInvites: Map<string, RoomInvite>;
  /** Waiting guest knocks (ADR-0040), by admissionKey(roomId, userId). */
  admissions: Map<string, AdmissionRec>;
  /** DM rooms (type DM, no workspace): roomId → the two participants (ADR-0020). */
  dmMembers: Map<string, [string, string]>;
  /** Notes shelves (ADR-0039): room id → owner and emoji (name and position live on the room). */
  shelves: Map<string, { ownerId: string; emoji: string }>;
  /** userId → roomId → own DM state (docs/09 #51): archived since (ms, 0 = no), cleared up to a message id. */
  dmState: Map<string, Map<string, { archivedAt: number; clearedBefore: string }>>;
  /** userId → roomId → stored notification settings (READY notification_settings; absent = default). */
  notifySettings: Map<string, Map<string, RoomNotificationSettings>>;
  /** userId → workspaceId → stored workspace notification settings (absent = MENTIONS, docs/09 item 22). */
  wsNotifySettings: Map<string, Map<string, WorkspaceNotificationSettings>>;
  /** Chat reactions: messageId → emoji → users (Message.reactions keeps the counts). */
  reactions: Map<string, Map<string, Set<string>>>;
  files: Map<string, FileRec>;
  /** userId → auth sessions (tokens are derived from the session id, see tokensFor). */
  sessions: Map<string, Session[]>;
  /** Revoked (logged out) sessions: their tokens are rejected until the next login. */
  revokedSessions: Set<string>;
  /** Private notes (docs/09 #20): authorId → subjectId → note; only the author reads them. */
  notes: Map<string, Map<string, { text: string; updatedAt: Timestamp }>>;
  /** Product superadmins (SUPERADMIN_EMAILS, ADR-0024): user ids; `me.isSuperadmin`, /api/admin/*. */
  superadmins: Set<string>;
  /** Admin view of a workspace plan (ADR-0024): note and who / when last changed it. */
  planMeta: Map<string, { note: string; updatedBy: string; updatedAt?: Timestamp }>;
  /** workspaceId → plan changes, newest first (GET /api/admin/workspaces/{id}/plan/log). */
  planLog: Map<string, PlanLogEntry[]>;
  /** Who suspended a workspace (docs/09 #32; Workspace.suspension has when / why). */
  suspendedBy: Map<string, string>;
  /** workspaceId → bans, newest first (docs/09 #32). */
  bans: Map<string, WorkspaceBan[]>;
  /**
   * workspaceId → roles (ADR-0026). The four built-ins carry their legacy names as ids
   * («member»…: the fixture's room overrides stay valid); created lazily for new workspaces.
   */
  roles: Map<string, Role[]>;
  /** Member badges (docs/09 #82) by id, in creation order; empty until MockServer.addBadge(). */
  badges: Map<string, Badge>;
  /** Camera backgrounds of workspaces (ADR-0035 addendum) by id, in creation order; empty until MockServer.addBackground(). */
  backgrounds: Map<string, WorkspaceBackground>;
  /** Soundboard of workspaces (ADR-0036) by id; empty until MockServer.addSound(). */
  sounds: Map<string, Sound>;
  /** Email codes (ADR-0023): `verify:<userId>` (also the email change) and `reset:<email>`. */
  emailCodes: Map<string, EmailCodeRec>;
  /** Pending invitations by email, by id. */
  emailInvites: Map<string, EmailInviteRec>;
  /** GPTunneL connection per workspace (ADR-0025); absent = not paired. */
  gptunnel: Map<string, GptunnelIntegration>;
  /** Rooms being recorded now (state ACTIVE), by room id. */
  recordings: Map<string, RoomRecording>;
  /** SIP account per workspace (ADR-0046); absent = never saved (the defaults). */
  sipSettings: Map<string, SipSettings>;
  /** SIP password per workspace (write-only in the API). */
  sipPasswords: Map<string, string>;
  /** Phone calls by id in creation order (live and journal). */
  sipCalls: Map<string, SipCall>;
  /** Sticker packs by id (ADR-0030), live stickers inside in order; deleted stickers stay in `deletedStickers`. */
  stickerPacks: Map<string, StickerPack>;
  /** Stickers removed from a pack that messages still show, by id. */
  deletedStickers: Map<string, Sticker>;
  /** userId → installed pack ids in the user's order. */
  userStickerPacks: Map<string, string[]>;
  /** Bots by user id (ADR-0031); empty until MockServer.seedBots(). */
  bots: Map<string, BotRec>;
  /** userId → bots they blocked. */
  blockedBots: Map<string, Set<string>>;
  /** Next sequence number per id kind (runtime-created entities). */
  next: Record<IdKind, number>;
  /** Runtime clock ticks (see RUNTIME_CLOCK_START_MS). */
  clock: number;
}

export function tick(s: MockState): Timestamp {
  s.clock += 1;
  return timestampFromMs(RUNTIME_CLOCK_START_MS + s.clock * 60_000);
}

export function nextId(s: MockState, kind: IdKind): string {
  const id = mockId(kind, s.next[kind]);
  s.next[kind] += 1;
  return id;
}

export const DEFAULT_MEDIA: RoomMediaSettings = create(RoomMediaSettingsSchema, {
  audioBitrateKbps: 32,
  maxStreamPreset: ScreenSharePreset.H1080,
  maxStreams: 3,
  cameraLimit: 6,
});

/** Plan limits of the mock (ADR-0024, docs/04 «Тарифы»): the server's built-in defaults. */
export const FREE_PLAN_LIMITS: PlanLimits = create(PlanLimitsSchema, {
  roomMembers: 5,
  streamMaxPreset: ScreenSharePreset.H720,
  streamMaxFps: 15,
  cameraMaxPreset: ScreenSharePreset.H720,
  cameraMaxFps: 15,
  streamsPerRoom: 1,
  camerasPerRoom: 3,
  storageMb: 5120n,
  members: 50,
  bots: 1,
  boards: 3,
  stickerPacks: 1,
  stickers: 200,
  audioTierMaxKbps: 16,
  caldavDisabled: true,
  // ADR-0058 §5: no checklists below Team, no board webhooks below Business.
  checklistsDisabled: true,
  boardWebhooksDisabled: true,
  // ADR-0046 (owner 02.10): telephony is Business only.
  telephonyDisabled: true,
});
/** Team (owner 30.09): 15 in a room, 100 members, 300 GB, 5 bots, 30 boards, 2 streams / 10 cameras; CalDAV yes. */
export const TEAM_PLAN_LIMITS: PlanLimits = create(PlanLimitsSchema, {
  roomMembers: 15,
  members: 100,
  bots: 5,
  boards: 30,
  streamsPerRoom: 2,
  camerasPerRoom: 10,
  storageMb: 300n * 1024n,
  boardWebhooksDisabled: true,
  telephonyDisabled: true,
});
/** Business = PLAN_ENTERPRISE (owner 30.09): 50 in a room, 500 members, 20 bots, 50 boards, 5 streams / 25 cameras, 1 TB. */
export const ENTERPRISE_PLAN_LIMITS: PlanLimits = create(PlanLimitsSchema, {
  roomMembers: 50,
  members: 500,
  bots: 20,
  boards: 50,
  streamsPerRoom: 5,
  camerasPerRoom: 25,
  storageMb: 1024n * 1024n,
});

export function effectiveMedia(ws: Workspace | undefined, o: RoomMediaOverride | undefined): RoomMediaSettings {
  const d = ws?.mediaDefaults ?? DEFAULT_MEDIA;
  return create(RoomMediaSettingsSchema, {
    audioBitrateKbps: o?.audioBitrateKbps ?? d.audioBitrateKbps,
    maxStreamPreset: o?.maxStreamPreset ?? d.maxStreamPreset,
    maxStreams: o?.maxStreams ?? d.maxStreams,
    cameraLimit: o?.cameraLimit ?? d.cameraLimit,
  });
}

export function defaultSettings(): UserSettings {
  return create(UserSettingsSchema, {
    noiseSuppression: false, // RNNoise off by default (owner, 27.09)
    unstableNetworkRed: false,
    pushToTalk: false,
    pushToTalkKey: '',
    micMode: MicMode.VAD,
    eventReminders: [60, 5], // ADR-0038 §5 defaults
    eventRemindersDnd: true,
  });
}

/** Fixed tokens of an auth session (not JWTs: the mock only maps them back to the session). */
export function tokensFor(sessionId: string): { accessToken: string; refreshToken: string } {
  return { accessToken: `mock-access.${sessionId}`, refreshToken: `mock-refresh.${sessionId}` };
}

export function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export function fileMeta(
  id: string,
  workspaceId: string,
  uploaderId: string,
  name: string,
  mime: string,
  bytes: Buffer,
  createdAt: Timestamp,
  size?: { width: number; height: number } | null,
): FileMeta {
  return create(FileMetaSchema, {
    id,
    workspaceId,
    uploaderId,
    name,
    mime,
    size: BigInt(bytes.length),
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    sha256: sha256(bytes),
    url: `/api/files/${id}`,
    thumbnailUrl: mime.startsWith('image/') ? `/api/files/${id}/thumbnail` : '',
    createdAt,
  });
}

// ---------------------------------------------------------------- builder

const { VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES } = PERMISSION_BITS;

interface UserSpec {
  key: keyof typeof IDS.users;
  n: number;
  name: string;
  email: string;
  status: string;
  avatar?: string;
  /** IANA zone (User.timezone); the visual tests run in Europe/Moscow. */
  timezone?: string;
  /** ADR-0077: nickname and phone (only for people with a status: member rows keep their second line). */
  username?: string;
  phone?: string;
}

const USERS: UserSpec[] = [
  { key: 'anna', n: 1, name: 'Анна Смирнова', email: 'owner@calaba.test', status: 'В фокусе до 18:00', username: 'anna', phone: '+7 916 555-01-01' },
  { key: 'boris', n: 2, name: 'Борис Петров', email: 'boris@calaba.test', status: 'На созвоне', timezone: 'Asia/Yekaterinburg', username: 'boris_p', phone: '+7 912 555-02-02' },
  { key: 'vera', n: 3, name: 'Вера Ким', email: 'vera@calaba.test', status: '', avatar: IDS.files.veraAvatar },
  {
    key: 'grigory',
    n: 4,
    name: 'Григорий Олегович Длинноимённый-Константинопольский',
    email: 'grigory@calaba.test',
    status: 'Очень длинный статус, который точно не поместится в одну строку боковой панели',
  },
  { key: 'dina', n: 5, name: 'Дина', email: 'dina@calaba.test', status: '' },
];

function override(targetType: PermissionTargetType, targetId: string, allow: bigint, deny: bigint): RoomPermissionOverride {
  return create(RoomPermissionOverrideSchema, { targetType, targetId, allow, deny });
}

interface MsgSpec {
  key?: string;
  room: string;
  at: string;
  author: string;
  content: string;
  replyTo?: string;
  editedAt?: string;
  attachments?: string[];
  /** emoji → users who reacted (chat reactions). */
  reactions?: Record<string, string[]>;
  /** Pinned by this user (5 minutes after the message). */
  pinnedBy?: string;
}

const U = IDS.users;
const R = IDS.rooms;

const CODE_BLOCK = [
  'Предлагаю так:',
  '```go',
  'func (c *Cache) Get(id string) (Room, bool) {',
  '\tc.mu.RLock()',
  '\tdefer c.mu.RUnlock()',
  '\tr, ok := c.rooms[id]',
  '\treturn r, ok',
  '}',
  '```',
].join('\n');

/** Messages; ids are assigned in chronological order. */
const MESSAGES: MsgSpec[] = [
  // ---- общий, day 1 (2026-01-14)
  { room: R.general, at: '2026-01-14T09:02:00Z', author: U.boris, content: 'Всем доброе утро! Сегодня в 11:00 синк по релизу.' },
  { room: R.general, at: '2026-01-14T09:03:00Z', author: U.boris, content: 'Повестка в **закреплённом** документе.', pinnedBy: U.boris },
  { room: R.general, at: '2026-01-14T09:05:00Z', author: U.vera, content: 'Утро! Буду, но на *пять минут* позже.' },
  { room: R.general, at: '2026-01-14T09:20:00Z', author: U.grigory, content: 'Коллеги, напоминаю про ревью `apps/server` до обеда.' },
  { room: R.general, at: '2026-01-14T09:21:00Z', author: U.grigory, content: 'Особенно `internal/perm` — там поменялись тест-векторы.' },
  { room: R.general, at: '2026-01-14T09:22:00Z', author: U.grigory, content: 'Спасибо!' },
  { room: R.dev, at: '2026-01-14T09:40:00Z', author: U.boris, content: 'Собрал ветку `release/0.4`, CI зелёный.' },
  { room: R.general, at: '2026-01-14T10:15:00Z', author: U.anna, content: 'Посмотрела — выглядит хорошо. Одно замечание по кэшу.' },
  { key: 'code', room: R.general, at: '2026-01-14T10:17:00Z', author: U.anna, content: CODE_BLOCK },
  { room: R.general, at: '2026-01-14T10:30:00Z', author: U.boris, content: 'Согласен, так и сделаем.', replyTo: 'code', reactions: { '🔥': [U.anna] } },
  { room: R.longPrivate, at: '2026-01-14T11:00:00Z', author: U.vera, content: 'Здесь обсуждаем закрытые вопросы.' },
  {
    room: R.general,
    at: '2026-01-14T12:40:00Z',
    author: U.vera,
    content: 'Новые иконки для панели комнат',
    attachments: [IDS.files.image],
  },
  { room: R.general, at: '2026-01-14T12:41:00Z', author: U.vera, content: 'Фидбек приветствуется!' },
  { room: R.general, at: '2026-01-14T14:05:00Z', author: U.dina, content: 'Здравствуйте! Я гость, помогаю с тестированием.' },
  { room: R.general, at: '2026-01-14T14:10:00Z', author: U.anna, content: `@${U.dina} добро пожаловать!` },
  { room: R.call, at: '2026-01-14T15:00:00Z', author: U.boris, content: 'Ссылка на доску для созвона: https://calaba.test/board' },
  { room: R.call, at: '2026-01-14T15:01:00Z', author: U.anna, content: 'Спасибо, подключаюсь.' },
  { room: R.designMockups, at: '2026-01-14T15:30:00Z', author: U.vera, content: 'Выложила макеты экрана настроек.' },
  { room: R.designMockups, at: '2026-01-14T15:45:00Z', author: U.anna, content: 'Отлично, *очень* аккуратно получилось.' },
  {
    room: R.general,
    at: '2026-01-14T16:30:00Z',
    author: U.grigory,
    content: 'Отчёт по нагрузочному тесту',
    attachments: [IDS.files.pdf],
  },
  {
    room: R.general,
    at: '2026-01-14T16:31:00Z',
    author: U.boris,
    content: 'Дашборд: [Grafana — голос](https://grafana.calaba.test/d/voice)',
  },
  // ---- day 2 (2026-01-15)
  {
    room: R.general,
    at: '2026-01-15T08:55:00Z',
    author: U.boris,
    content: 'Доброе утро! Релиз сегодня в 15:00.',
    reactions: { '👍': [U.anna, U.vera, U.grigory], '🎉': [U.vera] },
    pinnedBy: U.anna,
  },
  {
    room: R.general,
    at: '2026-01-15T08:56:00Z',
    author: U.boris,
    content: 'Чек-лист: миграции, конфиг LiveKit, смоук-тесты.',
    editedAt: '2026-01-15T09:10:00Z',
  },
  { room: R.general, at: '2026-01-15T09:01:00Z', author: U.vera, content: `@${U.anna} посмотришь макет настроек?` },
  { room: R.general, at: '2026-01-15T09:04:00Z', author: U.anna, content: 'Да, после обеда.' },
  {
    room: R.general,
    at: '2026-01-15T09:30:00Z',
    author: U.grigory,
    content:
      'Длинное сообщение для проверки переноса строк: после релиза нужно обновить документацию по развёртыванию, ' +
      'проверить шаблон конфигурации LiveKit на стенде, пересобрать образ Caddy с модулем layer4 и убедиться, ' +
      'что порты 7881 и 7882 открыты в nftables, иначе клиенты за строгим NAT не подключатся к голосу.',
  },
  { room: R.dev, at: '2026-01-15T09:45:00Z', author: U.grigory, content: 'Упал тест `gateway_resume_test.go`, смотрю.' },
  { key: 'readMark', room: R.general, at: '2026-01-15T10:12:00Z', author: U.vera, content: 'Ещё ссылка без разметки: https://calaba.test/docs/08-design' },
  { room: R.general, at: '2026-01-15T10:13:00Z', author: U.vera, content: 'Итог: **жирный**, *курсив*, ~~зачёркнутый~~, `код` — всё на месте.' },
  { room: R.dev, at: '2026-01-15T10:20:00Z', author: U.boris, content: `@${U.anna} глянь, пожалуйста, PR с миграциями.` },
  { room: R.general, at: '2026-01-15T11:00:00Z', author: U.boris, content: '@here кто сегодня дежурит по стенду?' },
  { room: R.general, at: '2026-01-15T11:02:00Z', author: U.dina, content: 'Могу я, если дадите доступ.' },
  { room: R.general, at: '2026-01-15T11:05:00Z', author: U.boris, content: 'Готово, выдал.' },
  // ---- «макеты» (Дизайн): the chat audio / video players (docs/09 #41); last, so earlier ids stay.
  { room: R.designMockups, at: '2026-01-15T11:30:00Z', author: U.vera, content: 'Джингл для релиза', attachments: [IDS.files.audio] },
  { room: R.designMockups, at: '2026-01-15T11:31:00Z', author: U.vera, content: 'И ролик с анимацией', attachments: [IDS.files.video] },
];

/**
 * The fixture voice message's waveform (100 bars): the envelope voice-note.ogg was made with
 * (e2e-support/README.md), so the bubble looks like the sound.
 */
export const VOICE_WAVEFORM = Uint8Array.from({ length: 100 }, (_, i) => {
  const t = (i + 0.5) * 0.05;
  const v = 0.05 + 0.9 * Math.abs(Math.sin(2 * Math.PI * t * 0.7) * Math.sin(2 * Math.PI * t * 2.3)) ** 0.7;
  return Math.round(Math.min(1, v * (t > 4.5 ? (5 - t) / 0.5 : 1)) * 255);
});

/** Small media files for the players (≤ 100 KB, made with ffmpeg: e2e-support/README.md «Fixtures»). */
const media = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** Number of messages in `общий` in the `data` scenario. */
export const GENERAL_MESSAGE_COUNT = MESSAGES.filter((m) => m.room === R.general).length;

export function buildState(scenario: Scenario): MockState {
  const s: MockState = {
    scenario,
    serverVersion: 'dev',
    users: new Map(),
    workspaces: new Map(),
    members: [],
    rooms: new Map(),
    dmMembers: new Map(),
    shelves: new Map(),
    dmState: new Map(),
    messages: new Map(),
    readStates: new Map(),
    notifySettings: new Map(),
    wsNotifySettings: new Map(),
    voiceStates: new Map(),
    categories: new Map(),
    presences: new Map(),
    invites: new Map(),
    roomInvites: new Map(),
    admissions: new Map(),
    reactions: new Map(),
    files: new Map(),
    sessions: new Map(),
    revokedSessions: new Set(),
    notes: new Map(),
    superadmins: new Set(),
    planMeta: new Map(),
    planLog: new Map(),
    suspendedBy: new Map(),
    bans: new Map(),
    roles: new Map(),
    badges: new Map(),
    backgrounds: new Map(),
    sounds: new Map(),
    emailCodes: new Map(),
    emailInvites: new Map(),
    gptunnel: new Map(),
    recordings: new Map(),
    sipSettings: new Map(),
    sipPasswords: new Map(),
    sipCalls: new Map(),
    stickerPacks: new Map(),
    deletedStickers: new Map(),
    userStickerPacks: new Map(),
    bots: new Map(),
    blockedBots: new Map(),
    next: { user: 0x100, workspace: 0x100, room: 0x100, message: 0x1000, file: 0x100, invite: 0x100, session: 0x100, category: 0x100, role: 0x100, sticker: 0x100, stickerPack: 0x100, badge: 0x100, background: 0x100, sound: 0x100, event: 0x100 },
    clock: 0,
  };
  if (scenario === 'marketing') return buildMarketingState(s);

  const created = ts('2025-12-01T10:00:00Z');
  for (const u of USERS) {
    const id = IDS.users[u.key];
    const sessionId = u.key === 'anna' ? IDS.sessions.annaDesktop : mockId('session', 0x10 + u.n);
    s.users.set(id, {
      user: create(UserSchema, {
        id,
        displayName: u.name,
        avatarFileId: scenario === 'data' ? (u.avatar ?? '') : '',
        statusText: scenario === 'data' ? u.status : '',
        timezone: u.timezone ?? '',
        createdAt: created,
        isGuest: u.key === 'dina', // guest account from a room link (ADR-0016)
        // ADR-0077: contacts as the server shows them to colleagues (the mock does not strip them;
        // the client shows them by its own rule), the nickname to everyone.
        ...(scenario === 'data' && u.key !== 'dina' ? { email: u.email, emailVerified: true, phone: u.phone ?? '', username: u.username ?? '' } : {}),
      }),
      email: u.email,
      password: PASSWORD,
      settings: defaultSettings(),
      emailVerified: true,
      pendingEmail: '',
      locale: '',
    });
    s.sessions.set(id, [
      create(SessionSchema, {
        id: sessionId,
        deviceName: u.key === 'anna' ? 'MacBook Pro (darwin)' : 'Desktop (win32)',
        ip: '192.0.2.10',
        userAgent: 'Calab/0.0.1',
        createdAt: ts('2026-01-10T08:00:00Z'),
        lastSeenAt: ts('2026-01-15T11:05:00Z'),
        expiresAt: ts('2099-01-01T00:00:00Z'),
      }),
    ]);
  }
  s.sessions.get(U.anna)?.push(
    create(SessionSchema, {
      id: IDS.sessions.annaWeb,
      deviceName: 'Chrome (web)',
      ip: '198.51.100.24',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0',
      createdAt: ts('2026-01-12T19:30:00Z'),
      lastSeenAt: ts('2026-01-14T21:12:00Z'),
      expiresAt: ts('2099-01-01T00:00:00Z'),
    }),
  );

  // Presences exist in both scenarios (only visible via shared workspaces).
  const presence = (userId: string, status: PresenceStatus, lastSeen?: string): void => {
    s.presences.set(userId, create(PresenceSchema, { userId, status, ...(lastSeen ? { lastSeen: ts(lastSeen) } : {}) }));
  };
  presence(U.anna, PresenceStatus.ONLINE, '2026-01-15T11:05:00Z');
  presence(U.boris, PresenceStatus.DND, '2026-01-15T11:05:00Z');
  presence(U.vera, PresenceStatus.ONLINE, '2026-01-15T11:05:00Z');
  presence(U.grigory, PresenceStatus.IDLE, '2026-01-15T10:40:00Z');
  presence(U.dina, PresenceStatus.OFFLINE);
  // docs/09 #143: the app of Boris's latest session (the profile card shows «Calab 1.1.0 · macOS»).
  const boris = s.presences.get(U.boris);
  if (boris) Object.assign(boris, { clientVersion: '1.1.0', clientPlatform: 'darwin' });

  if (scenario === 'empty') return s;

  // ---- files
  const image = encodePng(640, 400, cardPicture([91, 141, 239], [255, 255, 255], [214, 228, 255], 640 / 400));
  const imageThumb = encodePng(512, 320, cardPicture([91, 141, 239], [255, 255, 255], [214, 228, 255], 512 / 320));
  s.files.set(IDS.files.image, {
    meta: fileMeta(IDS.files.image, IDS.workspaces.main, U.vera, 'icons-v2.png', 'image/png', image, ts('2026-01-14T12:39:00Z'), {
      width: 640,
      height: 400,
    }),
    bytes: image,
    thumbnail: { bytes: imageThumb, mime: 'image/png' },
  });
  const pdf = Buffer.alloc(245_760, 0x20);
  pdf.write('%PDF-1.4\n% Calab mock report\n', 0, 'latin1');
  s.files.set(IDS.files.pdf, {
    meta: fileMeta(IDS.files.pdf, IDS.workspaces.main, U.grigory, 'load-test-report.pdf', 'application/pdf', pdf, ts('2026-01-14T16:29:00Z')),
    bytes: pdf,
  });
  const jingle = media('release-jingle.mp3');
  s.files.set(IDS.files.audio, {
    meta: fileMeta(IDS.files.audio, IDS.workspaces.design, U.vera, 'Команда Calab - Джингл релиза.mp3', 'audio/mpeg', jingle, ts('2026-01-15T11:29:00Z')),
    bytes: jingle,
  });
  const clip = media('demo-clip.mp4');
  s.files.set(IDS.files.video, {
    meta: fileMeta(IDS.files.video, IDS.workspaces.design, U.vera, 'demo-clip.mp4', 'video/mp4', clip, ts('2026-01-15T11:30:30Z')),
    bytes: clip,
  });
  // Not in any message: injectMessage({ attachments: [IDS.files.voice] }) posts it (voice tests).
  const note = media('voice-note.ogg');
  const noteMeta = fileMeta(IDS.files.voice, IDS.workspaces.design, U.vera, 'voice-2026-01-15-11-32-00.ogg', 'audio/ogg', note, ts('2026-01-15T11:32:00Z'));
  noteMeta.voice = create(VoiceInfoSchema, { durationMs: 5010, waveform: VOICE_WAVEFORM });
  s.files.set(IDS.files.voice, { meta: noteMeta, bytes: note });
  const portrait = encodePng(720, 1280, cardPicture([64, 170, 140], [255, 255, 255], [204, 240, 228], 720 / 1280));
  const portraitThumb = encodePng(288, 512, cardPicture([64, 170, 140], [255, 255, 255], [204, 240, 228], 288 / 512));
  s.files.set(IDS.files.portrait, {
    meta: fileMeta(IDS.files.portrait, IDS.workspaces.main, U.vera, 'IMG_2041.png', 'image/png', portrait, ts('2026-01-15T11:33:00Z'), { width: 720, height: 1280 }),
    bytes: portrait,
    thumbnail: { bytes: portraitThumb, mime: 'image/png' },
  });
  // Kept by the server after GPTunneL's done (docs/09 #47): the card's audio, posted by Борис.
  const meeting = media('meeting-recording.m4a');
  s.files.set(IDS.files.meeting, {
    meta: fileMeta(IDS.files.meeting, IDS.workspaces.main, U.boris, 'Переговорка 2026-01-15 12-00.m4a', 'audio/mp4', meeting, ts('2026-01-15T12:43:00Z')),
    bytes: meeting,
  });
  // ---- sticker packs (ADR-0030)
  const stickerFile = (id: string, name: string, bytes: Buffer): void => {
    s.files.set(id, { meta: fileMeta(id, IDS.workspaces.main, U.anna, name, 'image/webp', bytes, ts('2026-01-12T10:00:00Z'), { width: 160, height: 160 }), bytes });
  };
  const sun = media('sticker-sun.webp');
  const gem = media('sticker-gem.webp');
  const orbit = media('sticker-orbit.webp');
  stickerFile(IDS.files.stickerSun, 'sun.webp', sun);
  stickerFile(IDS.files.stickerGem, 'gem.webp', gem);
  stickerFile(IDS.files.stickerOrbit, 'orbit.webp', orbit);
  stickerFile(IDS.files.stickerSun2, 'wave.webp', sun);
  stickerFile(IDS.files.stickerGem2, 'heart.webp', gem);
  const st = (id: string, packId: string, fileId: string, emoji: string, bytes: Buffer, animated = false) =>
    create(StickerSchema, { id, packId, emoji, url: `/api/files/${fileId}`, width: 160, height: 160, animated, size: bytes.length });
  const P = IDS.stickerPacks;
  const S = IDS.stickers;
  s.stickerPacks.set(
    P.calab,
    create(StickerPackSchema, {
      id: P.calab,
      workspaceId: IDS.workspaces.main,
      name: 'Calab',
      shortName: 'calab',
      stickers: [st(S.sun, P.calab, IDS.files.stickerSun, '☀️', sun), st(S.gem, P.calab, IDS.files.stickerGem, '💎', gem), st(S.orbit, P.calab, IDS.files.stickerOrbit, '🌀', orbit, true)],
      createdBy: U.anna,
      createdAt: ts('2026-01-12T10:00:00Z'),
      updatedAt: ts('2026-01-12T10:05:00Z'),
    }),
  );
  s.stickerPacks.set(
    P.moods,
    create(StickerPackSchema, {
      id: P.moods,
      workspaceId: IDS.workspaces.main,
      name: 'Эмоции',
      shortName: 'moods',
      stickers: [st(S.wave, P.moods, IDS.files.stickerSun2, '👋', sun), st(S.heart, P.moods, IDS.files.stickerGem2, '❤️', gem)],
      createdBy: U.boris,
      createdAt: ts('2026-01-13T10:00:00Z'),
      updatedAt: ts('2026-01-13T10:00:00Z'),
    }),
  );
  s.userStickerPacks.set(U.anna, [P.calab]);

  const avatar = encodePng(128, 128, avatarPicture([255, 150, 120], [96, 72, 190]));
  s.files.set(IDS.files.veraAvatar, {
    meta: fileMeta(IDS.files.veraAvatar, '', U.vera, 'avatar.png', 'image/png', avatar, ts('2025-12-02T10:00:00Z'), { width: 128, height: 128 }),
    bytes: avatar,
    thumbnail: { bytes: avatar, mime: 'image/png' },
  });

  // ---- workspaces
  const ws = (id: string, slug: string, name: string, ownerId: string, visibility: WorkspaceVisibility, at: string, used: bigint): void => {
    s.workspaces.set(
      id,
      create(WorkspaceSchema, {
        id,
        slug,
        name,
        iconFileId: '',
        visibility,
        ownerId,
        createdAt: ts(at),
        mediaDefaults: DEFAULT_MEDIA,
        storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
        storageUsedBytes: used,
        allowSelfNickname: true,
      }),
    );
  };
  const W = IDS.workspaces;
  ws(W.main, 'calaba', 'Команда Calab', U.anna, WorkspaceVisibility.PRIVATE, '2025-12-01T10:05:00Z', 1_234_567n);
  ws(W.design, 'design', 'Дизайн', U.vera, WorkspaceVisibility.PRIVATE, '2025-12-03T12:00:00Z', 0n);
  ws(W.community, 'community', 'Сообщество', U.boris, WorkspaceVisibility.OPEN, '2025-12-05T12:00:00Z', 0n);

  const member = (workspaceId: string, userId: string, role: WorkspaceRole, joined: string, nickname = ''): void => {
    s.members.push({ workspaceId, userId, role, nickname, joinedAt: ts(joined) });
  };
  // ---- plans (ADR-0024): Team for the main workspace (no video caps: the voice shots stay as
  // they are), Free for «Дизайн», Custom for «Сообщество»; Anna is the superadmin.
  s.superadmins.add(U.anna);
  const setPlan = (id: string, plan: Plan, limits: PlanLimits, note: string, at: string, validUntil?: string): void => {
    const w = s.workspaces.get(id);
    if (!w) return;
    w.plan = create(WorkspacePlanSchema, { plan, limits, ...(validUntil ? { validUntil: ts(validUntil) } : {}), expired: false });
    s.planMeta.set(id, { note, updatedBy: U.anna, updatedAt: ts(at) });
    s.planLog.set(id, [
      create(PlanLogEntrySchema, {
        id: `${id}-log-1`,
        workspaceId: id,
        actorId: U.anna,
        actorEmail: 'owner@calaba.test',
        plan,
        limits,
        ...(validUntil ? { validUntil: ts(validUntil) } : {}),
        note,
        createdAt: ts(at),
      }),
    ]);
  };
  setPlan(W.main, Plan.TEAM, TEAM_PLAN_LIMITS, 'Счёт № 42, оплачен', '2026-01-10T09:00:00Z', '2026-12-31T23:59:59Z');
  const design = s.workspaces.get(W.design);
  if (design) design.plan = create(WorkspacePlanSchema, { plan: Plan.FREE, limits: FREE_PLAN_LIMITS, expired: false });
  setPlan(
    W.community,
    Plan.CUSTOM,
    create(PlanLimitsSchema, {
      roomMembers: 12,
      streamMaxPreset: ScreenSharePreset.H1080,
      streamMaxFps: 30,
      cameraMaxPreset: ScreenSharePreset.H720,
      cameraMaxFps: 30,
      streamsPerRoom: 2,
      storageMb: 5120n,
      members: 0,
    }),
    'Пилот для сообщества до весны',
    '2026-01-12T15:30:00Z',
    '2026-04-30T23:59:59Z',
  );

  // ---- custom roles (ADR-0026): «Дизайн» (blue) above «Модератор» (green), nobody holds them —
  // the role screens assign them (visual tests), the other screens stay as they are.
  s.roles.set(W.main, [
    ...builtinRoles(W.main),
    create(RoleSchema, {
      id: IDS.roles.design,
      workspaceId: W.main,
      name: 'Дизайн',
      color: 0x0a84ff,
      position: 3,
      permissions: PERMISSION_BITS.STREAM | PERMISSION_BITS.VIDEO | PERMISSION_BITS.ATTACH_FILES,
      mentionable: true,
      createdAt: ts('2026-01-05T10:00:00Z'),
    }),
    create(RoleSchema, {
      id: IDS.roles.moderator,
      workspaceId: W.main,
      name: 'Модератор',
      color: 0x34c759,
      position: 2,
      permissions: PERMISSION_BITS.MANAGE_MESSAGES | PERMISSION_BITS.MUTE_MEMBERS | PERMISSION_BITS.MOVE_MEMBERS,
      createdAt: ts('2026-01-05T10:05:00Z'),
    }),
  ]);

  member(W.main, U.anna, WorkspaceRole.OWNER, '2025-12-01T10:05:00Z');
  member(W.main, U.boris, WorkspaceRole.ADMIN, '2025-12-01T11:00:00Z');
  member(W.main, U.vera, WorkspaceRole.MEMBER, '2025-12-02T09:00:00Z');
  member(W.main, U.grigory, WorkspaceRole.MEMBER, '2025-12-02T09:30:00Z');
  member(W.main, U.dina, WorkspaceRole.GUEST, '2026-01-10T12:00:00Z');
  member(W.design, U.vera, WorkspaceRole.OWNER, '2025-12-03T12:00:00Z');
  member(W.design, U.anna, WorkspaceRole.MEMBER, '2025-12-03T12:10:00Z');
  member(W.community, U.boris, WorkspaceRole.OWNER, '2025-12-05T12:00:00Z');
  member(W.community, U.grigory, WorkspaceRole.MEMBER, '2025-12-06T12:00:00Z');

  // ---- rooms
  const room = (
    id: string,
    workspaceId: string,
    type: RoomType,
    name: string,
    topic: string,
    position: number,
    opts: {
      isPrivate?: boolean;
      overrides?: RoomPermissionOverride[];
      media?: RoomMediaOverride;
      categoryId?: string;
      userLimit?: number;
      voiceStartedAt?: string;
    } = {},
  ): void => {
    const mediaOverride = opts.media ?? create(RoomMediaOverrideSchema, {});
    s.rooms.set(
      id,
      create(RoomSchema, {
        id,
        workspaceId,
        type,
        name,
        topic,
        position,
        isPrivate: opts.isPrivate ?? false,
        media: effectiveMedia(s.workspaces.get(workspaceId), mediaOverride),
        mediaOverride,
        permissionOverrides: opts.overrides ?? [],
        createdAt: ts('2025-12-01T10:10:00Z'),
        categoryId: opts.categoryId ?? '',
        userLimit: opts.userLimit ?? 0,
        allowRecording: true, // the server's default (ADR-0025)
        ...(opts.voiceStartedAt ? { voiceStartedAt: ts(opts.voiceStartedAt) } : {}),
      }),
    );
  };
  // ---- categories: «Разработка» (text) and «Голосовые»; `общий` stays outside (top of the list).
  const C = IDS.categories;
  s.categories.set(C.dev, create(RoomCategorySchema, { id: C.dev, workspaceId: W.main, name: 'Разработка', position: 0 }));
  s.categories.set(C.voice, create(RoomCategorySchema, { id: C.voice, workspaceId: W.main, name: 'Голосовые', position: 1 }));
  const ROLE = PermissionTargetType.ROLE;
  const USER = PermissionTargetType.USER;
  room(R.general, W.main, RoomType.TEXT, 'общий', 'Общие вопросы команды', 0, {
    // @member: one allow (pin / delete others' messages) and one deny (files), so the room
    // settings «Права» shot shows all three tri-state values (review 2, §5).
    overrides: [override(ROLE, 'guest', VIEW_ROOM | SEND_MESSAGES, 0n), override(ROLE, 'member', MANAGE_MESSAGES, ATTACH_FILES)],
  });
  room(R.dev, W.main, RoomType.TEXT, 'разработка', 'Код, ревью, CI', 1, { categoryId: C.dev });
  room(R.longPrivate, W.main, RoomType.TEXT, 'очень-длинное-название-комнаты-для-проверки-обрезки', 'Закрытая комната', 2, {
    isPrivate: true,
    overrides: [override(ROLE, 'member', 0n, VIEW_ROOM), override(USER, U.vera, VIEW_ROOM, 0n)],
    categoryId: C.dev,
  });
  room(R.call, W.main, RoomType.VOICE, 'Созвон', '', 3, { categoryId: C.voice });
  room(R.meeting, W.main, RoomType.VOICE, 'Переговорка', 'Для встреч', 4, {
    overrides: [override(ROLE, 'guest', VIEW_ROOM, 0n)],
    media: create(RoomMediaOverrideSchema, { audioBitrateKbps: 48, maxStreams: 2 }),
    categoryId: C.voice,
    userLimit: 4,
    // The call runs since 13:05 MSK; the visual tests freeze the clock at 13:30 → «25:00».
    voiceStartedAt: '2026-01-15T10:05:00Z',
  });
  room(R.designMockups, W.design, RoomType.TEXT, 'макеты', '', 0);
  room(R.designReview, W.design, RoomType.VOICE, 'Ревью', '', 1);
  room(R.communityWelcome, W.community, RoomType.TEXT, 'добро-пожаловать', '', 0);

  // ---- messages (ids in chronological order)
  const sorted = [...MESSAGES].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byKey = new Map<string, string>();
  let n = 1;
  for (const m of sorted) {
    const id = mockId('message', n++);
    if (m.key) byKey.set(m.key, id);
    const attachments = (m.attachments ?? []).map((fid) => {
      const f = s.files.get(fid);
      if (!f) throw new Error(`fixture file ${fid} missing`);
      return f.meta;
    });
    const msg = create(MessageSchema, {
      id,
      roomId: m.room,
      authorId: m.author,
      content: m.content,
      attachments,
      replyToId: m.replyTo ? (byKey.get(m.replyTo) ?? '') : '',
      nonce: '',
      createdAt: ts(m.at),
      ...(m.editedAt ? { editedAt: ts(m.editedAt) } : {}),
      ...(m.pinnedBy ? { pinnedAt: timestampFromMs(Date.parse(m.at) + 5 * 60_000), pinnedBy: m.pinnedBy } : {}),
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, users]) => ({ emoji, count: users.length, me: false })),
    });
    if (m.reactions) s.reactions.set(id, new Map(Object.entries(m.reactions).map(([e, users]) => [e, new Set(users)])));
    const list = s.messages.get(m.room) ?? [];
    list.push(msg);
    s.messages.set(m.room, list);
  }

  // ---- direct messages (ADR-0020): Anna ↔ Boris (2 unread, one pinned), Vera (yesterday, read),
  // Grigory (a week ago, read). Message ids come from their own range (0x800+): after every room
  // message, so the fixture room messages keep their ids.
  const dm = (roomId: string, peer: string, created: string): void => {
    s.rooms.set(roomId, create(RoomSchema, { id: roomId, workspaceId: '', type: RoomType.DM, name: '', createdAt: ts(created) }));
    s.dmMembers.set(roomId, [U.anna, peer]);
  };
  dm(IDS.dms.boris, U.boris, '2026-01-05T09:00:00Z');
  dm(IDS.dms.vera, U.vera, '2026-01-06T09:00:00Z');
  dm(IDS.dms.grigory, U.grigory, '2026-01-07T09:00:00Z');
  const DM_MESSAGES: { room: string; author: string; at: string; content: string; key?: string; pinned?: boolean; reactions?: Record<string, string[]> }[] = [
    { room: IDS.dms.grigory, author: U.anna, at: '2026-01-08T15:20:00Z', content: 'Григорий, отчёт по нагрузке — огонь 🔥 Покажешь на планёрке?' },
    { room: IDS.dms.grigory, author: U.grigory, at: '2026-01-08T15:31:00Z', content: 'Да, подготовлю пару слайдов.' },
    { room: IDS.dms.vera, author: U.vera, at: '2026-01-14T15:02:00Z', content: 'Макеты рейла готовы: «Личные» сверху, как в Discord. Ссылка в #макеты', reactions: { '👍': [U.anna] } },
    { room: IDS.dms.vera, author: U.anna, at: '2026-01-14T15:07:00Z', content: 'Супер, спасибо! Посмотрю вечером.' },
    { room: IDS.dms.boris, author: U.boris, at: '2026-01-15T08:40:00Z', content: 'Анна, привет! Посмотришь PR с миграцией **00011**?' },
    { room: IDS.dms.boris, author: U.anna, at: '2026-01-15T08:42:00Z', content: 'Да, после обеда.', key: 'dmBorisRead' },
    { room: IDS.dms.boris, author: U.boris, at: '2026-01-15T10:15:00Z', content: 'Чек-лист релиза:\n1. миграции\n2. `make gen`\n3. визуальные тесты', pinned: true },
    { room: IDS.dms.boris, author: U.boris, at: '2026-01-15T10:16:00Z', content: 'Закрепил, чтобы не потерялся 🙏' },
  ];
  let dn = 0x800;
  const dmRead = new Map<string, string>();
  for (const m of DM_MESSAGES) {
    const id = mockId('message', dn++);
    if (m.key) dmRead.set(m.room, id);
    const msg = create(MessageSchema, {
      id,
      roomId: m.room,
      authorId: m.author,
      content: m.content,
      nonce: '',
      createdAt: ts(m.at),
      ...(m.pinned ? { pinnedAt: timestampFromMs(Date.parse(m.at) + 60_000), pinnedBy: m.author } : {}),
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, users]) => ({ emoji, count: users.length, me: false })),
    });
    if (m.reactions) s.reactions.set(id, new Map(Object.entries(m.reactions).map(([e, users]) => [e, new Set(users)])));
    const list = s.messages.get(m.room) ?? [];
    list.push(msg);
    s.messages.set(m.room, list);
  }

  // ---- read states: Anna is behind in `общий` and `разработка`, up to date elsewhere.
  const last = (roomId: string): string => s.messages.get(roomId)?.at(-1)?.id ?? '';
  const annaRead = new Map<string, string>([
    [R.general, byKey.get('readMark') ?? ''],
    [R.dev, s.messages.get(R.dev)?.[0]?.id ?? ''],
    [R.longPrivate, last(R.longPrivate)],
    [R.call, last(R.call)],
    [R.designMockups, last(R.designMockups)],
    [IDS.dms.boris, dmRead.get(IDS.dms.boris) ?? ''],
    [IDS.dms.vera, last(IDS.dms.vera)],
    [IDS.dms.grigory, last(IDS.dms.grigory)],
  ]);
  s.readStates.set(U.anna, annaRead);
  for (const u of [U.boris, U.vera, U.grigory, U.dina]) {
    s.readStates.set(u, new Map([...s.messages.keys()].map((rid) => [rid, last(rid)])));
  }

  // ---- notifications: Anna gets only mentions from the long private room, muted until 14:30 MSK
  // (the visual tests' clock is 13:30 → the bell shows «muted»; later it reads «only mentions»).
  s.notifySettings.set(
    U.anna,
    new Map([
      [
        R.longPrivate,
        create(RoomNotificationSettingsSchema, { roomId: R.longPrivate, level: NotificationLevel.MENTIONS, mutedUntil: ts('2026-01-15T11:30:00Z') }),
      ],
    ]),
  );

  // ---- voice: Boris (muted) and Vera (streaming) in «Переговорка». Cameras: none (the visual
  // test turns Boris's on together with a real LiveKit camera track, so tiles and icons agree).
  s.voiceStates.set(U.boris, create(VoiceStateSchema, { workspaceId: W.main, userId: U.boris, roomId: R.meeting, muted: true }));
  s.voiceStates.set(U.vera, create(VoiceStateSchema, { workspaceId: W.main, userId: U.vera, roomId: R.meeting, streaming: true }));

  // ---- invites
  s.invites.set(
    mockId('invite', 1),
    create(InviteSchema, {
      id: mockId('invite', 1),
      workspaceId: W.main,
      code: 'calaba-team-2026',
      createdBy: U.anna,
      maxUses: 0,
      uses: 3,
      createdAt: ts('2026-01-05T10:00:00Z'),
    }),
  );
  s.invites.set(
    mockId('invite', 2),
    create(InviteSchema, {
      id: mockId('invite', 2),
      workspaceId: W.main,
      code: 'guest-pass-7d',
      createdBy: U.boris,
      maxUses: 10,
      uses: 1,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-10T11:30:00Z'),
    }),
  );

  // ---- room link for «Созвон» (ADR-0016)
  s.roomInvites.set(
    mockId('invite', 3),
    create(RoomInviteSchema, {
      id: mockId('invite', 3),
      roomId: R.call,
      workspaceId: W.main,
      code: 'call-guest-link',
      createdBy: U.anna,
      maxUses: 10,
      uses: 2,
      allowGuests: true,
      allowSpeak: true,
      allowMessages: true,
      allowFiles: false,
      allowStream: false,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-12T09:00:00Z'),
    }),
  );
  // ---- guest link for «общий»: the room invite modal shows it right away (docs/09 #55)
  s.roomInvites.set(
    mockId('invite', 4),
    create(RoomInviteSchema, {
      id: mockId('invite', 4),
      roomId: R.general,
      workspaceId: W.main,
      code: 'general-guest-link',
      createdBy: U.anna,
      maxUses: 0,
      uses: 0,
      allowGuests: true,
      allowSpeak: false,
      allowMessages: true,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-13T09:00:00Z'),
    }),
  );

  return s;
}

/** Link previews served by GET /api/unfurl (the image is a local PNG behind /api/unfurl/image). */
export const UNFURLS: Record<string, { title: string; description: string; siteName: string; image: boolean }> = {
  'https://calaba.test/docs/08-design': {
    siteName: 'Calab Docs',
    title: 'Дизайн и UX',
    description: 'Визуальный язык macOS: сдержанные цвета, много воздуха, чёткая иерархия, материал «стекло» на панелях.',
    image: true,
  },
  'https://calaba.test/board': {
    siteName: 'calaba.test',
    title: 'Доска созвона',
    description: 'Задачи на неделю и заметки встречи.',
    image: false,
  },
};

