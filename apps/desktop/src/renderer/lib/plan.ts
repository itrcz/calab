import { Plan, ScreenSharePreset, SCREEN_SHARE_PRESETS, type ConcreteScreenSharePreset, type PlanLimits, type WorkspacePlan } from '@calaba/protocol';
import { plural, t, type MessageKey, type PluralKey } from '../i18n';
import { fmt } from './format';

/**
 * Workspace plans on the client (ADR-0024, docs/08 «Тариф»). Pure: no stores, no platform — the
 * UI and services call these. The server enforces every limit; the client only explains them
 * (locks, the «Тариф» tab, toasts) and never asks for more than the server granted.
 * In PlanLimits 0 / UNSPECIFIED = no limit.
 */

/** Built-in FREE limits (docs/04 «Тарифы», owner 28.09): the defaults of the admin CUSTOM form. */
export const FREE_LIMITS = {
  roomMembers: 5,
  streamMaxPreset: ScreenSharePreset.H720,
  streamMaxFps: 15,
  cameraMaxPreset: ScreenSharePreset.H720,
  cameraMaxFps: 15,
  streamsPerRoom: 1,
  storageMb: 5 * 1024,
  members: 50,
  bots: 1,
  stickerPacks: 1,
  audioTierMaxKbps: 16,
} as const;

/** Voice tiers the admin form offers as the plan cap; 0 = no cap. */
export const AUDIO_CAP_OPTIONS = [0, 8, 16, 32, 64] as const;

/** A voice tier above the plan's cap (`audio_tier_max_kbps`, 0 / undefined = none) is locked. */
export const audioTierLocked = (kbps: number, planMax: number | undefined): boolean => !!planMax && kbps > planMax;

/** The tier the mic may use: the room's, lowered to the plan's cap (docs/02 «Битрейт»). */
export const capAudioKbps = (kbps: number, planMax: number | undefined): number => (planMax && kbps > planMax ? planMax : kbps);

/** A counted limit (members, bots, sticker packs; 0 = none) is reached. */
export const atLimit = (used: number, limit: number | undefined): boolean => !!limit && used >= limit;

export const PLAN_LABEL: Record<Plan, MessageKey> = {
  [Plan.UNSPECIFIED]: 'plan.name.free',
  [Plan.FREE]: 'plan.name.free',
  [Plan.TEAM]: 'plan.name.team',
  [Plan.CUSTOM]: 'plan.name.custom',
  [Plan.ENTERPRISE]: 'plan.name.enterprise',
};

/**
 * Plan features that are not part of every plan: CalDAV, musician mode (ADR-0052), task
 * checklists — Team and above; board webhooks (ADR-0058 §5) and telephony SIP (ADR-0046, owner
 * 02.10) — Business only.
 */
export type PlanFeature = 'caldav' | 'musician' | 'checklists' | 'boardWebhooks' | 'telephony';

/** The «disabled» flag of PlanLimits behind each feature. */
const DISABLED_FLAG = {
  caldav: 'caldavDisabled',
  musician: 'musicianDisabled',
  checklists: 'checklistsDisabled',
  boardWebhooks: 'boardWebhooksDisabled',
  telephony: 'telephonyDisabled',
} as const satisfies Record<PlanFeature, keyof PlanLimits>;

/**
 * Is the feature part of the plan? PlanLimits carries «disabled» flags, so an absent plan (an older
 * server) or a plan without the flag allows it. The server enforces (409 PLAN_LIMIT); the client
 * shows the feature locked (PlanLock), never hides it.
 */
export function planHas(p: WorkspacePlan | undefined, f: PlanFeature): boolean {
  const l = p?.limits;
  return !l || !l[DISABLED_FLAG[f]];
}

/**
 * Can the plan have corporate identity — SSO, directory sync, the OAuth provider (ADR-0054 §5)?
 * In the cloud only a current Business (PLAN_ENTERPRISE); the server additionally wants a positive
 * entitlement and the operator configuration. No plan (an older server): the server decides.
 * A hint only: an on-prem Enterprise workspace is entitled on any plan, so the UI still asks the
 * server and an effective grant overrides this (PlanLock only without one).
 */
export function planHasIdentity(p: WorkspacePlan | undefined): boolean {
  return !p || (p.plan === Plan.ENTERPRISE && !p.expired);
}

