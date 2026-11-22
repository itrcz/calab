import type { ruDm } from '../ru/dm';
import type { DictShape } from '../types';

/**
 * English UI strings — direct messages (ADR-0020, ADR-0022). Same rules as ru: flat dotted keys,
 * `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const deDm: DictShape<typeof ruDm> = {
  'dm.home': 'Direktnachrichten',
  'dm.homeUnread': 'Direktnachrichten, ungelesen: {n}',
  'dm.list': 'Direktnachrichten',
  'dm.new': 'Neue Nachricht',
  'dm.empty': 'Noch keine Direktnachrichten',
  'dm.emptyHint': 'Einem Teamkollegen eine Nachricht senden: Verwenden Sie „Neue Nachricht“, sein Profil oder das Mitgliedermenü.',
  'dm.pickTitle': 'Direktnachrichten',
  'dm.pickText': 'Wählen Sie links eine Konversation aus oder beginnen Sie eine neue.',
  'dm.you': 'Du',
  'dm.noMessages': 'Keine Nachrichten',
  'dm.placeholder': 'Nachricht @{name}',
  'dm.searchIn': 'Suche im Gespräch',
  'dm.searchMessages': 'Nachrichten durchsuchen',
  'dm.searchChats': 'Chats',
  'dm.searchFailed': 'Die Suche ist fehlgeschlagen. Versuchen Sie es erneut.',
  'dm.write': 'Nachricht',
  'dm.welcomeText': 'Dies ist der Beginn Ihres Direktnachrichtenverlaufs.',
  'dm.markRead': 'Als gelesen markieren',
  'dm.copyLink': 'Link kopieren',
  'dm.linkCopied': 'Link kopiert',
  'dm.chat': 'Gespräch mit {name}',
  // “New message”
  'dm.newTitle': 'Neue Nachricht',
  'dm.newSearch': 'Name oder Spitzname',
  'dm.newHint': 'Sie können Mitgliedern Ihrer Arbeitsbereiche Nachrichten senden.',
  'dm.newEmpty': 'Niemand gefunden',
  'dm.newFailed': 'Die Liste konnte nicht geladen werden',
  // errors of POST /api/dms
  'dm.errRateLimited': 'Zu viele neue Gespräche – versuchen Sie es später noch einmal',
  'dm.errGuest': 'Direktnachrichten stehen Gästen nicht zur Verfügung',
  'dm.errNoCommon': 'Sie teilen keinen Arbeitsbereich mit dieser Person',
  'dm.errSelf': 'Sie können sich keine Nachrichten senden',
  'dm.errCreate': 'Das Gespräch konnte nicht gestartet werden',
  // a /dm/<id> link of someone else's (or a deleted) conversation
  'dm.errLink': 'Diese Konversation ist nicht verfügbar: Sie gehört nicht Ihnen oder wurde gelöscht',
  // archive and «delete for me» (docs/09 #51)
  'dm.archive': 'Archiv',
  'dm.unarchive': 'Dearchivieren',
  'dm.archiveSection': 'Archiv — {n}',
  'dm.deleteTitle': 'Chat löschen?',
  'dm.deleteConfirm': 'Der Verlauf wird nur für Sie gelöscht; die andere Person behält es.',
  'dm.errState': 'Konversation konnte nicht aktualisiert werden',
  'dm.actions': 'Konversationsaktionen',
  // quick switcher
  'search.dms': 'Direktnachrichten',
};
