/**
 * ⌘K result actions (docs/09 #66, #83): what a row does. The row itself only selects — the
 * actions are its buttons, and the keys do the same: Enter — the first one, ⇧Enter — the second
 * one (⌘Enter is «Все результаты», ADR-0062 §4).
 *   voice room (I may connect): «Подключиться», «Открыть чат» (the chat without joining);
 *   voice room without CONNECT, text room: «Открыть чат»;
 *   DM: «Написать»; member: «Сообщения» (filter by author) and «Написать» (if a DM is allowed);
 *   message: «Открыть». A person I may call (ADR-0034) also gets «Позвонить» after «Написать» —
 *   a button only, never on a key (a call must not start by a stray ⇧Enter).
 */

export type SwitcherAction = 'join' | 'chat' | 'write' | 'call' | 'filter' | 'open';

/** The part of a row that decides its actions. */
export interface SwitcherRowKind {
  kind: 'dm' | 'room' | 'member' | 'message';
  voice?: boolean;
  /** CONNECT in that voice room: without it the only action is to read its chat. */
  canConnect?: boolean;
  /** A member I may write to (canDmWith). */
  canDm?: boolean;
  /** A person I may call (canCallWith, ADR-0034): member and DM rows. */
  canCall?: boolean;
}

const JOIN_CHAT: readonly SwitcherAction[] = ['join', 'chat'];
const CHAT: readonly SwitcherAction[] = ['chat'];
const WRITE: readonly SwitcherAction[] = ['write'];
const WRITE_CALL: readonly SwitcherAction[] = ['write', 'call'];
const FILTER_WRITE: readonly SwitcherAction[] = ['filter', 'write'];
const FILTER_WRITE_CALL: readonly SwitcherAction[] = ['filter', 'write', 'call'];
const FILTER: readonly SwitcherAction[] = ['filter'];
const OPEN: readonly SwitcherAction[] = ['open'];

/** The row's actions (its buttons), the Enter one first. */
export function rowActions(r: SwitcherRowKind): readonly SwitcherAction[] {
  if (r.kind === 'room') return r.voice && r.canConnect ? JOIN_CHAT : CHAT;
  if (r.kind === 'dm') return r.canCall ? WRITE_CALL : WRITE;
  if (r.kind === 'member') return r.canDm ? (r.canCall ? FILTER_WRITE_CALL : FILTER_WRITE) : FILTER;
  return OPEN;
}

/** Enter — the first action; ⇧Enter — the second one, if the row has it. */
export function keyAction(r: SwitcherRowKind, keys: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }): SwitcherAction {
  const acts = rowActions(r).filter((a) => a !== 'call');
  return (keys.shiftKey ? acts[1] : undefined) ?? acts[0] ?? 'open';
}