/** The stored plan (UNSPECIFIED reads as FREE: the server's default when none was ever set). */
export const planKind = (p: WorkspacePlan | undefined): Plan => (!p || p.plan === Plan.UNSPECIFIED ? Plan.FREE : p.plan);

/** Webcam qualities the camera ▾ offers (capture 720p30 / 1080p30). */
export const CAMERA_PRESETS = [ScreenSharePreset.H720, ScreenSharePreset.H1080] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** Why a preset can't be picked: above the room's maximum (an admin's choice) or the plan's. */
export type PresetLock = 'room' | 'plan' | null;

/**
 * Screen share preset `p` against the room maximum (`Room.media.max_stream_preset`) and the plan
 * (`stream_max_preset`, UNSPECIFIED = none). The room lock wins: buying a plan would not lift it.
 */
export function streamPresetLock(p: ConcreteScreenSharePreset, roomMax: ScreenSharePreset, planMax: ScreenSharePreset | undefined): PresetLock {
  if (roomMax !== ScreenSharePreset.UNSPECIFIED && p > roomMax) return 'room';
  if (planMax && p > planMax) return 'plan'; // UNSPECIFIED (0) = no limit
  return null;
}

/** Webcam preset against the plan's `camera_max_preset`. */
export function cameraPresetLock(p: ScreenSharePreset, planMax: ScreenSharePreset | undefined): PresetLock {
  return planMax && p > planMax ? 'plan' : null; // UNSPECIFIED (0) = no limit
}

/** The highest preset ≤ `wanted` that neither the room nor the plan locks (ECONOMY at worst). */
export function allowedStreamPreset(wanted: ConcreteScreenSharePreset, roomMax: ScreenSharePreset, planMax: ScreenSharePreset | undefined): ConcreteScreenSharePreset {
  let p = wanted;
  while (p > ScreenSharePreset.ECONOMY && streamPresetLock(p, roomMax, planMax)) p = (p - 1);
  return p;
}

/** The camera preset to capture: the chosen one, lowered to what the plan allows. */
export function allowedCameraPreset(wanted: CameraPreset, planMax: ScreenSharePreset | undefined): CameraPreset {
  return cameraPresetLock(wanted, planMax) ? ScreenSharePreset.H720 : wanted;
}

/**
 * Frame rate to encode at: the preset's (or capture's) own, never above what the server granted
 * (`fps` of /stream/request, /camera/request; 0 = no cap).
 */
export function capFps(own: number, granted: number | undefined): number {
  return granted && granted > 0 ? Math.min(own, granted) : own;
}

/** Resolution in words: «720p», «исходное». */
function resText(p: ScreenSharePreset): string {
  if (p === ScreenSharePreset.ORIGINAL) return t('preset.native');
  if (p === ScreenSharePreset.UNSPECIFIED) return '';
  const h = SCREEN_SHARE_PRESETS[p].height;
  return h ? `${h}p` : t('preset.native');
}

/** «720p · 15 fps», «720p», «до 15 fps», or «Без ограничений» (a limit row of the «Тариф» tab). */
export function videoLimitText(preset: ScreenSharePreset, fps: number): string {
  const parts = [resText(preset), fps > 0 ? `${fps} fps` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('plan.unlimited');
}

/** A count limit («5») or «Без ограничений». */
export const countText = (n: number): string => (n > 0 ? fmt.number(n) : t('plan.unlimited'));

/** Storage limit in MiB → «1,00 ГБ» or «Без ограничений». */
export const storageText = (mb: bigint | number): string => (Number(mb) > 0 ? fmt.size(Number(mb) * 1024 * 1024) : t('plan.unlimited'));

/**
 * Where «Связаться для покупки» goes (`Ready.plan_contact`, server env): only `mailto:` and
 * `http(s):` — anything else (a misconfiguration) hides the button rather than open it.
 */
export function contactHref(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s.split('?')[0] ?? '')) return s;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  return null;
}

/** ApiError-like (lib/api/client.ts), duck-typed: this module stays free of the platform layer. */
interface ApiLike {
  name: string;
  code: string;
  message?: string;
  extra?: { reason?: string; used?: number; limit?: number };
}

const apiLike = (e: unknown): ApiLike | null => {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  return o['name'] === 'ApiError' && typeof o['code'] === 'string' ? (e as ApiLike) : null;
};

