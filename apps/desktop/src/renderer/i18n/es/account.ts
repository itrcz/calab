import type { ruAccount } from '../ru/account';
import type { DictShape } from '../types';

/** UI strings (Spanish) — account deletion (ADR-0153). */
export const esAccount: DictShape<typeof ruAccount> = {
  'account.delete.card': 'Eliminar cuenta',
  'account.delete.row': 'Eliminar cuenta',
  'account.delete.rowHint': 'De inmediato y para siempre. Los mensajes en los espacios de trabajo se quedan, firmados «Usuario eliminado».',
  'account.delete.open': 'Eliminar…',
  'account.delete.title': '¿Eliminar tu cuenta?',
  'account.delete.text': 'La cuenta se elimina de inmediato y para siempre: no se podrá recuperar.',
  'account.delete.goneTitle': 'Se elimina',
  'account.delete.goneProfile': 'Perfil: nombre, correo, contraseña, avatar, usuario, teléfono, cumpleaños',
  'account.delete.goneSessions': 'Las sesiones en todos los dispositivos y sus notificaciones',
  'account.delete.gonePersonal': 'Notas personales, notas sobre personas, el calendario conectado, el acceso de aplicaciones',
  'account.delete.staysTitle': 'Se conserva',
  'account.delete.stays': 'Los mensajes, tareas y archivos en espacios de trabajo y mensajes directos se quedan con sus miembros, como «Usuario eliminado».',
  'account.delete.ownerTitle': 'Primero elimina tus espacios de trabajo',
  'account.delete.ownerText': 'Elimina el espacio de trabajo en su configuración o escribe a support@calab.io para transferir la propiedad.',
  'account.delete.confirm': 'Eliminar para siempre',
  'account.delete.done': 'Cuenta eliminada',
};
