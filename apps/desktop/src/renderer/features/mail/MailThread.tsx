import { Mail } from 'lucide-react';
import { type ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { inboxUnread, useMail } from '../../stores/mail';
import { MailMessageView } from './MailMessageView';

/**
 * The centre (ADR-0088 §8): the open thread — the subject, then its messages oldest first, all
 * collapsed to a header row except the open one (one iframe on screen, §9). Reads the thread's id
 * list; a message re-renders on its own header / body.
 */
export function MailThread(): ReactNode {
  useLocale();
  const ids = useMail((s) => s.thread?.ids);
  const state = useMail((s) => s.thread?.state);
  const subject = useMail((s) => {
    const th = s.thread;
    const last = th ? s.headers[th.ids[th.ids.length - 1] ?? ''] : undefined;
    return last?.subject ?? '';
  });
  const unreadTotal = useMail((s) => (s.thread ? 0 : inboxUnread(s)));
  if (!ids) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-body text-muted" data-testid="mail-no-thread">
        <Mail className="size-10 text-faint" strokeWidth={1.25} aria-hidden />
        <p>{t('mbox.pickMessage')}</p>
        {unreadTotal > 0 ? <p className="text-caption">{plural('mbox.unreadInbox', unreadTotal)}</p> : null}
      </div>
    );
  }
  if (!ids.length) {
    return (
      <div className="grid flex-1 place-items-center">
        {state === 'error' ? <p className="text-body text-muted">{t('mbox.err.notFound')}</p> : <Spinner className="size-6" />}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-mail-thread data-testid="mail-thread">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-2 px-6 pb-10 pt-5">
        <h1 className="selectable px-1 pb-2 text-title font-semibold leading-tight text-fg">{subject.trim() || t('mbox.noSubject')}</h1>
        {ids.map((id, i) => (
          <MailMessageView key={id} id={id} last={i === ids.length - 1} />
        ))}
      </div>
    </div>
  );
}
