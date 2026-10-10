// Payer requisites (ADR-0080 §0.1): the client side of apps/server/internal/billing/payer.
// The schema itself comes from the server (GET …/billing/payer-schema); this file only runs
// its rules — normalization, patterns, check digits — so the form can answer inline. The
// server is the judge. Both sides are tested against proto/testdata/billing_payer_vectors.json.

import {
  PayerFieldCheck,
  PayerFieldInput,
  type PayerCountrySchema,
  type PayerFieldSpec,
  type PayerSchema,
  type PayerType,
} from './gen/calaba/v1/billing_pb.js';

/** ApiError.reason of a failed payer check (field "payer.<name>" / "payer.requisites.<key>"). */
export type PayerReason =
  | 'PAYER_REQUIRED'
  | 'PAYER_FORMAT'
  | 'PAYER_CHECKSUM'
  | 'PAYER_TOO_LONG'
  | 'PAYER_COUNTRY'
  | 'PAYER_TYPE_UNAVAILABLE'
  | 'PAYER_EMAIL';

export const PAYER_MAX_NAME = 200;
export const PAYER_MAX_EMAIL = 320;

/** The schema of a country (the fallback for a country without its own requisites). */
export function payerCountrySchema(schema: PayerSchema, country: string): PayerCountrySchema | undefined {
  return schema.countries.find((c) => c.country === country) ?? schema.fallback;
}

/** Payer types the country offers, in schema order (person, sole proprietor where registered, company). */
export function payerTypes(schema: PayerSchema, country: string): PayerType[] {
  return payerCountrySchema(schema, country)?.types.map((t) => t.type) ?? [];
}

/** Requisites of a country + type; null when the country does not offer the type. */
export function payerFields(schema: PayerSchema, country: string, type: PayerType): PayerFieldSpec[] | null {
  return payerCountrySchema(schema, country)?.types.find((t) => t.type === type)?.fields ?? null;
}

/**
 * The stored form of a value: TEXT trims and collapses whitespace; DIGITS / CODE drop spaces,
 * dashes, dots and slashes, CODE upper-cases and puts the VAT prefix in front («GR…» → «EL…»).
 */
export function normalizeRequisite(f: PayerFieldSpec, country: string, raw: string): string {
  if (f.input === PayerFieldInput.DIGITS || f.input === PayerFieldInput.CODE) {
    let v = raw.replace(/[\s\-./]/g, '');
    if (f.input === PayerFieldInput.CODE) {
      v = v.toUpperCase();
      if (f.prefix && v && !v.startsWith(f.prefix)) {
        if (country !== f.prefix && v.startsWith(country)) v = v.slice(country.length);
        v = f.prefix + v;
      }
    }
    return v;
  }
  return raw.trim().split(/\s+/).filter(Boolean).join(' ');
}

const patterns = new Map<string, RegExp>();
function fullMatch(pattern: string): RegExp {
  let re = patterns.get(pattern);
  if (!re) {
    re = new RegExp(`^(?:${pattern})$`);
    patterns.set(pattern, re);
  }
  return re;
}

/** Checks a normalized value: null when it passes (an empty optional value passes). */
export function checkRequisite(f: PayerFieldSpec, v: string): PayerReason | null {
  if (!v) return f.required ? 'PAYER_REQUIRED' : null;
  if ([...v].length > (f.maxLength || 64)) return 'PAYER_TOO_LONG';
  if (f.pattern && !fullMatch(f.pattern).test(v)) return 'PAYER_FORMAT';
  if (!payerChecksum(f.check, v)) return 'PAYER_CHECKSUM';
  return null;
}

const digitsOf = (v: string, n: number): number[] | null => (v.length === n && /^\d+$/.test(v) ? [...v].map(Number) : null);
const weighted = (d: number[], w: number[]): number => w.reduce((s, k, i) => s + (d[i] ?? 0) * k, 0);

