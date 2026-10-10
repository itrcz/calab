import { t, type MessageKey } from '../../i18n';

/**
 * Human errors for media / voice / stream (docs/09 #16): no raw strings («Not supported»,
 * «NotAllowedError: …») ever reach the UI. Every failure is classified into a code and mapped to
 * a short Russian text plus, where the user can fix it, one action. Pure: no platform, no store —
 * the caller logs the raw error (log.warn) and shows the result (services/mediaErrors.ts).
 */

/** Where the error happened: the same DOMException means different things for mic and screen. */
export type MediaContext = 'mic' | 'screen' | 'stream' | 'voice' | 'streamAudio' | 'camera' | 'cameraPublish';

export type MediaErrorCode =
  | 'cancelled'
  | 'permission'
  | 'os-permission'
  | 'not-found'
  | 'busy'
  | 'overconstrained'
  | 'unsupported'
  | 'insecure'
  | 'room-full'
  /** «Тариф не активен» (ADR-0086 amendment): ApiError.reason WORKSPACE_PLAN_INACTIVE (voice: two at most). */
  | 'plan-inactive'
  | 'stream-limit'
  | 'forbidden'
  | 'room-missing'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'timeout'
  | 'codec'
  | 'no-loopback'
  | 'unknown';

/** What the action button does (the UI layer knows how). */
export type MediaErrorAction = 'mic-privacy' | 'screen-privacy' | 'camera-privacy' | 'voice-settings' | 'connection';

export interface HumanError {
  code: MediaErrorCode;
  text: string;
  action: MediaErrorAction | null;
  /** The user did it themselves (closed the browser's picker): say nothing. */
  silent: boolean;
}

export interface ErrorEnv {
  /** Browser client (ADR-0015): different wording, no OS settings deep links. */
  web: boolean;
}

export const ACTION_LABEL: Record<MediaErrorAction, MessageKey> = {
  'mic-privacy': 'mediaErr.act.openSettings',
  'screen-privacy': 'mediaErr.act.openSettings',
  'camera-privacy': 'mediaErr.act.openSettings',
  'voice-settings': 'mediaErr.act.voiceSettings',
  connection: 'mediaErr.act.connection',
};

interface Parts {
  name: string;
  message: string;
  /** ApiError (lib/api/client.ts) — duck-typed to keep this module free of the platform layer. */
  apiCode: string | null;
  status: number | null;
  /** LiveKit ConnectionError reason name (NotAllowed, ServerUnreachable, Timeout, …). */
  reasonName: string | null;
  /** ApiError.reason (e.g. WORKSPACE_PLAN_INACTIVE). */
  apiReason?: string | null;
}

function parts(err: unknown): Parts {
  if (typeof err === 'string') return { name: '', message: err, apiCode: null, status: null, reasonName: null };
  if (!err || typeof err !== 'object') return { name: '', message: String(err), apiCode: null, status: null, reasonName: null };
  const o = err as Record<string, unknown>;
  const name = typeof o['name'] === 'string' ? o['name'] : '';
  const message = typeof o['message'] === 'string' ? o['message'] : '';
  const apiCode = name === 'ApiError' && typeof o['code'] === 'string' ? o['code'] : null;
  const status = typeof o['status'] === 'number' ? o['status'] : null;
  const reasonName = typeof o['reasonName'] === 'string' ? o['reasonName'] : null;
  const apiReason = apiCode && typeof o['reason'] === 'string' ? o['reason'] : null;
  return { name, message, apiCode, status, reasonName, apiReason };
}

