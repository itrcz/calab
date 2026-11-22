import type { ruFormer } from '../ru/former';
import type { DictShape } from '../types';

/** UI strings — former members and guests (ADR-0097, ADR-0098). */
export const deFormer: DictShape<typeof ruFormer> = {
  'former.chip': 'ehemalige',
  'former.since': 'Verlassen {date}',
  'former.profile': 'Ehemaliges Mitglied · {what} {date}',
  'former.profileNoDate': 'Ehemaliges Mitglied',
  'former.reason.left': 'links',
  'former.reason.removed': 'entfernt',
  'former.reason.banned': 'verboten',
  'former.reason.guestExpired': 'Gastzugang abgelaufen',
  'former.reason.directory': 'im Verzeichnis deaktiviert',
  'former.reason.accountDeleted': 'Konto gelöscht',
  'former.tab': 'Ehemalige',
  'former.card': 'Ehemalige Mitglieder – {n}',
  'former.none': 'Keine ehemaligen Mitglieder',
  'former.search': 'Suche nach Namen',
  'former.showGuests': 'Gäste anzeigen',
  'former.guestsHint': 'Gäste ohne Aktivität werden nach 48 Stunden entfernt',
  'former.openTasks': 'Offene Aufgaben: {n}',
  'former.openTasksOpen': 'Offene Aufgaben: {n}',
  'former.invite': 'Nochmals einladen',
  'former.inviteFor': 'Laden Sie {name} erneut ein',
  'former.more': 'Mehr anzeigen',
  'former.by': 'von {who}',
  'former.reassign': 'Neu zuweisen',
  'former.filter': 'Bevollmächtigter: ehemalige Mitglieder',
  'former.filterValue': 'Ehemalige Mitglieder',
  'former.guestsGroup': 'Gäste · {n}',
  'former.seen': 'gesehen {when}',
  'former.noActions': 'Ihre Direktnachrichten mit ihnen bleiben in Direct',
};
