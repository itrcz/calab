import type { MentionSource, UploadedImage } from './types';
import { MenuStore } from './menuStore';

/**
 * Per-editor environment read by the extensions at event time (not baked into them): the
 * WikiEditor updates the fields on every render, so changing a callback never rebuilds the editor.
 */
export interface EditorEnv {
  upload: ((file: File) => Promise<UploadedImage>) | null;
  mentions: MentionSource | null;
  imagePath: (fileId: string) => string;
  onError: (message: string) => void;
  menu: MenuStore;
  /** ⌘K: asks the bubble bar to open its link field. */
  openLink: () => void;
  /** The bubble bar listens for openLink(); returns the unsubscribe. */
  onOpenLink: (cb: () => void) => () => void;
}

export function createEnv(): EditorEnv {
  const linkSubs = new Set<() => void>();
  return {
    upload: null,
    mentions: null,
    imagePath: (id) => `/api/files/${id}`,
    onError: (m) => console.warn(m),
    menu: new MenuStore(),
    openLink: () => {
      for (const cb of linkSubs) cb();
    },
    onOpenLink: (cb) => {
      linkSubs.add(cb);
      return () => {
        linkSubs.delete(cb);
      };
    },
  };
}
