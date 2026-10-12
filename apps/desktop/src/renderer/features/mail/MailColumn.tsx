import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Archive, BrushCleaning, Check, ChevronDown, Flag, FolderInput, Forward, ListFilter, Mail, MailOpen, MessageSquareShare, Paperclip, Plus, Reply, ReplyAll, RotateCw, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { MailDraft, MailFolder, MailFolderRole, MailOutgoing } from '../../../shared/mail';
import { CreateButton } from '../../components/CreateButton';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { fmt, useTimeFormat } from '../../lib/format';
import {
  ALL_INBOXES,
  boxEquals,
  boxRole,
  boxUnread,
  firstSyncAccount,
  loadDrafts,
  loadMore,
  loadOlder,
  mailApi,
  openRow,
  outgoingOf,
  reloadList,
  scopeProblem,
  scopeSyncing,
  inTrash,
  selectBox,
  setFlaggedOnly,
  setQuery,
  setUnreadOnly,
  syncNow,
  trashBox,
  useMail,
  type MailBox,
} from '../../stores/mail';
import { clearPicked, pickRange, togglePick, useMailUi } from '../../stores/mailUi';
import { useUi } from '../../stores/ui';
import { toast } from '../../stores/toasts';
import { ColumnHeader, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { MAIL_KEYS, composeNew, deleteKeysForever, emptyTrash, moveKeys, replyOpen, toggleRowsFlag, toggleRowsRead } from './actions';
import { pickedSummary } from './BatchView';
import { useMoveTargets } from './MailMessageView';
import { UserAvatar, UserName, useMailUser } from './people';
import { addressLabel, allLabel, folderLabel, mailErrorText, mailListTime, ROLE_ORDER } from './format';

/**
 * The list column (ADR-0088 §8, Apple Mail): «Входящие ⌄» (the mailbox switcher) and «+» in the
 * header; search and the «Непрочитанные» filter under it; the thread rows of the box, virtualized,
 * the next page at the end and «Загрузить более ранние» below the last one. Drafts and the outgoing
 * queue have their own short lists. Rows are memo'd by key and read their own row object (§9).
 */
export function MailColumn(): ReactNode {
  const role = useMail((s) => (s.query ? null : boxRole(s, s.box)));
  return (
    <aside className="mat-sidebar mat-sidebar-window relative flex w-[clamp(300px,30vw,380px)] shrink-0 flex-col border-r border-line" aria-label={t('mbox.list')} data-testid="mail-column">
      <ColumnHeader title={<BoxSwitcher />}>
        <EmptyTrashButton />
        <SyncControl />
        <CreateButton label={t('mbox.compose')} data-testid="mail-compose" onClick={composeNew} />
      </ColumnHeader>
      <FirstSyncRow />
      <AccountNotice />
      <SearchBar />
      {role === 'drafts' ? <DraftList /> : role === 'outbox' ? <OutboxList /> : <ThreadList />}
    </aside>
  );
}

// ---------------------------------------------------------------- sync (owner 12.10)

/**
 * «Проверить почту» next to «+» (a quiet icon button) and, while an account of the box syncs, a
 * spinner of the same size in its place plus a thin indeterminate 2 px line under the header (a
 * background sync; a first sync shows FirstSyncRow instead). A leaf with boolean selectors:
 * `account_state` re-renders this and nothing else in the column. Not while the engine is down or
 * the sync is stalled (the selectors say no): the banner / the notice row speak then.
 */
const SyncControl = memo(function SyncControl(): ReactNode {
  useLocale();
  const syncing = useMail((s) => scopeSyncing(s, s.box.scope));
  const first = useMail((s) => firstSyncAccount(s, s.box.scope) !== '');
  return (
    <>
      {syncing ? (
        <span className="inline-grid size-8 shrink-0 place-items-center" data-testid="mail-sync-spinner">
          <Spinner className="size-4" label={t('mbox.checking')} />
        </span>
      ) : (
        <IconButton label={t('mbox.checkMail')} onClick={() => void syncNow()} data-testid="mail-sync">
          <RotateCw className="size-4" strokeWidth={1.75} />
        </IconButton>
      )}
      {syncing && !first ? (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-[1] h-0.5 overflow-hidden" aria-hidden data-testid="mail-sync-line">
          <div className="mail-sync-line h-full rounded-full bg-accent" />
        </div>
      ) : null}
    </>
  );
});

/**
 * The text of a first sync's progress (3.1.2): «Загружаем «Входящие»: 1 200 из 8 400», with the
 * address in «Все входящие» of several accounts; «Загружаем письма…» until the first progress.
 * Primitive selectors of one account's progress: only `sync_progress` of it re-renders the caller.
 */
function useSyncProgress(accountId: string): { text: string; ratio: number | null } {
  useLocale();
  const p = useMail(
    useShallow((s) => {
      const x = s.syncProgress[accountId];
      return { phase: x?.phase ?? null, name: x?.folder?.name ?? '', role: x?.folder?.role ?? null, done: x?.done ?? 0, total: x?.total ?? 0 };
    }),
  );
  const email = useMail((s) => (s.box.scope === 'all' && s.accountIds.length > 1 ? (s.accounts[accountId]?.email ?? '') : ''));
  if (p.phase === null) return { text: t('mbox.loadingMail'), ratio: null };
  if (p.phase === 'folders') return { text: t('mbox.sync.folders'), ratio: null };
  const folder = folderLabel({ role: p.role, name: p.name });
  const args = { folder, done: fmt.number(Math.min(p.done, p.total)), total: fmt.number(p.total) };
  return { text: email ? t('mbox.sync.progressOf', { ...args, email }) : t('mbox.sync.progress', args), ratio: p.total > 0 ? Math.min(1, p.done / p.total) : null };
}

/**
 * A first sync of an account of the box (owner 12.10: «бесконечно крутятся спиннеры, не ясно что
 * грузит»): one muted line under the header with what is loading and how far, and a determinate
 * 2 px bar where the background sync's indeterminate line goes. A leaf: progress events (≤ 2/s)
 * re-render this, never the list.
 */
const FirstSyncRow = memo(function FirstSyncRow(): ReactNode {
  const id = useMail((s) => firstSyncAccount(s, s.box.scope));
  return id ? <FirstSyncProgress accountId={id} /> : null;
});

function FirstSyncProgress({ accountId }: { accountId: string }): ReactNode {
  const { text, ratio } = useSyncProgress(accountId);
  return (
    <>
      <p role="status" className="mx-3 mb-2 shrink-0 truncate text-caption text-muted" title={text} data-testid="mail-sync-progress">
        {text}
      </p>
      <div className="pointer-events-none absolute inset-x-0 top-12 z-[1] h-0.5 overflow-hidden" aria-hidden data-testid="mail-sync-line">
        {ratio === null ? (
          <div className="mail-sync-line h-full rounded-full bg-accent" />
        ) : (
          <div className="mail-sync-bar h-full bg-accent" style={{ width: `${String(Math.round(ratio * 1000) / 10)}%` }} />
        )}
      </div>
    </>
  );
}

function FirstSyncText({ accountId }: { accountId: string }): ReactNode {
  return <p>{useSyncProgress(accountId).text}</p>;
}

/**
 * «Очистить корзину» in the header while one account's trash is shown (owner 12.10): confirmed
 * («Удалить N писем навсегда?»), disabled when the trash is empty. A leaf: only the box / count
 * re-render it.
 */
const EmptyTrashButton = memo(function EmptyTrashButton(): ReactNode {
  useLocale();
  const id = useMail((s) => trashBox(s)?.id ?? null);
  const total = useMail((s) => trashBox(s)?.total ?? 0);
  if (!id) return null;
  return (
    <IconButton label={t('mbox.trash.empty')} disabled={total === 0} onClick={() => void emptyTrash(id, total)} data-testid="mail-empty-trash">
      <BrushCleaning className="size-4" strokeWidth={1.75} />
    </IconButton>
  );
});

/** An account of the box that cannot sync: a thin row with the reason and «Повторить» / «Ввести пароль». */
function AccountNotice(): ReactNode {
  const key = useMail((s) => scopeProblem(s, s.box.scope));
  if (!key) return null;
  const [accountId = '', state = ''] = key.split('\n');
  return <NoticeRow accountId={accountId} state={state} />;
}

function NoticeRow({ accountId, state }: { accountId: string; state: string }): ReactNode {
  useLocale();
  const email = useMail((s) => s.accounts[accountId]?.email ?? '');
  const code = useMail((s) => s.accounts[accountId]?.error?.code ?? null);
  const multi = useMail((s) => s.accountIds.length > 1);
  const auth = state === 'auth_failed';
  const reason = auth
    ? t('mbox.state.authFailed')
    : state === 'stalled'
      ? t('mbox.state.stalled')
      : state === 'offline'
        ? t('mbox.state.offline')
        : code
          ? mailErrorText(code)
          : t('mbox.state.error');
  return (
    <div role="status" className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-[8px] bg-hover px-2.5 py-1.5 text-caption" data-testid="mail-account-notice">
      <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-muted" title={`${email}: ${reason}`}>
        {multi ? `${email}: ${reason}` : reason}
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-accent-text hover:underline"
        onClick={() => (auth ? useUi.getState().openDialog({ kind: 'settings', tab: 'mail' }) : void syncNow(accountId))}
        data-testid="mail-account-notice-action"
      >
        {auth ? t('mbox.enterPassword') : t('mbox.retry')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the switcher

function boxTitle(s: Parameters<typeof boxRole>[0] & { folders: Record<string, MailFolder[]> }, box: MailBox): string {
  if (box.scope === 'all') return allLabel(typeof box.folder === 'string' ? box.folder : 'inbox');
  const f = typeof box.folder === 'string' ? s.folders[box.scope]?.find((x) => x.role === box.folder) : s.folderById[box.folder.id];
  return f ? folderLabel(f) : t('mbox.section');
}

function BoxSwitcher(): ReactNode {
  useLocale();
  const title = useMail((s) => (s.query ? t('mbox.searchResults') : boxTitle(s, s.box)));
  const account = useMail((s) => (s.box.scope !== 'all' && s.accountIds.length > 1 ? (s.accounts[s.box.scope]?.email ?? '') : ''));
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={t('mbox.switcher')}
          title={account || undefined}
          data-testid="mail-box-switcher"
          className="group flex h-8 min-w-0 items-center gap-1 rounded-[var(--radius-row)] px-2 text-[17px] font-semibold leading-[22px] tracking-[-0.01em] text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active"
        >
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'max-h-[min(560px,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto')} sideOffset={4} align="start" collisionPadding={16} data-testid="mail-box-menu">
          <SwitcherItems />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Mounted only while open: «Все входящие», then each account's folders with their counters. */
function SwitcherItems(): ReactNode {
  const accountIds = useMail((s) => s.accountIds);
  const multi = accountIds.length > 1;
  return (
    <>
      <BoxItem box={ALL_INBOXES} label={t('mbox.allInboxes')} role="inbox" />
      {multi ? <BoxItem box={{ scope: 'all', folder: 'starred' }} label={allLabel('starred')} role="starred" /> : null}
      {accountIds.map((id) => (
        <AccountFolders key={id} accountId={id} />
      ))}
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Item className={menuItem} onSelect={() => useMailUi.getState().openAdd()} data-testid="mail-add-account">
        <Plus className="size-4" aria-hidden />
        {t('mbox.addAccount')}
      </Dropdown.Item>
    </>
  );
}

function AccountFolders({ accountId }: { accountId: string }): ReactNode {
  const email = useMail((s) => s.accounts[accountId]?.email ?? '');
  const state = useMail((s) => s.accounts[accountId]?.state);
  const folders = useMail(useShallow((s) => s.folders[accountId] ?? []));
  const sorted = useMemo(() => sortFolders(folders), [folders]);
  return (
    <>
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Label className={cx(menuLabel, 'flex items-center gap-1.5 normal-case')}>
        <span className="min-w-0 truncate">{email}</span>
        {state === 'auth_failed' || state === 'error' || state === 'offline' ? <TriangleAlert className="size-3 shrink-0 text-warn" aria-label={t(state === 'auth_failed' ? 'mbox.state.authFailed' : state === 'offline' ? 'mbox.state.offline' : 'mbox.state.error')} /> : null}
      </Dropdown.Label>
      {sorted.map(({ f, depth }) => (
        <BoxItem key={f.id} box={f.role ? { scope: accountId, folder: f.role } : { scope: accountId, folder: { id: f.id } }} label={folderLabel(f)} role={f.role} depth={depth} />
      ))}
    </>
  );
}

/** Role folders in Apple Mail's order, then the others by path with their nesting depth. */
function sortFolders(list: readonly MailFolder[]): Array<{ f: MailFolder; depth: number }> {
  const roles = ROLE_ORDER.map((r) => list.find((f) => f.role === r)).filter((f): f is MailFolder => !!f);
  const rest = list.filter((f) => !f.role).sort((a, b) => a.path.localeCompare(b.path));
  const byId = new Map(list.map((f) => [f.id, f]));
  const depth = (f: MailFolder): number => {
    let d = 0;
    for (let p = f.parentId; p && d < 6; p = byId.get(p)?.parentId ?? null) d++;
    return d;
  };
  return [...roles.map((f) => ({ f, depth: 0 })), ...rest.map((f) => ({ f, depth: depth(f) }))];
}

/**
 * A switcher row; one account's trash row also has a context menu with «Очистить корзину».
 */
function BoxItem(props: { box: MailBox; label: string; role: MailFolderRole | null; depth?: number }): ReactNode {
  const { box, role } = props;
  const trashId = role === 'trash' && box.scope !== 'all' && typeof box.folder === 'string' ? box.scope : null;
  if (!trashId) return <BoxRow {...props} />;
  return <TrashBoxItem accountId={trashId} {...props} />;
}

function TrashBoxItem({ accountId, ...props }: { accountId: string; box: MailBox; label: string; role: MailFolderRole | null; depth?: number }): ReactNode {
  const id = useMail((s) => s.folders[accountId]?.find((f) => f.role === 'trash')?.id ?? null);
  const total = useMail((s) => s.folders[accountId]?.find((f) => f.role === 'trash')?.total ?? 0);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <BoxRow {...props} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-max')} collisionPadding={16} data-testid="mail-box-trash-menu">
          <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} disabled={!id || total === 0} onSelect={() => id && void emptyTrash(id, total)} data-testid="mail-box-empty-trash">
            <BrushCleaning className="size-4" aria-hidden />
            {t('mbox.trash.empty')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const BoxRow = forwardRef<HTMLDivElement, { box: MailBox; label: string; role: MailFolderRole | null; depth?: number }>(function BoxRow({ box, label, role, depth = 0, ...rest }, ref): ReactNode {
  const current = useMail((s) => !s.query && boxEquals(s.box, box));
  // Drafts and the outgoing queue count their items; every other folder its unread.
  const count = useMail((s) => {
    if (role === 'drafts' || role === 'outbox') {
      const f = typeof box.folder !== 'string' ? s.folderById[box.folder.id] : box.scope === 'all' ? null : s.folders[box.scope]?.find((x) => x.role === role);
      return f ? f.total : 0;
    }
    return boxUnread(s, box);
  });
  return (
    // `rest`: the context menu trigger's handlers (the trash row).
    <Dropdown.Item {...rest} ref={ref} className={cx(menuItem, 'pr-2')} onSelect={() => selectBox(box)} data-testid="mail-box-item" style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 ? <span className="shrink-0 text-caption tabular-nums opacity-70">{count}</span> : null}
      <Check className={cx('size-4 shrink-0', !current && 'invisible')} aria-hidden />
    </Dropdown.Item>
  );
});

// ---------------------------------------------------------------- search + filter

function SearchBar(): ReactNode {
  const query = useMail((s) => s.query);
  const unreadOnly = useMail((s) => s.unreadOnly);
  const flaggedOnly = useMail((s) => s.flaggedOnly);
  const [text, setText] = useState(query);
  const [prev, setPrev] = useState(query);
  if (prev !== query) {
    setPrev(query);
    setText(query);
  }
  // One trailing timeout per keystroke burst (no interval): the search runs 250 ms after typing stops.
  useEffect(() => {
    if (text.trim() === query) return;
    const id = window.setTimeout(() => setQuery(text), 250);
    return () => window.clearTimeout(id);
  }, [text, query]);
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
      <div className="relative min-w-0 flex-1">
        <Input
          icon={<Search />}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text) {
              e.preventDefault();
              setText('');
              setQuery('');
            }
          }}
          placeholder={t('mbox.search')}
          aria-label={t('mbox.search')}
          className="pr-7 [&::-webkit-search-cancel-button]:hidden"
          data-testid="mail-search"
        />
        {text ? (
          <button
            type="button"
            aria-label={t('mbox.clearSearch')}
            onClick={() => {
              setText('');
              setQuery('');
            }}
            className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <IconButton label={t('mbox.unreadOnly')} active={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)} data-testid="mail-unread-filter">
        <ListFilter className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label={t('mbox.flaggedOnly')} active={flaggedOnly} onClick={() => setFlaggedOnly(!flaggedOnly)} data-testid="mail-flagged-filter">
        <Flag className={cx('size-4', flaggedOnly && 'fill-[var(--color-attention)] text-attention')} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------- the thread list

function ThreadList(): ReactNode {
  const order = useMail((s) => s.order);
  const state = useMail((s) => s.listState);
  const error = useMail((s) => s.listError);
  const ref = useRef<VirtuosoHandle>(null);
  // The selection moved by the keyboard (↑/↓) or after a move: keep it in view.
  useEffect(
    () =>
      useMail.subscribe((s, p) => {
        if (s.selected === p.selected || !s.selected) return;
        const index = s.order.indexOf(s.selected);
        if (index >= 0) ref.current?.scrollIntoView({ index, behavior: 'auto' });
      }),
    [],
  );
  const end = useCallback(() => void loadMore(), []);
  if (!order.length) {
    if (state === 'loading') {
      return (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      );
    }
    if (state === 'error' && error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-body text-muted" role="alert">
          <p>{t('mbox.err.load')}</p>
          <p className="text-caption">{mailErrorText(error)}</p>
          <Button size="sm" variant="secondary" onClick={() => void reloadList()}>
            <RotateCw className="size-3.5" aria-hidden /> {t('mbox.retry')}
          </Button>
        </div>
      );
    }
    return <EmptyList />;
  }
  return (
    <RowMenu>
      <Virtuoso
        ref={ref}
        role="listbox"
        aria-label={t('mbox.list')}
        aria-multiselectable
        data-testid="mail-list"
        className="min-h-0 flex-1"
        data={order}
        computeItemKey={(_, k) => k}
        increaseViewportBy={400}
        endReached={end}
        itemContent={(_, k) => <MailRow k={k} />}
        components={LIST_COMPONENTS}
      />
    </RowMenu>
  );
}

/**
 * No rows: the first sync of a new mailbox shows «Загружаем письма…» (owner 12.10: an empty list
 * right after adding the account read as «no mail»), then the real empty state. Mounted only while
 * the list is empty, so its account-state selector costs a full list nothing.
 */
function EmptyList(): ReactNode {
  const first = useMail((s) => (s.query ? '' : firstSyncAccount(s, s.box.scope)));
  const unreadOnly = useMail((s) => s.unreadOnly);
  const flaggedOnly = useMail((s) => s.flaggedOnly);
  const searching = useMail((s) => s.query !== '');
  if (first) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-body text-muted" data-testid="mail-list-first-sync">
        <Spinner />
        <FirstSyncText accountId={first} />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-body text-muted" data-testid="mail-list-empty">
      <p>{searching ? t('mbox.searchEmpty') : flaggedOnly ? t('mbox.emptyFlagged') : unreadOnly ? t('mbox.emptyUnread') : t('mbox.empty')}</p>
      {searching || unreadOnly || flaggedOnly ? null : <ListFooter />}
    </div>
  );
}

