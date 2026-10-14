import type { AdminPriceVersion } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';

/**
 * The custom plan's price versions (ADR-0086 «Индивидуальный тариф») — the server's rule
 * (core.CustomPriceAt): at time t the newest created version whose effective_from has come
 * applies, so a later version replaces one scheduled after its start. Pure, for the superadmin's
 * price history; the server decides every charge.
 */

/** The highest custom price per seat per day (minor units) by currency — the server's typo guard. */
export const CUSTOM_UNIT_CAP: Readonly<Record<string, bigint>> = { USD: 10_000n, RUB: 1_000_000n };

const fromMs = (v: AdminPriceVersion): number => (v.effectiveFrom ? timestampMs(v.effectiveFrom) : 0);
const createdMs = (v: AdminPriceVersion): number => (v.createdAt ? timestampMs(v.createdAt) : 0);
const newer = (a: AdminPriceVersion, b: AdminPriceVersion): boolean => (createdMs(a) !== createdMs(b) ? createdMs(a) > createdMs(b) : a.id > b.id);

/** The version in effect at `at` (ms), undefined before the first one. */
export function customPriceAt(versions: readonly AdminPriceVersion[], at: number): AdminPriceVersion | undefined {
  let best: AdminPriceVersion | undefined;
  for (const v of versions) if (fromMs(v) <= at && (!best || newer(v, best))) best = v;
  return best;
}

/** The first change of the price after `now`: the version and when it starts applying. */
export function nextCustomPrice(versions: readonly AdminPriceVersion[], now: number): { version: AdminPriceVersion; at: number } | null {
  const cur = customPriceAt(versions, now);
  const starts = [...new Set(versions.map(fromMs).filter((t) => t > now))].sort((a, b) => a - b);
  for (const at of starts) {
    const v = customPriceAt(versions, at);
    if (v && v.id !== cur?.id) return { version: v, at };
  }
  return null;
}

export type PriceStatus = 'current' | 'scheduled' | 'past' | 'replaced';

/** What a version of the history is now: in effect, waiting for its start, applied before, or never (replaced). */
export function priceStatus(versions: readonly AdminPriceVersion[], v: AdminPriceVersion, now: number): PriceStatus {
  if (customPriceAt(versions, now)?.id === v.id) return 'current';
  const applies = customPriceAt(versions, fromMs(v))?.id === v.id;
  if (fromMs(v) > now) return applies ? 'scheduled' : 'replaced';
  return applies ? 'past' : 'replaced';
}

/** `<input type="datetime-local">` value → ms (local time); '' / invalid → null. */
export function localInputMs(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}
