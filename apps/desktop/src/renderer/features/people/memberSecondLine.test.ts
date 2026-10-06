import { describe, expect, it } from 'vitest';
import { customStatusLine, memberActivity, memberSecondLine } from './members';

describe('member second line', () => {
  it('keeps the custom status while in voice (07.10: the voice line replaced it)', () => {
    const status = customStatusLine({ statusEmoji: '🍔', statusText: 'Обедаю' });
    expect(status).toBe('🍔 Обедаю');
    expect(memberSecondLine(status, memberActivity({ roomId: 'r1' }, false))).toEqual({ status, activity: 'voice', compact: true });
    expect(memberSecondLine(status, memberActivity({ roomId: 'r1', streaming: true }, false))).toEqual({ status, activity: 'stream', compact: true });
    expect(memberSecondLine(status, memberActivity(undefined, true))).toEqual({ status, activity: 'call', compact: true });
  });

  it('either alone takes the whole line', () => {
    expect(memberSecondLine('', memberActivity({ roomId: 'r1' }, false))).toEqual({ status: '', activity: 'voice', compact: false });
    expect(memberSecondLine('🎯', memberActivity({ roomId: '' }, false))).toEqual({ status: '🎯', activity: null, compact: false });
    expect(customStatusLine({ statusText: 'В фокусе до 18:00' })).toBe('В фокусе до 18:00');
    expect(customStatusLine(undefined)).toBe('');
  });
});
