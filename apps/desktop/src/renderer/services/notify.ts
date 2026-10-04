import { CallOutcome, PresenceStatus, levelNotifies, type Message, type Room } from '@calaba/protocol';
import { chatSound } from '../lib/chatSound';
import { mentionsMe } from '../lib/mentions';
import { achievementForMe } from '../lib/achievements';
import { playSound } from '../lib/sounds';
import { useInbox } from '../stores/inbox';
import { prefs } from '../stores/prefs';
import { mayMentionAll } from '../lib/permissions';
import { HOME, isDm } from '../stores/dms';
import { effectiveNotify, useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { memberName, rolesOf, useWorkspaces } from '../stores/workspaces';
import { platform } from '../platform';
import { onceAcrossTabs, type CrossTabDeps } from '../lib/crossTab';
import { previewText } from '../features/chat/mentionText';
import { roomLabel } from '../features/chat/roomLabel';
import { t } from '../i18n';
import { systemPreview } from '../lib/recording';
import { callCardOf } from '../lib/callModel';

export { mentionsMe };

/** Web: browser tabs share the auth session and all get the message (#40) — notify in one. */
const tabs: CrossTabDeps = {
  get locks() {
    // Web Locks exist only in secure contexts (https, localhost).
    return platform.kind === 'web' && typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
  },
  hidden: () => document.visibilityState === 'hidden',
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
};

export interface NotifyDecision {
  dm: boolean;
  /** A mention of me, or any DM message (ADR-0020). */
  mention: boolean;
  /**
   * The effective level lets it make a sound / a system notification (docs/09 item 22): a DM,
   * a mention, or a room at «Все сообщения» (its own level, or its workspace's through
   * «Как в пространстве»); never a muted room / workspace or level NONE.
   */
  notify: boolean;
}

/** What an incoming message of someone else is to me, by the effective notification level. */
export function shouldNotify(m: Message, workspaceId: string, now = Date.now()): NotifyDecision {
  const myId = useSession.getState().me?.user?.id ?? '';
  const rooms = useRooms.getState();
  const room = rooms.byId[m.roomId];
  const dm = isDm(room) || (!workspaceId && !room);
  const authorRole = rolesOf(useWorkspaces.getState().byId[workspaceId], m.authorId);
  const mention = dm || mentionsMe(m, myId, mayMentionAll(authorRole, m.authorId, room));
  const eff = effectiveNotify(m.roomId, rooms, now);
  const notify = levelNotifies({
    dm,
    mention,
    room: eff.room.level,
    workspace: eff.workspace.level,
    roomMuted: eff.room.mutedUntil !== null,
    workspaceMuted: eff.workspace.mutedUntil !== null,
  });
  return { dm, mention, notify };
}

/**
 * Unread counters, mention badges, sounds and system notifications for a message from someone
 * else. Counters always count; sounds and notifications follow shouldNotify. A DM message
 * (ADR-0020) notifies like a mention but never goes to the mentions inbox.
 */
export function onIncomingMessage(m: Message, workspaceId: string, visible: boolean): void {
  // A DM call log line (ADR-0034): only a missed call is news — unread, a sound, «Пропущенный
  // звонок» from the caller; the other outcomes are read by both sides at once (the server).
  const call = callCardOf(m);
  if (call && call.outcome !== CallOutcome.MISSED) return;
  const myId = useSession.getState().me?.user?.id ?? '';
  const room = useRooms.getState().byId[m.roomId];
  const { dm, mention, notify } = shouldNotify(m, workspaceId);
  if (mention && !dm) useInbox.getState().addLive(m);
  const p = prefs();
  // Sounds (docs/09 #29, P1 #13, item 22): «Упоминание» for a mention / DM, «Новое сообщение»
  // only in rooms at «Все сообщения»; the open chat is quiet or silent.
  const sound = chatSound({
    // My achievement card (ADR-0061) is authored by me, yet it is news: it sounds like a mention.
    own: m.authorId === myId && !achievementForMe(m, myId),
    mention,
    visible,
    notify,
    // «Не беспокоить»: counters only, no sounds or notifications (mentions and DMs included).
    dnd: p.presence === PresenceStatus.DND,
    openChat: p.messageSoundOpenChat,
  });
  // Badges count regardless of the notification settings (chat on screen: the read marker
  // moves when it is seen).
  if (!visible) useRooms.getState().addUnread(m.roomId, m.id, mention);
  const system = !visible && notify && p.presence !== PresenceStatus.DND && ((mention && p.notifyMentions) || p.notifyAll);
  // A tab showing the chat claims the message even when it stays quiet, so another tab does
  // not notify about what is on screen.
  if (!sound && !system && !visible) return;
  onceAcrossTabs(`msg:${m.id}`, tabs, () => {
    if (sound) playSound(sound.name, { volume: sound.volume });
    if (system) showMessageNotification(m, workspaceId, room, dm);
  });
}

function showMessageNotification(m: Message, workspaceId: string, room: Room | undefined, dm: boolean): void {
  const author = memberName(workspaceId || null, m.authorId);
  const body = systemPreview(m, author) || previewText(workspaceId || null, m.content).slice(0, 180) || (m.attachments.length ? t('notify.attachment') : '');
  try {
    // A DM is titled with its author alone (the chat is them).
    const n = new Notification(`${author}${room && !dm ? ` · ${roomLabel(room)}` : ''}`, { body, silent: true, tag: m.roomId });
    n.onclick = () => {
      window.focus();
      useUi.getState().openRoom(dm ? HOME : workspaceId, m.roomId);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}
