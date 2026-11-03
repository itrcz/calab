/**
 * When an incoming chat message makes a sound (docs/09 P1 #13). Pure: the caller gathers the
 * facts, services/notify.ts plays the result through lib/sounds (the rate limit lives there).
 */

/** «В открытом чате» — a message in the chat on screen (window focused): a quieter cue, or none. */
export type OpenChatSound = 'off' | 'quiet';

/** Volume multiplier of the quieter open-chat cue. */
export const OPEN_CHAT_QUIET_VOLUME = 0.35;

export interface ChatSoundFacts {
  /** The message is mine (another device of mine): never a sound. */
  own: boolean;
  /** A mention of me, or any DM message (ADR-0020). */
  mention: boolean;
  /** Its chat is open and the window has focus. */
  visible: boolean;
  /**
   * The room's effective level lets this message notify (services/notify.ts shouldNotify):
   * a DM, a mention, or a room at «Все сообщения»; never a muted room or workspace.
   */
  notify: boolean;
  /** Presence «Не беспокоить». */
  dnd: boolean;
  openChat: OpenChatSound;
}

export interface ChatSound {
  name: 'mention' | 'message';
  /** Multiplier on the user's sound volume. */
  volume: number;
}

export function chatSound(f: ChatSoundFacts): ChatSound | null {
  if (f.own || !f.notify || f.dnd) return null;
  const name = f.mention ? 'mention' : 'message';
  if (f.visible) return f.openChat === 'quiet' ? { name, volume: OPEN_CHAT_QUIET_VOLUME } : null;
  return { name, volume: 1 };
}

export interface TaskNoticeSoundFacts {
  /** The task is open on screen (window focused). */
  visible: boolean;
  /** The task's workspace is muted or at level NONE (stores/rooms.ts workspaceNotify). */
  workspaceQuiet: boolean;
  dnd: boolean;
  openChat: OpenChatSound;
}

/**
 * A task notice (ADR-0089) is addressed to me by the server (assignee, mention, approval, ...),
 * so it sounds like a mention — unless «Не беспокоить», a muted workspace, or the task is open.
 * Never for my own actions: the caller drops those before.
 */
export function taskNoticeSound(f: TaskNoticeSoundFacts): ChatSound | null {
  return chatSound({ own: false, mention: true, visible: f.visible, notify: !f.workspaceQuiet, dnd: f.dnd, openChat: f.openChat });
}
