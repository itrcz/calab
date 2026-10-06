import { t, type MessageKey } from '../../i18n';
import { ImageError } from '../image/errors';
import { ApiError } from './client';

/**
 * Human error texts (docs/09 #16): no raw strings («Failed to fetch», «slug must be 3..32
 * characters», «Error invoking remote method …») ever reach the UI. Every ApiError code and
 * every transport failure maps to a short Russian sentence; `retry` says whether repeating the
 * same action can help (the toast then offers «Повторить»). Pure: no logging, no stores.
 */
export interface HumanError {
  text: string;
  /** Offending field (ERROR_CODE_VALIDATION), for inline errors next to the input. */
  field?: string;
  /** Batch uploads (stickers): `file[i]` / `emoji[i]` → field `file` / `emoji`, index `i`. */
  index?: number;
  /** A retry of the same request may succeed (network, 5xx, rate limit). */
  retry: boolean;
  /** No specific reason is known: the text is the generic «Не получилось…». */
  generic: boolean;
}

const CODE: Record<string, { key: MessageKey; retry?: boolean }> = {
  ERROR_CODE_SSO_REQUIRED: { key: 'identity.required' },
  ERROR_CODE_IDENTITY_SCOPE_DENIED: { key: 'identity.scope' },
  ERROR_CODE_DIRECTORY_ACCESS_DENIED: { key: 'identity.directoryDenied' },
  ERROR_CODE_RECOVERY_ONLY: { key: 'identity.recoveryOnly' },
  ERROR_CODE_RECENT_AUTH_REQUIRED: { key: 'identity.reauthRequired' },
  ERROR_CODE_IDENTITY_CONFIG_CHANGED: { key: 'identity.changed', retry: true },
  ERROR_CODE_IDENTITY_NOT_LINKED: { key: 'identity.noLink' },
  ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE: { key: 'identity.unavailable', retry: true },
  ERROR_CODE_PLAN_LIMIT: { key: 'identity.plan' },
  ERROR_CODE_INTERNAL: { key: 'err.internal', retry: true },
  ERROR_CODE_BAD_REQUEST: { key: 'err.badRequest' },
  ERROR_CODE_VALIDATION: { key: 'err.validation' },
  ERROR_CODE_UNAUTHENTICATED: { key: 'err.unauthenticated' },
  ERROR_CODE_INVALID_REFRESH_TOKEN: { key: 'err.unauthenticated' },
  ERROR_CODE_FORBIDDEN: { key: 'err.forbidden' },
  ERROR_CODE_NOT_FOUND: { key: 'err.notFound' },
  ERROR_CODE_CONFLICT: { key: 'err.conflict' },
  ERROR_CODE_RATE_LIMITED: { key: 'err.rateLimited', retry: true },
  ERROR_CODE_INVALID_CREDENTIALS: { key: 'auth.err.credentials' },
  ERROR_CODE_REGISTRATION_CLOSED: { key: 'auth.err.inviteOnly' },
  ERROR_CODE_INVITE_INVALID: { key: 'auth.err.inviteInvalid' },
  ERROR_CODE_FILE_TOO_LARGE: { key: 'err.fileTooLarge' },
  ERROR_CODE_FILE_QUOTA_EXCEEDED: { key: 'err.quota' },
  ERROR_CODE_PAYLOAD_TOO_LARGE: { key: 'err.payloadTooLarge' },
  ERROR_CODE_ROOM_FULL: { key: 'err.roomFull' },
  ERROR_CODE_WORKSPACE_LIMIT: { key: 'err.workspaceLimit' },
  ERROR_CODE_STORAGE_FULL: { key: 'err.storageFull' },
  ERROR_CODE_EMAIL_NOT_VERIFIED: { key: 'mail.err.notVerified' },
  ERROR_CODE_CODE_INVALID: { key: 'mail.err.codeInvalid' },
  ERROR_CODE_CODE_EXPIRED: { key: 'mail.err.codeExpired' },
  ERROR_CODE_NOT_PAIRED: { key: 'rec.start.notPaired' },
  ERROR_CODE_ALREADY_RECORDING: { key: 'rec.start.already' },
  ERROR_CODE_RECORDING_LIMIT: { key: 'rec.start.busy', retry: true },
  ERROR_CODE_FILE_GONE: { key: 'rec.retry.fileGone' },
  ERROR_CODE_ALREADY_UPLOADED: { key: 'rec.retry.alreadyUploaded' },
  ERROR_CODE_WORKSPACE_SUSPENDED: { key: 'err.suspended' },
  ERROR_CODE_BANNED: { key: 'err.banned' },
  ERROR_CODE_ROOM_ARCHIVED: { key: 'temp.archived' },
  ERROR_CODE_USERNAME_TAKEN: { key: 'profile.username.taken' },
  ERROR_CODE_USERNAME_INVALID: { key: 'profile.username.invalid' },
};

const IMAGE_ERR: Record<ImageError['reason'], MessageKey> = {
  heicUnsupported: 'img.err.heicUnsupported',
  broken: 'img.err.broken',
  noEncoder: 'img.err.noEncoder',
};

