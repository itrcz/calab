import { describe, expect, it, vi } from 'vitest';
vi.mock('../../platform', () => ({ platform: { apiFetch: vi.fn() } }));
import { exportRange } from './subscriptionApi';

describe('calendar download dates', () => {
  it('includes the last local calendar day, including a DST boundary', () => {
    const range = exportRange('2026-03-28', '2026-03-29');
    expect(range).toEqual({ from: new Date(2026, 2, 28).toISOString(), to: new Date(2026, 2, 30).toISOString() });
  });
  it('rejects invalid, reversed and overlong dates before requesting a download', () => {
    for (const [a, b] of [
      ['2026-02-30', '2026-03-02'],
      ['', '2026-03-02'],
      ['2026-03-03', '2026-03-01'],
      ['2026-01-01', '2027-12-31'],
    ] as const) {
      expect(exportRange(a, b)).toBeNull();
    }
  });
});
