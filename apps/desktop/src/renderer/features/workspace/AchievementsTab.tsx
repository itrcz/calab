import type { Achievement, ListAchievementsResponse } from '@calaba/protocol';
import { Archive, ArchiveRestore, GripVertical, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, Field, Input, Spinner, Tip, cx } from '../../components/ui';
import { plural, t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { catalogKey, invalidateCatalog, useAchievementCatalogQuery } from '../../lib/achievementCatalog';
import { movePositions } from '../../lib/achievements';
import { ACH_ACCEPT, prepareAchievementImage, type AchievementReject } from '../../lib/achievementPrepare';
import { queryClient } from '../../lib/queryClient';
import { reportPlanError } from '../../services/plan';
import { useAchievementUi } from '../../stores/achievementUi';
import { toast } from '../../stores/toasts';
import { AchievementImg } from '../people/AchievementImg';

/**
 * «Настройки пространства → Библиотека → Ачивки» (ADR-0061 amendment 1, docs/08 «Ачивки»;
 * MANAGE_WORKSPACE): the workspace's catalog. A list by position (picture 40, title, description,
 * «Вручена N раз», drag the grip to reorder → PATCH position); a click on a row opens its editor
 * under it (title, description, replace the picture, archive, delete — disabled once granted);
 * «Добавить» opens a drop zone for a PNG / WebP with a transparent background (checked on the
 * client: lib/achievementPrepare), uploaded to the workspace and created with its file id. Every
 * picture is previewed on a light and a dark background at once.
 */

/** At most this many achievements per workspace (the server answers 409 ACHIEVEMENT_LIMIT). */
export const MAX_ACHIEVEMENTS = 100;
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 200;

const REJECT: Record<AchievementReject, MessageKey> = {
  unsupported: 'ach.cat.reject.unsupported',
  tooHeavy: 'ach.cat.reject.tooHeavy',
  sides: 'ach.cat.reject.sides',
  broken: 'ach.cat.reject.broken',
};

/** The error line of a failed change; null when the plan dialog already explained it (quota). */
function catalogError(e: unknown, workspaceId: string): string | null {
  if (e instanceof ApiError && e.reason === 'IMAGE_NEEDS_ALPHA') return t('ach.cat.needAlpha');
  if (e instanceof ApiError && e.reason === 'ACHIEVEMENT_IN_USE') return t('ach.cat.deleteInUse');
  if (e instanceof ApiError && e.reason === 'ACHIEVEMENT_LIMIT') return t('ach.cat.limit', { n: MAX_ACHIEVEMENTS });
  if (reportPlanError(e, workspaceId)) return null;
  return errorText(e, t('err.ctx.save'));
}

const statsLine = (a: Achievement): string => (a.grantedCount ? plural('ach.cat.granted', a.grantedCount) : t('ach.cat.notGranted'));

/** A picked picture: the prepared file, its local preview URL and the client check's warning. */
interface Picked {
  blob: Blob;
  name: string;
  url: string;
  opaque: boolean;
}

/** Uploads the picked picture to the workspace (its quota); the file id. */
async function uploadPicture(workspaceId: string, p: Picked): Promise<string> {
  const meta = await uploadFile(uploadPath(workspaceId, ''), p.blob, p.name, () => undefined).promise;
  return meta.id;
}

export function AchievementsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useAchievementCatalogQuery(workspaceId);
  const items = q.data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const full = items.length >= MAX_ACHIEVEMENTS;

  // Drag to reorder: the dragged index in a ref (rows keep stable callbacks), the drop target in state.
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const onDragStart = useCallback((i: number) => {
    drag.current = i;
  }, []);
  const onDragOver = useCallback((i: number) => setOver((o) => (o === i ? o : i)), []);
  const onDragEnd = useCallback(() => {
    drag.current = null;
    setOver(null);
  }, []);
  const onDrop = useCallback(
    (to: number) => {
      const from = drag.current;
      drag.current = null;
      setOver(null);
      if (from === null) return;
      const changes = movePositions(queryClient.getQueryData<ListAchievementsResponse>(catalogKey(workspaceId))?.achievements ?? [], from, to);
      if (!changes.length) return;
      // Optimistic order; the refetch brings the server's.
      queryClient.setQueryData<ListAchievementsResponse>(catalogKey(workspaceId), (d) => {
        if (!d) return d;
        const next = [...d.achievements];
        const [m] = next.splice(from, 1);
        if (m) next.splice(to, 0, m);
        return { ...d, achievements: next };
      });
      void (async () => {
        try {
          for (const c of changes) await api.achievements.update(c.id, { position: c.position });
        } catch (e) {
          const msg = catalogError(e, workspaceId);
          if (msg) toast.error(msg);
        } finally {
          invalidateCatalog(workspaceId);
        }
      })();
    },
    [workspaceId],
  );
  const toggle = useCallback((id: string) => setOpen((o) => (o === id ? null : id)), []);

  const add = (
    <Button onClick={() => setAdding(true)} disabled={full || adding} data-testid="ach-add">
      <Plus className="size-4" aria-hidden /> {t('ach.cat.add')}
    </Button>
  );
  if (q.isPending) return <Spinner className="mx-auto mt-6" />;
  if (q.isError) return <p className="text-body text-danger-text">{errorText(q.error)}</p>;
  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{full ? t('ach.cat.limit', { n: MAX_ACHIEVEMENTS }) : t('ach.cat.hint')}</p>
        {items.length > 0 ? add : null}
      </div>
      {adding ? (
        <NewAchievement
          workspaceId={workspaceId}
          onDone={(id) => {
            setAdding(false);
            if (id) setOpen(id);
          }}
        />
      ) : null}
      {items.length > 0 ? (
        <Card title={t('ach.cat.count', { n: items.length, max: MAX_ACHIEVEMENTS })}>
          <div role="list" data-testid="ach-list" onDragLeave={(e) => (e.currentTarget.contains(e.relatedTarget as Node | null) ? undefined : setOver(null))}>
            {items.map((a, i) => (
              <div key={a.id} role="listitem" className="border-b border-[var(--color-card-line)] last:border-b-0">
                <Row
                  a={a}
                  index={i}
                  open={a.id === open}
                  dropTarget={over === i}
                  onToggle={toggle}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDragEnd={onDragEnd}
                  onDrop={onDrop}
                />
                {a.id === open ? <EditAchievement key={a.id} workspaceId={workspaceId} a={a} onDeleted={() => setOpen(null)} /> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : adding ? null : (
        <Empty action={add}>{t('ach.cat.empty')}</Empty>
      )}
    </>
  );
}

const Row = memo(function Row({
  a,
  index,
  open,
  dropTarget,
  onToggle,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  a: Achievement;
  index: number;
  open: boolean;
  dropTarget: boolean;
  onToggle: (id: string) => void;
  onDragStart: (i: number) => void;
  onDragOver: (i: number) => void;
  onDragEnd: () => void;
  onDrop: (i: number) => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-expanded={open}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(index);
      }}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      onClick={() => onToggle(a.id)}
      data-testid="ws-achievement"
      className={cx(
        'flex w-full items-center gap-2 py-1.5 pl-1 pr-3 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover',
        open && 'bg-hover',
        dropTarget && 'shadow-[inset_0_2px_0_var(--color-accent)]',
      )}
    >
      <GripVertical className="size-3.5 shrink-0 cursor-grab text-faint" aria-label={t('ach.cat.drag', { title: a.title })} />
      <AchievementImg achievement={a} size={40} className={a.archivedAt ? 'opacity-60' : undefined} />
      <span className={cx('flex min-w-0 flex-1 flex-col', a.archivedAt && 'opacity-60')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-semibold" title={a.title}>
            {a.title}
          </span>
          {a.archivedAt ? <span className="shrink-0 text-micro font-semibold text-muted">{t('ach.cat.archivedBadge')}</span> : null}
        </span>
        <span className="truncate text-caption text-muted">{a.description || '—'}</span>
      </span>
      <span className="shrink-0 text-caption text-faint">{statsLine(a)}</span>
    </button>
  );
});

// ---------------------------------------------------------------- the editors

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

/** The drop zone / file button. */
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
      <input
        ref={input}
        type="file"
        accept={ACH_ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
        data-testid="ach-file"
      />
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
          data-testid="ach-drop"
          className={cx(
            'flex w-full flex-col items-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed px-4 py-6 text-center text-body text-muted transition-colors duration-[var(--motion-fast)]',
            hover ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] text-fg' : 'border-line hover:bg-hover',
          )}
        >
          <ImagePlus className="size-6" aria-hidden />
          <span>{label}</span>
          <span className="text-caption text-faint">{t('ach.cat.dropHint')}</span>
        </button>
      )}
    </>
  );
}

