import * as DialogP from '@radix-ui/react-dialog';
import { RoomType, type Message, type Room, type WorkspaceMember } from '@calaba/protocol';
import { ArrowRight, Hash, MessageCircle, MessageSquare, NotebookText, Phone, Search, Volume2, X } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Segmented, Spinner, Tip, cx } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, toDate } from '../../lib/format';
import { voice } from '../../services/voice';
import { can, isOwnerRoles, roomPerms } from '../../lib/permissions';
import { joinOutcome } from '../../lib/voiceEntry';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { HOME, sortedDms, useDms } from '../../stores/dms';
import { sortedShelves, useNotes } from '../../stores/notes';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, rolesOf, useWorkspaces } from '../../stores/workspaces';
import { customLook } from '../../lib/roles';
import { RoleMark, roleTextClass, roleTextStyle } from '../people/MemberBits';
import { useChatView } from '../chat/chatView';
import { previewText } from '../chat/mentionText';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { roomLabel } from '../chat/roomLabel';
import { systemPreview } from '../../lib/recording';
import { startDm } from '../../services/dms';
import { canCallNow, canDmNow, useCanCall, useCanDm } from '../dm/canDm';
import { startCall } from '../../services/call';
import { keyAction, rowActions, type SwitcherAction, type SwitcherRowKind } from './quickSwitcherActions';
import { switcherKey } from '../../lib/search/keys';
import { readScope, scopeParam, writeScope, type ScopeMode } from '../../lib/search/scope';
import type { SectionName } from '../../lib/search/sections';
import { summaryRows, type SummaryRow } from '../../lib/search/summary';
import { useSearchSummary } from '../search/useSearch';
import { HitIcon, HitTitle, hitPlace, sectionTitle, totalText } from '../search/hitParts';
import { openHit } from '../../services/searchNav';
import { useSearchPanel } from '../../stores/searchPanel';

type Item =
  | { kind: 'notes'; id: string; roomId: string; name: string; emoji: string }
  | { kind: 'dm'; id: string; roomId: string; peerId: string; name: string }
  | { kind: 'room'; id: string; room: Room }
  | { kind: 'member'; id: string; member: WorkspaceMember }
  | { kind: 'message'; id: string; msg: Message }
  /** Unified search (ADR-0062): a hit, «Все: N →», a timed-out section (lib/search/summary.ts). */
  | SummaryRow;

const MAX_ROOMS_QUERY = 6;
const MAX_DMS = 5;
const MAX_SHELVES_SHOWN = 5;
const MAX_MEMBERS = 5;
/** Server hits shown per section (ADR-0062 §4). */
const MAX_HITS = 4;

/** The group a row belongs to: a header above its first row, Tab jumps between groups. */
function groupOf(it: Item): string {
  if (it.kind === 'hit') return it.byKey ? 'key' : `s:${it.section}`;
  if (it.kind === 'more' || it.kind === 'timeout') return `s:${it.section}`;
  return it.kind;
}

/**
 * ⌘/Ctrl+K — global search (docs/09 #3, ADR-0062 §4). Instant local results — notes shelves
 * (ADR-0039), DMs by the peer's name (ADR-0020), rooms of every workspace, members of the active
 * one — and one debounced GET /api/search: messages, tasks, comments, events, files, notes and
 * transcripts, ≤ 4 each with «Все: N →» to the results panel. «Это пространство | Везде» is
 * remembered. Choosing a member filters messages by that author (the workspace message search).
 */
