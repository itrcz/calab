import { t } from '../../i18n';
import { useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { openSection } from '../shell/sectionNav';
import { getMailApi } from './api';
import { MAIL_ENABLED, openMailMessage } from './boot';
import type { MailLink } from './mailLink';

/** Resolves once accounts are loaded (a link can arrive before the store is bound, at startup). */
function whenLoaded(): Promise<void> {
  if (useMail.getState().loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useMail.subscribe((s) => {
      if (!s.loaded) return;
      off();
      resolve();
    });
  });
}

/**
 * A mail deep link (ADR-0088 §8, §12) → the section. The add-account link prefills the form and
 * stops there: the person clicks «Добавить» (never an automatic account). Desktop only.
 */
export async function openMailLink(link: MailLink): Promise<void> {
  if (!MAIL_ENABLED) return;
  openSection('mail');
  await whenLoaded();
  switch (link.kind) {
    case 'invalid':
      toast.error(t('mbox.add.linkBroken'));
      return;
    case 'add': {
      const s = useMail.getState();
      if (s.accountIds.some((id) => s.accounts[id]?.email === link.email)) {
        toast.info(t('mbox.add.already'));
        useMailUi.getState().closeAdd();
        return;
      }
      useMailUi.getState().openAdd({ email: link.email, password: link.password });
      return;
    }
    case 'compose':
      if (!useMail.getState().accountIds.length) {
        useMailUi.getState().openAdd();
        return;
      }
      useMailUi.getState().openCompose({ kind: 'new', to: link.to, cc: link.cc, subject: link.subject, text: link.body });
      return;
    case 'open': {
      const api = getMailApi();
      if (!api) return;
      try {
        const m = await api.messages.get(link.messageId);
        openMailMessage(m.threadId, m.id);
      } catch {
        toast.error(t('mbox.err.notFound'));
      }
    }
  }
}
