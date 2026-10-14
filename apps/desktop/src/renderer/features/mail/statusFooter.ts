import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import type { FooterKind } from '../../stores/mail';
import { folderLabel, mailErrorText } from './format';
import type { MailErrorCode, MailFolderRole, MailSyncPhase } from '../../../shared/mail';

/** The footer's key from `scopeFooter` (`kind\naccountId\nmore`) taken apart. */
export function parseFooter(key: string): { kind: FooterKind; accountId: string; more: number } | null {
  if (!key) return null;
  const [kind = '', accountId = '', more = '0'] = key.split('\n');
  return { kind: kind as FooterKind, accountId, more: Number(more) || 0 };
}

export interface FooterInput {
  kind: FooterKind;
  /** The account's address (shown in the muted line with several accounts / for problems). */
  email: string;
  /** More than one account exists (a first sync then names the address). */
  multi: boolean;
  more: number;
  /** The engine failed for good (report in hand) — «Скопировать отчёт». */
  engineFailed: boolean;
  code: MailErrorCode | null;
  phase: MailSyncPhase | null;
  folder: { role: MailFolderRole | null; name: string };
  done: number;
  total: number;
}

export type FooterAction = 'retry' | 'password' | 'report' | null;

export interface FooterView {
  title: string;
  detail: string;
  /** The detail's parts (rendered unbreakable, wrapping between them). */
  parts: string[];
  action: FooterAction;
  /** A problem (warning icon, no bar) or progress (bar). */
  problem: boolean;
}

const SEP = ' · ';
const join = (parts: Array<string | false>): string => parts.filter(Boolean).join(SEP);

/** The two lines of the status footer and its button: pure, so the texts per state are testable. */
export function footerView(i: FooterInput): FooterView {
  const v = footerLines(i);
  return { ...v, parts: v.detail ? v.detail.split(SEP) : [] };
}

function footerLines(i: FooterInput): Omit<FooterView, 'parts'> {
  const more = i.more > 0 ? t('mbox.status.more', { n: String(i.more) }) : false;
  switch (i.kind) {
    case 'engine':
      return { title: i.engineFailed ? t('mbox.err.engineFailed') : t('mbox.err.engineDown'), detail: '', action: i.engineFailed ? 'report' : null, problem: true };
    case 'first': {
      if (i.phase === null) return { title: t('mbox.status.loading'), detail: join([i.multi && i.email, more]), action: null, problem: false };
      if (i.phase === 'folders') return { title: t('mbox.status.folders'), detail: join([i.email, more]), action: null, problem: false };
      const progress = i.total > 0 ? t('mbox.status.progress', { folder: folderLabel(i.folder), done: fmt.number(Math.min(i.done, i.total)), total: fmt.number(i.total) }) : folderLabel(i.folder);
      return { title: t('mbox.status.loading'), detail: join([i.multi && i.email, progress, more]), action: null, problem: false };
    }
    case 'auth_failed':
      return { title: t('mbox.err.auth'), detail: join([i.email, more]), action: 'password', problem: true };
    case 'stalled':
      return { title: t('mbox.state.stalled'), detail: join([i.email, more]), action: 'retry', problem: true };
    case 'offline':
      return { title: t('mbox.state.offline'), detail: join([i.email, more]), action: 'retry', problem: true };
    case 'error':
      return { title: i.code ? mailErrorText(i.code) : t('mbox.state.error'), detail: join([i.email, more]), action: 'retry', problem: true };
    case 'syncing':
      return { title: t('mbox.status.checking'), detail: join([more]), action: null, problem: false };
  }
}
