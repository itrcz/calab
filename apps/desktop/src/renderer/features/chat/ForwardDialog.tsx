import { WorkspaceRole, type User } from '@calaba/protocol';
import { Check, Lock, NotebookText, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PickerPanel } from '../../components/picker/Picker';
import { Button, CLOSE_HIT, Modal, cx } from '../../components/ui';
import { RoomIcon } from '../../components/RoomIcon';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { isSuspended } from '../../lib/moderation';
import { can, roomPerms } from '../../lib/permissions';
import { forwardMessage, reportForward } from '../../services/forward';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useWorkspaces } from '../../stores/workspaces';
import { MemberPickRow } from '../people/MemberPicker';
import { userItems } from '../people/memberPickItems';
import { roomLabel } from './roomLabel';
import { MAX_FORWARD_TARGETS, forwardGroups, isSelected, roomItems, shelfItems, targetKey, toggleTarget, type ForwardItem, type RoomPickItem } from './forwardModel';
import { sortedShelves, useNotes } from '../../stores/notes';

/** The most senior role the user has in any workspace we share (the row's role mark). */
function sharedRole(userId: string): WorkspaceRole | undefined {
  let best: WorkspaceRole | undefined;
  for (const e of Object.values(useWorkspaces.getState().byId)) {
    const r = e.members[userId]?.role;
    if (r === WorkspaceRole.OWNER) return r;
    if (r === WorkspaceRole.ADMIN) best = r;
  }
  return best;
}

/**
 * «Переслать…» (ADR-0033 §5, docs/08 «Лента»): one search field over «Личные» (people I may
 * write to — GET /api/dms/candidates, as in «Новое сообщение») and the rooms where I may send
 * (the source room's workspace; from a DM — every workspace). Picking toggles a target (chips
 * above the list, Telegram); «Переслать» sends to them one by one and reports in a toast. From a
 * room «только по списку» (ADR-0029) a note warns that the recipients will see the content.
 *
 * `onSend` replaces the chat forward with another sender over the same picker (a mail message
 * «Отправить в чат…», ADR-0088); then `roomId` is '' (every workspace's rooms) and `title` / `description` name it.
 */
