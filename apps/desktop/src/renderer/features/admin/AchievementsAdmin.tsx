import type { AdminAchievement, Achievement } from '@calaba/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, GripVertical, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, Field, Input, Spinner, Tip, cx } from '../../components/ui';
import { plural, t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { adminAchievementsApi } from '../../lib/api/endpoints';
import { errorText, recentAuthRequired } from '../../lib/api/errors';
import { invalidateCatalog } from '../../lib/achievementCatalog';
import { movePositions } from '../../lib/achievements';
import { ACH_ACCEPT, prepareAchievementImage, type AchievementReject } from '../../lib/achievementPrepare';
import { useAchievementUi } from '../../stores/achievementUi';
import { toast } from '../../stores/toasts';
import { AchievementImg } from '../people/AchievementImg';

/**
 * Superadmin «Ачивки» (ADR-0061 §3, §5, docs/08 «Ачивки»): the host catalog. The left column lists
 * it by position (picture 40, title, «вручена N раз в M пространствах», drag to reorder → PATCH
 * position), «Добавить» on top; the right pane edits the chosen one (title, description, replace
 * the picture, archive, delete — disabled once granted) or adds a new one (a drop zone for a PNG /
 * WebP with a transparent background, checked on the client: lib/achievementPrepare). Every
 * picture is previewed on a light and a dark background at once.
 */

export const ADMIN_ACH_KEY = ['admin', 'achievements'] as const;
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 200;

const REJECT: Record<AchievementReject, MessageKey> = {
  unsupported: 'ach.admin.reject.unsupported',
  tooHeavy: 'ach.admin.reject.tooHeavy',
  sides: 'ach.admin.reject.sides',
  broken: 'ach.admin.reject.broken',
};

function adminError(e: unknown): string {
  if (e instanceof ApiError && e.reason === 'IMAGE_NEEDS_ALPHA') return t('ach.admin.needAlpha');
  if (e instanceof ApiError && e.reason === 'ACHIEVEMENT_IN_USE') return t('ach.admin.deleteInUse');
  return errorText(e, t('err.ctx.save'));
}

export function useAdminAchievements() {
  return useQuery({ queryKey: ADMIN_ACH_KEY, queryFn: ({ signal }) => adminAchievementsApi.list(signal), retry: false });
}

/** After a change: the admin list and everyone's catalog cache (the ETag changed). */
function refresh(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ADMIN_ACH_KEY });
  invalidateCatalog();
}

const statsLine = (a: AdminAchievement): string =>
  a.grantedCount ? `${plural('ach.admin.granted', a.grantedCount)} ${plural('ach.admin.inWs', a.workspacesCount)}` : t('ach.admin.notGranted');

// ---------------------------------------------------------------- the list (left column)

export function AchievementsSide({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }): ReactNode {
  const qc = useQueryClient();
  const q = useAdminAchievements();
  const items = q.data?.achievements ?? [];
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const drop = async (to: number): Promise<void> => {
    const from = drag;
    setDrag(null);
    setOver(null);
    if (from === null) return;
    const list = items.map((x) => ({ id: x.achievement?.id ?? '', position: x.achievement?.position ?? 0 }));
    const changes = movePositions(list, from, to);
    if (!changes.length) return;
    // Optimistic order; the refetch brings the server's.
    qc.setQueryData(ADMIN_ACH_KEY, (d: typeof q.data) => {
      if (!d) return d;
      const next = [...d.achievements];
      const [m] = next.splice(from, 1);
      if (m) next.splice(to, 0, m);
      return { ...d, achievements: next };
    });
    try {
      for (const c of changes) await adminAchievementsApi.update(c.id, { position: c.position });
    } catch (e) {
      toast.error(adminError(e));
    } finally {
      refresh(qc);
    }
  };
  return (
    <>
      <Button variant="secondary" className="mx-1 justify-start" onClick={() => onSelect('new')} data-testid="admin-ach-add">
        <Plus className="size-3.5" aria-hidden />
        {t('ach.admin.add')}
      </Button>
      <div role="listbox" aria-label={t('admin.tab.achievements')} className="-mx-0.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-0.5 pb-1" data-testid="admin-ach-list">
        {q.isLoading ? <Spinner className="mx-auto mt-6" /> : null}
        {q.isError && !recentAuthRequired(q.error) ? <p className="px-2 py-3 text-body text-danger-text">{t('admin.loadFailed')}</p> : null}
        {q.isSuccess && items.length === 0 ? <p className="px-2 py-3 text-body text-muted">{t('ach.admin.empty')}</p> : null}
        {items.map((x, i) =>
          x.achievement ? (
            <Row
              key={x.achievement.id}
              x={x}
              index={i}
              selected={x.achievement.id === selected}
              dropTarget={over === i && drag !== null && drag !== i}
              onSelect={onSelect}
              onDragStart={setDrag}
              onDragOver={setOver}
              onDrop={(to) => void drop(to)}
            />
          ) : null,
        )}
      </div>
    </>
  );
}