function ruINN(v: string): boolean {
  const ctl = (d: number[], w: number[]): number => (weighted(d, w) % 11) % 10;
  const d10 = digitsOf(v, 10);
  if (d10) return ctl(d10, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d10[9];
  const d12 = digitsOf(v, 12);
  if (d12) return ctl(d12, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d12[10] && ctl(d12, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d12[11];
  return false;
}

/** ОГРН (13, mod 11) / ОГРНИП (15, mod 13): the remainder of the leading digits, its last digit. */
function ruOGRN(v: string, n: number, mod: number): boolean {
  const d = digitsOf(v, n);
  if (!d) return false;
  let r = 0;
  for (let i = 0; i < n - 1; i++) r = (r * 10 + (d[i] ?? 0)) % mod;
  return r % 10 === d[n - 1];
}

function kzIINBIN(v: string): boolean {
  const d = digitsOf(v, 12);
  if (!d) return false;
  let c = weighted(d, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) % 11;
  if (c === 10) {
    c = weighted(d, [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]) % 11;
    if (c === 10) return false;
  }
  return c === d[11];
}

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function inGSTIN(v: string): boolean {
  if (v.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const d = BASE36.indexOf(v[i] ?? '');
    if (d < 0) return false;
    const p = d * (1 + (i % 2));
    sum += Math.floor(p / 36) + (p % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36] === v[14];
}

const USCC = '0123456789ABCDEFGHJKLMNPQRTUWXY';
function cnUSCC(v: string): boolean {
  if (v.length !== 18) return false;
  const w = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const d = USCC.indexOf(v[i] ?? '');
    if (d < 0) return false;
    sum += d * (w[i] ?? 0);
  }
  return USCC[(31 - (sum % 31)) % 31] === v[17];
}

/** The check digit algorithm of a field on a value that matched its pattern. */
export function payerChecksum(c: PayerFieldCheck, v: string): boolean {
  switch (c) {
    case PayerFieldCheck.RU_INN:
      return ruINN(v);
    case PayerFieldCheck.RU_OGRN:
      return ruOGRN(v, 13, 11);
    case PayerFieldCheck.RU_OGRNIP:
      return ruOGRN(v, 15, 13);
    case PayerFieldCheck.KZ_IIN_BIN:
      return kzIINBIN(v);
    case PayerFieldCheck.IN_GSTIN:
      return inGSTIN(v);
    case PayerFieldCheck.CN_USCC:
      return cnUSCC(v);
    default:
      return true;
  }
}

export interface PayerInput {
  type: PayerType;
  name: string;
  country: string;
  email: string;
  /** A legacy single tax number: taken as the primary field when that one is empty. */
  taxId?: string;
  requisites: Record<string, string>;
}

export interface PayerProblem {
  /** "payer.name", "payer.email", "payer.country", "payer.type", "payer.requisites.<key>" */
  field: string;
  reason: PayerReason;
}

export interface CheckedPayer {
  type: PayerType;
  name: string;
  country: string;
  email: string;
  taxId: string;
  requisites: Record<string, string>;
}

function validEmail(e: string): boolean {
  if (e.length < 3 || e.length > PAYER_MAX_EMAIL || /\s/.test(e)) return false;
  const at = e.lastIndexOf('@');
  return at > 0 && at < e.length - 1;
}

/**
 * Every problem of a payer, in form order (name, e-mail, then the requisites); the server answers
 * the first one. `payer` is the normalized payer when there is none.
 */
export function checkPayer(schema: PayerSchema, input: PayerInput): { payer: CheckedPayer | null; problems: PayerProblem[] } {
  const country = input.country.trim().toUpperCase();
  const problems: PayerProblem[] = [];
  if (!schema.allCountries.includes(country)) return { payer: null, problems: [{ field: 'payer.country', reason: 'PAYER_COUNTRY' }] };
  const fields = payerFields(schema, country, input.type);
  if (!fields) return { payer: null, problems: [{ field: 'payer.type', reason: 'PAYER_TYPE_UNAVAILABLE' }] };
  const name = input.name.trim().split(/\s+/).filter(Boolean).join(' ');
  if (!name) problems.push({ field: 'payer.name', reason: 'PAYER_REQUIRED' });
  else if ([...name].length > PAYER_MAX_NAME) problems.push({ field: 'payer.name', reason: 'PAYER_TOO_LONG' });
  const email = input.email.trim();
  if (!validEmail(email)) problems.push({ field: 'payer.email', reason: 'PAYER_EMAIL' });
  const requisites: Record<string, string> = {};
  let taxId = '';
  for (const f of fields) {
    let raw = input.requisites[f.key] ?? '';
    if (f.primary && !raw.trim()) raw = input.taxId ?? '';
    const v = normalizeRequisite(f, country, raw);
    const r = checkRequisite(f, v);
    if (r) {
      problems.push({ field: `payer.requisites.${f.key}`, reason: r });
      continue;
    }
    if (!v) continue;
    requisites[f.key] = v;
    if (f.primary) taxId = v;
  }
  if (problems.length) return { payer: null, problems };
  return { payer: { type: input.type, name, country, email, taxId, requisites }, problems };
}