/** ERROR_CODE_VALIDATION `field` (protojson name, see apps/server Validation(...)) → text. */
const FIELD: Record<string, MessageKey> = {
  name: 'err.field.name',
  displayName: 'err.field.displayName',
  nickname: 'err.field.nickname',
  slug: 'err.field.slug',
  email: 'err.field.email',
  password: 'err.field.password',
  content: 'err.field.content',
  topic: 'err.field.topic',
  statusText: 'err.field.status',
  phone: 'profile.phone.invalid',
  text: 'err.field.status',
  userLimit: 'err.field.userLimit',
  maxUses: 'err.field.maxUses',
  expiresInSeconds: 'err.field.expires',
  file: 'err.field.image',
  avatarFileId: 'err.field.image',
  iconFileId: 'err.field.image',
  attachmentIds: 'err.field.attachments',
  emoji: 'err.field.emoji',
  q: 'err.field.query',
  url: 'err.field.url',
  targetRoomId: 'err.field.targetRoom',
};

/**
 * `file[3]` / `emoji[3]` of a multipart batch (POST /api/sticker-packs/{id}/stickers), or a plain
 * `file` refused as a sticker (PUT …/stickers/{sid}: «not a valid WebP sticker: …»).
 */
const STICKER_FIELD = /^(file|emoji)(?:\[(\d+)\])?$/;
const WEBP_REFUSAL = /not a valid WebP sticker/;

/**
 * Why the server refused a sticker file — the reasons of ValidateWebP
 * (apps/server/internal/stickers/webp.go); anything else there is a broken / non-WebP file.
 */
const STICKER_FILE: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/canvas \d+x\d+ is larger than|size \d+x\d+ is outside/, 'stk.err.side'],
  [/file is larger than|too large/, 'stk.err.weight'],
  [/more than \d+ frames/, 'stk.err.frames'],
  [/animation longer than/, 'stk.err.duration'],
];

function stickerField(field: string, message: string): HumanError | null {
  const m = STICKER_FIELD.exec(field);
  if (!m) return null;
  const [, name = '', i] = m;
  if (i === undefined && !(name === 'file' && WEBP_REFUSAL.test(message))) return null;
  const key = name === 'emoji' ? 'stk.err.emoji' : (STICKER_FILE.find(([re]) => re.test(message))?.[1] ?? 'stk.err.notWebp');
  return { text: t(key), field: name, ...(i !== undefined ? { index: Number(i) } : {}), retry: false, generic: false };
}

const generic = (): HumanError => ({ text: t('err.generic'), retry: true, generic: true });

function fromStatus(status: number): HumanError {
  if (status === 0) return { text: t('err.network'), retry: true, generic: false };
  if (status === 401) return { text: t('err.unauthenticated'), retry: false, generic: false };
  if (status === 403) return { text: t('err.forbidden'), retry: false, generic: false };
  if (status === 404 || status === 410) return { text: t('err.notFound'), retry: false, generic: false };
  if (status === 413) return { text: t('err.fileTooLarge'), retry: false, generic: false };
  if (status === 429) return { text: t('err.rateLimited'), retry: true, generic: false };
  if (status === 502 || status === 503 || status === 504) return { text: t('err.unavailable'), retry: true, generic: false };
  if (status >= 500) return { text: t('err.internal'), retry: true, generic: false };
  return generic();
}

/** Transport-level failures: fetch() rejections, offline, CORS, aborted requests. */
function isNetworkError(e: unknown): boolean {
  // Some runtimes have no navigator.onLine at all (undefined): that is not «offline».
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine) return true;
  if (!(e instanceof Error)) return false;
  return e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message);
}

export function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

/**
 * 409 CONFLICT reason IDENTITY_NOT_CONFIGURED: the server has no SSO / OAuth provider operator
 * configuration (ADR-0054). A normal state of the install, shown as «не настроено на сервере».
 */
export function identityNotConfigured(e: unknown): boolean {
  return e instanceof ApiError && e.reason === 'IDENTITY_NOT_CONFIGURED';
}

/** 403 RECENT_AUTH_REQUIRED: the action needs a fresh local password proof (5 min, ADR-0054). */
export function recentAuthRequired(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ERROR_CODE_RECENT_AUTH_REQUIRED';
}

export function describeError(e: unknown): HumanError {
  if (e instanceof ApiError) {
    if (identityNotConfigured(e)) return { text: t('identity.notConfigured'), retry: false, generic: false };
    if (e.code === 'ERROR_CODE_UNAVAILABLE') return e.status === 0 ? fromStatus(0) : { text: t('err.unavailable'), retry: true, generic: false };
    if (e.code === 'ERROR_CODE_VALIDATION') {
      const sticker = e.field ? stickerField(e.field, e.message) : null;
      if (sticker) return sticker;
      const key = e.field ? FIELD[e.field] : undefined;
      return { text: t(key ?? 'err.validation'), ...(e.field ? { field: e.field } : {}), retry: false, generic: false };
    }
    const c = CODE[e.code];
    if (c) return { text: t(c.key), retry: c.retry ?? false, generic: false };
    return fromStatus(e.status);
  }
  // A picture that cannot be opened / encoded (lib/image): HEIC with no decoder, a broken file.
  if (e instanceof ImageError) return { text: t(IMAGE_ERR[e.reason]), retry: false, generic: false };
  if (isAbort(e)) return { text: t('err.cancelled'), retry: false, generic: false };
  if (isNetworkError(e)) return fromStatus(0);
  return generic();
}

/**
 * One line for a toast / inline error. With `what` («Не удалось сохранить») the reason follows
 * as a second sentence; a generic reason becomes «Не удалось сохранить. Попробуйте ещё раз».
 */
export function errorText(e: unknown, what?: string): string {
  const h = describeError(e);
  if (!what) return h.text;
  return `${what}. ${h.generic ? t('err.tryAgain') : h.text}`;
}