export interface PlanNotice {
  text: string;
  /** Offer «Связаться» (buying a plan would lift this limit). */
  contact: boolean;
}

/**
 * A plan limit behind an API error → the toast text (docs/08 «Тариф»), or null for any other
 * error (the caller shows its usual text):
 *   409 ROOM_FULL reason PLAN_LIMIT → «В бесплатном тарифе до 5 человек в комнате»;
 *   413 FILE_QUOTA_EXCEEDED → «Хранилище заполнено: 1,00 ГБ из 1,00 ГБ» (contact only when the
 *   plan is the cause, not the workspace's own quota).
 */
export function planErrorNotice(err: unknown, plan: Plan): PlanNotice | null {
  const e = apiLike(err);
  if (!e) return null;
  const x = e.extra ?? {};
  const byPlan = x.reason === 'PLAN_LIMIT';
  if (e.code === 'ERROR_CODE_ROOM_FULL' && byPlan) {
    const n = x.limit ?? 0;
    if (n <= 0) return { text: t('plan.toast.roomAny'), contact: true };
    // Team / Business name their plan; Free has its own wording; CUSTOM is «по тарифу пространства».
    if (plan === Plan.TEAM || plan === Plan.ENTERPRISE) return { text: t('plan.toast.roomPlan', { plan: t(PLAN_LABEL[plan]), n }), contact: true };
    const key: MessageKey = plan === Plan.FREE || plan === Plan.UNSPECIFIED ? 'plan.toast.roomFree' : 'plan.toast.room';
    return { text: t(key, { n }), contact: true };
  }
  // Members, voice quality (owner 28.09), sticker packs / stickers (ADR-0030) and bots
  // (ADR-0031) over the plan: 409 CONFLICT, reason PLAN_LIMIT; the message tells which limit.
  if (e.code === 'ERROR_CODE_CONFLICT' && byPlan) {
    const n = x.limit ?? 0;
    const msg = e.message ?? '';
    if (/\bvoice\b/i.test(msg)) return { text: t('plan.paidOnly'), contact: true };
    // CalDAV is a feature, not a count (ADR-0024, 30.09): used = limit = 0.
    if (/caldav/i.test(msg)) return { text: t('plan.caldavLocked'), contact: true };
    // Board webhooks — Business only, checklists — Team and above (ADR-0058 §5): features too.
    if (/webhook/i.test(msg)) return { text: t('plan.boardWebhooksLocked'), contact: true };
    if (/checklist/i.test(msg)) return { text: t('plan.checklistsLocked'), contact: true };
    // Telephony SIP — Business only (ADR-0046, owner 02.10).
    if (/telephony/i.test(msg)) return { text: t('plan.telephonyLocked'), contact: true };
    if (/\bmembers?\b/i.test(msg)) return { text: t('plan.membersFull', { plan: t(PLAN_LABEL[plan]), n }), contact: true };
    if (/\bboards?\b/i.test(msg)) return { text: t('plan.boardsFull', { plan: t(PLAN_LABEL[plan]), n }), contact: true };
    const key: PluralKey = /\bbots?\b/i.test(msg) ? 'bots.planLimit' : /pack/i.test(msg) ? 'stk.planPacks' : 'stk.planStickers';
    return { text: plural(key, n), contact: true };
  }
  // A notes shelf over the uploader's personal quota (ADR-0039 §5): nothing to buy, no «Связаться».
  if (e.code === 'ERROR_CODE_FILE_QUOTA_EXCEEDED' && x.reason === 'PERSONAL_QUOTA' && x.used !== undefined && x.limit !== undefined) {
    return { text: t('notes.quotaFull', { used: fmt.size(x.used), limit: fmt.size(x.limit) }), contact: false };
  }
  if (e.code === 'ERROR_CODE_FILE_QUOTA_EXCEEDED') {
    const text =
      x.used !== undefined && x.limit !== undefined ? t('plan.toast.quota', { used: fmt.size(x.used), limit: fmt.size(x.limit) }) : t('plan.toast.quotaAny');
    return { text, contact: byPlan };
  }
  return null;
}

// ---------------------------------------------------------------- admin form (CUSTOM limits)

