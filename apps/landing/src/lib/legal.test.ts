import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, formatLegalEdition } from './legal';

describe('formatLegalEdition', () => {
  it('renders the edition date per locale from one version', () => {
    expect(formatLegalEdition('ru', '2026-11-23')).toEqual({ label: 'Редакция от ', date: '23 ноября 2026 г.' });
    expect(formatLegalEdition('en', '2026-11-23')).toEqual({ label: 'Updated ', date: '23 November 2026' });
    expect(formatLegalEdition('en', '2026-01-01').date).toBe('1 January 2026');
  });
  it('is a valid ISO date', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