export function QuickSwitcher({ onClose, initialQuery = '' }: { onClose: () => void; initialQuery?: string }): ReactNode {
  const rooms = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  // «Личные» is not a workspace: no members / message search there.
  const activeWs = useUi((s) => (s.activeWorkspaceId && s.activeWorkspaceId !== HOME ? s.activeWorkspaceId : null));
  const openRoom = useUi((s) => s.openRoom);
  const dms = useDms((s) => s.byRoom);
  const shelves = useNotes((s) => s.byRoom);
  const users = useWorkspaces((s) => s.users);
  const [q, setQ] = useState(initialQuery);
  const [author, setAuthor] = useState<WorkspaceMember | null>(null);
  const [sel, setSel] = useState(0);
  const [scopeMode, setScopeMode] = useState<ScopeMode>(() => readScope());
  const scope = scopeParam(scopeMode, activeWs);
  // Messages of one author (the member filter): the workspace message search, tagged with its request.
  const [found, setFound] = useState<{ key: string; list: Message[] } | null>(null);
  const needle = q.trim().toLowerCase();
  const text = q.trim();

  const home = useUi((s) => s.activeWorkspaceId === HOME);
  const dmItems = useMemo(() => {
    // Without a query: recent DMs only in «Личные» (a workspace lists its rooms first).
    if (author || (!needle && !home)) return [];
    return sortedDms(dms)
      .map((e) => ({ ...e, name: memberName(null, e.peerId) }))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .slice(0, MAX_DMS);
    // users: a peer's renamed profile re-filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, dms, users, author, home]);

  // Shelves: by name with a query; without one in «Личные» only (like the recent DMs).
  const shelfItems = useMemo(() => {
    if (author || (!needle && !home)) return [];
    return sortedShelves(shelves)
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .slice(0, MAX_SHELVES_SHOWN);
  }, [needle, shelves, author, home]);

  const roomItems = useMemo(() => {
    if (author) return [];
    const list = Object.values(rooms)
      .filter((r) => workspaces[r.workspaceId])
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      // The active workspace first, then by name.
      .sort((a, b) => Number(b.workspaceId === activeWs) - Number(a.workspaceId === activeWs) || a.name.localeCompare(b.name, getLocale()));
    return list.slice(0, needle ? MAX_ROOMS_QUERY : 50);
  }, [needle, rooms, workspaces, activeWs, author]);

  const memberItems = useMemo(() => {
    if (!needle || author || !activeWs) return [];
    const ms = Object.values(workspaces[activeWs]?.members ?? {});
    return ms
      .filter((m) => [m.nickname, m.user?.displayName ?? ''].some((n) => n.toLowerCase().includes(needle)))
      .slice(0, MAX_MEMBERS);
  }, [needle, author, activeWs, workspaces]);

  // Unified search (ADR-0062): one debounced request, the previous one aborted, answers cached.
  const summary = useSearchSummary(text, scope, !author);

  // The author filter: that member's messages in the active workspace, debounced.
  const searchKey = author && text && activeWs ? `${activeWs}|${author.user?.id ?? ''}|${text}` : '';
  useEffect(() => {
    if (!searchKey || !activeWs || !author) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      api.messages
        .searchWorkspace(activeWs, { q: text, limit: 20, ...(author.user ? { author_id: author.user.id } : {}) }, ctl.signal)
        .then(
          (r) => setFound({ key: searchKey, list: r.messages }),
          () => {
            if (!ctl.signal.aborted) setFound({ key: searchKey, list: [] });
          },
        );
    }, 200);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [searchKey, text, activeWs, author]);
  const messages = searchKey && found?.key === searchKey ? found.list : null;
  const busy = (!!searchKey && found?.key !== searchKey) || summary.busy;

  const serverItems = useMemo(() => (summary.data && !author ? summaryRows(summary.data, MAX_HITS) : { byKey: [], rows: [] }), [summary.data, author]);

  const items: Item[] = useMemo(
    () => [
      ...serverItems.byKey,
      ...shelfItems.map((e): Item => ({ kind: 'notes', id: `n-${e.roomId}`, roomId: e.roomId, name: e.name, emoji: e.emoji })),
      ...dmItems.map((e): Item => ({ kind: 'dm', id: `d-${e.roomId}`, roomId: e.roomId, peerId: e.peerId, name: e.name })),
      ...roomItems.map((room): Item => ({ kind: 'room', id: `r-${room.id}`, room })),
      ...memberItems.map((member): Item => ({ kind: 'member', id: `u-${member.user?.id ?? ''}`, member })),
      ...(messages ?? []).map((msg): Item => ({ kind: 'message', id: `m-${msg.id}`, msg })),
      ...serverItems.rows,
    ],
    [serverItems, shelfItems, dmItems, roomItems, memberItems, messages],
  );
  const groups = useMemo(() => items.map(groupOf), [items]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));
  // Grid row of each result (a section header takes the row above it).
  const gridRows = useMemo(() => {
    let r = 0;
    return items.map((_it, i) => {
      if (needle && (i === 0 || groups[i - 1] !== groups[i])) r += 1;
      return (r += 1);
    });
  }, [items, groups, needle]);

  /** «Все результаты» of a section: the results panel (the chat stays where it is). */
  const openAll = (section: SectionName): void => {
    if (!text) return;
    useSearchPanel.getState().show(text, scope, section);
    onClose();
  };

  const go = (i: number, action?: SwitcherAction): void => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'more' || it.kind === 'timeout') {
      openAll(it.section);
      return;
    }
    if (it.kind === 'hit') {
      onClose();
      openHit(it.hit);
      return;
    }
    const act = action ?? rowActions(rowKindNow(it))[0];
    if (act === 'call') {
      const peer = it.kind === 'dm' ? it.peerId : it.kind === 'member' ? (it.member.user?.id ?? '') : '';
      onClose();
      if (peer) void startCall(peer);
      return;
    }
    if (it.kind === 'dm' || it.kind === 'notes') {
      openRoom(HOME, it.roomId);
      onClose();
    } else if (it.kind === 'room') {
      const r = it.room;
      openRoom(r.workspaceId, r.id);
      // «Подключиться» = the sidebar row's «Войти» button (same rights / limit checks);
      // «Открыть чат» only opens its feed — a call elsewhere stays as it is (docs/09 #14, #66).
      if (act === 'join') joinVoice(r);
      onClose();
    } else if (it.kind === 'member') {
      if (act === 'write') {
        void startDm(it.member.user?.id ?? '');
        onClose();
        return;
      }
      setAuthor(it.member);
      setQ('');
      setSel(0);
    } else {
      const r = rooms[it.msg.roomId];
      if (!r) return;
      openRoom(r.workspaceId, r.id);
      useChatView.getState().requestJump(r.id, it.msg.id);
      onClose();
    }
  };
  // Stable callbacks for the memoized rows: the latest go() through a ref.
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  const pick = useCallback((i: number, action?: SwitcherAction) => goRef.current(i, action), []);
  const hover = useCallback((i: number) => setSel(i), []);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Backspace' && !q && author) {
      setAuthor(null);
      return;
    }
    const out = switcherKey(groups, cur, { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing });
    if (out.kind === 'none') return;
    e.preventDefault();
    if (out.kind === 'move') setSel(out.index);
    else if (out.kind === 'all') {
      const it = items[out.index];
      openAll(it && (it.kind === 'hit' || it.kind === 'more' || it.kind === 'timeout') ? it.section : 'messages');
    } else {
      const it = items[out.index];
      if (!it) return;
      if (it.kind === 'hit' || it.kind === 'more' || it.kind === 'timeout') go(out.index);
      else go(out.index, keyAction(rowKindNow(it), { shiftKey: out.second }));
    }
  };

  const header = (it: Item): string => {
    if (it.kind === 'hit' && it.byKey) return t('search.byKey');
    if (it.kind === 'hit' || it.kind === 'more' || it.kind === 'timeout') return sectionTitle(it.section);
    return it.kind === 'notes' ? t('search.notes') : it.kind === 'dm' ? t('search.dms') : it.kind === 'room' ? t('search.rooms') : it.kind === 'member' ? t('search.members') : t('search.messages');
  };

  const changeScope = (v: ScopeMode): void => {
    setScopeMode(v);
    writeScope(v);
    setSel(0);
  };

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content aria-modal="true"
          aria-label={t('search.title')}
          data-layout-anchor="top" // Spotlight-like: anchored near the top, not centred
          data-testid="quick-switcher"
          className="mat-sheet anim-in fixed left-1/2 top-[14vh] z-[var(--z-modal)] flex max-h-[70vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] focus:outline-none"
        >
          <DialogP.Title className="sr-only">{t('search.title')}</DialogP.Title>
          <DialogP.Description className="sr-only">{t('search.hint')}</DialogP.Description>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
            {author ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-strong py-0.5 pl-2 pr-1 text-caption font-medium text-accent-fg">
                {t('search.from', { name: memberName(activeWs, author.user?.id ?? '') })}
                <Tip label={t('search.clearFrom')}>
                  <button type="button" aria-label={t('search.clearFrom')} className="grid size-4 place-items-center rounded-full hover:bg-[rgb(255_255_255/20%)]" onClick={() => setAuthor(null)}>
                    <X className="size-3" />
                  </button>
                </Tip>
              </span>
            ) : null}
            <input
              autoFocus
              // Pre-filled from the header field: the caret goes after the typed text.
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={onKey}
              role="combobox"
              aria-expanded
              aria-controls="quick-switcher-list"
              aria-activedescendant={items[cur] ? `qs-${items[cur].id}` : undefined}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              className="h-12 min-w-0 flex-1 bg-transparent text-headline text-fg placeholder:text-faint"
            />
            {busy ? <Spinner className="size-4" /> : null}
            {/* «Это пространство | Везде» (ADR-0062 §4); «Личные» always searches everywhere. */}
            {activeWs && !author ? (
              <span className="shrink-0 mobile:hidden" data-testid="search-scope">
                <Segmented
                  value={scopeMode}
                  onChange={changeScope}
                  label={t('search.scope')}
                  options={[
                    { value: 'workspace', label: t('search.scopeWorkspace') },
                    { value: 'all', label: t('search.scopeAll') },
                  ]}
                />
              </span>
            ) : null}
          </div>
          {/* A two-column grid: the listbox (display: contents) fills column 1 with its options;
              each option's action buttons sit in column 2 on the same grid row — outside the
              listbox, whose children may only be options (docs/09 #66, #83). */}
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto] content-start overflow-y-auto p-1.5">
            <ul id="quick-switcher-list" role="listbox" aria-label={t('search.title')} className="contents">
              {items.length === 0 ? (
                <li role="presentation" className="col-span-full px-3 py-6 text-center text-body text-muted">
                  {busy ? t('search.searching') : author && !q.trim() ? t('search.memberHint') : t('search.empty')}
                </li>
              ) : null}
              {items.map((it, i) => (
                <Fragment key={it.id}>
                  {needle && (i === 0 || groups[i - 1] !== groups[i]) ? (
                    <li role="presentation" className="col-span-full px-3 pb-1 pt-2 text-caption font-semibold text-muted" style={{ gridRow: (gridRows[i] ?? 1) - 1 }}>
                      {header(it)}
                    </li>
                  ) : null}
                  <SwitcherOption
                    it={it}
                    index={i}
                    row={gridRows[i] ?? 1}
                    selected={i === cur}
                    q={text}
                    workspaceName={it.kind === 'room' ? (workspaces[it.room.workspaceId]?.ws.name ?? '') : ''}
                    activeWs={activeWs}
                    rooms={rooms}
                    onHover={hover}
                    onPick={pick}
                  />
                </Fragment>
              ))}
            </ul>
            <div className="contents">
              {items.map((it, i) => (
                <SwitcherActions key={it.id} it={it} index={i} row={gridRows[i] ?? 1} selected={i === cur} onPick={pick} onHover={hover} />
              ))}
            </div>
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** My CONNECT in a voice room (read at the moment of the action). */
function canConnectNow(it: Item): boolean {
  if (it.kind !== 'room' || it.room.type !== RoomType.VOICE) return false;
  const me = useSession.getState().me?.user?.id ?? '';
  return can(roomPerms(rolesOf(useWorkspaces.getState().byId[it.room.workspaceId], me), me, it.room), 'CONNECT');
}

