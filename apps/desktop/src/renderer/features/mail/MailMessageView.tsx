import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Archive, Flag, FolderInput, Forward, ImageOff, Mail, MailOpen, Paperclip, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { MailAddress, MailHeader, MailMessage } from '../../../shared/mail';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { isSafeHref } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { allowRemote, expandMessage, loadBody, setMessageFlags, updateSettings, useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { autoReadDue, MAIL_KEYS, moveOpen, noteManualRead, replyOpen, toggleOpenFlag, toggleOpenRead } from './actions';
import { AttachmentStrip } from './Attachments';
import { addressFull, addressLabel, avatarTone, folderLabel, mailHeaderTime, mailInitials, mailListTime, ROLE_ORDER } from './format';
import { parseMailto } from './mailLink';
import { MailFrame } from './MailFrame';
import { linkify } from './sanitize';

/**
 * One message of the thread (ADR-0088 §8): collapsed — a header row (avatar, sender, preview,
 * date), a click opens it; open — the header with «Подробнее», the action bar, the remote-images
 * bar, the body (sandboxed iframe, §10) and the attachments. Memo'd by id; reads its header.
 */
export const MailMessageView = memo(function MailMessageView({ id, last }: { id: string; last: boolean }): ReactNode {
  useLocale();
  const header = useMail((s) => s.headers[id]);
  const open = useMail((s) => s.openId === id);
  if (!header) return null;
  return open ? <OpenMessage header={header} /> : <CollapsedMessage header={header} last={last} />;
});

function Initials({ from, size }: { from: MailAddress; size: number }): ReactNode {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: avatarTone(from.address), fontSize: size * 0.38 }}
    >
      {mailInitials(from)}
    </span>
  );
}

function CollapsedMessage({ header }: { header: MailHeader; last: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => expandMessage(header.id)}
      className="flex w-full min-w-0 items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-4 py-2.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover"
      data-testid="mail-message-collapsed"
    >
      <Initials from={header.from} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cx('truncate text-body text-fg', header.flags.seen ? 'font-medium' : 'font-bold')}>{addressLabel(header.from)}</span>
        <span className="truncate text-caption text-muted">{header.snippet}</span>
      </span>
      {header.flags.flagged ? <Flag className="size-3.5 shrink-0 fill-[var(--color-attention)] text-attention" aria-label={t('mbox.flagged')} /> : null}
      {header.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted" aria-label={t('mbox.hasAttachments')} /> : null}
      <span className="shrink-0 text-caption tabular-nums text-muted">{mailListTime(header.date)}</span>
    </button>
  );
}

