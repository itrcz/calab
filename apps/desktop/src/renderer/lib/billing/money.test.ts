import { describe, expect, it } from 'vitest';
import { clampMinor, currencyDigits, formatMinor, inputOf, majorString, parseMajor } from './money';

describe('billing money (int64 minor units, no floats)', () => {
  it('knows the minor digits of a currency', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('RUB')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('???')).toBe(2);
  });

  it('turns minor units into an exact major decimal string', () => {
    expect(majorString(1234n, 'USD')).toBe('12.34');
    expect(majorString(-5n, 'USD')).toBe('-0.05');
    expect(majorString(0n, 'USD')).toBe('0.00');
    expect(majorString(500n, 'JPY')).toBe('500');
    // Beyond 2^53: still exact (a float would round the last digits).
    expect(majorString(9_007_199_254_740_993n, 'USD')).toBe('90071992547409.93');
  });

  it('formats with Intl in the given locale', () => {
    expect(formatMinor(4230n, 'USD', { locale: 'en' })).toBe('$42.30');
    expect(formatMinor(-320n, 'USD', { locale: 'en' })).toBe('-$3.20');
    expect(formatMinor(50_000n, 'USD', { locale: 'en', compact: true })).toBe('$500');
    expect(formatMinor(50_050n, 'USD', { locale: 'en', compact: true })).toBe('$500.50');
    expect(formatMinor(250n, 'USD', { locale: 'en', signed: true })).toBe('+$2.50');
    expect(formatMinor(-60n, 'USD', { locale: 'en', signed: true })).toBe('-$0.60');
    expect(formatMinor(9_007_199_254_740_993n, 'USD', { locale: 'en' })).toBe('$90,071,992,547,409.93');
    expect(formatMinor(1n, '', { locale: 'en' })).toBe('—');
    // ru: the symbol after the amount, comma decimals.
    expect(formatMinor(4230n, 'RUB', { locale: 'ru' }).replace(/\s/g, ' ')).toBe('42,30 ₽');
  });

  it('parses typed amounts into minor units', () => {
    expect(parseMajor('12', 'USD')).toBe(1200n);
    expect(parseMajor('12.5', 'USD')).toBe(1250n);
    expect(parseMajor('12,50', 'USD')).toBe(1250n);
    expect(parseMajor(' $ 1 200 ', 'USD')).toBe(120_000n);
    expect(parseMajor('1\u00a0200,05 ₽', 'RUB')).toBe(120_005n);
    expect(parseMajor('0.1', 'USD')).toBe(10n);
    expect(parseMajor('500', 'JPY')).toBe(500n);
    expect(parseMajor('1.5', 'JPY')).toBeNull();
    expect(parseMajor('1.234', 'USD')).toBeNull();
    expect(parseMajor('-5', 'USD')).toBeNull();
    expect(parseMajor('1e3', 'USD')).toBeNull();
    expect(parseMajor('1.2.3', 'USD')).toBeNull();
    expect(parseMajor('', 'USD')).toBeNull();
    expect(parseMajor('abc', 'USD')).toBeNull();
  });

  it('gives the editable text of an amount', () => {
    expect(inputOf(50_000n, 'USD')).toBe('500');
    expect(inputOf(1250n, 'USD')).toBe('12.50');
    expect(inputOf(7n, 'JPY')).toBe('7');
  });

  it('clamps', () => {
    expect(clampMinor(1n, 500n, 500_000n)).toBe(500n);
    expect(clampMinor(600_000n, 500n, 500_000n)).toBe(500_000n);
    expect(clampMinor(1000n, 500n, 500_000n)).toBe(1000n);
  });
});