function rowKind(it: Item, canConnect: boolean, canDm: boolean, canCall: boolean): SwitcherRowKind {
  if (it.kind === 'room') return { kind: 'room', voice: it.room.type === RoomType.VOICE, canConnect };
  if (it.kind === 'member') return { kind: 'member', canDm, canCall };
  if (it.kind === 'dm') return { kind: 'dm', canCall };
  if (it.kind === 'notes') return { kind: 'room' };
  return { kind: 'message' };
}

/** Whose row it is, for «Позвонить» (ADR-0034): a DM's peer or a member; '' otherwise. */
function personOf(it: Item): string {
  return it.kind === 'dm' ? it.peerId : it.kind === 'member' ? (it.member.user?.id ?? '') : '';
}

/** rowKind with the rights read at the moment of the action (keyboard). */
function rowKindNow(it: Item): SwitcherRowKind {
  const person = personOf(it);
  return rowKind(it, canConnectNow(it), it.kind === 'member' && canDmNow(it.member.workspaceId, it.member.user?.id ?? ''), person !== '' && canCallNow(person));
}

/** The sidebar row's «Войти» on a voice room (joinOutcome: CONNECT, the user limit, owner-only over it). */
function joinVoice(r: Room): void {
  const entry = useWorkspaces.getState().byId[r.workspaceId];
  const me = useSession.getState().me?.user?.id ?? '';
  const perms = roomPerms(rolesOf(entry, me), me, r);
  const people = Object.values(entry?.voice ?? {}).filter((v) => v.roomId === r.id).length;
  const next = joinOutcome({
    inRoom: useVoice.getState().roomId === r.id,
    canConnect: can(perms, 'CONNECT'),
    owner: isOwnerRoles(rolesOf(entry, me)),
    people,
    limit: r.userLimit,
  });
  if (next === 'full') toast.info(t('shell.roomFull'));
  else if (next === 'join') void voice.join(r.id, r.workspaceId);
}

