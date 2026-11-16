import type { ru } from './ru';

/** Locales with a dictionary (ADR-0022). `ru` is the source of truth for keys and types. */
export const LOCALES = ['ru', 'en', 'es', 'zh-CN', 'de'] as const;
export type Locale = (typeof LOCALES)[number];
/** Language names in the language itself (the picker shows them the same in every UI language). */
export const LOCALE_NAMES: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
  es: 'Español',
  'zh-CN': '中文（简体）',
  de: 'Deutsch',
};

/** The user's choice in «Настройки → Основное → Язык»; 'auto' = follow the OS. */
export type LocalePref = 'auto' | Locale;

/**
 * Forms of a plural key, by `Intl.PluralRules` category. `other` is always required; a locale
 * lists the categories its language uses (ru: one/few/many/other, en/es: one/other, zh: other).
 */
export interface PluralForms {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/** The shape of a dictionary (or of one area file): same keys as `ru`, plural keys stay plural. */
export type DictShape<T> = { readonly [K in keyof T]: T[K] extends string ? string : PluralForms };

export type Dict = DictShape<typeof ru>;

/** Keys of plain strings (`t`). */
export type MessageKey = { [K in keyof Dict]: Dict[K] extends string ? K : never }[keyof Dict];
/** Keys of plural forms (`plural`). */
export type PluralKey = Exclude<keyof Dict, MessageKey>;
