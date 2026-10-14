import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = { mobile: false };
vi.mock('../lib/mobile', () => ({ useMobile: () => state.mobile }));

import { Choice, phonePicker } from './Choice';

const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Label ${i}` }));
const render = (n: number, phone?: 'auto' | 'picker' | 'segmented') =>
  renderToStaticMarkup(createElement(Choice<string>, { value: 'v1', options: opts(n), onChange: () => undefined, label: 'Pick', phone }));

describe('phonePicker', () => {
  it('auto switches above three options; phone forces either form', () => {
    expect(phonePicker('auto', 3)).toBe(false);
    expect(phonePicker('auto', 4)).toBe(true);
    expect(phonePicker('picker', 2)).toBe(true);
    expect(phonePicker('segmented', 9)).toBe(false);
  });
});

describe('Choice', () => {
  it('renders segments on desktop', () => {
    state.mobile = false;
    const html = render(5, 'picker');
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('aria-haspopup');
  });
  it('renders a picker button on a phone with the current label', () => {
    state.mobile = true;
    const html = render(3, 'picker');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Pick"');
    expect(html).toContain('Label 1');
    expect(html).not.toContain('role="radiogroup"');
  });
  it('keeps segments on a phone when forced or few options', () => {
    state.mobile = true;
    expect(render(5, 'segmented')).toContain('role="radiogroup"');
    expect(render(3)).toContain('role="radiogroup"');
    expect(render(4)).toContain('aria-haspopup="menu"');
  });
});