/**
 * One result: the `option`, column 1 of its grid row. A click only selects it (docs/09 #83) —
 * the actions are the row's buttons (and Enter / ⇧Enter); «Все: N →» and a timed-out section
 * have no buttons: a click opens the results panel.
 */
const SwitcherOption = memo(function SwitcherOption({
  it,
  index,
  row,
  selected,
  q,
  workspaceName,
  activeWs,
  rooms,
  onHover,
  onPick,
}: {
  it: Item;
  index: number;
  row: number;
  selected: boolean;
  q: string;
  workspaceName: string;
  activeWs: string | null;
  rooms: Record<string, Room>;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}): ReactNode {
  const link = it.kind === 'more' || it.kind === 'timeout';
  return (
    <li
      id={`qs-${it.id}`}
      role="option"
      aria-selected={selected}
      style={{ gridRow: row }}
      onMouseMove={selected ? undefined : () => onHover(index)}
      onClick={link ? () => onPick(index) : selected ? undefined : () => onHover(index)}
      data-testid={it.kind === 'hit' ? 'search-hit' : link ? `search-${it.kind}` : undefined}
      className={cx(
        'col-start-1 flex min-w-0 cursor-default items-center gap-2 rounded-l-[var(--radius-row)] pl-3 pr-2 text-left text-body text-fg',
        it.kind === 'message' || it.kind === 'hit' ? 'py-1.5' : link ? 'h-8 mobile:h-11' : 'h-9 mobile:h-12',
        selected && 'bg-active',
      )}
    >
      <RowBody it={it} q={q} workspaceName={workspaceName} activeWs={activeWs} rooms={rooms} />
    </li>
  );
});

