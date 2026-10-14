import { FormerMemberReason } from '@calaba/protocol';
import { t, type MessageKey } from '../../i18n';

const REASON_KEY: Record<FormerMemberReason, MessageKey> = {
  [FormerMemberReason.UNSPECIFIED]: 'former.reason.left',
  [FormerMemberReason.LEFT]: 'former.reason.left',
  [FormerMemberReason.REMOVED]: 'former.reason.removed',
  [FormerMemberReason.BANNED]: 'former.reason.banned',
  [FormerMemberReason.GUEST_EXPIRED]: 'former.reason.guestExpired',
  [FormerMemberReason.DIRECTORY_DISABLED]: 'former.reason.directory',
};

/** «ушёл» / «удалён» / «забанен» / «гостевой доступ истёк» (ADR-0097 §4). */
export const formerReasonText = (reason: FormerMemberReason): string => t(REASON_KEY[reason]);
