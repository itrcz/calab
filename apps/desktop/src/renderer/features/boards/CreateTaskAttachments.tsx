import { Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { uploadFile, type UploadHandle } from '../../lib/api/endpoints';
import { roomLeft, type PendingFile } from '../../lib/boards/pendingFiles';
import { boardsApi } from '../../services/boardsApi';
import { toast } from '../../stores/toasts';

export interface PendingFiles {
  items: PendingFile[];
  add: (files: File[]) => void;
  remove: (key: string) => void;
  /** Drops everything (aborting uploads): another board cannot take these files. */
  clear: () => void;
}

/** Uploads to the board as files are picked; `items` is what the create dialog sends and waits for. */
export function usePendingFiles(boardId: string): PendingFiles {
  const [items, setItems] = useState<PendingFile[]>([]);
  // The ref is the source of truth (event handlers read it); state only mirrors it for rendering.
  const itemsRef = useRef<PendingFile[]>([]);
  const commit = useCallback((next: PendingFile[]): void => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const handles = useRef(new Map<string, UploadHandle>());
  const seq = useRef(0);

  const patch = useCallback((key: string, p: Partial<PendingFile>): void => {
    commit(itemsRef.current.map((x) => (x.key === key ? { ...x, ...p } : x)));
  }, [commit]);

  const add = useCallback(
    (files: File[]): void => {
      const take = files.slice(0, roomLeft(itemsRef.current));
      if (!take.length) return;
      const added = take.map((file) => ({ file, item: { key: `f${++seq.current}`, name: file.name, id: '', progress: 0, failed: false } satisfies PendingFile }));
      commit([...itemsRef.current, ...added.map((a) => a.item)]);
      for (const { file, item } of added) {
        let last = 0;
        const h = uploadFile(boardsApi.uploadPath(boardId), file, file.name, (p) => {
          // Re-render per whole percent at most, not per progress event.
          const pct = Math.floor(p * 100);
          if (pct !== last) {
            last = pct;
            patch(item.key, { progress: p });
          }
        });
        handles.current.set(item.key, h);
        h.promise.then(
          (meta) => {
            if (!handles.current.delete(item.key)) return; // removed meanwhile
            patch(item.key, { id: meta.id, progress: 1 });
          },
          (e: unknown) => {
            if (!handles.current.delete(item.key)) return; // removed/aborted by the user
            patch(item.key, { failed: true });
            toast.fail(e, t('boards.err.save'));
          },
        );
      }
    },
    [boardId, patch, commit],
  );

  const remove = useCallback((key: string): void => {
    handles.current.get(key)?.abort();
    handles.current.delete(key);
    commit(itemsRef.current.filter((x) => x.key !== key));
  }, [commit]);

  const clear = useCallback((): void => {
    for (const h of handles.current.values()) h.abort();
    handles.current.clear();
    commit([]);
  }, [commit]);

  useEffect(() => {
    const live = handles.current;
    return () => {
      for (const h of live.values()) h.abort();
    };
  }, []);

  return { items, add, remove, clear };
}

/** Chips of the files picked so far, with progress and «×». */
export function PendingFileList({ items, onRemove }: { items: PendingFile[]; onRemove: (key: string) => void }): ReactNode {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="create-task-files">
      {items.map((f) => (
        <span key={f.key} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border border-line pl-2 pr-1 text-caption">
          <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className={f.failed ? 'min-w-0 truncate text-danger' : 'min-w-0 truncate'}>{f.name}</span>
          {!f.id && !f.failed ? <span className="shrink-0 tabular-nums text-faint">{Math.round(f.progress * 100)}%</span> : null}
          <button type="button" aria-label={t('boards.removeAttachment', { name: f.name })} onClick={() => onRemove(f.key)} className="grid size-5 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}