export function ForwardDialog({
  roomId,
  messageId,
  onClose,
  onSend,
  title,
  description,
}: {
  roomId: string;
  messageId: string;
  onClose: () => void;
  onSend?: (targets: readonly ForwardItem[]) => Promise<void>;
  title?: string;
  description?: string;
}): ReactNode {
  const src = useRooms((s) => s.byId[roomId]);
  const byId = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  const order = useWorkspaces((s) => s.order);
  const myId = useSession((s) => s.me?.user?.id ?? '');
  const noDms = useSession((s) => !s.me?.user || s.me.user.isGuest);
  const srcWs = src?.workspaceId ?? '';
  const [q, setQ] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; users: User[] } | null>(null);
  const [selected, setSelected] = useState<ForwardItem[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q === null || noDms) return;
    const ctl = new AbortController();
    api.dms.candidates(q, ctl.signal).then(
      (r) => setFound({ q, users: r.users }),
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        log.warn('forward: dm candidates failed', e);
        setFound({ q, users: [] });
      },
    );
    return () => ctl.abort();
  }, [q, noDms]);

  // The room groups: the source room's workspace, or (from a DM) every workspace in rail order.
  const roomGroups = useMemo(() => {
    const ids = srcWs ? [srcWs] : order;
    const rooms = Object.values(byId);
    return ids.flatMap((wsId) => {
      const e = workspaces[wsId];
      if (!e || isSuspended(e.ws)) return [];
      const roles = rolesOf(e, myId);
      const items = roomItems(
        rooms.filter((r) => r.workspaceId === wsId),
        (r) => can(roomPerms(roles, myId, r), 'SEND_MESSAGES'),
        roomLabel,
      );
      return items.length ? [{ id: wsId, label: ids.length > 1 ? e.ws.name : t('chat.fwd.rooms'), items }] : [];
    });
  }, [srcWs, order, byId, workspaces, myId]);

  const people = useMemo(() => (noDms ? [] : userItems((found?.users ?? []).filter((u) => u.id !== myId), sharedRole)), [found, noDms, myId]);
  // «Заметки» first (ADR-0039): my shelves, the source shelf left out.
  const shelves = useNotes((s) => s.byRoom);
  const notes = useMemo(() => ({ label: t('chat.fwd.notes'), items: noDms ? [] : shelfItems(sortedShelves(shelves), roomId) }), [shelves, roomId, noDms]);
  const groups = useMemo(() => forwardGroups(people, roomGroups, q ?? '', t('chat.fwd.people'), notes), [people, roomGroups, q, notes]);
  const loading = !noDms && (found === null || found.q !== q);
  const onQuery = useCallback((next: string) => setQ(next), []);

  const pick = (item: ForwardItem): void => {
    const r = toggleTarget(selected, item);
    if (r.full) toast.error(t('chat.fwd.limit', { n: MAX_FORWARD_TARGETS }));
    setSelected(r.next);
  };
  const send = async (): Promise<void> => {
    if (!selected.length || sending) return;
    setSending(true);
    if (onSend) {
      await onSend(selected);
      setSending(false);
      onClose();
      return;
    }
    const r = await forwardMessage(roomId, messageId, selected);
    setSending(false);
    reportForward(r);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title ?? t('chat.fwd.title')}
      description={description ?? t('chat.fwd.hint')}
      initialFocus={input}
      fill
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!selected.length} busy={sending} onClick={() => void send()} data-testid="forward-send">
            {t('chat.fwd.send')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="forward-dialog">
        {src?.restricted ? (
          <p className="flex shrink-0 items-start gap-1.5 text-caption text-muted" data-testid="forward-restricted">
            <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
            {t('chat.fwd.restricted')}
          </p>
        ) : null}
        {selected.length ? (
          <ul className="flex shrink-0 flex-wrap gap-1.5" aria-label={t('chat.fwd.chosen')} data-testid="forward-chips">
            {selected.map((s) => (
              <li key={targetKey(s)} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-line pl-2.5 pr-1 text-caption text-fg">
                <span className="min-w-0 truncate">{s.name}</span>
                <button
                  type="button"
                  aria-label={t('chat.fwd.remove', { name: s.name })}
                  className={cx(CLOSE_HIT, 'grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg')}
                  onClick={() => setSelected((cur) => cur.filter((x) => targetKey(x) !== targetKey(s)))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="-mx-2 flex min-h-0 flex-1 flex-col">
          <PickerPanel<ForwardItem>
            groups={groups}
            onQuery={onQuery}
            loading={loading}
            emptyText={t('picker.empty')}
            onSelect={pick}
            placeholder={t('chat.fwd.search')}
            label={t('chat.fwd.title')}
            alwaysHeaders
            height={264}
            fill
            inputRef={input}
            autoFocus={false}
            renderItem={(item, active) => {
              const mark = isSelected(selected, item) ? (
                <>
                  <Check className={cx('size-4 shrink-0', active ? '' : 'text-accent-text')} aria-hidden />
                  <span className="sr-only">{t('chat.fwd.picked')}</span>
                </>
              ) : null;
              return item.kind === 'room' ? <RoomRow item={item} active={active} trailing={mark} /> : <MemberPickRow item={item} active={active} trailing={mark} />;
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

function RoomRow({ item, active, trailing }: { item: RoomPickItem; active: boolean; trailing: ReactNode }): ReactNode {
  return (
    <>
      <span className={cx('grid size-6 shrink-0 place-items-center leading-none', active ? '' : 'text-muted')} aria-hidden>
        {item.emoji ? <span className="text-[16px]">{item.emoji}</span> : item.notes ? <NotebookText className="size-4" /> : <RoomIcon roomId={item.roomId} size={16} />}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium" title={item.name}>
        {item.name}
      </span>
      {trailing}
    </>
  );
}
