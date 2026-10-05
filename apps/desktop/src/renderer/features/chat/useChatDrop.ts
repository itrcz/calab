import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { dragOutActive } from '../../lib/dragOut';
import { MESSAGE_MIME, decodeDragged, draggedMessage, resolveDrop, type DropAction, type DropTarget } from '../../lib/messageDrag';

export interface ChatDropHandlers {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/**
 * A chat row as a drop target (docs/05 «Заметки», lib/messageDrag.ts): a dragged message is
 * forwarded there, OS files go to a shelf. Returns whether a usable drag is over the row (the
 * row's own state: nothing else re-renders during a drag) and stable handlers to spread on it.
 * `target` null = not a target now.
 */
export function useChatDrop(target: DropTarget | null, onAction: (a: DropAction, files: File[]) => void): [boolean, ChatDropHandlers] {
  const [over, setOver] = useState(false);
  const targetRef = useRef(target);
  const actionRef = useRef(onAction);
  useEffect(() => {
    targetRef.current = target;
    actionRef.current = onAction;
  });

  // A drag that ends anywhere (dropped elsewhere, Esc, out of the window) clears the highlight.
  useEffect(() => {
    if (!over) return;
    const off = (): void => setOver(false);
    window.addEventListener('dragend', off, true);
    window.addEventListener('drop', off, true);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('dragend', off, true);
      window.removeEventListener('drop', off, true);
      window.removeEventListener('blur', off);
    };
  }, [over]);

  const handlers = useMemo<ChatDropHandlers>(() => {
    const accept = (e: DragEvent): boolean => {
      const t = targetRef.current;
      const a = t ? resolveDrop(e.dataTransfer.types, draggedMessage(), t) : null;
      // Our own image dragged out (its file) is not a file from the OS to send again.
      if (!a || (a.kind === 'files' && dragOutActive())) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
      return true;
    };
    return {
      onDragEnter: (e) => void accept(e),
      onDragOver: (e) => void accept(e),
      onDragLeave: (e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
      },
      onDrop: (e) => {
        setOver(false);
        const t = targetRef.current;
        if (!t) return;
        const dragged = decodeDragged(e.dataTransfer.getData(MESSAGE_MIME)) ?? draggedMessage();
        const a = resolveDrop(e.dataTransfer.types, dragged, t);
        if (!a || (a.kind === 'files' && dragOutActive())) return;
        e.preventDefault();
        e.stopPropagation();
        actionRef.current(a, a.kind === 'files' ? Array.from(e.dataTransfer.files) : []);
      },
    };
  }, []);

  return [over, handlers];
}
