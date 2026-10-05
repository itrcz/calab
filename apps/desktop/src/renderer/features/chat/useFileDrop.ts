import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { dragOutActive } from '../../lib/dragOut';
import { DropState } from '../../lib/dropState';

export interface FileDropHandlers {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/**
 * The chat's file drop zone (desktop, DM and mobile web all render ChatPane): the overlay flag
 * plus the zone's handlers (stable, safe to spread on the zone). The show/hide logic lives in
 * lib/dropState.ts; this hook wires the zone events and the window-level events that end a drag
 * outside the zone (docs/09 #104).
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void): [boolean, FileDropHandlers] {
  const [dragging, setDragging] = useState(false);
  const state = useRef<DropState | null>(null);
  state.current ??= new DropState(setDragging);
  const enabledRef = useRef(enabled);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    enabledRef.current = enabled;
    onFilesRef.current = onFiles;
    if (!enabled) state.current?.reset();
  }, [enabled, onFiles]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    const onStart = (): void => s.dragStart();
    const onEnd = (): void => s.end();
    // Leaving the window: relatedTarget is null (between elements it is the element entered).
    const onLeave = (e: globalThis.DragEvent): void => {
      if (e.relatedTarget === null) s.reset();
    };
    const onReset = (): void => s.reset();
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') s.reset();
    };
    window.addEventListener('dragstart', onStart, true);
    window.addEventListener('dragend', onEnd, true);
    // Bubble phase: the zone's own onDrop (React, at the root) reads the state first.
    window.addEventListener('drop', onEnd);
    window.addEventListener('dragleave', onLeave, true);
    // No pointer-up is delivered during an OS drag: one arriving means any drag is over.
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('mouseup', onEnd, true);
    window.addEventListener('blur', onReset);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
      window.removeEventListener('drop', onEnd);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('mouseup', onEnd, true);
      window.removeEventListener('blur', onReset);
      document.removeEventListener('visibilitychange', onVisibility);
      s.dispose();
    };
  }, []);

  const handlers = useMemo<FileDropHandlers>(
    () => ({
      // Our own image dragged out of the feed (lib/dragOut.ts) is never a file to attach.
      onDragEnter: (e) => {
        if (enabledRef.current && !dragOutActive()) state.current?.enter(e.dataTransfer.types);
      },
      onDragOver: (e) => {
        if (enabledRef.current && !dragOutActive() && state.current?.over(e.dataTransfer.types)) e.preventDefault();
      },
      onDragLeave: () => state.current?.leave(),
      onDrop: (e) => {
        const accept = enabledRef.current && !dragOutActive() && (state.current?.active ?? false);
        e.preventDefault();
        state.current?.end();
        if (accept) onFilesRef.current(Array.from(e.dataTransfer.files));
      },
    }),
    [],
  );

  return [dragging, handlers];
}
