import { AiProvider, AiState, type AiSettings, type CheckAiResponse } from '@calaba/protocol';
import type { MessageKey } from '../i18n';

/**
 * Workspace settings → «AI интеграция» (CBF-60, ai.proto): the provider tabs, the form and the
 * check's outcome as text. Pure: the component (features/workspace/AiCard.tsx) only renders.
 */
export type AiTab = 'gptunnel' | 'openai';

/** The model a workspace starts with (owner, 22.10); the server sends it for unsaved settings too. */
export const DEFAULT_AI_MODEL = 'gpt-6-astra';

export const providerOf = (tab: AiTab): AiProvider => (tab === 'openai' ? AiProvider.OPENAI_COMPATIBLE : AiProvider.GPTUNNEL);

/** The tab a saved provider opens on; never saved = GPTunneL. */
export const tabOf = (p: AiProvider): AiTab => (p === AiProvider.OPENAI_COMPATIBLE ? 'openai' : 'gptunnel');

export interface AiDraft {
  baseUrl: string;
  /** '' = keep the stored key (when it was entered for this provider and address). */
  key: string;
  model: string;
}

/** The form of a tab from what is saved: the active tab gets the saved values, the other the defaults. */
export function draftOf(s: AiSettings | undefined, tab: AiTab): AiDraft {
  const saved = s && s.provider !== AiProvider.UNSPECIFIED && tabOf(s.provider) === tab;
  if (saved) return { baseUrl: s.baseUrl, key: '', model: s.model };
  return { baseUrl: '', key: '', model: tab === 'gptunnel' ? DEFAULT_AI_MODEL : '' };
}

/** The server's normalisation of an API root: no trailing «/», a pasted «/chat/completions» dropped. */
export function normalizeBaseUrl(raw: string): string {
  let v = raw.trim().replace(/\/+$/, '');
  if (v.endsWith('/chat/completions')) v = v.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  return v;
}

/** An absolute http(s) URL without credentials or query (what the server accepts). */
export function validBaseUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v || v.length > 500) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' && !u.username && !u.password && !u.search;
  } catch {
    return false;
  }
}

/** Whether the stored key was entered for this tab (and address): only then an empty field keeps it. */
export function keyApplies(s: AiSettings | undefined, tab: AiTab, baseUrl: string): boolean {
  if (!s?.hasKey || s.provider !== providerOf(tab)) return false;
  return tab === 'gptunnel' || normalizeBaseUrl(baseUrl) === s.baseUrl;
}

const KEY_RE = /^[\x21-\x7e]{1,512}$/;

/** The first problem of the form before any request: field and its text (null = fine). */
export function draftError(d: AiDraft, s: AiSettings | undefined, tab: AiTab, needKey: boolean): { field: 'baseUrl' | 'apiKey' | 'model'; key: MessageKey } | null {
  if (tab === 'openai' && !validBaseUrl(d.baseUrl)) return { field: 'baseUrl', key: 'ai.err.baseUrl' };
  const key = d.key.trim().replace(/^Bearer\s+/, '');
  if (key && !KEY_RE.test(key)) return { field: 'apiKey', key: 'ai.err.keyFormat' };
  if (!key && needKey && !keyApplies(s, tab, d.baseUrl)) return { field: 'apiKey', key: s?.hasKey ? 'ai.err.keyOther' : 'ai.err.key' };
  if (!d.model.trim()) return { field: 'model', key: 'ai.err.model' };
  return null;
}

/** The request body of PUT / check: the key only when typed (unset = keep the stored one). */
export function requestOf(d: AiDraft, tab: AiTab): { provider: AiProvider; baseUrl: string; model: string; apiKey?: string } {
  const key = d.key.trim();
  return {
    provider: providerOf(tab),
    baseUrl: tab === 'openai' ? d.baseUrl.trim() : '',
    model: d.model.trim(),
    ...(key ? { apiKey: key } : {}),
  };
}

