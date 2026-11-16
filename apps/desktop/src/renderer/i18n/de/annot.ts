import type { ruAnnot } from '../ru/annot';
import type { DictShape } from '../types';

/** English UI strings — laser pointer and pen over a stream (ADR-0028). */
export const deAnnot: DictShape<typeof ruAnnot> = {
  'annot.tools': 'Zeichnen Sie auf den Stream',
  'annot.pointer': 'Zeiger',
  'annot.pen': 'Stift',
  'annot.color': 'Farbe',
  'annot.clear': 'Klar',
  'annot.clearAll': 'Löschen Sie die Zeichnungen der Betrachter',
  'annot.allowViewers': 'Zuschauer können zeichnen',
  'annot.hint.screen': 'Zeichnungen werden auf Ihrem Bildschirm angezeigt, nicht im Stream',
  'annot.hint.preview': 'Zeichnungen werden in der Vorschau Ihres Streams angezeigt',
  'annot.activity.pointer': '{name} zeigt',
  'annot.activity.stroke': '{name} zeichnet',
  'annot.showPreview': 'Zeigen',
  'annot.color.red': 'Rot',
  'annot.color.yellow': 'Gelb',
  'annot.color.green': 'Grün',
  'annot.color.blue': 'Blau',
  'annot.color.purple': 'Lila',
  'annot.color.white': 'Weiß',
};