/**
 * The row's right end (docs/09 #66, #83), column 2 of its grid row: the action buttons, with
 * text. Shown on the selected row (hover or arrows) and while one of them has focus (Tab), so
 * they stay in the tab order (opacity, not display); no Enter hint. Phone: always, 44 px.
 */
const SwitcherActions = memo(function SwitcherActions({
  it,
  index,
  row,
  selected,
  onPick,
  onHover,
}: {
  it: Item;
  index: number;
  row: number;
  selected: boolean;
  onPick: (i: number, action?: SwitcherAction) => void;
  onHover: (i: number) => void;
}): ReactNode {
  const canConnect = useCanConnect(it.kind === 'room' && it.room.type === RoomType.VOICE ? it.room : null);
  const canDm = useCanDm(it.kind === 'member' ? it.member.workspaceId : '', it.kind === 'member' ? (it.member.user?.id ?? '') : '');
  const canCall = useCanCall(personOf(it));
  const actions = it.kind === 'more' || it.kind === 'timeout' ? [] : rowActions(rowKind(it, canConnect, canDm, canCall));
  const name = rowName(it);
  return (
    <div
      style={{ gridRow: row }}
      onMouseMove={selected ? undefined : () => onHover(index)}
      onFocus={selected ? undefined : () => onHover(index)}
      className={cx(
        'col-start-2 flex items-center justify-end gap-1 rounded-r-[var(--radius-row)] pr-1.5 mobile:opacity-100',
        selected ? 'bg-active' : 'opacity-0 focus-within:opacity-100',
      )}
    >
      {actions.map((a) => {
        const label = actionLabel(a);
        const Icon = a === 'join' || a === 'call' ? Phone : a === 'chat' ? MessageSquare : a === 'write' ? MessageCircle : null;
        return (
          <Button
            key={a}
            size="sm"
            variant={a === 'join' ? 'primary' : 'secondary'}
            aria-label={t('search.actionOn', { action: label, name })}
            onClick={() => onPick(index, a)}
            className={Icon ? 'mobile:size-11 mobile:rounded-full mobile:px-0' : 'mobile:h-11 mobile:px-4'}
          >
            {Icon ? <Icon className="size-3.5 mobile:size-5" aria-hidden /> : null}
            <span className={Icon ? 'mobile:hidden' : undefined}>{label}</span>
          </Button>
        );
      })}
    </div>
  );
});

