import documents from '@/content/legal.json';

export const LEGAL_VERSION = '2026-10-09';
export const LEGAL_DATE = '9 октября 2026 года';
export const LEGAL_DOCUMENTS = documents;
export type LegalDocumentId = keyof typeof documents;
export const LEGAL_IDS = Object.keys(documents) as LegalDocumentId[];
export const isLegalDocument = (id: string): id is LegalDocumentId => Object.hasOwn(documents, id);
