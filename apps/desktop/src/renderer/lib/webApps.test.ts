import { describe, expect, it } from 'vitest';
import { appDropAt, appInitial, coversContent, moveApp, showBottomIsland, TIP_TEXT_MAX, tipOverApp, tipText, titleSlot, visibleViewRect, type OverlayNode } from './webApps';

describe('showBottomIsland', () => {
  it('is hidden whenever an app is open, regardless of voice state', () => {
    expect(showBottomIsland(false)).toBe(true);
    expect(showBottomIsland(true)).toBe(false);
  });
  it('is hidden on the Calendar / Boards tabs, call or not', () => {
    expect(showBottomIsland(false, true)).toBe(false);
    expect(showBottomIsland(true, true)).toBe(false);
  });
});

describe('titleSlot', () => {
  it('shows the app name while an app is open, else the workspace switcher', () => {
    expect(titleSlot('GPTunneL')).toEqual({ kind: 'app', text: 'GPTunneL' });
    expect(titleSlot(undefined)).toEqual({ kind: 'workspace' });
    expect(titleSlot('')).toEqual({ kind: 'workspace' });
  });
});

describe('appInitial', () => {
  it('takes the first letter or digit', () => {
    expect(appInitial('grafana')).toBe('G');
    expect(appInitial('  «вики»')).toBe('В');
    expect(appInitial('1С')).toBe('1');
    expect(appInitial('—')).toBe('?');
  });
});

describe('appDropAt', () => {
  const slots = [
    { id: 'a', top: 0, bottom: 32 },
    { id: 'b', top: 40, bottom: 72 },
    { id: 'c', top: 80, bottom: 112 },
  ];
  it('finds the insertion index among the others', () => {
    expect(appDropAt(slots, 5, 'c')).toEqual({ index: 0, lineY: -2 });
    expect(appDropAt(slots, 50, 'c')).toEqual({ index: 1, lineY: 38 });
    expect(appDropAt(slots, 200, 'a')).toEqual({ index: 2, lineY: 114 });
  });
  it('is null on its own place or for an unknown id', () => {
    expect(appDropAt(slots, 20, 'a')).toBeNull();
    expect(appDropAt(slots, 50, 'a')).toBeNull();
    expect(appDropAt(slots, 50, 'x')).toBeNull();
  });
});

describe('moveApp', () => {
  it('returns the order and the neighbours for the server', () => {
    expect(moveApp(['a', 'b', 'c'], 'c', 0)).toEqual({ order: ['c', 'a', 'b'], after: '', before: 'a' });
    expect(moveApp(['a', 'b', 'c'], 'a', 1)).toEqual({ order: ['b', 'a', 'c'], after: 'b', before: 'c' });
    expect(moveApp(['a', 'b', 'c'], 'a', 2)).toEqual({ order: ['b', 'c', 'a'], after: 'c', before: '' });
    expect(moveApp(['a', 'b'], 'a', 9)).toEqual({ order: ['b', 'a'], after: 'b', before: '' });
  });
});

function node(attrs: Record<string, string>, inner: string[] = []): OverlayNode {
  return {
    getAttribute: (n) => attrs[n] ?? null,
    hasAttribute: (n) => n in attrs,
    querySelector: (sel) => (sel.split(',').some((s) => inner.includes(s.trim())) ? {} : null),
  };
}

describe('coversContent (overlays hide the native view)', () => {
  it('menus, popovers and dialogs cover; tooltips do not', () => {
    expect(coversContent(node({ 'data-radix-popper-content-wrapper': '' }))).toBe(true);
    expect(coversContent(node({ 'data-radix-popper-content-wrapper': '' }, ['[role="tooltip"]']))).toBe(false);
    expect(coversContent(node({ role: 'dialog' }))).toBe(true);
    expect(coversContent(node({ role: 'alertdialog' }))).toBe(true);
    expect(coversContent(node({}, ['[role="dialog"]']))).toBe(true);
    expect(coversContent(node({ id: 'toasts' }))).toBe(false);
  });
});

