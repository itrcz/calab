import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Flag, ListFilter, Paperclip, Plus, RotateCw, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  loadDrafts,
  loadMore,
  loadOlder,
  mailApi,
  openRow,
  outgoingOf,
  reloadList,
  selectBox,
  setQuery,
  setUnreadOnly,
  useMail,
  type MailBox,
} from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { ColumnHeader, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { composeNew } from './actions';
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
    <aside className="mat-sidebar mat-sidebar-window flex w-[clamp(300px,30vw,380px)] shrink-0 flex-col border-r border-line" aria-label={t('mbox.list')} data-testid="mail-column">
      <ColumnHeader title={<BoxSwitcher />}>
        <CreateButton label={t('mbox.compose')} data-testid="mail-compose" onClick={composeNew} />
      </ColumnHeader>
      <SearchBar />
      {role === 'drafts' ? <DraftList /> : role === 'outbox' ? <OutboxList /> : <ThreadList />}
    </aside>
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

function BoxItem({ box, label, role, depth = 0 }: { box: MailBox; label: string; role: MailFolderRole | null; depth?: number }): ReactNode {
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
    <Dropdown.Item className={cx(menuItem, 'pr-2')} onSelect={() => selectBox(box)} data-testid="mail-box-item" style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 ? <span className="shrink-0 text-caption tabular-nums opacity-70">{count}</span> : null}
      <Check className={cx('size-4 shrink-0', !current && 'invisible')} aria-hidden />
    </Dropdown.Item>
  );
}

// ---------------------------------------------------------------- search + filter

function SearchBar(): ReactNode {
  const query = useMail((s) => s.query);
  const unreadOnly = useMail((s) => s.unreadOnly);
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
    </div>
  );
}

// ---------------------------------------------------------------- the thread list

function ThreadList(): ReactNode {
  const order = useMail((s) => s.order);
  const state = useMail((s) => s.listState);
  const error = useMail((s) => s.listError);
  const unreadOnly = useMail((s) => s.unreadOnly);
  const searching = useMail((s) => s.query !== '');
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
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-body text-muted" data-testid="mail-list-empty">
        <p>{searching ? t('mbox.searchEmpty') : unreadOnly ? t('mbox.emptyUnread') : t('mbox.empty')}</p>
        {searching || unreadOnly ? null : <ListFooter />}
      </div>
    );
  }
  return (
    <Virtuoso
      ref={ref}
      role="listbox"
      aria-label={t('mbox.list')}
      data-testid="mail-list"
      className="min-h-0 flex-1"
      data={order}
      computeItemKey={(_, k) => k}
      increaseViewportBy={400}
      endReached={end}
      itemContent={(_, k) => <MailRow k={k} />}
      components={LIST_COMPONENTS}
    />
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
  // «Все входящие» with several accounts: the account under the sender (where the reply goes from).
  const account = useMail((s) => (s.box.scope === 'all' && s.accountIds.length > 1 && row ? (s.accounts[row.accountId]?.email ?? '') : ''));
  if (!row) return null;
  const subject = row.subject.trim() || t('mbox.noSubject');
  const sender = addressLabel(row.from);
  return (
    <div className="px-2 pb-px">
      <div
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={() => openRow(k)}
        data-testid="mail-row"
        data-unread={row.unread || undefined}
        className={cx('relative flex cursor-default flex-col gap-0.5 rounded-[8px] py-2 pl-6 pr-3', selected ? ROW_SELECTED : ROW_HOVER)}
      >
        {row.unread ? <span className="absolute left-2 top-[13px] size-2.5 rounded-full bg-accent" aria-label={t('mbox.unread')} /> : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cx('min-w-0 flex-1 truncate text-[14px] leading-5 text-fg', row.unread ? 'font-bold' : 'font-semibold')}>{sender}</span>
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