/** Classifies a raw error into a code (context-independent where possible). */
export function classifyMediaError(err: unknown, ctx: MediaContext, env: ErrorEnv): MediaErrorCode {
  const p = parts(err);
  const msg = p.message.toLowerCase();

  // ---- our API (join / stream slot)
  if (p.apiCode) {
    if (p.apiReason === 'WORKSPACE_PLAN_INACTIVE') return 'plan-inactive';
    switch (p.apiCode) {
      case 'ERROR_CODE_ROOM_FULL':
        return 'room-full';
      case 'ERROR_CODE_CONFLICT':
        return ctx === 'stream' ? 'stream-limit' : 'server';
      case 'ERROR_CODE_FORBIDDEN':
        return 'forbidden';
      case 'ERROR_CODE_NOT_FOUND':
        return 'room-missing';
      case 'ERROR_CODE_RATE_LIMITED':
        return 'rate-limited';
      case 'ERROR_CODE_UNAVAILABLE':
        return p.status === 0 || p.status === null ? 'network' : 'server';
      default:
        return p.status === 0 ? 'network' : 'server';
    }
  }

  // ---- getUserMedia / getDisplayMedia (DOMException names, incl. legacy Chromium ones)
  switch (p.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Chromium: «Permission denied by system» = OS privacy settings. Otherwise, for the
      // browser's screen picker, the user simply closed it.
      if (msg.includes('by system')) return 'os-permission';
      if (ctx === 'screen') return env.web ? 'cancelled' : 'os-permission';
      return 'permission';
    case 'SecurityError':
      return env.web && ctx !== 'voice' ? 'insecure' : 'permission';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';
    case 'AbortError':
      return ctx === 'screen' && env.web ? 'cancelled' : 'busy';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'overconstrained';
    case 'NotSupportedError':
      return ctx === 'stream' ? 'codec' : 'unsupported';
    case 'InvalidStateError':
      return 'unknown';
    case 'TimeoutError':
      return 'timeout';
  }

  // ---- LiveKit
  if (p.name === 'ConnectionError') {
    switch (p.reasonName) {
      case 'NotAllowed':
        return 'forbidden';
      case 'Timeout':
        return 'timeout';
      case 'Cancelled':
      case 'LeaveRequest':
        return 'cancelled';
      case 'ServiceNotFound':
      case 'InternalError':
        return 'server';
      default:
        return 'network';
    }
  }
  if (p.name === 'DeviceUnsupportedError' || p.name === 'UnsupportedServer') return p.name === 'UnsupportedServer' ? 'server' : 'unsupported';
  if (p.name === 'PublishTrackError' || p.name === 'NegotiationError' || p.name === 'TrackInvalidError') {
    return ctx === 'stream' || ctx === 'screen' ? 'codec' : 'server';
  }
  if (p.name === 'SignalRequestError') return 'server';
  if (p.name === 'UnexpectedConnectionState' || p.name === 'SignalReconnectError') return 'network';

  // ---- plain messages (fetch failures, encoder / codec, missing APIs)
  if (/failed to fetch|networkerror|network error|load failed|err_internet|err_network|err_connection/.test(msg)) return 'network';
  if (/timed? ?out|timeout/.test(msg)) return 'timeout';
  if (/codec|encod|scalability/.test(msg)) return 'codec';
  if (/not supported|unsupported|is not a function|undefined is not|cannot read properties of undefined \(reading '(getusermedia|getdisplaymedia)'\)/.test(msg)) {
    return ctx === 'stream' ? 'codec' : 'unsupported';
  }
  if (p.name === 'TypeError' && /getusermedia|getdisplaymedia|mediadevices|rtcpeerconnection/.test(msg)) return 'unsupported';
  return 'unknown';
}

