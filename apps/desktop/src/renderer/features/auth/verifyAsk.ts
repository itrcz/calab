/**
 * Whether the signed-in account is asked to confirm its address unprompted — the onboarding step
 * «Подтвердите почту» and the bar over the main window (ADR-0023, ADR-0065).
 *
 * EMAIL_VERIFICATION=required (and servers before ADR-0065, which send no flag): every unconfirmed
 * account is asked — creating workspaces, invitations and DMs waits for the code.
 * EMAIL_VERIFICATION=optional: nothing waits for it, so nobody is asked — except while an email
 * invitation waits for the address (its join needs the confirmation, ADR-0027). The address is
 * then confirmed from the account settings only («Не подтверждена» · «Подтвердить»).
 */
export interface VerifyAskInput {
  me: { emailVerified: boolean; user?: { isGuest: boolean } } | null;
  emailVerificationOptional: boolean;
  emailInvitePending: boolean;
}

export function asksToVerify(s: VerifyAskInput): boolean {
  if (!s.me || s.me.emailVerified || s.me.user?.isGuest) return false;
  return !s.emailVerificationOptional || s.emailInvitePending;
}

/**
 * Why the address is asked for, for the texts: `join` — only an email invitation waits for it
 * (EMAIL_VERIFICATION=optional), `blocked` — the actions of ADR-0023 wait for it.
 */
export function verifyReason(s: Pick<VerifyAskInput, 'emailVerificationOptional'>): 'join' | 'blocked' {
  return s.emailVerificationOptional ? 'join' : 'blocked';
}
