import { RoomType } from '@calaba/protocol';

/**
 * Voice rooms: joining and reading their chat without joining (docs/09 #14).
 *
 * A click on a voice room's row opens its chat and never joins (owner, 02.10); the row's «Войти»
 * button (hover / focus on desktop, always on touch; hidden when the room is full, except for the workspace owner) joins. A call in another
 * room stays as it is until a join. The chat header of such a room says «Вы не в голосе» and
 * offers «Войти в голос», which goes through the same `joinOutcome` as the row's button.
 */

/** What «join this voice room» does: nothing (already in / no right), join, or «Комната заполнена». */
export type JoinOutcome = 'none' | 'join' | 'full';

export function joinOutcome(o: { inRoom: boolean; canConnect: boolean; owner: boolean; people: number; limit: number }): JoinOutcome {
  if (o.inRoom || !o.canConnect) return 'none';
  // Only the workspace owner may enter a full room, admins and moderators may not (owner, 07.10); the server enforces the same rule.
  if (o.limit > 0 && o.people >= o.limit && !o.owner) return 'full';
  return 'join';
}

/**
 * The row's «Войти»: shown only when joining would succeed (not in the room, CONNECT, and the
 * room is not full unless I am the workspace owner). Visible always on touch, otherwise on hover / focus,
 * so the room name keeps the row width (docs/08).
 */
export function joinButton(o: { inRoom: boolean; canConnect: boolean; owner: boolean; people: number; limit: number; touch: boolean }): { shown: boolean; always: boolean } {
  return { shown: joinOutcome(o) === 'join', always: o.touch };
}

/** The open room is a voice room whose chat I read without being in its voice. */
export function isVoicePreview(room: { id: string; type: RoomType } | undefined, voiceRoomId: string | null): boolean {
  return room !== undefined && room.type === RoomType.VOICE && voiceRoomId !== room.id;
}