/** Text key + action for a code in a context. */
function text(code: MediaErrorCode, ctx: MediaContext, env: ErrorEnv): { key: MessageKey; action: MediaErrorAction | null } {
  if (code === 'plan-inactive') return { key: ctx === 'voice' ? 'billing.lapsed.roomFull' : 'billing.lapsed.error', action: null };
  const desktop = !env.web;
  switch (ctx) {
    case 'mic':
      switch (code) {
        case 'permission':
        case 'os-permission':
          return env.web ? { key: 'mediaErr.mic.permissionWeb', action: null } : { key: 'mediaErr.mic.permission', action: 'mic-privacy' };
        case 'not-found':
          return { key: 'mediaErr.mic.notFound', action: 'voice-settings' };
        case 'busy':
          return { key: 'mediaErr.mic.busy', action: 'voice-settings' };
        case 'overconstrained':
          return { key: 'mediaErr.mic.overconstrained', action: 'voice-settings' };
        case 'unsupported':
          return { key: env.web ? 'mediaErr.mic.unsupportedWeb' : 'mediaErr.mic.unsupported', action: null };
        case 'insecure':
          return { key: 'mediaErr.insecure', action: null };
        default:
          return { key: 'mediaErr.mic.generic', action: 'voice-settings' };
      }
    case 'screen':
      switch (code) {
        case 'permission':
        case 'os-permission':
          return desktop ? { key: 'mediaErr.screen.permission', action: 'screen-privacy' } : { key: 'mediaErr.screen.permissionWeb', action: null };
        case 'not-found':
          return { key: 'mediaErr.screen.gone', action: null };
        case 'busy':
          return { key: 'mediaErr.screen.busy', action: null };
        case 'unsupported':
          return { key: env.web ? 'mediaErr.screen.unsupportedWeb' : 'mediaErr.screen.unsupported', action: null };
        case 'insecure':
          return { key: 'mediaErr.insecure', action: null };
        case 'codec':
          return { key: 'mediaErr.stream.codec', action: null };
        default:
          return { key: 'mediaErr.screen.generic', action: null };
      }
    case 'stream':
      switch (code) {
        case 'stream-limit':
          return { key: 'mediaErr.stream.limit', action: null };
        case 'forbidden':
          return { key: 'mediaErr.stream.forbidden', action: null };
        case 'codec':
        case 'unsupported':
          return { key: env.web ? 'mediaErr.stream.codecWeb' : 'mediaErr.stream.codec', action: null };
        case 'network':
          return { key: 'mediaErr.network', action: 'connection' };
        case 'timeout':
          return { key: 'mediaErr.timeout', action: 'connection' };
        case 'rate-limited':
          return { key: 'mediaErr.rateLimited', action: null };
        default:
          return { key: 'mediaErr.stream.generic', action: null };
      }
    case 'camera':
      switch (code) {
        case 'permission':
        case 'os-permission':
          return env.web ? { key: 'mediaErr.camera.permissionWeb', action: null } : { key: 'mediaErr.camera.permission', action: 'camera-privacy' };
        case 'not-found':
          return { key: 'mediaErr.camera.notFound', action: 'voice-settings' };
        case 'busy':
          return { key: 'mediaErr.camera.busy', action: null };
        case 'overconstrained':
          return { key: 'mediaErr.camera.notFound', action: 'voice-settings' };
        case 'insecure':
          return { key: 'mediaErr.insecure', action: null };
        case 'unsupported':
          return { key: 'mediaErr.camera.unsupported', action: null };
        default:
          return { key: 'mediaErr.camera.generic', action: 'voice-settings' };
      }
    case 'cameraPublish':
      switch (code) {
        case 'forbidden':
          return { key: 'video.forbidden', action: null };
        case 'network':
        case 'timeout':
          return { key: 'mediaErr.network', action: 'connection' };
        case 'rate-limited':
          return { key: 'mediaErr.rateLimited', action: null };
        default:
          return { key: 'mediaErr.camera.publish', action: null };
      }
    case 'streamAudio':
      return code === 'no-loopback' ? { key: 'mediaErr.streamAudio.none', action: null } : { key: 'mediaErr.streamAudio.failed', action: null };
    case 'voice':
      switch (code) {
        case 'room-full':
          return { key: 'mediaErr.voice.full', action: null };
        case 'forbidden':
          return { key: 'mediaErr.voice.forbidden', action: null };
        case 'room-missing':
          return { key: 'mediaErr.voice.missing', action: null };
        case 'rate-limited':
          return { key: 'mediaErr.rateLimited', action: null };
        case 'unsupported':
          return { key: env.web ? 'mediaErr.voice.unsupportedWeb' : 'mediaErr.voice.generic', action: null };
        case 'network':
        case 'timeout':
          return { key: 'mediaErr.voice.network', action: 'connection' };
        case 'server':
          return { key: 'mediaErr.voice.server', action: 'connection' };
        default:
          return { key: 'mediaErr.voice.generic', action: 'connection' };
      }
  }
}

/** Raw error → human text + action. `code` overrides the classification (e.g. 'no-loopback'). */
export function describeMediaError(err: unknown, ctx: MediaContext, env: ErrorEnv, code?: MediaErrorCode): HumanError {
  const c = code ?? classifyMediaError(err, ctx, env);
  const { key, action } = text(c, ctx, env);
  return { code: c, text: t(key), action, silent: c === 'cancelled' };
}