/** The client check's message under the picker. */
function PickNote({ error, opaque }: { error: string | null; opaque: boolean }): ReactNode {
  if (error) {
    return (
      <p role="alert" className="text-caption text-danger-text">
        {error}
      </p>
    );
  }
  return opaque ? (
    <p role="status" className="text-caption text-attention">
      {t('ach.cat.opaque')}
    </p>
  ) : null;
}

/** The picture on a light and a dark background side by side. */
function Preview({ achievement, url, onOpen }: { achievement?: Achievement | undefined; url?: string | undefined; onOpen?: (() => void) | undefined }): ReactNode {
  const img = url ? (
    <img src={url} alt="" width={96} height={96} className="achievement-img object-contain" style={{ width: 96, height: 96 }} />
  ) : (
    <AchievementImg achievement={achievement} size={96} />
  );
  const box = 'grid h-[136px] flex-1 place-items-center rounded-[var(--radius-card)] border border-line';
  const content = (
    <div className="flex w-full gap-2" aria-label={t('ach.cat.preview')}>
      <div className={cx(box, 'achievement-preview-light')} title={t('ach.cat.light')}>
        {img}
      </div>
      <div className={cx(box, 'achievement-preview-dark')} title={t('ach.cat.dark')}>
        {img}
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

function Fields({ title, description, onTitle, onDescription }: { title: string; description: string; onTitle: (v: string) => void; onDescription: (v: string) => void }): ReactNode {
  return (
    <>
      <Field label={t('ach.cat.title')}>
        <Input value={title} maxLength={TITLE_MAX} onChange={(e) => onTitle(e.target.value)} data-testid="ach-title" />
      </Field>
      <Field label={t('ach.cat.description')} hint={`${description.length}/${DESCRIPTION_MAX}`}>
        <textarea
          value={description}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          onChange={(e) => onDescription(e.target.value)}
          className="selectable min-h-[72px] w-full resize-none rounded-[12px] bg-input px-3 py-2 text-body text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent"
        />
      </Field>
    </>
  );
}

/** «Новая ачивка»: the drop zone (then the preview), title, description, «Добавить». */
function NewAchievement({ workspaceId, onDone }: { workspaceId: string; onDone: (id: string | null) => void }): ReactNode {
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
      const fileId = await uploadPicture(workspaceId, img.picked);
      const a = await api.achievements.create(workspaceId, { title: title.trim(), description: description.trim(), fileId });
      invalidateCatalog(workspaceId);
      toast.success(t('ach.cat.created'));
      onDone(a.id);
    } catch (e) {
      setError(catalogError(e, workspaceId));
      setBusy(false);
    }
  };
  return (
    <Card title={t('ach.cat.new')}>
      <div className="flex flex-col gap-4 px-3 py-3" data-testid="ach-new">
        {img.picked ? <Preview url={img.picked.url} /> : null}
        <DropZone onFile={img.pick} compact={!!img.picked} label={img.picked ? t('ach.cat.replace') : t('ach.cat.drop')} />
        <PickNote error={img.error} opaque={!!img.picked?.opaque} />
        <Fields title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
        <div className="flex items-center justify-end gap-2">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </span>
          ) : null}
          <Button variant="secondary" onClick={() => onDone(null)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ok} busy={busy} onClick={() => void create()} data-testid="ach-create">
            {t('ach.cat.create')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** The editor under an open row. */
function EditAchievement({ workspaceId, a, onDeleted }: { workspaceId: string; a: Achievement; onDeleted: () => void }): ReactNode {
  const img = usePicker();
  const [title, setTitle] = useState(a.title);
  const [description, setDescription] = useState(a.description);
  const [busy, setBusy] = useState<'save' | 'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = title.trim() !== a.title || description.trim() !== a.description || !!img.picked;
  const run = async (what: 'save' | 'archive' | 'delete', job: () => Promise<unknown>, done: MessageKey): Promise<boolean> => {
    setBusy(what);
    setError(null);
    try {
      await job();
      invalidateCatalog(workspaceId);
      toast.success(t(done));
      return true;
    } catch (e) {
      setError(catalogError(e, workspaceId));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const save = (): void =>
    void run(
      'save',
      async () => {
        const fileId = img.picked ? await uploadPicture(workspaceId, img.picked) : undefined;
        return api.achievements.update(a.id, {
          ...(title.trim() !== a.title ? { title: title.trim() } : {}),
          ...(description.trim() !== a.description ? { description: description.trim() } : {}),
          ...(fileId ? { fileId } : {}),
        });
      },
      'common.saved',
    ).then((ok) => ok && img.clear());
  const archive = (): void => void run('archive', () => api.achievements.update(a.id, { archived: !a.archivedAt }), a.archivedAt ? 'ach.cat.unarchived' : 'ach.cat.archived');
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('ach.cat.deleteTitle'), t('ach.cat.deleteText', { title: a.title }), t('common.delete')))) return;
    if (await run('delete', () => api.achievements.remove(a.id), 'ach.cat.deleted')) onDeleted();
  };
  const view = img.picked ? undefined : () => useAchievementUi.getState().openView({ achievementId: a.id, workspaceId });
  return (
    <div className="flex flex-col gap-4 px-3 pb-4 pt-2" data-testid="ach-edit">
      <Preview achievement={a} url={img.picked?.url} onOpen={view} />
      <div className="flex flex-wrap items-center gap-2">
        <DropZone onFile={img.pick} compact label={t('ach.cat.replace')} />
        <span className="text-caption text-muted">{statsLine(a)}</span>
      </div>
      <PickNote error={img.error} opaque={!!img.picked?.opaque} />
      <Fields title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
      <div className="flex items-center justify-end gap-3">
        {error ? (
          <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
            {error}
          </span>
        ) : null}
        <Button disabled={!dirty || !title.trim()} busy={busy === 'save'} onClick={save} data-testid="ach-save">
          {t('common.save')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-caption text-muted">{a.archivedAt ? t('ach.cat.archivedHint') : t('ach.cat.archiveHint')}</span>
        <Button variant="secondary" busy={busy === 'archive'} onClick={archive} data-testid="ach-archive">
          {a.archivedAt ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
          {a.archivedAt ? t('ach.cat.unarchive') : t('ach.cat.archive')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-caption text-muted">{t('ach.cat.deleteHint')}</span>
        {a.inUse ? (
          <Tip label={t('ach.cat.deleteInUse')}>
            {/* A disabled button gets no pointer events: the tooltip sits on its wrapper. */}
            <span tabIndex={0} className="rounded-[var(--radius-control)]">
              <Button variant="destructive" disabled className="pointer-events-none" data-testid="ach-delete">
                <Trash2 className="size-3.5" aria-hidden />
                {t('common.delete')}
              </Button>
            </span>
          </Tip>
        ) : (
          <Button variant="destructive" busy={busy === 'delete'} onClick={() => void remove()} data-testid="ach-delete">
            <Trash2 className="size-3.5" aria-hidden />
            {t('common.delete')}
          </Button>
        )}
      </div>
    </div>
  );
}
