import documents from '@/content/legal.json';
import globalDocuments from '@/content/legal-global.json';
import type { Locale } from '@/i18n/locales';

export const LEGAL_VERSION = '2026-10-09';
export type LegalDocumentId = keyof typeof documents;
type LegalDocument = { title: string; description: string; sections: { title: string; paragraphs: string[] }[] };
const globalEdition: Record<LegalDocumentId, LegalDocument> = globalDocuments;
export const getLegalDocuments = (locale: Locale): Record<LegalDocumentId, LegalDocument> => locale === 'ru' ? documents : globalEdition;
export const LEGAL_IDS = Object.keys(documents) as LegalDocumentId[];
export const isLegalDocument = (id: string): id is LegalDocumentId => Object.hasOwn(documents, id);
