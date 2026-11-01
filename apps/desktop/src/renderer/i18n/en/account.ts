import type { ruAccount } from '../ru/account';
import type { DictShape } from '../types';

/** UI strings — account deletion (ADR-0153). */
export const enAccount: DictShape<typeof ruAccount> = {
  'account.delete.card': 'Delete account',
  'account.delete.row': 'Delete account',
  'account.delete.rowHint': 'Immediately and for good. Messages in workspaces stay, signed “Deleted user”.',
  'account.delete.open': 'Delete…',
  'account.delete.title': 'Delete your account?',
  'account.delete.text': 'The account is deleted immediately and for good — it cannot be restored.',
  'account.delete.goneTitle': 'Deleted',
  'account.delete.goneProfile': 'Profile: name, email, password, avatar, username, phone, birthday',
  'account.delete.goneSessions': 'Sign-ins on all devices and their notifications',
  'account.delete.gonePersonal': 'Personal notes, notes about people, the connected calendar, app access',
  'account.delete.staysTitle': 'Kept',
  'account.delete.stays': 'Messages, tasks and files in workspaces and direct messages stay with their members, by “Deleted user”.',
  'account.delete.ownerTitle': 'Delete your workspaces first',
  'account.delete.ownerText': 'Delete the workspace in its settings, or write to support@calab.io to hand ownership over.',
  'account.delete.confirm': 'Delete for good',
  'account.delete.done': 'Account deleted',
};
