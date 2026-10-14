/**
 * The document of a public wiki page (ADR-0096 §6) — the lazy chunk's entry for `/w/{code}`:
 * a fresh Y.Doc with the state stream applied and the same Tiptap editor, read-only. No sync
 * socket, no awareness; pictures come through the public files route.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as Y from 'yjs';
import { stateUpdates } from '../../lib/wiki/publicState';
import { wikiPublic } from '../../services/wikiPublic';
import WikiEditor from './editor/WikiEditor';

const NOBODY = { id: '', name: '' };

/** The Y.Doc of a state stream; null when the stream is damaged (a half document is never shown). */
function build(body: Uint8Array): Y.Doc | null {
  const d = new Y.Doc();
  try {
    d.transact(() => {
      for (const u of stateUpdates(body)) Y.applyUpdate(d, u);
    });
    return d;
  } catch {
    d.destroy();
    return null;
  }
}

/** One per answer (the page keys it by the body): the doc lives as long as the component. */
export default function PublicDoc({ code, body, onError }: { code: string; body: Uint8Array; onError: () => void }): ReactNode {
  const [doc] = useState(() => build(body));
  useEffect(() => {
    if (!doc) {
      onError();
      return;
    }
    return () => doc.destroy();
  }, [doc, onError]);
  const imagePath = useCallback((fileId: string) => wikiPublic.filePath(code, fileId), [code]);
  if (!doc) return null;
  return <WikiEditor doc={doc} editable={false} me={NOBODY} imagePath={imagePath} className="mt-4" />;
}
