import type { enDm } from '../en/dm';
import type { DictShape } from '../types';

/**
 * Spanish UI strings — direct messages (ADR-0020, ADR-0022). Same rules as en: flat dotted keys,
 * `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const esDm: DictShape<typeof enDm> = {
  'dm.home': 'Mensajes directos',
  'dm.homeUnread': 'Mensajes directos, sin leer: {n}',
  'dm.list': 'Mensajes directos',
  'dm.new': 'Nuevo mensaje',
  'dm.empty': 'Todavía no hay mensajes directos',
  'dm.emptyHint': 'Escribe a un compañero: usa «Nuevo mensaje», su perfil o el menú del miembro.',
  'dm.pickTitle': 'Mensajes directos',
  'dm.pickText': 'Elige una conversación a la izquierda o inicia una nueva.',
  'dm.you': 'Tú',
  'dm.noMessages': 'Sin mensajes',
  'dm.placeholder': 'Mensaje a @{name}',
  'dm.searchIn': 'Buscar en la conversación',
  'dm.searchMessages': 'Buscar en mensajes',
  'dm.searchChats': 'Chats',
  'dm.searchFailed': 'La búsqueda falló. Inténtalo de nuevo.',
  'dm.write': 'Escribir',
  'dm.welcomeText': 'Aquí comienza el historial de tus mensajes directos.',
  'dm.markRead': 'Marcar como leído',
  'dm.copyLink': 'Copiar enlace',
  'dm.linkCopied': 'Enlace copiado',
  'dm.chat': 'Conversación con {name}',
  // “New message”
  'dm.newTitle': 'Nuevo mensaje',
  'dm.newSearch': 'Nombre o apodo',
  'dm.newHint': 'Puedes escribir a miembros de tus espacios.',
  'dm.newEmpty': 'No se encontró a nadie',
  'dm.newFailed': 'No se pudo cargar la lista',
  // errors of POST /api/dms
  'dm.errRateLimited': 'Demasiadas conversaciones nuevas — inténtalo más tarde',
  'dm.errGuest': 'Los mensajes directos no están disponibles para invitados',
  'dm.errNoCommon': 'No compartes ningún espacio con esta persona',
  'dm.errSelf': 'No puedes enviarte un mensaje a ti mismo',
  'dm.errCreate': 'No se pudo iniciar la conversación',
  // a /dm/<id> link of someone else's (or a deleted) conversation
  'dm.errLink': 'Esta conversación no está disponible: no es tuya o fue eliminada',
  // archive and «delete for me» (docs/09 #51)
  'dm.archive': 'Archivar',
  'dm.unarchive': 'Desarchivar',
  'dm.archiveSection': 'Archivo — {n}',
  'dm.deleteTitle': '¿Eliminar el chat?',
  'dm.deleteConfirm': 'El historial se eliminará solo para ti; la otra persona lo conservará.',
  'dm.errState': 'No se pudo actualizar la conversación',
  'dm.actions': 'Acciones de la conversación',
  // quick switcher
  'search.dms': 'Mensajes directos',
} as const;
