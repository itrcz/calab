/**
 * The open wiki page's live document (ADR-0096 §4, §9) — the lazy chunk's entry with Yjs, the sync
 * provider and the editor. One per open page (keyed by the page id): it creates the Y.Doc and the
 * awareness, connects WikiSyncProvider to `/api/wiki/pages/{id}/sync`, and destroys both when the
 * page closes (no background sockets). The window hidden pauses the awareness inside the provider.
 * Also: the meta line («изменено … · соавторы онлайн») and the handle the main chunk uses for
 * «Экспорт в Markdown» and «Восстановить» (lib/wiki/docHandle).
 */
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { avatarColor } from '../../components/Avatar';
import { Tip } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { filterCandidates, type MentionCandidate } from '../../lib/mentions';
import { setDocHandle } from '../../lib/wiki/docHandle';
import { toMarkdown, type PmNode } from '../../lib/wiki/markdown';
import { docMeta, docPlainText, WIKI_FIELD } from '../../lib/wiki/plainText';
import { createWikiSync, type WikiSyncProvider } from '../../lib/wikiSync';
import { platform } from '../../platform';
import { loadPage, uploadImage } from '../../services/wiki';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import WikiEditor from './editor/WikiEditor';
import { PhoneToolbar } from './editor/PhoneToolbar';
import type { MentionSource, WikiEditorApi } from './editor/types';

