import { ApiError, toApiError } from '../lib/api/client';
import { platform } from '../platform';

/**
 * The one-time mailbox password page `/mail-reset/{token}` (ADR-0101): an anonymous POST to
 * `/api/mailbox/password/redeem` — the server deletes the token in that very request, so the
 * password is shown once and only here. Not part of the proto contract: plain JSON.
 */

export interface MailReset {
  email: string;
  password: string;
}

/** Redeems the token once; a repeat or an expired token throws ApiError 410 CODE_EXPIRED. */
export async function redeemMailReset(token: string, signal?: AbortSignal): Promise<MailReset> {
  const res = await platform.apiFetch('/api/mailbox/password/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  const b = (await res.json()) as MailReset;
  if (typeof b.email !== 'string' || typeof b.password !== 'string') throw new ApiError('ERROR_CODE_INTERNAL', 'bad answer', 0);
  return b;
}

/** The token of a `/mail-reset/{token}` page in the web build (null elsewhere). */
export const mailResetToken = (): string | null =>
  import.meta.env.VITE_PLATFORM === 'web' ? (/^\/mail-reset\/([A-Za-z0-9_-]{1,128})\/?$/.exec(location.pathname)?.[1] ?? null) : null;
