import { IdentityAccessReason, SessionAuthorityKind, type SessionAuthority, type WorkspaceIdentityAccess } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { MessageKey } from '../../i18n';
export function localAuthority(authority: SessionAuthority | null): boolean {
  // Older local-only servers do not provide authority. Unknown explicit kinds remain restricted.
  return authority === null || authority.kind === SessionAuthorityKind.LOCAL_ACCOUNT;
}
export function accessLocked(access: WorkspaceIdentityAccess | undefined, now = Date.now()): boolean {
  return (
    !!access &&
    (access.reason !== IdentityAccessReason.ALLOWED || (!!access.validUntil && timestampDate(access.validUntil).getTime() <= now))
  );
}
export function reasonKey(reason: IdentityAccessReason): MessageKey {
  switch (reason) {
    case IdentityAccessReason.ALLOWED:
      return 'identity.enabled';
    case IdentityAccessReason.DIRECTORY_DENIED:
      return 'identity.directoryDenied';
    case IdentityAccessReason.ENTITLEMENT_REQUIRED:
      return 'identity.plan';
    case IdentityAccessReason.SCOPE_DENIED:
      return 'identity.scope';
    case IdentityAccessReason.RECOVERY_ONLY:
      return 'identity.recoveryOnly';
    case IdentityAccessReason.DEPENDENCY_UNAVAILABLE:
      return 'identity.checkUnavailable';
    default:
      return 'identity.required';
  }
}
/**
 * Title of a workspace the client holds closed. A dependency outage (the server could not
 * evaluate access, e.g. a DB timeout) is not a lock and must not read «workspace locked» (#115).
 */
export function lockTitleKey(reason: IdentityAccessReason | undefined): MessageKey {
  return reason === IdentityAccessReason.DEPENDENCY_UNAVAILABLE ? 'identity.lockedUnavailable' : 'identity.locked';
}
export function consentHandle(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.pathname !== '/oauth/consent' || parsed.searchParams.getAll('request').length !== 1) return null;
  const handle = parsed.searchParams.get('request') ?? '';
  return /^[A-Za-z0-9_-]{32,128}$/.test(handle) ? handle : null;
}
export const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