describe('coversContent: the incoming call card hides the native view', () => {
  it('the call sheet (a Radix dialog portalled to <body>) covers', () => {
    expect(coversContent(node({ role: 'dialog', 'data-testid': 'call-incoming' }))).toBe(true);
    expect(coversContent(node({ 'data-radix-portal': '' }, ['[role="dialog"]']))).toBe(true);
  });
});

describe('visibleViewRect (toasts, knock cards, the calling strip stay visible)', () => {
  const view = { x: 72, y: 80, width: 900, height: 600 };
  it('no overlay, or one outside the view: the whole placeholder', () => {
    expect(visibleViewRect(view, [])).toEqual(view);
    expect(visibleViewRect(view, [{ x: 0, y: 700, width: 900, height: 60 }])).toEqual(view);
    expect(visibleViewRect(view, [{ x: 300, y: 600, width: 480, height: 0 }])).toEqual(view); // an empty toast stack
  });
  it('a toast stack at the bottom: the site ends above it', () => {
    const toast = { x: 282, y: 600, width: 480, height: 64 }; // bottom 664 < 680
    expect(visibleViewRect(view, [toast])).toEqual({ x: 72, y: 80, width: 900, height: 600 - 80 - 8 });
  });
  it('a knock card top right: the side that keeps the most area', () => {
    const knock = { x: 72 + 900 - 356, y: 90, width: 340, height: 100 };
    const r = visibleViewRect(view, [knock]);
    expect(r).toEqual({ x: 72, y: 198, width: 900, height: 482 });
  });
  it('the calling strip at the top edge and a toast at the bottom together', () => {
    const strip = { x: 400, y: 60, width: 240, height: 36 };
    const toast = { x: 282, y: 620, width: 480, height: 50 };
    expect(visibleViewRect(view, [strip, toast])).toEqual({ x: 72, y: 104, width: 900, height: 620 - 8 - 104 });
  });
  it('too little left: hidden (null)', () => {
    expect(visibleViewRect(view, [{ x: 0, y: 0, width: 2000, height: 2000 }])).toBeNull();
    expect(visibleViewRect({ x: 0, y: 0, width: 400, height: 200 }, [{ x: 50, y: 60, width: 300, height: 100 }])).toBeNull();
  });
});

describe('tipOverApp (tooltips over the app go to the native overlay)', () => {
  const app = { x: 72, y: 40, width: 800, height: 560 };
  it('a rail tooltip reaching into the app', () => expect(tipOverApp({ x: 60, y: 100, width: 80, height: 24 }, app)).toBe(true));
  it('a tooltip fully inside the app', () => expect(tipOverApp({ x: 300, y: 300, width: 80, height: 24 }, app)).toBe(true));
  it('a tooltip left of the app', () => expect(tipOverApp({ x: 0, y: 100, width: 60, height: 24 }, app)).toBe(false));
  it('touching the edge does not count', () => expect(tipOverApp({ x: 12, y: 100, width: 60, height: 24 }, app)).toBe(false));
  it('above the app (title bar)', () => expect(tipOverApp({ x: 300, y: 10, width: 80, height: 30 }, app)).toBe(false));
  it('no app on screen', () => expect(tipOverApp({ x: 300, y: 300, width: 80, height: 24 }, null)).toBe(false));
  it('a tooltip not laid out yet (0×0)', () => expect(tipOverApp({ x: 300, y: 300, width: 0, height: 0 }, app)).toBe(false));
  it('a hidden app (0×0)', () => expect(tipOverApp({ x: 0, y: 0, width: 80, height: 24 }, { x: 0, y: 0, width: 0, height: 0 })).toBe(false));
});

describe('tipText', () => {
  it('collapses whitespace', () => expect(tipText('  Grafana \n dashboards ')).toBe('Grafana dashboards'));
  it('cuts long text to the overlay limit', () => {
    const s = tipText('x'.repeat(500));
    expect(s.length).toBe(TIP_TEXT_MAX);
    expect(s.endsWith('…')).toBe(true);
  });
});