/** The CUSTOM form's fields as typed (strings: inputs), converted by `limitsFromForm`. */
export interface LimitsForm {
  roomMembers: string;
  streamMaxPreset: ScreenSharePreset;
  streamMaxFps: string;
  cameraMaxPreset: ScreenSharePreset;
  cameraMaxFps: string;
  streamsPerRoom: string;
  storageMb: string;
  members: string;
  bots: string;
  stickerPacks: string;
  /** A tier (8 | 16 | 32 | 64) or 0 = no cap. */
  audioTierMaxKbps: number;
  /** Feature flags of the plan (ADR-0058 §5, ADR-0046): checklists off, board webhooks off, telephony off. */
  checklistsDisabled: boolean;
  boardWebhooksDisabled: boolean;
  telephonyDisabled: boolean;
}

/**
 * The form's starting values: the workspace's stored limits when it is CUSTOM already, the FREE
 * defaults otherwise (switching FREE / TEAM → CUSTOM starts from the free limits).
 */
export function limitsFormFrom(plan: Plan, limits: PlanLimits | undefined): LimitsForm {
  const src = plan === Plan.CUSTOM && limits ? limits : null;
  return {
    roomMembers: String(src ? src.roomMembers : FREE_LIMITS.roomMembers),
    streamMaxPreset: src ? src.streamMaxPreset : FREE_LIMITS.streamMaxPreset,
    streamMaxFps: String(src ? src.streamMaxFps : FREE_LIMITS.streamMaxFps),
    cameraMaxPreset: src ? src.cameraMaxPreset : FREE_LIMITS.cameraMaxPreset,
    cameraMaxFps: String(src ? src.cameraMaxFps : FREE_LIMITS.cameraMaxFps),
    streamsPerRoom: String(src ? src.streamsPerRoom : FREE_LIMITS.streamsPerRoom),
    storageMb: String(src ? src.storageMb : FREE_LIMITS.storageMb),
    members: String(src ? src.members : FREE_LIMITS.members),
    bots: String(src ? src.bots : FREE_LIMITS.bots),
    stickerPacks: String(src ? src.stickerPacks : FREE_LIMITS.stickerPacks),
    audioTierMaxKbps: src ? src.audioTierMaxKbps : FREE_LIMITS.audioTierMaxKbps,
    // ADR-0058 §5: a new CUSTOM plan has checklists and no board webhooks (the stored flags else).
    checklistsDisabled: src ? src.checklistsDisabled : CUSTOM_DEFAULT_FLAGS.checklistsDisabled,
    boardWebhooksDisabled: src ? src.boardWebhooksDisabled : CUSTOM_DEFAULT_FLAGS.boardWebhooksDisabled,
    telephonyDisabled: src ? src.telephonyDisabled : CUSTOM_DEFAULT_FLAGS.telephonyDisabled,
  };
}

/**
 * The feature flags a CUSTOM plan starts with: checklists on, board webhooks off (ADR-0058 §5),
 * telephony off (ADR-0046: Business only) — the server's CustomBase.
 */
export const CUSTOM_DEFAULT_FLAGS = { checklistsDisabled: false, boardWebhooksDisabled: true, telephonyDisabled: true } as const;

/** Upper bounds of the numeric fields (sanity, the server validates too). */
const MAX: Record<'roomMembers' | 'streamMaxFps' | 'cameraMaxFps' | 'streamsPerRoom' | 'storageMb' | 'members' | 'bots' | 'stickerPacks', number> = {
  roomMembers: 10_000,
  streamMaxFps: 120,
  cameraMaxFps: 120,
  streamsPerRoom: 100,
  storageMb: 100 * 1024 * 1024,
  members: 1_000_000,
  bots: 1000,
  stickerPacks: 10_000,
};

export type LimitsField = keyof typeof MAX;

export interface PlanLimitsInit {
  roomMembers: number;
  streamMaxPreset: ScreenSharePreset;
  streamMaxFps: number;
  cameraMaxPreset: ScreenSharePreset;
  cameraMaxFps: number;
  streamsPerRoom: number;
  storageMb: bigint;
  members: number;
  bots: number;
  stickerPacks: number;
  audioTierMaxKbps: number;
  checklistsDisabled: boolean;
  boardWebhooksDisabled: boolean;
  telephonyDisabled: boolean;
}

