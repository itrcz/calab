import type { ruAccount } from '../ru/account';
import type { DictShape } from '../types';

/** UI strings — account deletion (ADR-0153). */
export const deAccount: DictShape<typeof ruAccount> = {
  'account.delete.card': 'Konto löschen',
  'account.delete.row': 'Konto löschen',
  'account.delete.rowHint': 'Sofort und für immer. Nachrichten im Arbeitsbereich bleiben mit der Signatur „Gelöschter Benutzer“ erhalten.',
  'account.delete.open': 'Löschen…',
  'account.delete.title': 'Konto löschen?',
  'account.delete.text': 'Das Konto wird sofort und endgültig gelöscht – eine Wiederherstellung ist nicht möglich.',
  'account.delete.goneTitle': 'Gelöscht',
  'account.delete.goneProfile': 'Profil: Name, E-Mail, Passwort, Avatar, Benutzername, Telefon, Geburtstag',
  'account.delete.goneSessions': 'Anmeldungen auf allen Geräten und deren Benachrichtigungen',
  'account.delete.gonePersonal': 'Persönliche Notizen, Notizen zu Personen, der verbundene Kalender, App-Zugriff',
  'account.delete.staysTitle': 'Behalten',
  'account.delete.stays': 'Nachrichten, Aufgaben und Dateien in Arbeitsbereichen und Direktnachrichten bleiben bei ihren Mitgliedern, nach „Gelöschter Benutzer“.',
  'account.delete.ownerTitle': 'Löschen Sie zuerst Ihren Arbeitsbereich',
  'account.delete.ownerText': 'Löschen Sie den Arbeitsbereich in seinen Einstellungen oder schreiben Sie an support@calab.io, um den Besitz zu übergeben.',
  'account.delete.confirm': 'Endgültig löschen',
  'account.delete.done': 'Konto gelöscht',
};