function OpenMessage({ header }: { header: MailHeader }): ReactNode {
  const [details, setDetails] = useState(false);
  const body = useMail((s) => s.bodies[header.id]);
  const bodyState = useMail((s) => s.bodyState[header.id]);
  // The message opened is marked read after 1 s (§8): one timeout, none while it stays open.
  const seen = header.flags.seen;
  useEffect(() => {
    if (seen || !autoReadDue(header.id)) return;
    const id = window.setTimeout(() => {
      noteManualRead(header.id);
      void setMessageFlags([header.id], { seen: true });
    }, 1000);
    return () => window.clearTimeout(id);
  }, [header.id, seen]);
  const recipients = [...header.to, ...header.cc];
  return (
    <article className="flex flex-col rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="mail-message" aria-label={addressLabel(header.from)}>
      <header className="flex items-start gap-3 px-4 pb-2 pt-3">
        <Initials from={header.from} size={40} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="selectable min-w-0 truncate text-[15px] font-semibold text-fg" title={addressFull(header.from)}>
              {addressLabel(header.from)}
            </span>
            <span className="ml-auto shrink-0 text-caption tabular-nums text-muted">{mailHeaderTime(header.date)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1 text-caption text-muted">
            <span className="min-w-0 truncate">
              {t('mbox.toLine', { names: recipients.map(addressLabel).join(', ') || '—' })}
            </span>
            <button type="button" className="shrink-0 text-accent-text hover:underline" onClick={() => setDetails((v) => !v)} aria-expanded={details} data-testid="mail-details">
              {details ? t('mbox.hideDetails') : t('mbox.details')}
            </button>
          </div>
        </div>
      </header>
      {details ? <Details header={header} /> : null}
      <ActionBar header={header} />
      {body?.remoteImages ? <RemoteBar message={body} /> : null}
      {body ? <Body message={body} /> : bodyState === 'error' ? <BodyError id={header.id} /> : <BodyLoading />}
      {body ? <AttachmentStrip message={body} /> : null}
    </article>
  );
}

function Details({ header }: { header: MailHeader }): ReactNode {
  const rows: Array<[string, MailAddress[]]> = [
    [t('mbox.from'), [header.from]],
    [t('mbox.to'), header.to],
    [t('mbox.cc'), header.cc],
    [t('mbox.bcc'), header.bcc],
    [t('mbox.replyTo'), header.replyTo],
  ];
  return (
    <dl className="selectable mx-4 mb-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-[8px] bg-hover px-3 py-2 text-caption" data-testid="mail-details-list">
      {rows
        .filter(([, list]) => list.length)
        .map(([label, list]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-fg">{list.map(addressFull).join(', ')}</dd>
          </div>
        ))}
      <dt className="text-muted">{t('mbox.date')}</dt>
      <dd className="text-fg">{new Date(header.date).toLocaleString()}</dd>
    </dl>
  );
}

/** The action bar of the open message (§8). */
function ActionBar({ header }: { header: MailHeader }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-3 pb-2" role="toolbar" aria-label={t('mbox.actions')}>
      <IconButton label={t('mbox.reply')} shortcut={MAIL_KEYS.reply} onClick={() => replyOpen('reply')} data-testid="mail-reply">
        <Reply className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label={t('mbox.replyAll')} shortcut={MAIL_KEYS.replyAll} onClick={() => replyOpen('replyAll')}>
        <ReplyAll className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label={t('mbox.forward')} shortcut={MAIL_KEYS.forward} onClick={() => replyOpen('forward')}>
        <Forward className="size-4" strokeWidth={1.75} />
      </IconButton>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden />
      <IconButton label={t('mbox.archive')} onClick={() => moveOpen({ kind: 'archive' })} data-testid="mail-archive">
        <Archive className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label={t('mbox.trash')} shortcut={MAIL_KEYS.trash} onClick={() => moveOpen({ kind: 'trash' })} data-testid="mail-trash">
        <Trash2 className="size-4" strokeWidth={1.75} />
      </IconButton>
      <MoveMenu accountId={header.accountId} folderId={header.folderId} />
      <span className="mx-1 h-4 w-px bg-line" aria-hidden />
      <IconButton label={header.flags.flagged ? t('mbox.unflag') : t('mbox.flag')} active={header.flags.flagged} onClick={toggleOpenFlag} data-testid="mail-flag">
        <Flag className={cx('size-4', header.flags.flagged && 'fill-[var(--color-attention)] text-attention')} strokeWidth={1.75} />
      </IconButton>
      <IconButton label={header.flags.seen ? t('mbox.markUnread') : t('mbox.markRead')} shortcut={MAIL_KEYS.unread} onClick={toggleOpenRead} data-testid="mail-read">
        {header.flags.seen ? <Mail className="size-4" strokeWidth={1.75} /> : <MailOpen className="size-4" strokeWidth={1.75} />}
      </IconButton>
    </div>
  );
}