const Row = memo(function Row({
  x,
  index,
  selected,
  dropTarget,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  x: AdminAchievement;
  index: number;
  selected: boolean;
  dropTarget: boolean;
  onSelect: (id: string) => void;
  onDragStart: (i: number) => void;
  onDragOver: (i: number) => void;
  onDrop: (i: number) => void;
}): ReactNode {
  const a = x.achievement;
  if (!a) return null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      onClick={() => onSelect(a.id)}
      data-testid="admin-achievement"
      className={cx(
        'group flex w-full items-center gap-2 rounded-[var(--radius-card)] py-1.5 pl-1 pr-3 text-left transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-accent-strong text-accent-fg' : 'hover:bg-hover',
        dropTarget && 'shadow-[inset_0_2px_0_var(--color-accent)]',
        a.archivedAt && !selected && 'opacity-60',
      )}
    >
      <GripVertical className={cx('size-3.5 shrink-0 cursor-grab', selected ? 'text-accent-fg' : 'text-faint')} aria-label={t('ach.admin.drag', { title: a.title })} />
      <AchievementImg achievement={a} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-semibold" title={a.title}>
            {a.title}
          </span>
          {a.archivedAt ? <span className={cx('shrink-0 text-micro font-semibold', selected ? 'text-accent-fg' : 'text-muted')}>{t('ach.admin.archivedBadge')}</span> : null}
        </span>
        <span className={cx('truncate text-caption', selected ? 'text-accent-fg' : 'text-muted')}>{a.description || '—'}</span>
        <span className={cx('truncate text-caption', selected ? 'text-accent-fg' : 'text-faint')}>{statsLine(x)}</span>
      </span>
    </button>
  );
});

// ---------------------------------------------------------------- the pane (right)

/** A picked picture: the file, its local preview URL and the client check's warning. */
interface Picked {
  blob: Blob;
  name: string;
  url: string;
  opaque: boolean;
}

function usePicker(): { picked: Picked | null; error: string | null; pick: (f: File | undefined) => void; clear: () => void } {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => (picked ? URL.revokeObjectURL(picked.url) : undefined), [picked]);
  const pick = (f: File | undefined): void => {
    if (!f) return;
    setError(null);
    void prepareAchievementImage(f).then((r) => {
      if (!r.ok) {
        setError(t(REJECT[r.reason]));
        return;
      }
      setPicked({ blob: r.file, name: r.name, url: URL.createObjectURL(r.file), opaque: r.opaque });
    });
  };
  return { picked, error, pick, clear: () => setPicked(null) };
}

/** The drop zone / file button; shows the warning of the client alpha check. */
function DropZone({ onFile, compact, label }: { onFile: (f: File | undefined) => void; compact?: boolean; label: string }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setHover(false);
    onFile(e.dataTransfer.files[0]);
  };
  return (
    <>
      <input ref={input} type="file" accept={ACH_ACCEPT} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="admin-ach-file" />
      {compact ? (
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <ImagePlus className="size-3.5" aria-hidden />
          {label}
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setHover(true);
          }}
          onDragLeave={() => setHover(false)}
          onDrop={onDrop}
          data-testid="admin-ach-drop"
          className={cx(
            'flex w-full flex-col items-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed px-4 py-6 text-center text-body text-muted transition-colors duration-[var(--motion-fast)]',
            hover ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] text-fg' : 'border-line hover:bg-hover',
          )}
        >
          <ImagePlus className="size-6" aria-hidden />
          <span>{label}</span>
          <span className="text-caption text-faint">{t('ach.admin.dropHint')}</span>
        </button>
      )}
    </>
  );
}

