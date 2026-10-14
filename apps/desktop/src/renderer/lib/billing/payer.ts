import { PayerFieldInput, PayerType, type PayerFieldSpec, type PayerReason } from '@calaba/protocol';
import { plural, t, type Locale, type MessageKey } from '../../i18n';

/**
 * The payer form's texts and country list (ADR-0080 §0.1). The rules come from the server's
 * schema (GET …/billing/payer-schema) and run in @calaba/protocol payer.ts; this file only names
 * things: requisite labels and hints, error reasons, countries in the UI language.
 */

/** Requisite key of the server schema → its label. A key without one is labelled «Tax ID». */
const FIELD_LABEL: Record<string, MessageKey> = {
  inn: 'billing.payer.field.inn',
  kpp: 'billing.payer.field.kpp',
  ogrn: 'billing.payer.field.ogrn',
  ogrnip: 'billing.payer.field.ogrnip',
  legal_address: 'billing.payer.field.legal_address',
  address: 'billing.payer.field.address',
  trn: 'billing.payer.field.trn',
  trade_license: 'billing.payer.field.trade_license',
  vat: 'billing.payer.field.vat',
  ein: 'billing.payer.field.ein',
  iin: 'billing.payer.field.iin',
  bin: 'billing.payer.field.bin',
  unp: 'billing.payer.field.unp',
  uscc: 'billing.payer.field.uscc',
  gstin: 'billing.payer.field.gstin',
  tax_id: 'billing.payer.field.tax_id',
};

/** Keys with their own label (tests: every key of the served schema is here). */
export const PAYER_FIELD_KEYS: readonly string[] = Object.keys(FIELD_LABEL);

export function fieldLabel(key: string): string {
  return t(FIELD_LABEL[key] ?? 'billing.payer.field.tax_id');
}

/** The label of a form field: «ИНН», or «ИНН (необязательно)» for an optional one. */
export function fieldTitle(f: PayerFieldSpec): string {
  const label = fieldLabel(f.key);
  return f.required ? label : t('billing.payer.optional', { label });
}

/**
 * A short format hint: «10 цифр» for a fixed digit count, «9 символов» for a code, the VAT
 * prefix the server adds by itself; nothing for free text.
 */
export function fieldHint(f: PayerFieldSpec): string | undefined {
  if (f.prefix) return t('billing.payer.hint.prefix', { prefix: f.prefix });
  const n = /^\\d\{(\d+)\}$/.exec(f.pattern)?.[1];
  if (f.input === PayerFieldInput.DIGITS && n) return plural('billing.payer.hint.digits', Number(n));
  if (f.input === PayerFieldInput.CODE && f.example) return plural('billing.payer.hint.chars', f.example.length);
  return undefined;
}

const REASON: Record<PayerReason, MessageKey> = {
  PAYER_REQUIRED: 'billing.payer.err.required',
  PAYER_FORMAT: 'billing.payer.err.format',
  PAYER_CHECKSUM: 'billing.payer.err.checksum',
  PAYER_TOO_LONG: 'billing.payer.err.tooLong',
  PAYER_COUNTRY: 'billing.payer.err.country',
  PAYER_TYPE_UNAVAILABLE: 'billing.payer.err.type',
  PAYER_EMAIL: 'billing.payer.err.email',
};

/** The inline text of a failed check (server reasons outside the list read as a format error). */
export function reasonText(reason: string, field?: string): string {
  if (field === 'payer.name' && reason === 'PAYER_REQUIRED') return t('billing.payer.err.name');
  return t((REASON as Partial<Record<string, MessageKey>>)[reason] ?? 'billing.payer.err.format');
}

/** The type's label in the segmented control and the card. */
export function payerTypeLabel(type: PayerType): string {
  switch (type) {
    case PayerType.COMPANY:
      return t('billing.payer.company');
    case PayerType.SOLE_PROPRIETOR:
      return t('billing.payer.soleProprietor');
    default:
      return t('billing.payer.person');
  }
}

/** The name field's label for a type («Название организации», «ФИО предпринимателя», «Имя и фамилия»). */
export function nameLabel(type: PayerType): string {
  switch (type) {
    case PayerType.COMPANY:
      return t('billing.payer.companyName');
    case PayerType.SOLE_PROPRIETOR:
      return t('billing.payer.soleProprietorName');
    default:
      return t('billing.payer.personName');
  }
}

export interface Country {
  code: string;
  name: string;
  /** Matched by the search: the name in the UI language and in English, the code. */
  search: string[];
}

const namesCache = new Map<Locale, readonly Country[]>();

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' });
  } catch {
    return null;
  }
}

/** Every code of the schema, named in the UI language and sorted by that name. */
export function countryList(codes: readonly string[], locale: Locale): readonly Country[] {
  const hit = namesCache.get(locale);
  if (hit && hit.length === codes.length) return hit;
  const local = displayNames(locale);
  const en = displayNames('en');
  const collator = new Intl.Collator(locale);
  const out = codes
    .map((code) => {
      const name = local?.of(code) ?? code;
      const english = en?.of(code) ?? code;
      return { code, name, search: [name, english, code] };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
  namesCache.set(locale, out);
  return out;
}

/** «Германия» for "DE" in the UI language; the code itself when Intl does not know it. */
export function countryName(code: string, locale: Locale): string {
  if (!/^[A-Z]{2}$/.test(code)) return code || '—';
  return displayNames(locale)?.of(code) ?? code;
}

const LOCALE_COUNTRY: Record<Locale, string> = { ru: 'RU', en: 'US', es: 'ES', 'zh-CN': 'CN' };

/**
 * The preselected country of a new payer: Russia for an account of the Russian market, else the
 * region of the system language (en-GB → GB), else the UI language's country. A guess only: the
 * payer's country never decides the market (ADR-0080 §2.1).
 */
export function defaultCountry(market: string, locale: Locale, languages: readonly string[], known: readonly string[]): string {
  const ok = (c: string | undefined): c is string => !!c && known.includes(c);
  if (market === 'ru' && ok('RU')) return 'RU';
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (ok(region)) return region;
    } catch {
      // not a language tag
    }
  }
  const byLocale = LOCALE_COUNTRY[locale];
  return ok(byLocale) ? byLocale : (known[0] ?? '');
}

/** "payer.requisites.inn" → "inn"; other fields stay as they are ("payer.name"). */
export function problemKey(field: string): string {
  return field.startsWith('payer.requisites.') ? field.slice('payer.requisites.'.length) : field;
}