/** «Переместить» → the account's real folders (no virtual ones, not the current one). */
function MoveMenu({ accountId, folderId }: { accountId: string; folderId: string }): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('mbox.move')} data-testid="mail-move">
          <FolderInput className="size-4" strokeWidth={1.75} />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto')} sideOffset={4} align="start" collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{t('mbox.moveTo')}</Dropdown.Label>
          <MoveTargets accountId={accountId} folderId={folderId} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function MoveTargets({ accountId, folderId }: { accountId: string; folderId: string }): ReactNode {
  const folders = useMail(useShallow((s) => s.folders[accountId] ?? []));
  const targets = useMemo(() => {
    const real = folders.filter((f) => f.path && f.id !== folderId && f.role !== 'starred' && f.role !== 'outbox' && f.role !== 'drafts');
    const rank = (r: (typeof real)[number]): number => (r.role ? ROLE_ORDER.indexOf(r.role) : 100);
    return real.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }, [folders, folderId]);
  return (
    <>
      {targets.map((f) => (
        <Dropdown.Item key={f.id} className={menuItem} onSelect={() => moveOpen({ kind: 'move', folderId: f.id })}>
          {folderLabel(f)}
        </Dropdown.Item>
      ))}
    </>
  );
}

/** «Картинки скрыты · Показать · Всегда для этого отправителя» (§8, §10). */
function RemoteBar({ message }: { message: MailMessage }): ReactNode {
  const allowed = useRemoteAllowed(message);
  if (allowed) return null;
  const sender = message.from.address.toLowerCase();
  return (
    <div className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] bg-hover px-3 py-1.5 text-caption text-muted" data-testid="mail-images-hidden">
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span>{t('mbox.imagesHidden')}</span>
      <button type="button" className="text-accent-text hover:underline" onClick={() => allowRemote(message.id)} data-testid="mail-images-show">
        {t('mbox.showImages')}
      </button>
      <button
        type="button"
        className="text-accent-text hover:underline"
        onClick={() => {
          const list = useMail.getState().settings.remoteImageSenders;
          if (!list.includes(sender)) void updateSettings({ remoteImageSenders: [...list, sender] });
        }}
      >
        {t('mbox.alwaysSender')}
      </button>
    </div>
  );
}

/** Remote images for this message: always, this sender, or «Показать» this session. */
function useRemoteAllowed(m: Pick<MailMessage, 'id' | 'from'>): boolean {
  const sender = m.from.address.toLowerCase();
  return useMail((s) => s.settings.remoteImages === 'always' || !!s.remoteAllowed[m.id] || s.settings.remoteImageSenders.includes(sender));
}

function Body({ message }: { message: MailMessage }): ReactNode {
  const remote = useRemoteAllowed(message);
  if (message.html) return <MailFrame message={message} remote={remote} />;
  if (message.text) return <TextBody text={message.text} />;
  return <p className="px-5 py-6 text-body text-muted">{t('mbox.noBody')}</p>;
}

function openLink(href: string): void {
  const mailto = parseMailto(href);
  if (mailto) {
    useMailUi.getState().openCompose({ kind: 'new', to: mailto.to, cc: mailto.cc, subject: mailto.subject, text: mailto.body });
    return;
  }
  if (isSafeHref(href)) void platform.app.openExternal(href);
}

/** A plain-text message: wrapped, links clickable (http(s) in the browser, mailto in the composer). */
function TextBody({ text }: { text: string }): ReactNode {
  const parts = useMemo(() => linkify(text), [text]);
  return (
    <div className="selectable whitespace-pre-wrap break-words px-5 py-4 text-[14px] leading-[1.5] text-fg" data-testid="mail-text">
      {parts.map((p, i) =>
        'href' in p ? (
          <a
            key={i}
            href={p.href}
            onClick={(e) => {
              e.preventDefault();
              openLink(p.href);
            }}
            className="text-accent-text hover:underline"
          >
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}

function BodyLoading(): ReactNode {
  return (
    <div className="grid h-32 place-items-center">
      <Spinner />
    </div>
  );
}

function BodyError({ id }: { id: string }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-8 text-body text-muted" role="alert">
      <p>{t('mbox.bodyFailed')}</p>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          useMail.setState((s) => {
            const bodyState = { ...s.bodyState };
            delete bodyState[id];
            return { bodyState };
          });
          void loadBody(id);
        }}
      >
        {t('mbox.retry')}
      </Button>
    </div>
  );
}
