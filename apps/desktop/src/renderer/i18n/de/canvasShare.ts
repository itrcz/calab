import type { ruCanvasShare } from '../ru/canvasShare';
import type { DictShape } from '../types';

/** The public read-only link of a canvas (ADR-0127 wave 5). Same keys and placeholders as ru/canvasShare.ts. */
export const deCanvasShare: DictShape<typeof ruCanvasShare> = {
  'canvasShare.tabs': 'Zugang zur Leinwand',
  'canvasShare.tab.access': 'Zugang',
  'canvasShare.tab.link': 'Link',
  'canvasShare.link.on': 'Zugang per Link',
  'canvasShare.link.hint': 'Jeder, der über den Link verfügt, sieht die Leinwand, ohne sich anzumelden, kann sie jedoch nicht bearbeiten oder sehen, wer sich darauf befindet',
  'canvasShare.link.private': 'Eine private Leinwand kann nicht per Link geöffnet werden. Deaktivieren Sie „Nur ausgewählte Personen“ auf der Registerkarte „Zugriff“, um den Link zu aktivieren.',
  'canvasShare.link.views': 'Aufrufe: {n}',
  'canvasShare.err.link': 'Der Link konnte nicht geändert werden',
  'canvasShare.public.readOnly': 'Nur ansehen',
  'canvasShare.public.gone': 'Leinwand nicht verfügbar',
  'canvasShare.public.goneText': 'Der Link wurde widerrufen oder ist abgelaufen oder die Leinwand wurde privat gemacht oder gelöscht.',
  'canvasShare.public.busy': 'Zu viele Zuschauer aus Ihrem Netzwerk. Versuchen Sie es später noch einmal',
};
