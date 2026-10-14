import { timestampDate, timestampMs } from '@bufbuild/protobuf/wkt';
import { WIKI_BITS, type WikiVersion } from '@calaba/protocol';
import { ChevronRight, Copy, FileText } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Input, Modal, Segmented, Select, Spinner, Switch, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { diffable, diffBlocks, type DiffBlock } from '../../lib/textDiff';
import { docHandle } from '../../lib/wiki/docHandle';
import { ancestorsOf, childKey, isInSubtree, TOP } from '../../lib/wiki/tree';
import { loadChildren, movePage, restoreVersion, wikiApi } from '../../services/wiki';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWiki } from '../../stores/wiki';
import { useWikiUi, type WikiDialog } from '../../stores/wikiUi';
import { MemberAvatar } from '../boards/menus';
import { entryOf, TreeAccessEditor, useTreeAccess } from '../people/TreeAccess';

/**
 * The wiki's dialogs (ADR-0096 §5, §6): «Поделиться» (Доступ + Ссылка as tabs), «История версий»
 * (side-by-side diff against the live text, «Восстановить»), «Переместить». One host reads the
 * request from stores/wikiUi; each mounts only while open.
 */
export function WikiDialogs({ workspaceId }: { workspaceId: string }): ReactNode {
  const dialog = useWikiUi((s) => s.dialog);
  if (!dialog) return null;
  return <DialogBody dialog={dialog} workspaceId={workspaceId} onClose={closeDialog} />;
}

const closeDialog = (): void => useWikiUi.getState().openDialog(null);

function DialogBody({ dialog, workspaceId, onClose }: { dialog: WikiDialog; workspaceId: string; onClose: () => void }): ReactNode {
  switch (dialog.kind) {
    case 'share':
      return <ShareDialog pageId={dialog.pageId} tab={dialog.tab} onClose={onClose} />;
    case 'versions':
      return <VersionsDialog workspaceId={workspaceId} pageId={dialog.pageId} onClose={onClose} />;
    case 'move':
      return <MoveDialog workspaceId={workspaceId} pageId={dialog.pageId} onClose={onClose} />;
  }
}

// ---------------------------------------------------------------- «Поделиться»

const WIKI_TREE = { VIEW: WIKI_BITS.VIEW, WRITE: WIKI_BITS.WRITE };

type ShareTab = 'access' | 'link';

function ShareDialog({ pageId, tab: initial, onClose }: { pageId: string; tab: ShareTab; onClose: () => void }): ReactNode {
  useLocale();
  const page = useWiki((s) => s.pages[pageId]);
  const [tab, setTab] = useState<ShareTab>(initial);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => wikiApi.permissions(pageId), [pageId]);
  const access = useTreeAccess(load, WIKI_TREE, (e) => {
    toast.fail(e, t('wiki.err.access'));
    onClose();
  });
  if (!page) return null;
  const { drafts, restricted } = access;
  const save = (): void => {
    if (!drafts) return;
    setBusy(true);
    wikiApi
      .setPermissions(pageId, {
        entries: drafts.map((d) => entryOf(d, WIKI_TREE)),
        restricted,
      })
      .then(
        () => {
          const cur = useWiki.getState().pages[pageId];
          if (cur) useWiki.getState().upsert({ ...cur, restricted, shared: drafts.length > 0 });
          onClose();
        },
        (e: unknown) => {
          setBusy(false);
          toast.fail(e, t('wiki.err.access'));
        },
      );
  };
  return (
    <Modal
      open
      onClose={onClose}
      medium
      initialFocus="body"
      title={t('wiki.shareTitle', { name: page.title || t('wiki.untitled') })}
      footer={
        tab === 'access' ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={save} busy={busy} disabled={!drafts} data-testid="wiki-access-save">
              {t('common.save')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        )
      }
    >
      <div className="flex min-h-[340px] flex-col gap-4" data-testid="wiki-share-dialog">
        <Segmented<ShareTab>
          value={tab}
          label={t('wiki.share')}
          fill
          options={[
            { value: 'access', label: t('wiki.access') },
            { value: 'link', label: t('wiki.link') },
          ]}
          onChange={setTab}
          testId="wiki-share-tabs"
        />
        {tab === 'access' ? (
          <TreeAccessEditor
            workspaceId={page.workspaceId}
            ownerId={page.ownerId}
            access={access}
            hint={t('wiki.restrictedHint')}
            inherited={t('wiki.accessInherited')}
            footer={t('wiki.accessFooter')}
            testId="wiki-access"
          />
        ) : (
          <LinkPanel pageId={pageId} />
        )}
      </div>
    </Modal>
  );
}

