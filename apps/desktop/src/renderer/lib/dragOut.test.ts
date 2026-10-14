import { describe, expect, it } from 'vitest';
import { beginDragOut, dragOutActive, END_GRACE_MS, endDragOut } from './dragOut';

describe('dragOut flag', () => {
  it('is off before any drag, on during one, and lingers briefly after its end', () => {
    expect(dragOutActive(0)).toBe(false);
    beginDragOut();
    expect(dragOutActive(10_000)).toBe(true);
    endDragOut(20_000);
    expect(dragOutActive(20_000 + END_GRACE_MS - 1)).toBe(true);
    expect(dragOutActive(20_000 + END_GRACE_MS)).toBe(false);
  });
  it('a second end (no drag running) does not extend the grace', () => {
    beginDragOut();
    endDragOut(50_000);
    endDragOut(60_000);
    expect(dragOutActive(50_000 + END_GRACE_MS)).toBe(false);
  });
});
