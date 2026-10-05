import { describe, expect, it } from 'vitest';
import { asksToVerify, verifyReason } from './verifyAsk';

const unverified = { emailVerified: false, user: { isGuest: false } };
const required = { emailVerificationOptional: false, emailInvitePending: false };
const optional = { emailVerificationOptional: true, emailInvitePending: false };

describe('asking to confirm the address (ADR-0023, ADR-0065)', () => {
  it('required (and servers without the flag): every unconfirmed account is asked', () => {
    expect(asksToVerify({ me: unverified, ...required })).toBe(true);
    expect(verifyReason(required)).toBe('blocked');
  });

  it('optional: no onboarding step and no bar after sign-up', () => {
    expect(asksToVerify({ me: unverified, ...optional })).toBe(false);
  });

  it('optional: an email invitation waiting for the address still asks, for the join', () => {
    expect(asksToVerify({ me: unverified, ...optional, emailInvitePending: true })).toBe(true);
    expect(verifyReason(optional)).toBe('join');
  });

  it('never asks a confirmed account, a guest or nobody', () => {
    expect(asksToVerify({ me: { ...unverified, emailVerified: true }, ...required })).toBe(false);
    expect(asksToVerify({ me: { emailVerified: false, user: { isGuest: true } }, ...required })).toBe(false);
    expect(asksToVerify({ me: null, ...required })).toBe(false);
  });
});