/** The picture on a light and a dark background side by side (as the owner's index.html). */
function Preview({ achievement, url, onOpen }: { achievement?: Achievement | undefined; url?: string | undefined; onOpen?: () => void }): ReactNode {
  const img = (size: number): ReactNode =>
    url ? <img src={url} alt="" width={size} height={size} className="achievement-img object-contain" style={{ width: size, height: size }} /> : <AchievementImg achievement={achievement} size={size} />;
  const box = 'grid h-[136px] flex-1 place-items-center rounded-[var(--radius-card)] border border-line';
  const content = (
    <div className="flex w-full gap-2" aria-label={t('ach.admin.preview')}>
      <div className={cx(box, 'achievement-preview-light')} title={t('ach.admin.light')}>
        {img(96)}
      </div>
      <div className={cx(box, 'achievement-preview-dark')} title={t('ach.admin.dark')}>
        {img(96)}
      </div>
    </div>
  );
  return onOpen ? (
    <button type="button" className="w-full rounded-[var(--radius-card)]" onClick={onOpen} aria-label={t('ach.view.open', { title: achievement?.title ?? '' })}>
      {content}
    </button>
  ) : (
    content
  );
}

export function AchievementsPane({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }): ReactNode {
  const q = useAdminAchievements();
  if (selected === 'new') return <NewAchievement onCreated={(id) => onSelect(id)} />;
  const x = q.data?.achievements.find((it) => it.achievement?.id === selected);
  if (!selected || !x?.achievement) {
    return <div className="grid flex-1 place-items-center">{q.isLoading ? <Spinner /> : <Empty>{t('ach.admin.pick')}</Empty>}</div>;
  }
  return <EditAchievement key={x.achievement.id} x={x} onDeleted={() => onSelect(null)} />;
}

