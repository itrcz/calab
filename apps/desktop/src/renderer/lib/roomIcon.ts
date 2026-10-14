import { RoomType, type Room } from '@calaba/protocol';

/** What a room looks like when it is not in the store (a search hit, a link preview). */
export type RoomIconInfo = Pick<Room, 'type' | 'isPrivate' | 'iconFileId'> & { temp?: boolean };

export type RoomGlyph = 'text' | 'voice' | 'temp';

type RoomsById = { byId: Record<string, Room> };

/*
 * The selectors of components/RoomIcon (ADR-0092): primitives by room id, so a ROOM_UPDATE of one
 * room re-renders only that room's icon (CLAUDE.md «Ререндеры»).
 */

/** The picture's file id ('' = the glyph). */
export const roomIconFile = (s: RoomsById, roomId: string, room?: RoomIconInfo): string => s.byId[roomId]?.iconFileId ?? room?.iconFileId ?? '';

/** The glyph of the room type: a temporary room (ADR-0044) has its timer. */
export function roomGlyph(s: RoomsById, roomId: string, room?: RoomIconInfo): RoomGlyph {
  const r = s.byId[roomId];
  if (r ? !!r.expiresAt : room?.temp) return 'temp';
  return (r ?? room)?.type === RoomType.VOICE ? 'voice' : 'text';
}

export const roomIsPrivate = (s: RoomsById, roomId: string, room?: RoomIconInfo): boolean => s.byId[roomId]?.isPrivate ?? room?.isPrivate ?? false;
