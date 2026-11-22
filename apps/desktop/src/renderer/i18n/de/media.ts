import type { ruMedia } from '../ru/media';
import type { DictShape } from '../types';

/** English UI strings — audio / video player in the chat (docs/08). Same keys as ru/media.ts. */
export const deMedia: DictShape<typeof ruMedia> = {
  'media.audio': 'Audio „{name}“',
  'media.video': 'Video „{name}“',
  'media.play': 'Spielen',
  'media.pause': 'Pause',
  'media.seek': 'Suchen',
  'media.position': '{pos} von {total}',
  'media.speed': 'Geschwindigkeit: {rate}',
  'media.fullscreen': 'Vollbild',
  'media.pip': 'Bild im Bild',
  'media.nowPlaying': 'Jetzt spielen',
  'media.jump': 'Nachricht anzeigen',
  'media.close': 'Spieler schließen',
  'media.error': 'Diese Datei kann nicht abgespielt werden',
  'media.voice': 'Sprachnachricht',
  'media.voiceDownload': 'Laden Sie die Sprachnachricht herunter: Dieser Browser kann Ogg/Opus nicht abspielen',
  'media.voiceRecord': 'Sprachnachricht: Zum Aufnehmen gedrückt halten',
  'media.voiceHoldHint': 'Halten Sie die Mikrofontaste gedrückt, um eine Sprachnachricht aufzunehmen',
  'media.voiceRecording': 'Aufzeichnen einer Sprachnachricht',
  'media.voiceSlideCancel': 'Zum Abbrechen nach links schieben',
  'media.voiceSlideCancelEsc': 'Zum Abbrechen nach links schieben oder Esc drücken',
};
