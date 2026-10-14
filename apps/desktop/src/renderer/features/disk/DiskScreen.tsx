import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { DISK_BITS, diskPermissions, WorkspaceRole } from '@calaba/protocol';
import { CircleAlert, Upload, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { canWrite } from '../../lib/disk';
import { loadListing, loadPath, moveItems, trashItems, uploadFiles } from '../../services/disk';
import { useDisk, useDiskUploads } from '../../stores/disk';
import { folderOf, useDiskUi } from '../../stores/diskUi';
import { myUserId } from '../../stores/session';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { useFileDrop } from '../chat/useFileDrop';
import { DiskBar } from './DiskBar';
import { DiskListing, DragChip, DropTarget } from './DiskItems';
import { DiskDialogs } from './Dialogs';
import { UsageMeter } from './UsageMeter';

/**
 * «Диск» on the desktop (ADR-0094 §8, docs/08 «Диск»): one panel in place of the column and the
 * centre — the header (crumbs, search, view, sort, «+», «⋯»), the listing of the open folder or
 * the trash, the storage meter in the footer, the uploads card. System files dropped anywhere on
 * the listing go up into the open folder (onto a folder tile — into that folder); items are
 * dragged with the mouse onto a folder or a crumb. Mounted only while the section is open: a
 * hidden section has no subscriptions and no timers.
 */
export function DiskScreen({ workspaceId }: { workspaceId: string }): ReactNode {
  const folderId = useDiskUi((s) => folderOf(s, workspaceId));
  const trash = useDiskUi((s) => !!s.trashOf[workspaceId]);
  const roles = useMemberRoles(workspaceId, myUserId());
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  const wsBits = diskPermissions(roles, { guest });
  // In a folder its own bits (the server's); at the root the workspace's.
  const folderBits = useDisk((s) => (folderId ? (s.items[folderId]?.myBits ?? 0n) : wsBits));
  const write = canWrite(folderBits);
  const manage = (wsBits & DISK_BITS.MANAGE) !== 0n;

  useEffect(() => {
    void loadListing(workspaceId, folderId, trash);
    if (!trash) void loadPath(folderId);
  }, [workspaceId, folderId, trash]);

  // System files: into the folder tile under the pointer, else the open folder.
  const dropTarget = useRef<string | null>(null);
  const onFiles = useCallback(
    (files: File[]) => {
      const into = dropTarget.current ?? folderId;
      dropTarget.current = null;
      if (files.length) uploadFiles(workspaceId, into, files);
    },
    [workspaceId, folderId],
  );
  const [dragging, dropHandlers] = useFileDrop(write && !trash, onFiles);

  // Mouse drags of items (6 px, as the room list): onto a folder tile or a crumb.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<string | null>(null);
  const onDragStart = (e: DragStartEvent): void => setDragged(String(e.active.id));
  const onDragEnd = (e: DragEndEvent): void => {
    setDragged(null);
    const target = (e.over?.data.current as { folderId?: string } | undefined)?.folderId;
    const id = String(e.active.id);
    if (target === undefined || target === id) return;
    void moveItems([id], target);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const sel = useDiskUi.getState().selected;
    if (e.key === 'Escape' && sel) {
      useDiskUi.getState().select(null);
      return;
    }
    if (!sel || trash || useDiskUi.getState().renaming) return;
    if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      const it = useDisk.getState().items[sel];
      if (it && canWrite(it.myBits)) {
        e.preventDefault();
        void trashItems([sel]);
      }
    }
  };

  return (
    <DropTarget.Provider value={dropTarget}>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragged(null)}>
        <section className="mat-content relative flex min-w-0 flex-1 flex-col" aria-label={t('disk.section')} data-testid="disk">
          <DiskBar workspaceId={workspaceId} folderId={folderId} trash={trash} write={write} manage={manage} />
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
            onClick={() => useDiskUi.getState().select(null)}
            onKeyDown={onKeyDown}
            {...dropHandlers}
            data-testid="disk-area"
          >
            <DiskListing workspaceId={workspaceId} folderId={folderId} trash={trash} />
            {dragging ? (
              <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-[var(--radius-panel)] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]" data-testid="disk-drop">
                <span className="flex items-center gap-2 rounded-full bg-[var(--color-popover-solid)] px-3 py-1.5 text-body font-medium shadow-[var(--shadow-popover)]">
                  <Upload className="size-4 text-accent" aria-hidden />
                  {t('disk.dropHere')}
                </span>
              </div>
            ) : null}
          </div>
          <footer className="flex h-11 shrink-0 items-center gap-3 border-t border-line px-4">
            <button
              type="button"
              onClick={() => useDiskUi.getState().openDialog({ kind: 'usage', wsId: workspaceId })}
              className="-mx-2 w-72 max-w-full rounded-[var(--radius-control)] px-2 py-1 text-left hover:bg-hover"
              aria-label={t('disk.usage.title')}
              data-testid="disk-footer-meter"
            >
              <UsageMeter workspaceId={workspaceId} compact />
            </button>
          </footer>
          <Uploads workspaceId={workspaceId} />
          <DiskDialogs workspaceId={workspaceId} />
        </section>
        {createPortal(<DragOverlay dropAnimation={null}>{dragged ? <DragChip id={dragged} /> : null}</DragOverlay>, document.body)}
      </DndContext>
    </DropTarget.Provider>
  );
}

/** The uploads of this workspace: a card bottom-right, a row per file with its own progress. */
function Uploads({ workspaceId }: { workspaceId: string }): ReactNode {
  const ids = useDiskUploads(useShallow((s) => s.order.filter((id) => s.byId[id]?.wsId === workspaceId)));
  if (!ids.length) return null;
  return (
    <div className="mat-popover absolute bottom-14 right-4 z-20 flex w-72 flex-col gap-1 rounded-[var(--radius-card)] p-2 shadow-[var(--shadow-popover)]" role="status" aria-label={t('disk.uploads')} data-testid="disk-uploads">
      <span className="px-1 text-caption font-semibold text-muted">{t('disk.uploading', { n: ids.length })}</span>
      {ids.map((id) => (
        <UploadRow key={id} id={id} />
      ))}
    </div>
  );
}

export const UploadRow = memo(function UploadRow({ id }: { id: string }): ReactNode {
  const u = useDiskUploads((s) => s.byId[id]);
  if (!u) return null;
  const pct = Math.round(u.progress * 100);
  return (
    <div className="flex items-center gap-2 px-1" data-testid="disk-upload-row">
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2 text-caption">
          <span className="truncate" title={u.name}>
            {u.name}
          </span>
          {u.error ? null : <span className="shrink-0 tabular-nums text-muted">{pct}%</span>}
        </div>
        {u.error ? (
          <p className="flex items-center gap-1 truncate text-caption text-danger-text" title={u.error}>
            <CircleAlert className="size-3 shrink-0" aria-hidden />
            {u.error}
          </p>
        ) : (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-fill-hover)]">
            <div className={cx('h-full rounded-full bg-accent')} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <IconButton size="sm" label={u.error ? t('common.close') : t('common.cancel')} onClick={() => (u.error ? useDiskUploads.getState().done(id) : u.abort())}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
});
