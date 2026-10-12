import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Archive, Flag, FolderInput, Mail, MailOpen, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { inTrash, useMail, type MailState } from '../../stores/mail';
import { actionKeys, useMailUi } from '../../stores/mailUi';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { MAIL_KEYS, deleteKeysForever, moveKeys, toggleRowsFlag, toggleRowsRead } from './actions';
import { folderLabel } from './format';
import { useMoveTargets } from './MailMessageView';

/** What the picked rows have in common, as primitives (selectors over both stores). */
export function pickedSummary(s: Pick<MailState, 'rows'>, picked: ReadonlySet<string>): { anyUnread: boolean; anyUnflagged: boolean; account: string; folder: string } {
  let anyUnread = false;
  let anyUnflagged = false;
  let account: string | null = null;
  let folder: string | null = null;
  for (const k of picked) {
    const r = s.rows[k];
    if (!r) continue;
    if (r.unread) anyUnread = true;
    if (!r.flagged) anyUnflagged = true;
    account = account === null || account === r.accountId ? r.accountId : '';
    folder = folder === null || folder === r.folderId ? r.folderId : '';
  }
  return { anyUnread, anyUnflagged, account: account ?? '', folder: folder ?? '' };
}

/**
 * The centre with several rows picked (Apple Mail): «Выбрано N писем» and the batch actions —
 * read / unread, flag / unflag, archive, trash, move (one account only). Each is one engine call
 * over the rows (`MailSelection.threads`), optimistic with rollback (stores/mail.ts).
 */
export function BatchView(): ReactNode {
  useLocale();
  const picked = useMailUi((s) => s.picked);
  const anyUnread = useMail((s) => pickedSummary(s, picked).anyUnread);
  const anyUnflagged = useMail((s) => pickedSummary(s, picked).anyUnflagged);
  const account = useMail((s) => pickedSummary(s, picked).account);
  const folder = useMail((s) => pickedSummary(s, picked).folder);
  const trash = useMail(inTrash);
  const n = picked.size;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6" data-testid="mail-batch">
      <Mail className="size-10 text-faint" strokeWidth={1.25} aria-hidden />
      <p className="text-headline font-semibold text-fg">{plural('mbox.pickedCount', n)}</p>
      <div className="flex flex-wrap items-center justify-center gap-0.5 rounded-[var(--radius-card)] bg-[var(--color-card)] px-2 py-1" role="toolbar" aria-label={t('mbox.actions')}>
        <IconButton label={anyUnread ? t('mbox.markRead') : t('mbox.markUnread')} shortcut={MAIL_KEYS.unread} onClick={() => toggleRowsRead(actionKeys())} data-testid="mail-batch-read">
          {anyUnread ? <MailOpen className="size-4" strokeWidth={1.75} /> : <Mail className="size-4" strokeWidth={1.75} />}
        </IconButton>
        <IconButton label={anyUnflagged ? t('mbox.flag') : t('mbox.unflag')} shortcut={MAIL_KEYS.flag} onClick={() => toggleRowsFlag(actionKeys())} data-testid="mail-batch-flag">
          <Flag className={cx('size-4', !anyUnflagged && 'fill-[var(--color-attention)] text-attention')} strokeWidth={1.75} />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <IconButton label={t('mbox.archive')} shortcut={MAIL_KEYS.archive || undefined} onClick={() => moveKeys(actionKeys(), { kind: 'archive' })} data-testid="mail-batch-archive">
          <Archive className="size-4" strokeWidth={1.75} />
        </IconButton>
        {trash ? (
          <IconButton label={t('mbox.trash.deleteForever')} shortcut={MAIL_KEYS.trash} onClick={() => void deleteKeysForever(actionKeys())} data-testid="mail-batch-delete-forever">
            <Trash2 className="size-4 text-danger-text" strokeWidth={1.75} />
          </IconButton>
        ) : (
          <IconButton label={t('mbox.trash')} shortcut={MAIL_KEYS.trash} onClick={() => moveKeys(actionKeys(), { kind: 'trash' })} data-testid="mail-batch-trash">
            <Trash2 className="size-4" strokeWidth={1.75} />
          </IconButton>
        )}
        {account ? <BatchMove accountId={account} folderId={folder || null} /> : null}
      </div>
    </div>
  );
}

function BatchMove({ accountId, folderId }: { accountId: string; folderId: string | null }): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('mbox.move')} data-testid="mail-batch-move">
          <FolderInput className="size-4" strokeWidth={1.75} />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto')} sideOffset={4} align="start" collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{t('mbox.moveTo')}</Dropdown.Label>
          <BatchTargets accountId={accountId} folderId={folderId} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function BatchTargets({ accountId, folderId }: { accountId: string; folderId: string | null }): ReactNode {
  const targets = useMoveTargets(accountId, folderId);
  return (
    <>
      {targets.map((f) => (
        <Dropdown.Item key={f.id} className={menuItem} onSelect={() => moveKeys(actionKeys(), { kind: 'move', folderId: f.id })}>
          {folderLabel(f)}
        </Dropdown.Item>
      ))}
    </>
  );
}
