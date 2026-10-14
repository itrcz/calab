import { timestampDate } from '@bufbuild/protobuf/wkt';
import { DISK_BITS, type DiskActivity, type DiskItem } from '@calaba/protocol';
import { ChevronRight, Copy, Folder } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Input, Modal, Select, Spinner, Switch, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { activityDays, canMoveInto, describeActivity, folderKey, isFolder, ROOT, visibleIds } from '../../lib/disk';
import { fmt } from '../../lib/format';
import { collator, diskApi, loadListing, loadPath, moveItems, refreshDisk } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi, type DiskDialog } from '../../stores/diskUi';
import { toast } from '../../stores/toasts';
import { useMemberName } from '../../stores/workspaces';
import { VideoAttachment } from '../chat/MediaPlayer';
import { MemberAvatar } from '../boards/menus';
import { entryOf, TreeAccessEditor, useTreeAccess } from '../people/TreeAccess';
import { openBuyStorage, UsageMeter } from './UsageMeter';

/**
 * The disk's dialogs (ADR-0094 §8): «Доступ», «Ссылка», «История» (an item's or the whole disk's),
 * «Переместить», «Место» and the video player card. One host reads the dialog request from
 * stores/diskUi; each dialog mounts only while open.
 */
export function DiskDialogs({ workspaceId }: { workspaceId: string }): ReactNode {
  const dialog = useDiskUi((s) => s.dialog);
  if (!dialog) return null;
  return <DialogBody dialog={dialog} workspaceId={workspaceId} onClose={closeDialog} />;
}

/** Stable (a dialog's effects depend on it). */
const closeDialog = (): void => useDiskUi.getState().openDialog(null);

function DialogBody({ dialog, workspaceId, onClose }: { dialog: DiskDialog; workspaceId: string; onClose: () => void }): ReactNode {
  switch (dialog.kind) {
    case 'access':
      return <AccessDialog itemId={dialog.itemId} onClose={onClose} />;
    case 'link':
      return <LinkDialog itemId={dialog.itemId} onClose={onClose} />;
    case 'history':
      return <HistoryDialog workspaceId={workspaceId} itemId={dialog.itemId} onClose={onClose} />;
    case 'disk-history':
      return <HistoryDialog workspaceId={dialog.wsId} onClose={onClose} />;
    case 'move':
      return <MoveDialog workspaceId={workspaceId} itemIds={dialog.itemIds} onClose={onClose} />;
    case 'usage':
      return <UsageDialog workspaceId={dialog.wsId} full={!!dialog.full} onClose={onClose} />;
    case 'preview':
      return <PreviewDialog itemId={dialog.itemId} onClose={onClose} />;
  }
}

// ---------------------------------------------------------------- «Доступ»

const DISK_TREE = { VIEW: DISK_BITS.VIEW, WRITE: DISK_BITS.WRITE };

/**
 * «Доступ» (ADR-0094 §2): the shared tree access editor (features/people/TreeAccess) in a sheet;
 * saved at once with PUT (the whole list), like the board's access.
 */
function AccessDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): ReactNode {
  const item = useDisk((s) => s.items[itemId]);
  const ws = item?.workspaceId ?? '';
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => diskApi.permissions(itemId), [itemId]);
  const access = useTreeAccess(load, DISK_TREE, (e) => {
    toast.fail(e, t('disk.err.access'));
    onClose();
  });
  if (!item) return null;
  const { drafts, restricted } = access;
  const save = (): void => {
    if (!drafts) return;
    setBusy(true);
    diskApi.setPermissions(itemId, { entries: drafts.map((d) => entryOf(d, DISK_TREE)), restricted }).then(
      () => {
        useDisk.getState().upsert({ ...item, restricted, shared: drafts.length > 0 });
        refreshDisk(ws);
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        toast.fail(e, t('disk.err.access'));
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      medium
      initialFocus="body"
      title={t('disk.accessTitle', { name: item.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} busy={busy} disabled={!drafts} data-testid="disk-access-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TreeAccessEditor
        workspaceId={ws}
        ownerId={item.ownerId}
        access={access}
        hint={t('disk.restrictedHint')}
        inherited={t('disk.accessInherited')}
        footer={t('disk.accessFooter')}
        testId="disk-access"
      />
    </Modal>
  );
}

// ---------------------------------------------------------------- «Ссылка»

const EXPIRY_DAYS = [0, 1, 7, 30] as const;
type Expiry = (typeof EXPIRY_DAYS)[number];

/**
 * «Ссылка» (ADR-0094 §3): the switch «Доступ по ссылке» (anyone with it downloads the file without
 * signing in), the address with «Скопировать», the term chosen before switching on (changing it
 * means a new link), the download counter.
 */
function LinkDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): ReactNode {
  const item = useDisk((s) => s.items[itemId]);
  const on = !!item?.link;
  const [url, setUrl] = useState('');
  const [expiry, setExpiry] = useState<Expiry>(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!on || url) return;
    let live = true;
    // The live link is returned as is: the way to read its address.
    diskApi.createLink(itemId).then(
      (r) => live && setUrl(r.url),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on, url, itemId]);
  if (!item) return null;
  const toggle = (v: boolean): void => {
    setBusy(true);
    const done = (): void => setBusy(false);
    if (v) {
      diskApi.createLink(itemId, expiry ? Date.now() + expiry * 86_400_000 : undefined).then((r) => {
        setUrl(r.url);
        const cur = useDisk.getState().items[itemId];
        if (cur && r.link) useDisk.getState().upsert({ ...cur, link: r.link });
        done();
      }, (e: unknown) => {
        toast.fail(e, t('disk.err.link'));
        done();
      });
    } else {
      diskApi.deleteLink(itemId).then(() => {
        setUrl('');
        const cur = useDisk.getState().items[itemId];
        if (cur) useDisk.getState().upsert({ ...cur, link: undefined });
        done();
      }, (e: unknown) => {
        toast.fail(e, t('disk.err.link'));
        done();
      });
    }
  };
  const until = item.link?.expiresAt ? timestampDate(item.link.expiresAt) : null;
  return (
    <Modal open onClose={onClose} initialFocus="body" title={t('disk.linkTitle', { name: item.name })}>
      <div className="flex flex-col gap-4" data-testid="disk-link">
        <Switch checked={on} onChange={toggle} label={t('disk.link.on')} hint={t('disk.link.hint')} disabled={busy} />
        {on ? (
          <>
            <div className="flex items-center gap-2">
              <Input readOnly value={url} aria-label={t('disk.link.address')} className="font-mono text-caption" onFocus={(e) => e.currentTarget.select()} data-testid="disk-link-url" />
              <Button
                variant="secondary"
                disabled={!url}
                onClick={() =>
                  void navigator.clipboard.writeText(url).then(
                    () => toast.success(t('disk.link.copied')),
                    (e: unknown) => toast.fail(e),
                  )
                }
                data-testid="disk-link-copy"
              >
                <Copy className="size-3.5" aria-hidden />
                {t('disk.link.copyShort')}
              </Button>
            </div>
            <p className="text-caption text-muted">
              {until ? t('disk.link.until', { date: fmt.stamp(until) }) : t('disk.link.forever')}
              {' · '}
              {t('disk.link.downloads', { n: item.link?.downloads ?? 0 })}
            </p>
          </>
        ) : (
          <label className="flex items-center justify-between gap-4 text-body">
            <span>{t('disk.link.expiry')}</span>
            <span className="w-40">
              <Select value={String(expiry)} onChange={(e) => setExpiry(Number(e.target.value) as Expiry)} data-testid="disk-link-expiry">
                {EXPIRY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? t('disk.link.never') : t('disk.link.days', { n: d })}
                  </option>
                ))}
              </Select>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- «История»

/**
 * «История» (ADR-0094 §5): an item's journal or, for DISK_MANAGE, the whole disk's — newest first,
 * by day, the actor's avatar and name with the sentence, the time on the right; «Показать ещё»
 * pages by the cursor.
 */
function HistoryDialog({ workspaceId, itemId, onClose }: { workspaceId: string; itemId?: string; onClose: () => void }): ReactNode {
  useLocale();
  const name = useDisk((s) => (itemId ? (s.items[itemId]?.name ?? '') : ''));
  const [list, setList] = useState<DiskActivity[]>([]);
  const [cursor, setCursor] = useState<string | null>('');
  const [loading, setLoading] = useState(true);
  const fetchPage = (from: string): void => {
    (itemId ? diskApi.itemActivity(itemId, from || undefined) : diskApi.activity(workspaceId, from || undefined)).then(
      (p) => {
        setList((l) => [...l, ...p.activities]);
        setCursor(p.nextCursor || null);
        setLoading(false);
      },
      (e: unknown) => {
        toast.fail(e, t('disk.err.history'));
        setCursor(null);
        setLoading(false);
      },
    );
  };
  const more = (from: string): void => {
    setLoading(true);
    fetchPage(from);
  };
  useEffect(() => {
    fetchPage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first page once
  }, []);
  const days = activityDays(list);
  const now = new Date();
  return (
    <Modal open onClose={onClose} medium title={itemId ? t('disk.historyTitle', { name }) : t('disk.diskHistory')} initialFocus="body">
      <div className="-mx-5 flex flex-col pb-2" data-testid="disk-history">
        {days.map((g) => (
          <section key={g.day} className="flex flex-col">
            <h4 className="px-5 pb-1 pt-2 text-caption font-medium text-muted">{fmt.dayLabel(new Date(g.at), now)}</h4>
            <ol className="relative flex flex-col">
              <span className="pointer-events-none absolute bottom-3 left-[29px] top-3 w-px bg-[var(--color-separator)]" aria-hidden />
              {g.items.map((a) => (
                <HistoryRow key={a.id} workspaceId={workspaceId} a={a} />
              ))}
            </ol>
          </section>
        ))}
        {loading ? (
          <div className="grid h-12 place-items-center">
            <Spinner />
          </div>
        ) : !list.length ? (
          <p className="px-5 py-3 text-caption text-muted">{t('disk.historyEmpty')}</p>
        ) : cursor ? (
          <button type="button" onClick={() => more(cursor)} className="mx-5 mt-1 h-7 self-start rounded-full px-2.5 text-caption text-accent-text hover:bg-hover">
            {t('boards.hist.more')}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

function HistoryRow({ workspaceId, a }: { workspaceId: string; a: DiskActivity }): ReactNode {
  const actor = useMemberName(workspaceId, a.actorId);
  const d = describeActivity(a);
  const at = a.createdAt ? timestampDate(a.createdAt) : null;
  return (
    <li className="relative flex items-start gap-2 py-1 pl-[40px] pr-5" data-testid="disk-history-row">
      <span className="absolute left-[26px] top-[11px] size-[7px] rounded-full bg-[var(--color-label-tertiary)] ring-2 ring-[var(--color-bg)]" aria-hidden />
      {a.actorId ? (
        <MemberAvatar workspaceId={workspaceId} userId={a.actorId} size={20} />
      ) : (
        <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)]" aria-hidden />
      )}
      <p className="min-w-0 flex-1 break-words text-caption leading-[22px] text-muted">
        <span className="font-medium text-fg">{a.actorId ? actor : t('disk.sweeper')}</span> {t(d.key, d.params)}
      </p>
      {at ? (
        <time className="shrink-0 pt-px text-caption leading-[22px] tabular-nums text-faint" dateTime={at.toISOString()} title={fmt.full(at)}>
          {fmt.time(at)}
        </time>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- «Переместить»

/**
 * «Переместить» (ADR-0094 §8): a card that walks the folders from the open one — crumbs on top,
 * the subfolders as rows (a click goes in), «Переместить сюда» moves into the shown folder. The
 * moved items themselves and the place they are in are not offered (lib/disk canMoveInto).
 */
function MoveDialog({ workspaceId, itemIds, onClose }: { workspaceId: string; itemIds: readonly string[]; onClose: () => void }): ReactNode {
  const first = useDisk((s) => s.items[itemIds[0] ?? '']);
  const [at, setAt] = useState<string>(first?.parentId ?? ROOT);
  const key = folderKey(workspaceId, at);
  const folders = useDisk(
    useShallow((s) =>
      visibleIds(s.lists[key], s.items, 'name', '', collator()).filter((id) => {
        const it = s.items[id];
        return !!it && isFolder(it) && !itemIds.includes(id);
      }),
    ),
  );
  const loaded = useDisk((s) => !!s.lists[key]);
  const path = useDisk((s) => (at ? s.paths[at] : undefined));
  useEffect(() => {
    void loadListing(workspaceId, at, false);
    void loadPath(at);
  }, [workspaceId, at]);
  const pathIds = (path ?? []).map((p) => p.id);
  const items = itemIds.map((id) => useDisk.getState().items[id]).filter((x): x is DiskItem => !!x);
  const ok = items.length > 0 && items.every((it) => canMoveInto(it, at, pathIds));
  const crumbs = [{ id: ROOT, name: t('disk.section') }, ...(path ?? []).map((p) => ({ id: p.id, name: p.name }))];
  return (
    <Modal
      open
      onClose={onClose}
      initialFocus="body"
      title={items.length === 1 ? t('disk.moveTitle', { name: items[0]?.name ?? '' }) : t('disk.moveTitleMany', { n: items.length })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ok}
            onClick={() => {
              onClose();
              void moveItems(itemIds, at);
            }}
            data-testid="disk-move-here"
          >
            {t('disk.moveHere')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="disk-move">
        <nav aria-label={t('disk.path')} className="flex min-w-0 flex-wrap items-center gap-0.5 text-body">
          {crumbs.map((c, i) => (
            <span key={c.id || 'root'} className="flex min-w-0 items-center gap-0.5">
              {i > 0 ? <ChevronRight className="size-3.5 text-faint" aria-hidden /> : null}
              <button
                type="button"
                onClick={() => setAt(c.id)}
                className={cx('h-7 max-w-48 truncate rounded-[var(--radius-control)] px-1.5', i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex h-60 flex-col overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] p-1">
          {!loaded ? (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          ) : folders.length ? (
            folders.map((id) => <MoveRow key={id} id={id} onOpen={setAt} />)
          ) : (
            <p className="grid flex-1 place-items-center text-caption text-muted">{t('disk.moveNoFolders')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MoveRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const name = useDisk((s) => s.items[id]?.name ?? '');
  return (
    <button type="button" onClick={() => onOpen(id)} className="flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover" data-testid="disk-move-folder">
      <Folder className="size-4 shrink-0 fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent" strokeWidth={1.5} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------- «Место», the player

/** «Место» (ADR-0094 §6): the meter with its legend and «Докупить место»; after a 413 — «Не хватает места». */
function UsageDialog({ workspaceId, full, onClose }: { workspaceId: string; full: boolean; onClose: () => void }): ReactNode {
  return (
    <Modal
      open
      onClose={onClose}
      initialFocus="body"
      title={full ? t('disk.usage.fullTitle') : t('disk.usage.title')}
      description={full ? t('disk.usage.fullText') : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button onClick={() => openBuyStorage(workspaceId)} data-testid="disk-buy-open">
            {t('disk.buy.title')}
          </Button>
        </>
      }
    >
      <div data-testid="disk-usage">
        <UsageMeter workspaceId={workspaceId} />
      </div>
    </Modal>
  );
}

function PreviewDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): ReactNode {
  const item = useDisk((s) => s.items[itemId]);
  if (!item?.file) return null;
  return (
    <Modal open onClose={onClose} wide initialFocus="body" title={item.name}>
      <div className="flex justify-center pb-1">
        <VideoAttachment f={item.file} />
      </div>
    </Modal>
  );
}