function NewAchievement({ onCreated }: { onCreated: (id: string) => void }): ReactNode {
  const qc = useQueryClient();
  const img = usePicker();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!img.picked && title.trim().length > 0 && !busy;
  const create = async (): Promise<void> => {
    if (!img.picked || !ok) return;
    setBusy(true);
    setError(null);
    try {
      const a = await adminAchievementsApi.create({ title: title.trim(), description: description.trim(), image: { blob: img.picked.blob, name: img.picked.name } });
      refresh(qc);
      toast.success(t('ach.admin.created'));
      onCreated(a.id);
    } catch (e) {
      setError(adminError(e));
      setBusy(false);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 mobile:px-4" data-testid="admin-ach-new">
      <div className="mx-auto flex max-w-[640px] flex-col gap-4">
        {img.picked ? <Preview url={img.picked.url} /> : null}
        <DropZone onFile={img.pick} compact={!!img.picked} label={img.picked ? t('ach.admin.replace') : t('ach.admin.drop')} />
        {img.error ? (
          <p role="alert" className="text-caption text-danger-text">
            {img.error}
          </p>
        ) : img.picked?.opaque ? (
          <p role="status" className="text-caption text-attention">
            {t('ach.admin.opaque')}
          </p>
        ) : null}
        <Fields title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
        <div className="flex items-center justify-end gap-3">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </span>
          ) : null}
          <Button disabled={!ok} busy={busy} onClick={() => void create()} data-testid="admin-ach-create">
            {t('ach.admin.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fields({ title, description, onTitle, onDescription }: { title: string; description: string; onTitle: (v: string) => void; onDescription: (v: string) => void }): ReactNode {
  return (
    <>
      <Field label={t('ach.admin.title')}>
        <Input value={title} maxLength={TITLE_MAX} onChange={(e) => onTitle(e.target.value)} data-testid="admin-ach-title" />
      </Field>
      <Field label={t('ach.admin.description')} hint={`${description.length}/${DESCRIPTION_MAX}`}>
        <textarea
          value={description}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          onChange={(e) => onDescription(e.target.value)}
          className="selectable w-full resize-none rounded-[var(--radius-control)] border border-line bg-elev px-2 py-1.5 text-body text-fg shadow-[var(--shadow-card)] outline-none placeholder:text-muted focus:border-[var(--color-focus)]"
        />
      </Field>
    </>
  );
}

function EditAchievement({ x, onDeleted }: { x: AdminAchievement; onDeleted: () => void }): ReactNode {
  const qc = useQueryClient();
  const a = x.achievement;
  const img = usePicker();
  const [title, setTitle] = useState(a?.title ?? '');
  const [description, setDescription] = useState(a?.description ?? '');
  const [busy, setBusy] = useState<'save' | 'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!a) return null;
  const dirty = title.trim() !== a.title || description.trim() !== a.description || !!img.picked;
  const run = async (what: 'save' | 'archive' | 'delete', job: () => Promise<unknown>, done: MessageKey): Promise<boolean> => {
    setBusy(what);
    setError(null);
    try {
      await job();
      refresh(qc);
      toast.success(t(done));
      return true;
    } catch (e) {
      setError(adminError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const save = (): void =>
    void run(
      'save',
      () =>
        adminAchievementsApi.update(a.id, {
          ...(title.trim() !== a.title ? { title: title.trim() } : {}),
          ...(description.trim() !== a.description ? { description: description.trim() } : {}),
          ...(img.picked ? { image: { blob: img.picked.blob, name: img.picked.name } } : {}),
        }),
      'admin.saved',
    ).then((ok) => ok && img.clear());
  const archive = (): void => void run('archive', () => adminAchievementsApi.update(a.id, { archived: !a.archivedAt }), a.archivedAt ? 'ach.admin.unarchived' : 'ach.admin.archived');
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('ach.admin.deleteTitle'), t('ach.admin.deleteText', { title: a.title }), t('common.delete')))) return;
    if (await run('delete', () => adminAchievementsApi.remove(a.id), 'ach.admin.deleted')) onDeleted();
  };
  const granted = x.grantedCount > 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 mobile:px-4" data-testid="admin-ach-edit">
      <div className="mx-auto flex max-w-[640px] flex-col gap-4">
        <Preview achievement={a} url={img.picked?.url} onOpen={img.picked ? undefined : () => useAchievementUi.getState().openView({ achievementId: a.id })} />
        <div className="flex flex-wrap items-center gap-2">
          <DropZone onFile={img.pick} compact label={t('ach.admin.replace')} />
          <span className="text-caption text-muted">{statsLine(x)}</span>
        </div>
        {img.error ? (
          <p role="alert" className="text-caption text-danger-text">
            {img.error}
          </p>
        ) : img.picked?.opaque ? (
          <p role="status" className="text-caption text-attention">
            {t('ach.admin.opaque')}
          </p>
        ) : null}
        <Fields title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
        <div className="flex items-center justify-end gap-3">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </span>
          ) : null}
          <Button disabled={!dirty || !title.trim()} busy={busy === 'save'} onClick={save} data-testid="admin-ach-save">
            {t('admin.save')}
          </Button>
        </div>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-body text-muted">{a.archivedAt ? t('ach.admin.archivedHint') : t('ach.admin.archiveHint')}</span>
            <Button variant="secondary" busy={busy === 'archive'} onClick={archive} data-testid="admin-ach-archive">
              {a.archivedAt ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
              {a.archivedAt ? t('ach.admin.unarchive') : t('ach.admin.archive')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-body text-muted">{t('ach.admin.deleteHint')}</span>
            {granted ? (
              <Tip label={t('ach.admin.deleteInUse')}>
                {/* A disabled button gets no pointer events: the tooltip sits on its wrapper. */}
                <span tabIndex={0} className="rounded-[var(--radius-control)]">
                  <Button variant="destructive" disabled className="pointer-events-none" data-testid="admin-ach-delete">
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('common.delete')}
                  </Button>
                </span>
              </Tip>
            ) : (
              <Button variant="destructive" busy={busy === 'delete'} onClick={() => void remove()} data-testid="admin-ach-delete">
                <Trash2 className="size-3.5" aria-hidden />
                {t('common.delete')}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
