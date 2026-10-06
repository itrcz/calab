import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { IdentityAccessReason, SessionAuthorityKind, SessionAuthoritySchema, WorkspaceIdentityAccessSchema } from '@calaba/protocol';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { accessLocked, consentHandle, localAuthority, lockTitleKey, reasonKey } from './model';
describe('identity UX states', () => {
  it('only independently local sessions offer global controls, with legacy server compatibility', () => {
    expect(localAuthority(null)).toBe(true);
    expect(localAuthority(create(SessionAuthoritySchema, { kind: SessionAuthorityKind.LOCAL_ACCOUNT }))).toBe(true);
    for (const kind of [SessionAuthorityKind.WORKSPACE_SSO, SessionAuthorityKind.RECOVERY, SessionAuthorityKind.UNSPECIFIED])
      expect(localAuthority(create(SessionAuthoritySchema, { kind }))).toBe(false);
  });
  it('unknown access fails closed and deadlines do not get clock-skew extensions', () => {
    expect(accessLocked(create(WorkspaceIdentityAccessSchema), 100)).toBe(true);
    expect(
      accessLocked(create(WorkspaceIdentityAccessSchema, { reason: IdentityAccessReason.ALLOWED, validUntil: timestampFromMs(100) }), 100),
    ).toBe(true);
    expect(
      accessLocked(create(WorkspaceIdentityAccessSchema, { reason: IdentityAccessReason.ALLOWED, validUntil: timestampFromMs(101) }), 100),
    ).toBe(false);
  });
  it('offers actionable directory, plan, scope and recovery explanations', () => {
    expect(reasonKey(IdentityAccessReason.DIRECTORY_DENIED)).toBe('identity.directoryDenied');
    expect(reasonKey(IdentityAccessReason.ENTITLEMENT_REQUIRED)).toBe('identity.plan');
    expect(reasonKey(IdentityAccessReason.SCOPE_DENIED)).toBe('identity.scope');
    expect(reasonKey(IdentityAccessReason.RECOVERY_ONLY)).toBe('identity.recoveryOnly');
  });
  it('a dependency outage is not presented as a locked workspace (#115)', () => {
    expect(lockTitleKey(IdentityAccessReason.DEPENDENCY_UNAVAILABLE)).toBe('identity.lockedUnavailable');
    expect(reasonKey(IdentityAccessReason.DEPENDENCY_UNAVAILABLE)).toBe('identity.checkUnavailable');
    for (const reason of [IdentityAccessReason.SSO_REQUIRED, IdentityAccessReason.SUSPENDED, IdentityAccessReason.DIRECTORY_DENIED, undefined])
      expect(lockTitleKey(reason)).toBe('identity.locked');
  });
  it('only reads the opaque consent handle, rejecting duplicate or malformed inputs', () => {
    const handle = 'x'.repeat(43);
    expect(consentHandle(`https://app.test/oauth/consent?request=${handle}&client=evil&redirect_uri=https://evil.test`)).toBe(handle);
    expect(consentHandle(`https://app.test/oauth/consent?request=${handle}&request=${handle}`)).toBeNull();
    expect(consentHandle('https://app.test/oauth/consent?request=short')).toBeNull();
    expect(consentHandle(`https://app.test/other?request=${handle}`)).toBeNull();
  });
});
