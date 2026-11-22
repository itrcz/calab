import type { ruContacts } from '../ru/contacts';
import type { DictShape } from '../types';

/** English UI strings — contacts and nickname in the profile (ADR-0077). Same keys as ru/contacts.ts. */
export const deContacts: DictShape<typeof ruContacts> = {
  'people.contacts.title': 'Kontakte',
  'people.contacts.email': 'E-Mail',
  'people.contacts.phone': 'Telefon',
  'people.contacts.unverified': 'nicht verifiziert',
  'people.contacts.copyWhat': 'Kopieren: {what}',
  'people.contacts.copied': 'Kopiert',
  'people.contacts.copyFailed': 'Konnte nicht kopiert werden',
  'profile.username': 'Benutzername',
  'profile.username.hint': 'Für @Erwähnungen eine für alle Arbeitsbereiche',
  'profile.username.placeholder': 'ivan_petrov',
  'profile.username.checking': 'Überprüfen…',
  'profile.username.free': 'Benutzername ist verfügbar',
  'profile.username.taken': 'Dieser Benutzername ist vergeben',
  'profile.username.invalid': '3 bis 32 lateinische Buchstaben, Ziffern und _, beginnend mit einem Buchstaben',
  'profile.username.reserved': 'Dieser Benutzername ist reserviert',
  'profile.phone': 'Telefon',
  'profile.phone.hint': 'Für Ihre Workspace-Kollegen sichtbar, nicht verifiziert',
  'profile.phone.placeholder': '+1 555 123-4567',
  'profile.phone.invalid': 'Nur Ziffern, +, Leerzeichen, Klammern und Bindestriche, bis zu 32 Zeichen',
};