const EXPIRY_DAYS = [0, 1, 7, 30] as const;
type Expiry = (typeof EXPIRY_DAYS)[number];

/** The page's public address `/w/{code}` on the server's origin (the answer's `url` when known). */
const publicUrl = (code: string): string => new URL(`/w/${code}`, useSession.getState().serverUrl || window.location.origin).toString();

/**
 * «Ссылка» (ADR-0096 §6): «Доступ по ссылке» (anyone with it reads the page without signing in),
 * «Вместе с подстраницами» (the public page lists the branch), the address with «Скопировать»,
 * the term (chosen before switching on), views. A live link is updated in place, keeping its code.
 */
function LinkPanel({ pageId }: { pageId: string }): ReactNode {
  const link = useWiki((s) => s.pages[pageId]?.link);
  const on = !!link;
  const [url, setUrl] = useState('');
  const [expiry, setExpiry] = useState<Expiry>(0);
  const [children, setChildren] = useState(link?.includeChildren ?? false);
  const [busy, setBusy] = useState(false);
  const address = url || (link ? publicUrl(link.code) : '');
  const apply = (p: { on: boolean; includeChildren: boolean }): void => {
    setBusy(true);
    const done = (): void => setBusy(false);
    const err = (e: unknown): void => {
      toast.fail(e, t('wiki.err.link'));
      done();
    };
    if (p.on) {
      const keep = link?.expiresAt ? timestampMs(link.expiresAt) : expiry ? Date.now() + expiry * 86_400_000 : undefined;
      wikiApi
        .createLink(pageId, {
          includeChildren: p.includeChildren,
          expiresAtMs: keep,
        })
        .then((r) => {
          setUrl(r.url);
          const cur = useWiki.getState().pages[pageId];
          if (cur && r.link) useWiki.getState().upsert({ ...cur, link: r.link });
          done();
        }, err);
    } else {
      wikiApi.deleteLink(pageId).then(() => {
        setUrl('');
        const cur = useWiki.getState().pages[pageId];
        if (cur) useWiki.getState().upsert({ ...cur, link: undefined });
        done();
      }, err);
    }
  };
  const until = link?.expiresAt ? timestampDate(link.expiresAt) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="wiki-link">
      <Switch checked={on} onChange={(v) => apply({ on: v, includeChildren: children })} label={t('wiki.link.on')} hint={t('wiki.link.hint')} disabled={busy} />
      <Switch
        checked={children}
        onChange={(v) => {
          setChildren(v);
          if (on) apply({ on: true, includeChildren: v });
        }}
        label={t('wiki.link.children')}
        hint={t('wiki.link.childrenHint')}
        disabled={busy}
      />
      {on ? (
        <>
          <div className="flex items-center gap-2">
            <Input readOnly value={address} aria-label={t('disk.link.address')} className="min-w-0 flex-1 text-ellipsis font-mono text-caption" onFocus={(e) => e.currentTarget.select()} data-testid="wiki-link-url" />
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={!address}
              onClick={() =>
                void navigator.clipboard.writeText(address).then(
                  () => toast.success(t('disk.link.copied')),
                  (e: unknown) => toast.fail(e),
                )
              }
              data-testid="wiki-link-copy"
            >
              <Copy className="size-3.5" aria-hidden />
              {t('disk.link.copyShort')}
            </Button>
          </div>
          <p className="text-caption text-muted">
            {until ? t('disk.link.until', { date: fmt.stamp(until) }) : t('disk.link.forever')}
            {' · '}
            {t('wiki.link.views', { n: link.views })}
          </p>
        </>
      ) : (
        <label className="flex items-center justify-between gap-4 text-body">
          <span>{t('disk.link.expiry')}</span>
          <span className="w-40">
            <Select value={String(expiry)} onChange={(e) => setExpiry(Number(e.target.value) as Expiry)} data-testid="wiki-link-expiry">
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
  );
}

// ---------------------------------------------------------------- «История версий»

// The tint carries the meaning; the text stays at full contrast on it (axe 4.5:1).
const DEL = 'rounded-[3px] bg-[color-mix(in_srgb,var(--color-red)_20%,transparent)] px-px text-fg line-through decoration-1';
const ADD = 'rounded-[3px] bg-[color-mix(in_srgb,var(--color-green)_20%,transparent)] px-px text-fg no-underline';

/**
 * «История версий» (ADR-0096 §5): the versions newest first (date, authors) on the left; the
 * picked one against the live text side by side — removed since in the version's column, added
 * since in the current one (lib/textDiff). «Восстановить» puts the version's content into the live
 * document as one edit (co-authors see it, the history stays linear).
 */
function VersionsDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }): ReactNode {
  useLocale();
  const title = useWiki((s) => s.pages[pageId]?.title ?? '');
  const [list, setList] = useState<WikiVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>('');
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchPage = useCallback(
    (from: string) => {
      wikiApi.versions(pageId, from || undefined).then(
        (r) => {
          setList((l) => [...l, ...r.versions]);
          setPicked((p) => p ?? r.versions[0]?.id ?? null);
          setCursor(r.nextCursor || null);
          setLoading(false);
        },
        (e: unknown) => {
          toast.fail(e, t('wiki.err.versions'));
          setCursor(null);
          setLoading(false);
        },
      );
    },
    [pageId],
  );
  useEffect(() => fetchPage(''), [fetchPage]);
  const version = list.find((v) => v.id === picked) ?? null;
  // Read once per pick (the live text at that moment).
  const current = useMemo(() => (picked ? (docHandle(pageId)?.text() ?? null) : null), [pageId, picked]);
  const writable = docHandle(pageId)?.writable() ?? false;
  return (
    <Modal
      open
      onClose={onClose}
      wide
      initialFocus="body"
      title={t('wiki.versionsTitle', { name: title || t('wiki.untitled') })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            disabled={!version || !writable}
            busy={busy}
            onClick={() => {
              if (!version) return;
              setBusy(true);
              void restoreVersion(pageId, version.id).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
            data-testid="wiki-version-restore"
          >
            {t('wiki.versions.restore')}
          </Button>
        </>
      }
    >
      <div className="flex h-[min(60vh,480px)] gap-3" data-testid="wiki-versions">
        <ol className="scrollbar-thin flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] p-1">
          {list.map((v) => (
            <VersionRow key={v.id} workspaceId={workspaceId} v={v} active={v.id === picked} onPick={setPicked} />
          ))}
          {loading ? (
            <li className="grid h-12 place-items-center">
              <Spinner />
            </li>
          ) : !list.length ? (
            <li className="px-2 py-3 text-caption text-muted">{t('wiki.versions.empty')}</li>
          ) : cursor ? (
            <li>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  fetchPage(cursor);
                }}
                className="h-7 rounded-full px-2.5 text-caption text-accent-text hover:bg-hover"
              >
                {t('boards.hist.more')}
              </button>
            </li>
          ) : null}
        </ol>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {version ? (
            <SideBySide before={version.plainText} after={current} />
          ) : (
            <div className="grid flex-1 place-items-center text-caption text-muted">{loading ? null : t('wiki.versions.pick')}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

const VersionRow = memo(function VersionRow({ workspaceId, v, active, onPick }: { workspaceId: string; v: WikiVersion; active: boolean; onPick: (id: string) => void }): ReactNode {
  const at = v.createdAt ? timestampDate(v.createdAt) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(v.id)}
        aria-pressed={active}
        className={cx('flex w-full flex-col gap-1 rounded-[var(--radius-row)] px-2 py-1.5 text-left', active ? 'bg-active' : 'hover:bg-hover')}
        data-testid="wiki-version-row"
      >
        <span className="text-body">{at ? fmt.dateTime(at, 'short') : '—'}</span>
        <span className="flex items-center -space-x-1">
          {v.authorIds.slice(0, 5).map((id) => (
            <span key={id} className="rounded-full ring-2 ring-[var(--color-card)]">
              <MemberAvatar workspaceId={workspaceId} userId={id} size={18} />
            </span>
          ))}
        </span>
      </button>
    </li>
  );
});

function SideBySide({ before, after }: { before: string; after: string | null }): ReactNode {
  const [only, setOnly] = useState(false);
  // Blocks first, words only inside changed blocks; the same normalisation on both sides.
  const diff = useMemo(() => (after !== null && diffable(before, after) ? diffBlocks(before, after) : null), [before, after]);
  const plain = (text: string): ReactNode => <p className="whitespace-pre-wrap break-words">{text.trim() || '—'}</p>;
  const col = (label: string, body: ReactNode, testId: string): ReactNode => (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      <h3 className="text-caption font-semibold text-muted">{label}</h3>
      <div tabIndex={0} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2 text-body" data-testid={testId}>
        {body}
      </div>
    </section>
  );
  const blocks = (list: DiffBlock[], mark: 'del' | 'add'): ReactNode => {
    const rows: ReactNode[] = [];
    let gap = false;
    list.forEach((b, i) => {
      if (only && !b.changed) {
        gap = rows.length > 0;
        return;
      }
      if (gap)
        rows.push(
          <div key={`g${i}`} className="text-center text-caption text-faint" aria-hidden>
            …
          </div>,
        );
      gap = false;
      rows.push(
        <p
          key={i}
          className={cx('whitespace-pre-wrap break-words border-l-2 py-0.5 pl-2', b.changed ? (mark === 'del' ? 'border-[var(--color-red)]' : 'border-[var(--color-green)]') : 'border-transparent')}
          data-changed={b.changed ? '' : undefined}
        >
          {b.ops.map((o, k) =>
            o.op === 'eq' ? (
              <span key={k}>{o.text}</span>
            ) : o.op === 'del' ? (
              <del key={k} className={DEL}>
                {o.text}
              </del>
            ) : (
              <ins key={k} className={ADD}>
                {o.text}
              </ins>
            ),
          )}
        </p>,
      );
    });
    return rows.length ? <div className="flex flex-col gap-1">{rows}</div> : <p className="text-muted">—</p>;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {diff ? <Switch checked={only} onChange={setOnly} label={t('wiki.versions.onlyChanges')} /> : null}
      <div className="flex min-h-0 flex-1 gap-3">
        {col(t('wiki.versions.version'), diff ? blocks(diff.before, 'del') : plain(before), 'wiki-version-before')}
        {col(t('wiki.versions.current'), after === null ? t('wiki.versions.noCurrent') : diff ? blocks(diff.after, 'add') : plain(after), 'wiki-version-after')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- «Переместить»

/**
 * «Переместить» (ADR-0096 §9): walks the tree from the page's parent — crumbs on top, the child
 * pages as rows (a click goes in), «Переместить сюда» puts the page last there. The page itself and
 * its subtree are not offered.
 */
function MoveDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }): ReactNode {
  useLocale();
  const page = useWiki((s) => s.pages[pageId]);
  const [at, setAt] = useState<string>(page?.parentId ?? TOP);
  const key = childKey(workspaceId, at);
  const rows = useWiki(useShallow((s) => (s.lists[key] ?? []).filter((id) => !isInSubtree(s.pages, id, pageId))));
  const loaded = useWiki((s) => !!s.lists[key]);
  const path = useWiki(useShallow((s) => (at ? [...ancestorsOf(s.pages, at), at] : [])));
  useEffect(() => {
    void loadChildren(workspaceId, at);
  }, [workspaceId, at]);
  if (!page) return null;
  const ok = at !== page.parentId && at !== pageId;
  return (
    <Modal
      open
      onClose={onClose}
      initialFocus="body"
      title={t('wiki.moveTitle', { name: page.title || t('wiki.untitled') })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ok}
            onClick={() => {
              onClose();
              const n = (useWiki.getState().lists[key] ?? []).filter((x) => x !== pageId).length;
              void movePage(pageId, at, n);
            }}
            data-testid="wiki-move-here"
          >
            {t('wiki.moveHere')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="wiki-move">
        <nav aria-label={t('wiki.path')} className="flex min-w-0 flex-wrap items-center gap-0.5 text-body">
          <MoveCrumb id={TOP} last={!path.length} onOpen={setAt} />
          {path.map((id, i) => (
            <span key={id} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight className="size-3.5 text-faint" aria-hidden />
              <MoveCrumb id={id} last={i === path.length - 1} onOpen={setAt} />
            </span>
          ))}
        </nav>
        <div tabIndex={-1} className="flex h-60 flex-col overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] p-1 outline-none">
          {!loaded ? (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          ) : rows.length ? (
            rows.map((id) => <MoveRow key={id} id={id} onOpen={setAt} />)
          ) : (
            <p className="grid flex-1 place-items-center text-caption text-muted">{t('wiki.noSubpages')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MoveCrumb({ id, last, onOpen }: { id: string; last: boolean; onOpen: (id: string) => void }): ReactNode {
  const title = useWiki((s) => (id ? (s.pages[id]?.title ?? '') : ''));
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className={cx('h-7 max-w-48 truncate rounded-[var(--radius-control)] px-1.5', last ? 'font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {id ? title || t('wiki.untitled') : t('wiki.section')}
    </button>
  );
}

function MoveRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  return (
    <button type="button" onClick={() => onOpen(id)} className="flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover" data-testid="wiki-move-row">
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        {icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{title || t('wiki.untitled')}</span>
      <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
    </button>
  );
}
