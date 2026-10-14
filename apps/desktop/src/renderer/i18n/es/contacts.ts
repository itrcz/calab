import type { enContacts } from '../en/contacts';
import type { DictShape } from '../types';

/** Spanish UI strings — contacts and nickname in the profile (ADR-0077). Same keys as en/contacts.ts. */
export const esContacts: DictShape<typeof enContacts> = {
  'people.contacts.title': 'Contactos',
  'people.contacts.email': 'Correo',
  'people.contacts.phone': 'Teléfono',
  'people.contacts.unverified': 'sin verificar',
  'people.contacts.copyWhat': 'Copiar: {what}',
  'people.contacts.copied': 'Copiado',
  'people.contacts.copyFailed': 'No se pudo copiar',
  'profile.username': 'Usuario',
  'profile.username.hint': 'Para menciones con @, uno para todos los espacios',
  'profile.username.placeholder': 'ivan_petrov',
  'profile.username.checking': 'Comprobando…',
  'profile.username.free': 'El usuario está disponible',
  'profile.username.taken': 'Este usuario ya está en uso',
  'profile.username.invalid': 'De 3 a 32 letras latinas, cifras y _, empezando por una letra',
  'profile.username.reserved': 'Este usuario está reservado',
  'profile.phone': 'Teléfono',
  'profile.phone.hint': 'Lo ven tus compañeros de espacio, no se verifica',
  'profile.phone.placeholder': '+34 600 123 456',
  'profile.phone.invalid': 'Solo cifras, +, espacios, paréntesis y guiones, hasta 32 caracteres',
};
