import type { ruFormer } from '../ru/former';
import type { DictShape } from '../types';

/** UI strings — former members and guests (ADR-0097, ADR-0098). */
export const esFormer: DictShape<typeof ruFormer> = {
  'former.chip': 'antiguo',
  'former.since': 'Se fue el {date}',
  'former.profile': 'Antiguo miembro · {what} {date}',
  'former.profileNoDate': 'Antiguo miembro',
  'former.reason.left': 'se fue',
  'former.reason.removed': 'expulsado',
  'former.reason.banned': 'vetado',
  'former.reason.guestExpired': 'acceso de invitado caducado',
  'former.reason.directory': 'desactivado en el directorio',
  'former.tab': 'Antiguos',
  'former.card': 'Antiguos miembros — {n}',
  'former.none': 'No hay antiguos miembros',
  'former.search': 'Buscar por nombre',
  'former.showGuests': 'Mostrar invitados',
  'former.guestsHint': 'Los invitados sin actividad se eliminan a las 48 h',
  'former.openTasks': 'Tareas abiertas: {n}',
  'former.openTasksOpen': 'Tareas abiertas: {n}',
  'former.invite': 'Invitar de nuevo',
  'former.inviteFor': 'Invitar de nuevo a {name}',
  'former.more': 'Mostrar más',
  'former.by': 'por {who}',
  'former.reassign': 'Reasignar',
  'former.filter': 'Responsable: antiguos miembros',
  'former.filterValue': 'Antiguos miembros',
  'former.guestsGroup': 'Invitados · {n}',
  'former.seen': 'visto {when}',
  'former.noActions': 'Tus mensajes directos con esta persona siguen en Directos',
};
