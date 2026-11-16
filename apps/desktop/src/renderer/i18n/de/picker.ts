import type { ruPicker } from '../ru/picker';
import type { DictShape } from '../types';

/** UI strings (en) — the member / room picker and the room invite dialog (docs/09 #33). */
export const dePicker: DictShape<typeof ruPicker> = {
  'picker.empty': "Niemand gefunden",
  'picker.noRooms': "Keine Zimmer gefunden",
  'picker.searchPeople': "Name, Spitzname, E-Mail oder Telefon",
  'picker.searchRooms': "Finden Sie ein Zimmer",
  'picker.roles': "Rollen",
  'picker.members': "Mitglieder",
  'picker.guests': "Gäste · {n}",
  'picker.rooms': "Zimmer",
  'picker.fullAccess': "voller Zugriff",
  'picker.alwaysFull': "Immer voller Zugriff: Raumeinstellungen gelten nicht für diese Rolle",
  'picker.listed': "aufgeführt",
  'roomInvite.title': "In {room} einladen",
  'roomInvite.hint': "Sie erhalten eine Direktnachricht mit einem Link zum Raum.",
  'roomInvite.send': "Einladen",
  'roomInvite.sent': "Gesendet",
  'roomInvite.inRoom': "schon da",
  'roomInvite.dmText': "Begleiten Sie mich im {room}: {link}",
  'roomInvite.failed': "Die Einladung konnte nicht gesendet werden",
  'roomInvite.link': "Oder senden Sie einen Link",
  'roomInvite.copy': "Kopieren",
};
