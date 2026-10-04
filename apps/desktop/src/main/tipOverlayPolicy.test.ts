import { describe, expect, it } from 'vitest';
import { parseTipPayload, TIP_PAGE_HTML, TIP_PAGE_URL, TIP_TEXT_MAX, tipRenderScript } from './tipOverlayPolicy';

const win = { width: 1200, height: 800 };
const ok = { text: 'Grafana', shortcut: '', rect: { x: 60, y: 100, width: 80, height: 26 }, theme: 'dark', side: 'right' };

describe('parseTipPayload (webapp:tip-show from the renderer)', () => {
  it('a valid tooltip', () => expect(parseTipPayload(ok, 1, win)).toEqual({ ...ok, theme: 'dark', side: 'right' }));
  it('the rect is scaled by the page zoom and rounded outward', () => {
    const p = parseTipPayload({ ...ok, rect: { x: 10.4, y: 20, width: 80, height: 25.5 } }, 1.25, win);
    expect(p.rect).toEqual({ x: 13, y: 25, width: 100, height: 32 });
    // A fraction of a pixel wider than the DOM box, never narrower (the text must not wrap).
    expect(parseTipPayload({ ...ok, rect: { x: 58, y: 179, width: 42.0625, height: 26 } }, 1, win).rect).toEqual({ x: 58, y: 179, width: 43, height: 26 });
  });
  it('a missing shortcut is empty', () => {
    const { shortcut: _drop, ...rest } = ok;
    expect(parseTipPayload(rest, 1, win).shortcut).toBe('');
  });
  const bad: [string, unknown][] = [
    ['not an object', 'x'],
    ['null', null],
    ['empty text', { ...ok, text: '  ' }],
    ['text over the limit', { ...ok, text: 'x'.repeat(TIP_TEXT_MAX + 1) }],
    ['text not a string', { ...ok, text: 42 }],
    ['a long shortcut', { ...ok, shortcut: 'x'.repeat(33) }],
    ['unknown theme', { ...ok, theme: 'sepia' }],
    ['unknown side', { ...ok, side: 'center' }],
    ['no rect', { ...ok, rect: undefined }],
    ['NaN in rect', { ...ok, rect: { ...ok.rect, x: Number.NaN } }],
    ['zero size', { ...ok, rect: { ...ok.rect, width: 0 } }],
    ['huge', { ...ok, rect: { x: 0, y: 0, width: 1100, height: 30 } }],
    ['left of the window', { ...ok, rect: { ...ok.rect, x: -40 } }],
    ['below the window', { ...ok, rect: { ...ok.rect, y: 790 } }],
    ['right of the window', { ...ok, rect: { ...ok.rect, x: 1150 } }],
  ];
  for (const [name, v] of bad) it(`rejects: ${name}`, () => expect(() => parseTipPayload(v, 1, win)).toThrow());
  it('a pixel of rounding past the edge is fine', () => {
    expect(() => parseTipPayload({ ...ok, rect: { x: 1120.5, y: 0, width: 80, height: 26 } }, 1, win)).not.toThrow();
  });
});

describe('the overlay page', () => {
  it('allows no script, no network: only inline styles', () => {
    expect(TIP_PAGE_HTML).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(TIP_PAGE_HTML).not.toMatch(/<script|https?:\/\/|@import|url\(/i);
    expect(TIP_PAGE_URL.startsWith('data:text/html;charset=utf-8,')).toBe(true);
  });
  it('has no animation or transition', () => expect(TIP_PAGE_HTML).not.toMatch(/animation|transition/));
});

describe('tipRenderScript', () => {
  it('sets values as JSON string literals (text, never HTML)', () => {
    const nasty = `"</style><img src=x onerror=alert(1)>'${String.fromCharCode(0x2028)}\\`;
    const js = tipRenderScript({ text: nasty, shortcut: '⌘K', theme: 'light' });
    expect(js).not.toContain('innerHTML');
    const set = (target: string): unknown => {
      const at = js.indexOf(`${target}=`) + target.length + 1;
      const end = js.indexOf(';', at);
      return JSON.parse(js.slice(at, end));
    };
    expect(set('className')).toBe('light');
    expect(set("getElementById('l').textContent")).toBe(nasty);
    expect(set("getElementById('k').textContent")).toBe('⌘K');
  });
});