/**
 * Validates the CUSTOM form: every number a whole number 0…max (empty = 0 = no limit). Returns
 * the limits, or the first invalid field.
 */
export function limitsFromForm(f: LimitsForm): { limits: PlanLimitsInit } | { error: LimitsField } {
  const out: Partial<Record<LimitsField, number>> = {};
  for (const k of Object.keys(MAX) as LimitsField[]) {
    const raw = f[k].trim();
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX[k]) return { error: k };
    out[k] = n;
  }
  return {
    limits: {
      roomMembers: out.roomMembers ?? 0,
      streamMaxPreset: f.streamMaxPreset,
      streamMaxFps: out.streamMaxFps ?? 0,
      cameraMaxPreset: f.cameraMaxPreset,
      cameraMaxFps: out.cameraMaxFps ?? 0,
      streamsPerRoom: out.streamsPerRoom ?? 0,
      storageMb: BigInt(out.storageMb ?? 0),
      members: out.members ?? 0,
      bots: out.bots ?? 0,
      stickerPacks: out.stickerPacks ?? 0,
      audioTierMaxKbps: f.audioTierMaxKbps,
      checklistsDisabled: f.checklistsDisabled,
      boardWebhooksDisabled: f.boardWebhooksDisabled,
      telephonyDisabled: f.telephonyDisabled,
    },
  };
}

/** The admin form as a whole (features/admin): what PUT …/plan gets. */
export interface PlanForm {
  plan: Plan.FREE | Plan.TEAM | Plan.ENTERPRISE | Plan.CUSTOM;
  limits: LimitsForm;
  /** `<input type="date">` value; '' = no end date. */
  validUntil: string;
  note: string;
}

export const NOTE_MAX = 500;

/**
 * The PUT /api/admin/workspaces/{id}/plan body from the form: limits only with CUSTOM (FREE and
 * TEAM take theirs from the server config, ENTERPRISE has none), the end of the chosen day, the trimmed note. Returns
 * the first invalid field instead when the CUSTOM numbers are wrong.
 */
export function setPlanBody(f: PlanForm): { body: { plan: Plan; limits?: PlanLimitsInit; validUntil?: Date; note: string } } | { error: LimitsField } {
  let limits: PlanLimitsInit | undefined;
  if (f.plan === Plan.CUSTOM) {
    const r = limitsFromForm(f.limits);
    if ('error' in r) return r;
    limits = r.limits;
  }
  const until = validUntilFromInput(f.validUntil);
  return {
    body: {
      plan: f.plan,
      ...(limits ? { limits } : {}),
      ...(until ? { validUntil: until } : {}),
      note: f.note.trim().slice(0, NOTE_MAX),
    },
  };
}

/** `<input type="date">` value («2026-12-31») → the end of that day in UTC; '' → none. */
export function validUntilFromInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date → the `<input type="date">` value (UTC day). */
export function inputFromDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '';
}

/**
 * «Сейчас» of the «Тариф» tab from the workspace's live data: the fullest voice room, the most
 * streams in one room, members without guests (guests do not count against the plan; bots do),
 * bots among them.
 */
export function planUsage(
  voice: ReadonlyArray<{ roomId: string; streaming: boolean }>,
  members: ReadonlyArray<{ guest: boolean; bot?: boolean }>,
): { roomPeak: number; streamPeak: number; members: number; bots: number } {
  const people = new Map<string, number>();
  const streams = new Map<string, number>();
  for (const v of voice) {
    if (!v.roomId) continue;
    people.set(v.roomId, (people.get(v.roomId) ?? 0) + 1);
    if (v.streaming) streams.set(v.roomId, (streams.get(v.roomId) ?? 0) + 1);
  }
  const peak = (m: Map<string, number>): number => Math.max(0, ...m.values());
  return { roomPeak: peak(people), streamPeak: peak(streams), members: members.filter((m) => !m.guest).length, bots: members.filter((m) => m.bot).length };
}

/** min(value, cap); cap 0 = no plan limit. */
export function clampToCap(value: number, cap: number): number {
  return cap > 0 ? Math.min(value, cap) : value;
}

/** Highest selectable value of a count select under the plan cap (0 = no plan limit). */
export function capMax(max: number, cap: number): number {
  return cap > 0 ? Math.min(max, cap) : max;
}
