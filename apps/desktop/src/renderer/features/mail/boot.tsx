import { PresenceStatus } from '@calaba/protocol';
import type { MailEvent } from '../../../shared/mail';
import { t } from '../../i18n';
import { lazyPreload } from '../../lib/lazyPreload';
import { prefs } from '../../stores/prefs';
import { initMail, onMailEvent, openThread, setMailErrorReporter, useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { getMailApi, mailAvailable } from './api';
import { addressLabel, mailErrorText } from './format';

/** Resolved once per page load: the API never appears later (ADR-0088 §1 — desktop only). */
export const MAIL_ENABLED = mailAvailable();

/** The section's screens in their own chunk (docs/18): not on the chat's startup path. */
export const MailScreenLazy = lazyPreload(
  () => import('./MailScreen').then((m) => m.MailScreen),
  <div className="mat-content flex-1" />,
);

/**
 * Starts the mail client with the shell (AppShell): binds the store to the engine (the rail badge
 * needs the folder counters before the section is opened) and the new-mail notifications. Idempotent.
 */
export function startMail(): () => void {
  const api = MAIL_ENABLED ? getMailApi() : undefined;
  if (!api) return () => undefined;
  setMailErrorReporter((code, what) => {
    const ctx = what === 'flags' ? t('mbox.err.flags') : what === 'move' ? t('mbox.err.move') : what === 'send' ? t('mbox.err.send') : what === 'load' ? t('mbox.err.load') : what === 'empty' ? t('mbox.err.empty') : '';
    toast.error(ctx ? `${ctx}: ${mailErrorText(code).toLowerCase()}` : mailErrorText(code));
  });
  void initMail(api);
  return onMailEvent(onEvent);
}

function onEvent(e: MailEvent): void {
  if (e.type === 'new_mail') notifyNewMail(e);
  else if (e.type === 'outgoing' && !e.removed && e.item.state === 'failed' && e.item.nextAt === null) {
    toast.error(t('mbox.sendFailed', { subject: e.item.subject || t('mbox.noSubject') }));
  }
}

/** The message is on screen in a focused window: no notification for it (as for messages, §8). */
function onScreen(e: Extract<MailEvent, { type: 'new_mail' }>): boolean {
  if (typeof document === 'undefined' || !document.hasFocus() || !useMailUi.getState().active) return false;
  const th = useMail.getState().thread;
  return !!th && (th.threadId === e.threadId || th.ids.includes(e.messageId));
}

/** «Имя отправителя · Тема» (§8): the notification rules of messages — DND, the window on that message. */
function notifyNewMail(e: Extract<MailEvent, { type: 'new_mail' }>): void {
  if (!useMail.getState().settings.notify) return;
  if (prefs().presence === PresenceStatus.DND) return;
  if (onScreen(e)) return;
  const account = useMail.getState().accounts[e.accountId];
  try {
    const n = new Notification(`${addressLabel(e.from)} · ${e.subject.trim() || t('mbox.noSubject')}`, {
      body: account?.email ?? '',
      silent: true,
      tag: `mail:${e.messageId}`,
    });
    n.onclick = () => {
      window.focus();
      openMailMessage(e.threadId, e.messageId);
    };
  } catch {
    // notifications unavailable
  }
}

/** Opens a message in the section: its row selected when the list on screen has it. */
export function openMailMessage(threadId: string, messageId: string): void {
  void import('../shell/sectionNav').then((m) => {
    m.openSection('mail');
    const s = useMail.getState();
    const key = s.order.find((k) => s.rows[k]?.threadId === threadId) ?? null;
    if (key) useMail.setState({ selected: key });
    void openThread(threadId, messageId, key);
  });
}
