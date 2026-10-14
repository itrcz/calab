import { describe, expect, it } from 'vitest';
import { isActivityTab, migrateActivityTab } from './activity';

describe('task panel tabs (ADR-0091 §1)', () => {
  it('knows its two tabs', () => {
    expect(isActivityTab('comments')).toBe(true);
    expect(isActivityTab('history')).toBe(true);
    expect(isActivityTab('all')).toBe(false);
    expect(isActivityTab(undefined)).toBe(false);
  });

  it('migrates the stored tab of an older build', () => {
    expect(migrateActivityTab('all')).toBe('comments');
    expect(migrateActivityTab('changes')).toBe('history');
    expect(migrateActivityTab('comments')).toBe('comments');
    expect(migrateActivityTab('history')).toBe('history');
    expect(migrateActivityTab('bogus')).toBe('comments');
    expect(migrateActivityTab(undefined)).toBe('comments');
  });
});