const REASON: Record<string, MessageKey> = {
  unauthorized: 'ai.reason.unauthorized',
  model_not_found: 'ai.reason.model_not_found',
  not_found: 'ai.reason.not_found',
  insufficient_balance: 'ai.reason.insufficient_balance',
  rate_limited: 'ai.reason.rate_limited',
  provider_error: 'ai.reason.provider_error',
  bad_request: 'ai.reason.bad_request',
  bad_response: 'ai.reason.bad_response',
  timeout: 'ai.reason.timeout',
  network: 'ai.reason.network',
  blocked_address: 'ai.reason.blocked_address',
};

export const reasonKey = (code: string): MessageKey => REASON[code] ?? 'ai.reason.unknown';

/** 422 VALIDATION `field` of PUT / check → its text. */
export function fieldErrorKey(field: string, s: AiSettings | undefined, typedKey: boolean): MessageKey | null {
  switch (field) {
    case 'baseUrl':
      return 'ai.err.baseUrl';
    case 'model':
      return 'ai.err.model';
    case 'apiKey':
      return typedKey ? 'ai.err.keyFormat' : s?.hasKey ? 'ai.err.keyOther' : 'ai.err.key';
    default:
      return null;
  }
}

/** Seconds of the check, one decimal («3,1» via the caller's number format). */
export const checkSeconds = (r: Pick<CheckAiResponse, 'latencyMs'>): number => Math.round(r.latencyMs / 100) / 10;

/** The react-query key of GET …/ai/status (the «+» menu reads it; save / check invalidate it). */
export const aiStatusKey = (workspaceId: string): readonly unknown[] => ['ai-status', workspaceId];

/**
 * «Создать умную задачу» (CBF-68): why the item is off — null = it is on (READY). A plan without
 * AI (CBF-69: Free / Team) comes first: its status is not even asked. Unknown (not loaded yet)
 * shows the loading hint; the server refuses anything but READY anyway.
 */
export function smartOffKey(state: AiState | undefined, planAI = true): MessageKey | null {
  if (!planAI) return 'smart.off.plan';
  switch (state) {
    case AiState.READY:
      return null;
    case undefined:
      return 'smart.off.loading';
    case AiState.UNCHECKED:
      return 'smart.off.unchecked';
    case AiState.FAILED:
      return 'smart.off.failed';
    default:
      return 'smart.off.noKey';
  }
}

/**
 * A refused smart task (ApiError status / reason / field / message) → its text and the reason's;
 * null when nothing smart-specific is known — the dialog then names the generic cause (network,
 * 5xx, 403, 413, … — errorText), never a bare «Не удалось сохранить» (bug #152).
 */
export function smartErrorText(e: { status: number; reason?: string | undefined; field?: string | undefined; message: string }): { key: MessageKey; reason?: MessageKey } | null {
  if (e.status === 429) return { key: 'smart.err.rate' };
  if (e.status === 422 && e.field === 'text') return { key: 'smart.err.text' };
  // No answer in time (the desktop's own deadline or the proxy's): the server may still have filed it.
  if (e.status === 504) return { key: 'smart.err.timeout' };
  switch (e.reason) {
    case 'AI_NOT_READY':
      return { key: 'smart.err.notReady' };
    case 'AI_PLAN_REQUIRED':
      return { key: 'smart.off.plan' };
    case 'NO_BOARDS':
      return { key: 'smart.err.noBoards' };
    case 'AI_BAD_ANSWER':
      return { key: 'smart.err.badAnswer' };
    case 'AI_FAILED':
      return { key: 'smart.err.failed', reason: reasonKey(e.message) };
    default:
      return null;
  }
}

/**
 * What a person quotes when reporting a failed smart task: the error code, the HTTP status and
 * the request id the server logged it under («UNAVAILABLE · 504 · 9f…»); "" when nothing is known.
 */
export function smartErrorRef(e: { code?: string | undefined; status?: number | undefined; requestId?: string | undefined }): string {
  const code = e.code && e.code !== 'ERROR_CODE_UNSPECIFIED' ? e.code.replace(/^ERROR_CODE_/, '') : '';
  return [code, e.status ? String(e.status) : '', e.requestId ?? ''].filter(Boolean).join(' · ');
}
