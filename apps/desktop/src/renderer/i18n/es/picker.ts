import type { ruPicker } from '../ru/picker';
import type { DictShape } from '../types';

/** UI strings (es) — the member / room picker and the room invite dialog (docs/09 #33). */
export const esPicker: DictShape<typeof ruPicker> = {
  'picker.empty': "No se encontró a nadie",
  'picker.noRooms': "No se encontraron salas",
  'picker.searchPeople': "Nombre, apodo, email o teléfono",
  'picker.searchRooms': "Buscar una sala",
  'picker.roles': "Roles",
  'picker.members': "Miembros",
  'picker.guests': "Invitados · {n}",
  'picker.rooms': "Salas",
  'picker.fullAccess': "acceso total",
  'picker.alwaysFull': "Siempre acceso total: los ajustes de la sala no se aplican a este rol",
  'picker.listed': "en la lista",
  'roomInvite.title': "Invitar a {room}",
  'roomInvite.hint': "Recibirá un mensaje directo con el enlace a la sala.",
  'roomInvite.send': "Invitar",
  'roomInvite.sent': "Enviado",
  'roomInvite.inRoom': "ya está aquí",
  'roomInvite.dmText': "Te invito a {room}: {link}",
  'roomInvite.failed': "No se pudo enviar la invitación",
  'roomInvite.link': "O envía un enlace",
  'roomInvite.copy': "Copiar",
};
