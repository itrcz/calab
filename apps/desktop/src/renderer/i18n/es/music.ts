import type { enMusic } from '../en/music';
import type { DictShape } from '../types';

/** Spanish UI strings — musician mode (ADR-0052, docs/02, docs/08). Same keys as en/music.ts. */
export const esMusic: DictShape<typeof enMusic> = {
  'music.mode': 'Modo músico',
  'music.hint': 'Sonido en vivo de instrumentos y voz: sin cancelación de eco ni supresión de ruido, sin ganancia automática, en alta calidad, el micrófono no se apaga en las pausas. Solo con auriculares.',
  'music.warnHeadphones': 'Necesitas auriculares: sin cancelación de eco los demás se oirán a sí mismos.',
  'music.warnSpeakers': 'El sonido sale por los altavoces ({device}). Sin cancelación de eco los demás se oirán a sí mismos: ponte los auriculares.',
  'music.echoRisk': 'Los demás se oyen a sí mismos: el modo músico no tiene cancelación de eco. Ponte los auriculares o desactiva el modo',
  'music.turnOff': 'Desactivar el modo músico',
  'music.off': 'Desactivar',
  'music.badge': 'Músico',
  'music.badgeHint': 'Modo músico: sonido sin procesar',
  'music.rnnoiseOff': 'Desactivado en el modo músico',
  'music.audioOnly': 'El modo músico aún no está disponible en iPhone',
  'music.aecNote': 'Modo músico: la cancelación de eco, la supresión de ruido y la ganancia automática están desactivadas.',
  'music.stats': 'músico',
};