// ---------------------------------------------------------------- selection + the row menu

/** A row click (Apple Mail): ⌘ toggles it in the selection, ⇧ picks the range, a plain click opens it alone. */
function rowClick(e: ReactMouseEvent<HTMLElement>): void {
  const k = e.currentTarget.dataset['rowKey'];
  if (!k) return;
  if (e.metaKey || e.ctrlKey) togglePick(k);
  else if (e.shiftKey) pickRange(k);
  else {
    clearPicked();
    openRow(k);
  }
}

/**
 * The rows' context menu (owner 12.10): one Radix menu for the whole list (not one per row). A
 * right click on a row outside the selection selects that row first; on a picked row the menu acts
 * on all the picked rows. Empty space opens nothing.
 */
function RowMenu({ children }: { children: ReactNode }): ReactNode {
  const [keys, setKeys] = useState<string[]>([]);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger
        asChild
        onContextMenu={(e) => {
          const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-row-key]') : null;
          const k = el?.dataset['rowKey'];
          if (!k) {
            e.preventDefault();
            return;
          }
          const picked = useMailUi.getState().picked;
          if (picked.size > 1 && picked.has(k)) {
            setKeys([...picked]);
            return;
          }
          clearPicked();
          if (useMail.getState().selected !== k) openRow(k);
          setKeys([k]);
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-max max-w-[380px] whitespace-nowrap')} collisionPadding={16} data-testid="mail-row-menu">
          <RowMenuItems keys={keys} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** «Отправить в чат…» from a row: the row's message (the newest of the thread in this folder). */
function toChatRow(key: string | undefined): void {
  const row = key ? useMail.getState().rows[key] : undefined;
  if (row) useMailUi.getState().openToChat(row.messageId);
}

const Hint = ({ k }: { k: string }): ReactNode => (k ? <span className="ml-auto pl-4 text-caption tabular-nums opacity-60">{k}</span> : null);

function RowMenuItems({ keys }: { keys: string[] }): ReactNode {
  useLocale();
  const n = keys.length;
  const set = useMemo(() => new Set(keys), [keys]);
  const anyUnread = useMail((s) => pickedSummary(s, set).anyUnread);
  const anyUnflagged = useMail((s) => pickedSummary(s, set).anyUnflagged);
  const account = useMail((s) => pickedSummary(s, set).account);
  const folder = useMail((s) => pickedSummary(s, set).folder);
  const trash = useMail(inTrash);
  if (!n) return null;
  const one = n === 1;
  const letters = plural('mbox.letters', n);
  const label = (single: string, many: Parameters<typeof t>[0]): string => (one ? single : t(many, { letters }));
  return (
    <>
      {one ? (
        <>
          <ContextMenu.Item className={menuItem} onSelect={() => replyOpen('reply')}>
            <Reply className="size-4" aria-hidden />
            {t('mbox.reply')}
            <Hint k={MAIL_KEYS.reply} />
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => replyOpen('replyAll')}>
            <ReplyAll className="size-4" aria-hidden />
            {t('mbox.replyAll')}
            <Hint k={MAIL_KEYS.replyAll} />
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => replyOpen('forward')}>
            <Forward className="size-4" aria-hidden />
            {t('mbox.forward')}
            <Hint k={MAIL_KEYS.forward} />
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => toChatRow(keys[0])} data-testid="mail-menu-to-chat">
            <MessageSquareShare className="size-4" aria-hidden />
            {t('mbox.chat.title')}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
        </>
      ) : null}
      <ContextMenu.Item className={menuItem} onSelect={() => toggleRowsRead(keys)} data-testid="mail-menu-read">
        {anyUnread ? <MailOpen className="size-4" aria-hidden /> : <Mail className="size-4" aria-hidden />}
        {anyUnread ? label(t('mbox.markRead'), 'mbox.multi.read') : label(t('mbox.markUnread'), 'mbox.multi.unread')}
        <Hint k={MAIL_KEYS.unread} />
      </ContextMenu.Item>
      <ContextMenu.Item className={menuItem} onSelect={() => toggleRowsFlag(keys)} data-testid="mail-menu-flag">
        <Flag className="size-4" aria-hidden />
        {anyUnflagged ? label(t('mbox.flag'), 'mbox.multi.flag') : label(t('mbox.unflag'), 'mbox.multi.unflag')}
        <Hint k={MAIL_KEYS.flag} />
      </ContextMenu.Item>
      <ContextMenu.Separator className={menuSeparator} />
      <ContextMenu.Item className={menuItem} onSelect={() => moveKeys(keys, { kind: 'archive' })} data-testid="mail-menu-archive">
        <Archive className="size-4" aria-hidden />
        {label(t('mbox.archive'), 'mbox.multi.archive')}
        <Hint k={MAIL_KEYS.archive} />
      </ContextMenu.Item>
      {trash ? (
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void deleteKeysForever(keys)} data-testid="mail-menu-delete-forever">
          <Trash2 className="size-4" aria-hidden />
          {t('mbox.trash.deleteForever')}
          <Hint k={MAIL_KEYS.trash} />
        </ContextMenu.Item>
      ) : (
        <ContextMenu.Item className={menuItem} onSelect={() => moveKeys(keys, { kind: 'trash' })} data-testid="mail-menu-trash">
          <Trash2 className="size-4" aria-hidden />
          {label(t('mbox.trash'), 'mbox.multi.trash')}
          <Hint k={MAIL_KEYS.trash} />
        </ContextMenu.Item>
      )}
      {account ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="mail-menu-move">
            <FolderInput className="size-4" aria-hidden />
            {label(t('mbox.move'), 'mbox.multi.move')}
            <ChevronDown className="ml-auto size-3.5 -rotate-90 opacity-60" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'max-h-[min(420px,var(--radix-context-menu-content-available-height))] overflow-y-auto')} collisionPadding={16}>
              <ContextMenu.Label className={menuLabel}>{t('mbox.moveTo')}</ContextMenu.Label>
              <MenuTargets accountId={account} folderId={folder || null} keys={keys} />
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}
    </>
  );
}