/** `wss://host/api/wiki/pages/{id}/sync` from the server URL (the gateway's way). */
function syncUrl(pageId: string): string {
  const u = new URL(`/api/wiki/pages/${pageId}/sync`, useSession.getState().serverUrl || window.location.origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/** The members of the workspace for `@`, read at call time (no subscription: typing `@` is rare). */
function mentionSource(workspaceId: string, me: string): MentionSource {
  return {
    search: (q) => {
      const members = useWorkspaces.getState().byId[workspaceId]?.members ?? {};
      const list: MentionCandidate[] = [];
      for (const m of Object.values(members)) {
        const u = m.user;
        if (!u || u.id === me) continue;
        const name = m.nickname || u.displayName;
        list.push({
          id: u.id,
          name,
          alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [],
          ...(u.username ? { nick: u.username } : {}),
        });
      }
      return filterCandidates(q, list);
    },
    label: (id) => (useWorkspaces.getState().byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : undefined),
  };
}

export interface WikiDocProps {
  workspaceId: string;
  pageId: string;
  /** WIKI_WRITE on the page and not in the trash. */
  editable: boolean;
  /** The phone's page (ADR-0096 §7): no carets of others, a counter instead of the avatars, the toolbar in `toolbarHost`. */
  phone?: boolean;
  toolbarHost?: HTMLElement | null;
}

export default function WikiDoc({ workspaceId, pageId, editable, phone = false, toolbarHost = null }: WikiDocProps): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myName = useWorkspaces((s) => (me && s.byId[workspaceId]?.members[me] ? memberName(workspaceId, me) : '')) || ' ';
  const [{ doc, awareness }] = useState(() => {
    const d = new Y.Doc();
    return { doc: d, awareness: new Awareness(d) };
  });
  useEffect(
    () => () => {
      awareness.destroy();
      doc.destroy();
    },
    [doc, awareness],
  );

  const provider = useRef<WikiSyncProvider | null>(null);
  useEffect(() => {
    const p = createWikiSync(doc, awareness, {
      url: () => syncUrl(pageId),
      getToken: () => platform.auth.accessToken(),
      refreshToken: () => platform.auth.forceRefresh(),
      createSocket: (url) => new WebSocket(url),
      readOnly: !editable,
      // The title lives in wiki_pages (the header PATCHes it); the snapshot carries the current one.
      meta: () => ({
        ...docMeta(doc),
        title: useWiki.getState().pages[pageId]?.title ?? '',
      }),
      onTooLarge: () => toast.error(t('wiki.tooLarge')),
      onFatal: () => void loadPage(workspaceId, pageId),
    });
    provider.current = p;
    const ui = useWikiUi.getState();
    ui.setSync(p.getStatus());
    const unsub = p.subscribe((s) => useWikiUi.getState().setSync(s));
    return () => {
      unsub();
      p.destroy();
      provider.current = null;
      useWikiUi.getState().setSync('online');
    };
  }, [doc, awareness, pageId, workspaceId, editable]);

  // The handle for the main chunk (export, restore).
  const api = useRef<WikiEditorApi | null>(null);
  const [phoneApi, setPhoneApi] = useState<WikiEditorApi | null>(null);
  const onReady = useCallback(
    (a: WikiEditorApi | null) => {
      api.current = a;
      if (phone) setPhoneApi(a);
    },
    [phone],
  );
  useEffect(() => {
    setDocHandle({
      pageId,
      markdown: (title) => (api.current ? toMarkdown(api.current.getJSON() as PmNode, { title }) : null),
      text: () => docPlainText(doc),
      restore: (state) => {
        const v = new Y.Doc();
        Y.applyUpdate(v, state);
        const src = v.getXmlFragment(WIKI_FIELD);
        const dst = doc.getXmlFragment(WIKI_FIELD);
        doc.transact(() => {
          dst.delete(0, dst.length);
          // y-prosemirror writes elements and text only (no hooks).
          const nodes = src.toArray().flatMap((n) => (n instanceof Y.XmlElement || n instanceof Y.XmlText ? [n.clone()] : []));
          dst.insert(0, nodes);
        });
        v.destroy();
      },
      writable: () => editable && provider.current?.status === 'online',
    });
    return () => setDocHandle(null);
  }, [doc, pageId, editable]);

  const user = useMemo(() => ({ id: me, name: myName, color: avatarColor(me) }), [me, myName]);
  const mentions = useMemo(() => mentionSource(workspaceId, me), [workspaceId, me]);
  const upload = useCallback((f: File) => uploadImage(pageId, f), [pageId]);
  const onError = useCallback((m: string) => toast.error(m), []);

  return (
    <>
      {phone ? <PeersReporter awareness={awareness} me={me} /> : <MetaLine workspaceId={workspaceId} pageId={pageId} awareness={awareness} me={me} />}
      <WikiEditor doc={doc} awareness={awareness} editable={editable} me={user} onUploadImage={upload} mentionSource={mentions} onError={onError} onReady={onReady} phone={phone} className={phone ? 'mt-2' : 'mt-4'} />
      {phone && editable && toolbarHost && phoneApi ? createPortal(<PhoneToolbar editor={phoneApi.editor} onBlocks={() => phoneApi.openBlocks()} />, toolbarHost) : null}
    </>
  );
}

/** «Изменено 5 минут назад · [аватары соавторов онлайн]» — re-renders on its own inputs only. */
const MetaLine = memo(function MetaLine({ workspaceId, pageId, awareness, me }: { workspaceId: string; pageId: string; awareness: Awareness; me: string }): ReactNode {
  useLocale();
  const updated = useWiki((s) => {
    const at = s.pages[pageId]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  const by = useWiki((s) => s.pages[pageId]?.updatedBy ?? '');
  const byName = useWorkspaces((s) => (by && s.byId[workspaceId]?.members[by] ? memberName(workspaceId, by) : ''));
  const online = useCoauthors(awareness, me);
  return (
    <div className="mt-2 flex min-h-6 items-center gap-2 text-caption text-muted" data-testid="wiki-meta">
      {updated ? (
        <span title={fmt.full(new Date(updated))}>
          {byName
            ? t('wiki.editedBy', {
                when: fmt.relative(new Date(updated)),
                name: byName,
              })
            : t('wiki.edited', { when: fmt.relative(new Date(updated)) })}
        </span>
      ) : null}
      {online.length ? (
        <>
          <span aria-hidden>·</span>
          <span className="flex items-center -space-x-1.5" aria-label={t('wiki.online', { n: online.length })} data-testid="wiki-coauthors">
            {online.slice(0, 5).map((id) => (
              <Tip key={id} label={memberName(workspaceId, id)}>
                <span className="rounded-full ring-2 ring-[var(--color-bg)]">
                  <MemberAvatar workspaceId={workspaceId} userId={id} size={20} />
                </span>
              </Tip>
            ))}
          </span>
          {online.length > 5 ? <span>+{online.length - 5}</span> : null}
        </>
      ) : null}
    </div>
  );
});

/** Phone: writes the number of other people on the page to the store (the header shows «ещё N редактируют»); renders nothing. */
function PeersReporter({ awareness, me }: { awareness: Awareness; me: string }): ReactNode {
  const n = useCoauthors(awareness, me).length;
  useEffect(() => {
    useWikiUi.getState().setPeers(n);
    return () => useWikiUi.getState().setPeers(0);
  }, [n]);
  return null;
}

/** The user ids of the other people on this page now (awareness), as a stable array per change. */
function useCoauthors(awareness: Awareness, me: string): readonly string[] {
  const cache = useRef<{ key: string; ids: readonly string[] }>({
    key: '',
    ids: [],
  });
  const subscribe = useCallback(
    (cb: () => void) => {
      awareness.on('change', cb);
      return () => awareness.off('change', cb);
    },
    [awareness],
  );
  const get = useCallback((): readonly string[] => {
    const ids = new Set<string>();
    awareness.getStates().forEach((st, client) => {
      if (client === awareness.clientID) return;
      const u = (st as { user?: { id?: unknown } }).user;
      if (u && typeof u.id === 'string' && u.id && u.id !== me) ids.add(u.id);
    });
    const list = [...ids].sort();
    const key = list.join(',');
    if (key !== cache.current.key) cache.current = { key, ids: list };
    return cache.current.ids;
  }, [awareness, me]);
  return useSyncExternalStore(subscribe, get);
}
