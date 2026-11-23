// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { attachInput, PASTE_FALLBACK_MS } from './input';
import { keyIs } from './keys';
import type { CanvasEngine } from './engine';

function setup(order: string[], selectedId: string | null) {
  const engine = {
    selection: new Set(selectedId ? [selectedId] : []),
    scene: { orderedIds: () => order, get: () => undefined },
    getState: () => ({ selectedId }),
    cycleSelection: vi.fn(),
    selectAll: vi.fn(),
    paste: vi.fn(),
    setTool: vi.fn(),
    readOnly: false,
    touch: false,
    flushCamera: vi.fn(),
  } as unknown as CanvasEngine;
  const canvas = document.createElement('canvas');
  attachInput(engine, canvas);
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    canvas.dispatchEvent(e);
    return e;
  };
  return { engine, press };
}

describe('keyIs', () => {
  it('matches by physical key on a Russian layout, and by letter without a code', () => {
    expect(keyIs({ code: 'KeyV', key: 'м' }, 'v')).toBe(true);
    expect(keyIs({ code: '', key: 'V' }, 'v')).toBe(true);
    expect(keyIs({ code: 'KeyC', key: 'с' }, 'v')).toBe(false);
  });
});

describe('canvas hotkeys', () => {
  it('Ctrl+V works on a Russian layout', async () => {
    const { engine, press } = setup([], null);
    const e = press({ code: 'KeyV', key: 'м', ctrlKey: true });
    // Left to the browser, which fires `paste` with the clipboard; without that event the async read runs next task.
    expect(e.defaultPrevented).toBe(false);
    await new Promise((done) => setTimeout(done, PASTE_FALLBACK_MS + 20));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- spy reference, not a call
    expect(engine.paste).toHaveBeenCalled();
  });
  it('tool letter works on a Russian layout', () => {
    const { engine, press } = setup([], null);
    press({ code: 'KeyS', key: 'ы' });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- spy reference, not a call
    expect(engine.setTool).toHaveBeenCalledWith('sticky');
  });
  it('Tab walks objects but is left to the browser on an empty canvas and past the ends', () => {
    let r = setup(['a', 'b'], 'a');
    let e = r.press({ key: 'Tab', code: 'Tab' });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- spy reference, not a call
    expect(r.engine.cycleSelection).toHaveBeenCalledWith(1);
    expect(e.defaultPrevented).toBe(true);
    r = setup([], null);
    e = r.press({ key: 'Tab', code: 'Tab' });
    expect(e.defaultPrevented).toBe(false);
    r = setup(['a', 'b'], 'b');
    e = r.press({ key: 'Tab', code: 'Tab' });
    expect(e.defaultPrevented).toBe(false);
    r = setup(['a', 'b'], 'a');
    e = r.press({ key: 'Tab', code: 'Tab', shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
  });
});
