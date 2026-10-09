import type { Money } from '@calaba/protocol';
import { getLocale } from '../../i18n';

/**
 * Money of balance billing (ADR-0080 v5): always int64 minor units (`bigint`) with the account's
 * ISO 4217 currency from the server. Logic never uses floats: amounts are added / compared as
 * bigint, and only the final text goes through `Intl.NumberFormat` (an exact decimal string, not a
 * Number). Pure: no stores, no React.
 */

/** Minor units of a currency: USD 2, JPY 0, KWD 3 (what Intl knows; 2 for an unknown code). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export const minorOf = (m: Money | undefined): bigint => m?.minor ?? 0n;

/** A signed minor amount as an exact decimal string in major units: -1234n USD → "-12.34". */
export function majorString(minor: bigint, currency: string): string {
  const digits = currencyDigits(currency);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  if (digits === 0) return `${neg ? '-' : ''}${abs}`;
  const base = 10n ** BigInt(digits);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(digits, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

const fmtCache = new Map<string, Intl.NumberFormat>();

function moneyFormat(locale: string, currency: string, whole: boolean, signed: boolean): Intl.NumberFormat {
  const id = `${locale}|${currency}|${whole}|${signed}`;
  let f = fmtCache.get(id);
  if (!f) {
    const opts: Intl.NumberFormatOptions = { style: 'currency', currency, ...(signed ? { signDisplay: 'exceptZero' } : {}) };
    try {
      f = new Intl.NumberFormat(locale, whole ? { ...opts, minimumFractionDigits: 0, maximumFractionDigits: 0 } : opts);
    } catch {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: currencyDigits(currency) });
    }
    fmtCache.set(id, f);
  }
  return f;
}

export interface MoneyFormatOptions {
  /** «+$5.00» / «−$1.20» (a ledger amount). */
  signed?: boolean;
  /** Drop zero cents: «$500» instead of «$500.00» (presets, limits). */
  compact?: boolean;
  /** Locale override (tests); default — the UI language. */
  locale?: string;
}

/** «$12.34» in the UI language; «—» without an amount. */
export function formatMinor(minor: bigint, currency: string, o: MoneyFormatOptions = {}): string {
  if (!currency) return '—';
  const digits = currencyDigits(currency);
  const whole = !!o.compact && digits > 0 && minor % 10n ** BigInt(digits) === 0n;
  const f = moneyFormat(o.locale ?? getLocale(), currency, whole, !!o.signed);
  // An exact decimal string (Intl.NumberFormat v3): no float rounding of large amounts.
  return f.format(majorString(minor, currency) as `${number}`);
}

export function formatMoney(m: Money | undefined, o: MoneyFormatOptions = {}): string {
  return m ? formatMinor(m.minor, m.currency, o) : '—';
}

/**
 * Parses what a person typed as a major amount into minor units: «12», «12.5», «12,50», «$ 1 200»;
 * null when it is not a non-negative amount with at most the currency's minor digits. No floats.
 */
export function parseMajor(input: string, currency: string): bigint | null {
  const digits = currencyDigits(currency);
  if (input.includes('-')) return null; // never a negative amount
  // Spaces (incl. NBSP / thin) and currency symbols / letters around the number are dropped.
  const s = input.replace(/[\s\u00a0\u202f]/g, '').replace(/^[^\d.,]+|[^\d.,]+$/g, '');
  if (!s) return null;
  const m = /^(\d+)(?:[.,](\d*))?$/.exec(s);
  if (!m) return null;
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  return BigInt(whole) * 10n ** BigInt(digits) + (frac ? BigInt(frac.padEnd(digits, '0')) : 0n);
}

/** The plain editable text of an amount: 1250n USD → "12.50", 50000n → "500". */
export function inputOf(minor: bigint, currency: string): string {
  const s = majorString(minor, currency);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

export const maxMinor = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minMinor = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const clampMinor = (v: bigint, lo: bigint, hi: bigint): bigint => minMinor(maxMinor(v, lo), hi);