function actionLabel(a: SwitcherAction): string {
  if (a === 'join') return t('search.join');
  if (a === 'chat') return t('search.chat');
  if (a === 'write') return t('dm.write');
  if (a === 'call') return t('call.call');
  if (a === 'filter') return t('search.filter');
  return t('search.open');
}

/** CONNECT in a voice room, reactive (a boolean selector: a role change re-renders only this row). */
function useCanConnect(room: Room | null): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => (room ? can(roomPerms(rolesOf(s.byId[room.workspaceId], me), me, room), 'CONNECT') : false));
}

/** The row's subject for the buttons' names («Подключиться: Созвон»). */
function rowName(it: Item): string {
  if (it.kind === 'dm' || it.kind === 'notes') return it.name;
  if (it.kind === 'room') return it.room.name;
  if (it.kind === 'member') return it.member.nickname || it.member.user?.displayName || '';
  if (it.kind === 'hit') return it.hit.title || sectionTitle(it.section);
  if (it.kind === 'more' || it.kind === 'timeout') return sectionTitle(it.section);
  return memberName(useRooms.getState().byId[it.msg.roomId]?.workspaceId ?? null, it.msg.authorId);
}

function RowBody({ it, q, workspaceName, activeWs, rooms }: { it: Item; q: string; workspaceName: string; activeWs: string | null; rooms: Record<string, Room> }): ReactNode {
  const sub = 'shrink-0 truncate text-caption text-muted mobile:hidden';
  if (it.kind === 'hit') {
    const place = hitPlace(it.hit, activeWs);
    return (
      <>
        <HitIcon section={it.section} hit={it.hit} className="mt-0.5 size-4 shrink-0 self-start text-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            <HitTitle hit={it.hit} q={q} />
          </span>
          {place ? <span className="truncate text-caption text-muted">{place}</span> : null}
        </span>
      </>
    );
  }
  if (it.kind === 'more') {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 pl-6 text-caption font-medium text-accent-text">
        {t('search.all', { n: totalText(it.total) })}
        <ArrowRight className="size-3.5" aria-hidden />
      </span>
    );
  }
  if (it.kind === 'timeout') {
    return <span className="min-w-0 flex-1 truncate pl-6 text-caption text-muted">{t('search.timedOut')}</span>;
  }
  if (it.kind === 'notes') {
    return (
      <>
        <span className="grid size-5 shrink-0 place-items-center text-[15px] leading-none text-muted" aria-hidden>
          {it.emoji || <NotebookText className="size-4" strokeWidth={1.75} />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={it.name} q={q} />
        </span>
        <span className={sub}>{t('search.notes')}</span>
      </>
    );
  }
  if (it.kind === 'dm') {
    const u = useWorkspaces.getState().users[it.peerId];
    return (
      <>
        <Avatar userId={it.peerId} name={it.name} fileId={u?.avatarFileId || undefined} size={20} />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={it.name} q={q} />
        </span>
        <span className={sub}>{t('search.dms')}</span>
      </>
    );
  }
  if (it.kind === 'room') {
    const r = it.room;
    const Icon = r.type === RoomType.VOICE ? Volume2 : Hash;
    return (
      <>
        <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={r.name} q={q} />
        </span>
        <span className={sub}>{workspaceName}</span>
      </>
    );
  }
  if (it.kind === 'member') {
    const u = it.member.user;
    const name = it.member.nickname || u?.displayName || '';
    const look = customLook(rolesOf(useWorkspaces.getState().byId[it.member.workspaceId], u?.id ?? ''));
    return (
      <>
        <Avatar userId={u?.id ?? ''} name={name} fileId={u?.avatarFileId || undefined} size={20} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className={cx('min-w-0 truncate', roleTextClass(it.member.role, 'role', look))} style={roleTextStyle(it.member.role, 'role', look)}>
            <Highlight text={name} q={q} />
          </span>
          <RoleMark role={it.member.role} custom={look} tone="role" />
        </span>
        <span className={sub}>{t('search.memberHint')}</span>
      </>
    );
  }
  const m = it.msg;
  const room = rooms[m.roomId];
  const d = toDate(m.createdAt);
  const wsId = room?.workspaceId ?? null;
  const text = systemPreview(m) || previewText(wsId, m.content) || t('chat.attachment');
  const author = memberName(wsId, m.authorId);
  const user = useWorkspaces.getState().users[m.authorId];
  return (
    <>
      <Avatar userId={m.authorId} name={author} fileId={user?.avatarFileId || undefined} size={28} className="self-start" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-semibold">{author}</span>
          <span className="shrink-0 truncate text-caption text-muted">
            {room ? `${roomLabel(room)} · ` : ''}
            {fmt.dayLabel(d)}, {fmt.time(d)}
          </span>
        </span>
        <span className="line-clamp-2 break-words">
          <Highlight text={snippetAround(text, q)} q={q} />
        </span>
      </span>
    </>
  );
}

/** ~140 characters of context around the first match. */
export function snippetAround(text: string, q: string, span = 140): string {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase().split(/\s+/)[0] ?? '') : -1;
  if (i < 0 || text.length <= span) return text.slice(0, span);
  const start = Math.max(0, Math.min(i - 40, text.length - span));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + span)}${start + span < text.length ? '…' : ''}`;
}

/** Hits: 600 weight + accent text (the selected row is a neutral fill: the accent stays readable). */
function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  const parts = splitHits(text, searchWords(q));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-transparent font-semibold text-accent-text">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