function MenuTargets({ accountId, folderId, keys }: { accountId: string; folderId: string | null; keys: string[] }): ReactNode {
  const targets = useMoveTargets(accountId, folderId);
  return (
    <>
      {targets.map((f) => (
        <ContextMenu.Item key={f.id} className={menuItem} onSelect={() => moveKeys(keys, { kind: 'move', folderId: f.id })}>
          {folderLabel(f)}
        </ContextMenu.Item>
      ))}
    </>
  );
}

const LIST_COMPONENTS = { Footer: () => <ListFooter /> };

/** The end of the list: the next page loading, else «Загрузить более ранние» (90 more days, §3). */
function ListFooter(): ReactNode {
  const loading = useMail((s) => s.listState === 'loading' && s.order.length > 0);
  const hasNext = useMail((s) => s.next !== null);
  const older = useMail((s) => s.older);
  const searching = useMail((s) => s.query !== '');
  if (loading || hasNext) {
    return (
      <div className="grid h-12 place-items-center">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (searching) return <div className="h-4" />;
  return (
    <div className="flex h-14 items-center justify-center px-3">
      {older === 'exhausted' ? (
        <span className="text-caption text-faint">{t('mbox.noOlder')}</span>
      ) : (
        <Button size="sm" variant="ghost" busy={older === 'loading'} onClick={() => void loadOlder()} data-testid="mail-load-older">
          {t('mbox.loadOlder')}
        </Button>
      )}
    </div>
  );
}

/**
 * One thread row (§8): unread dot, sender bold, time right, the subject, two lines of preview, the
 * flag, the paperclip and the thread count. Memo'd by key; reads its own row and a boolean.
 */
const MailRow = memo(function MailRow({ k }: { k: string }): ReactNode {
  useLocale();
  useTimeFormat();
  const row = useMail((s) => s.rows[k]);
  const selected = useMail((s) => s.selected === k);
  const picked = useMailUi((s) => s.picked.has(k));
  // The sender is a person of Calab (owner 12.10): their avatar and name, a click opens the profile.
  const userId = useMailUser(row?.from.address ?? '');
  // «Все входящие» with several accounts: the account under the sender (where the reply goes from).
  const account = useMail((s) => (s.box.scope === 'all' && s.accountIds.length > 1 && row ? (s.accounts[row.accountId]?.email ?? '') : ''));
  if (!row) return null;
  const subject = row.subject.trim() || t('mbox.noSubject');
  const sender = addressLabel(row.from);
  return (
    <div className="px-2 pb-px">
      <div
        role="option"
        aria-selected={selected || picked}
        tabIndex={-1}
        onClick={rowClick}
        data-row-key={k}
        data-testid="mail-row"
        data-unread={row.unread || undefined}
        data-picked={picked || undefined}
        className={cx('relative flex cursor-default select-none flex-col gap-0.5 rounded-[8px] py-2 pl-6 pr-3', selected || picked ? ROW_SELECTED : ROW_HOVER)}
      >
        {row.unread ? <span className="absolute left-2 top-[13px] size-2.5 rounded-full bg-accent" aria-label={t('mbox.unread')} /> : null}
        <div className="flex min-w-0 items-center gap-1.5">
          {userId ? (
            <span className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-[14px] leading-5 text-fg', row.unread ? 'font-bold' : 'font-semibold')} title={row.from.address}>
              <UserAvatar userId={userId} size={18} />
              <UserName userId={userId} />
            </span>
          ) : (
            <span className={cx('min-w-0 flex-1 truncate text-[14px] leading-5 text-fg', row.unread ? 'font-bold' : 'font-semibold')}>{sender}</span>
          )}
          {row.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted" aria-label={t('mbox.hasAttachments')} /> : null}
          {row.flagged ? <Flag className="size-3.5 shrink-0 fill-[var(--color-attention)] text-attention" aria-label={t('mbox.flagged')} /> : null}
          <time className="shrink-0 text-caption tabular-nums text-muted" dateTime={new Date(row.date).toISOString()}>
            {mailListTime(row.date)}
          </time>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-fg">{subject}</span>
          {row.count > 1 ? (
            <span className="shrink-0 rounded-full bg-hover px-1.5 text-micro font-semibold leading-4 tabular-nums text-muted" aria-label={plural('mbox.threadCount', row.count)}>
              {row.count}
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 text-[13px] leading-[18px] text-muted">{row.snippet}</p>
        {account ? <span className="truncate text-micro text-faint">{account}</span> : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- drafts and the outgoing queue

/** Local drafts (§6): a click opens the composer with the draft. */
function DraftList(): ReactNode {
  const drafts = useMail((s) => s.drafts);
  useEffect(() => void loadDrafts(), []);
  if (!drafts.length) return <p className="flex flex-1 items-center justify-center text-body text-muted">{t('mbox.draftsEmpty')}</p>;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-testid="mail-drafts">
      {drafts.map((d) => (
        <DraftRow key={d.id ?? ''} draft={d} />
      ))}
    </ul>
  );
}

const DraftRow = memo(function DraftRow({ draft }: { draft: MailDraft }): ReactNode {
  const to = draft.to.map(addressLabel).join(', ');
  const remove = (): void => {
    const api = mailApi();
    if (!api || !draft.id) return;
    api.drafts.remove(draft.id).then(
      () => void loadDrafts(),
      () => toast.error(t('mbox.err.generic')),
    );
  };
  return (
    <li className={cx('group relative flex flex-col gap-0.5 rounded-[8px] py-2 pl-3 pr-9', ROW_HOVER)}>
      <button type="button" className="absolute inset-0 rounded-[8px]" aria-label={draft.subject || t('mbox.noSubject')} onClick={() => useMailUi.getState().openCompose({ kind: 'draft', draft })} />
      <span className="pointer-events-none truncate text-[14px] font-semibold text-fg">{to || t('mbox.draftNoRecipients')}</span>
      <span className="pointer-events-none truncate text-[13px] text-fg">{draft.subject.trim() || t('mbox.noSubject')}</span>
      <span className="pointer-events-none line-clamp-2 text-[13px] text-muted">{draft.text}</span>
      <IconButton label={t('mbox.deleteDraft')} size="sm" className="absolute right-1 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={remove}>
        <Trash2 className="size-3.5" />
      </IconButton>
    </li>
  );
});

/** «Исходящие» (§6): queued, sending and failed items — retry / remove. */
function OutboxList(): ReactNode {
  const items = useMail(useShallow(outgoingOf));
  if (!items.length) return <p className="flex flex-1 items-center justify-center text-body text-muted">{t('mbox.outboxEmpty')}</p>;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-testid="mail-outbox">
      {items.map((o) => (
        <OutboxRow key={o.id} item={o} />
      ))}
    </ul>
  );
}

const OutboxRow = memo(function OutboxRow({ item }: { item: MailOutgoing }): ReactNode {
  useLocale();
  const api = mailApi();
  const run = (p: Promise<void> | undefined): void => {
    p?.catch((e: unknown) => toast.error(mailErrorText(typeof e === 'object' && e && 'code' in e ? (e as { code: never }).code : 'ENGINE_DOWN')));
  };
  const state =
    item.state === 'failed'
      ? item.nextAt
        ? t('mbox.out.retryAt', { time: fmt.time(new Date(item.nextAt)) })
        : t('mbox.out.failed')
      : item.state === 'sending'
        ? t('mbox.out.sending')
        : t('mbox.out.queued');
  return (
    <li className="flex flex-col gap-1 rounded-[8px] px-3 py-2" data-testid="mail-outbox-row">
      <span className="truncate text-[14px] font-semibold text-fg">{item.to.map(addressLabel).join(', ')}</span>
      <span className="truncate text-[13px] text-fg">{item.subject.trim() || t('mbox.noSubject')}</span>
      <span className={cx('text-caption', item.state === 'failed' ? 'text-danger-text' : 'text-muted')}>
        {state}
        {item.error ? ` · ${mailErrorText(item.error.code)}` : ''}
      </span>
      <div className="flex gap-2 pt-0.5">
        {item.state === 'failed' ? (
          <Button size="sm" variant="secondary" onClick={() => run(api?.outgoing.retry(item.id))}>
            {t('mbox.out.retry')}
          </Button>
        ) : null}
        {item.state !== 'sending' ? (
          <Button size="sm" variant="ghost" onClick={() => run(api?.outgoing.remove(item.id))}>
            {t('mbox.out.remove')}
          </Button>
        ) : null}
      </div>
    </li>
  );
});
