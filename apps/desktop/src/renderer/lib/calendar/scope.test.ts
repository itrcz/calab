import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { EventRepeat, EventScope } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { asksScope, scopedUpdate, touchesRepeat } from './scope';

const at = timestampFromMs(Date.UTC(2026, 10, 17, 7));

describe('asksScope', () => {
  it('asks for a listed occurrence of a series only', () => {
    expect(asksScope({ repeat: EventRepeat.WEEKLY, occurrenceAt: at })).toBe(true);
    expect(asksScope({ repeat: EventRepeat.WORKDAYS, occurrenceAt: at })).toBe(true);
    // A one-off meeting, an override (no repeat) and a series fetched alone change as a whole.
    expect(asksScope({ repeat: EventRepeat.UNSPECIFIED, occurrenceAt: at })).toBe(false);
    expect(asksScope({ repeat: EventRepeat.WEEKLY, occurrenceAt: undefined })).toBe(false);
    expect(asksScope(undefined)).toBe(false);
  });
});

describe('scopedUpdate', () => {
  const moved = { startsAt: timestampFromMs(Date.UTC(2026, 10, 17, 12)), endsAt: timestampFromMs(Date.UTC(2026, 10, 17, 13)) };

  it('«Только эту» names the occurrence and drops what only a series has', () => {
    const out = scopedUpdate({ ...moved, title: 'X', repeat: EventRepeat.DAILY, clearRepeatUntil: true, tempRoom: true }, { occurrenceAt: at }, 'this');
    expect(out).toEqual({ ...moved, title: 'X', scope: EventScope.THIS, occurrenceAt: at });
  });

  it('«Всю серию» keeps the repeat and sends the occurrence’s new times as they are', () => {
    const out = scopedUpdate({ ...moved, repeat: EventRepeat.DAILY }, { occurrenceAt: at }, 'following');
    expect(out).toEqual({ ...moved, repeat: EventRepeat.DAILY, scope: EventScope.FOLLOWING, occurrenceAt: at });
  });
});

describe('touchesRepeat', () => {
  it('a new repeat or its end is a change of the series, not of one occurrence', () => {
    expect(touchesRepeat({ repeat: EventRepeat.WEEKLY })).toBe(true);
    expect(touchesRepeat({ clearRepeatUntil: true })).toBe(true);
    expect(touchesRepeat({ repeatUntil: at })).toBe(true);
    expect(touchesRepeat({ title: 'X', startsAt: at })).toBe(false);
  });
});
