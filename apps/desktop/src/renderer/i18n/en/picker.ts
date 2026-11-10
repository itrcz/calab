import type { ruPicker } from '../ru/picker';
import type { DictShape } from '../types';

/** UI strings (en) — the member / room picker and the room invite dialog (docs/09 #33). */
export const enPicker: DictShape<typeof ruPicker> = {
  'picker.empty': "No one found",
  'picker.noRooms': "No rooms found",
  'picker.searchPeople': "Name, nickname, email or phone",
  'picker.searchRooms': "Find a room",
  'picker.roles': "Roles",
  'picker.members': "Members",
  'picker.guests': "Guests · {n}",
  'picker.rooms': "Rooms",
  'picker.fullAccess': "full access",
  'picker.alwaysFull': "Always full access: room settings don’t apply to this role",
  'picker.listed': "listed",
  'roomInvite.title': "Invite to {room}",
  'roomInvite.hint': "They’ll get a direct message with a link to the room.",
  'roomInvite.send': "Invite",
  'roomInvite.sent': "Sent",
  'roomInvite.inRoom': "already here",
  'roomInvite.dmText': "Join me in {room}: {link}",
  'roomInvite.failed': "Couldn’t send the invite",
  'roomInvite.link': "Or send a link",
  'roomInvite.copy': "Copy",
};
