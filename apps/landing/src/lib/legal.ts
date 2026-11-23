import documents from '@/content/legal.json';
import globalDocuments from '@/content/legal-global.json';
import type { Locale } from '@/i18n/locales';

// Edition date of all legal documents (published together). Must equal the actual publication (merge/deploy)
// date; bump it if the merge slips or the text changes again. Rendered by formatLegalEdition on every legal page.
export const LEGAL_VERSION = '2026-11-23';

/** «Редакция от 23 ноября 2026 г.» / «Updated 23 November 2026», from LEGAL_VERSION (UTC: no off-by-one). */
export const formatLegalEdition = (locale: Locale, version: string = LEGAL_VERSION): { label: string; date: string } => {
  const ru = locale === 'ru';
  const date = new Intl.DateTimeFormat(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${version}T00:00:00Z`));
  return { label: ru ? 'Редакция от ' : 'Updated ', date };
};
export type LegalDocumentId = keyof typeof documents;
type LegalDocument = { title: string; description: string; sections: { title: string; paragraphs: string[] }[] };
const globalEdition: Record<LegalDocumentId, LegalDocument> = globalDocuments;
export const getLegalDocuments = (locale: Locale): Record<LegalDocumentId, LegalDocument> => locale === 'ru' ? documents : globalEdition;
export const LEGAL_IDS = Object.keys(documents) as LegalDocumentId[];
export const isLegalDocument = (id: string): id is LegalDocumentId => Object.hasOwn(documents, id);

/**
 * The legal pages shown inside the native phone shell's "app mode" (#139, docs/adr/0148): `offer`
 * and `payments` are excluded everywhere in that mode — they carry prices and purchase terms, and a
 * store reviewer must not reach them from the app (Apple 3.1.1 / Play Payments policy risk).
 */
export const APP_LEGAL_IDS: LegalDocumentId[] = LEGAL_IDS.filter((id) => id !== 'offer' && id !== 'payments');
export const isAppLegalDocument = (id: string): id is LegalDocumentId => (APP_LEGAL_IDS as string[]).includes(id);
