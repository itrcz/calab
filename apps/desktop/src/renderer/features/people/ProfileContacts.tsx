import { Copy, Mail, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { log } from '../../lib/log';
import { toast } from '../../stores/toasts';
import { telHref, useContacts, useUsername } from './contacts';

/** Copies a contact and says so («Скопировано»). */
function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(t('people.contacts.copied')),
    (e: unknown) => {
      log.warn('copy contact', e);
      toast.error(t('people.contacts.copyFailed'));
    },
  );
}

function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <IconButton size="sm" label={t('people.contacts.copyWhat', { what: label })} onClick={() => copy(value)} className="-my-1 size-6">
      <Copy className="size-3.5" aria-hidden />
    </IconButton>
  );
}

/**
 * «Почта» and «Телефон» of a person (ADR-0077), each with «Скопировать»; the phone is a `tel:` link
 * on a phone. Nothing when I may not see them (contacts.ts) or there are none. `row` — dt/dd pairs
 * for the profile card's list; `section` — the profile dialog's block.
 */
export function ProfileContacts({ userId, variant }: { userId: string; variant: 'row' | 'section' }): ReactNode {
  const c = useContacts(userId);
  const mobile = useMobile();
  if (!c || (!c.email && !c.phone)) return null;
  const email = c.email ? (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="profile-email">
      <span className="selectable min-w-0 [overflow-wrap:anywhere]">
        {c.email}
      </span>
      {c.emailVerified ? null : <span className="shrink-0 text-muted">· {t('people.contacts.unverified')}</span>}
      <CopyButton value={c.email} label={t('people.contacts.email')} />
    </span>
  ) : null;
  const phone = c.phone ? (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="profile-phone">
      {mobile ? (
        <a href={telHref(c.phone)} className="flex min-h-11 min-w-0 items-center text-accent-text [overflow-wrap:anywhere] hover:underline">
          {c.phone}
        </a>
      ) : (
        <span className="selectable min-w-0 tabular-nums [overflow-wrap:anywhere]">{c.phone}</span>
      )}
      <CopyButton value={c.phone} label={t('people.contacts.phone')} />
    </span>
  ) : null;
  if (variant === 'row') {
    return (
      <>
        {email ? (
          <>
            <dt className="text-muted">{t('people.contacts.email')}</dt>
            <dd className="min-w-0">{email}</dd>
          </>
        ) : null}
        {phone ? (
          <>
            <dt className="text-muted">{t('people.contacts.phone')}</dt>
            <dd className="min-w-0">{phone}</dd>
          </>
        ) : null}
      </>
    );
  }
  return (
    <section className="mt-5" data-testid="profile-contacts">
      <h3 className="mb-1.5 text-caption font-semibold text-muted">{t('people.contacts.title')}</h3>
      <div className="flex flex-col gap-1.5 text-body">
        {email ? (
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="size-4 shrink-0 text-muted" role="img" aria-label={t('people.contacts.email')} />
            {email}
          </div>
        ) : null}
        {phone ? (
          <div className="flex min-w-0 items-center gap-2">
            <Phone className="size-4 shrink-0 text-muted" role="img" aria-label={t('people.contacts.phone')} />
            {phone}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** `@nick` under a person's name (ADR-0077); nothing without one. */
export function UserHandle({ userId, className }: { userId: string; className?: string }): ReactNode {
  const nick = useUsername(userId);
  if (!nick) return null;
  return (
    <div className={cx('selectable truncate text-caption text-muted', className)} data-testid="user-handle">
      @{nick}
    </div>
  );
}
