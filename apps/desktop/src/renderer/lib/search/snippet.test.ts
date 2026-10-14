import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HL_END as E, HL_START as S, snippetHasHit, snippetParts, snippetText } from './snippet';
import { snippetNodes } from './snippetNodes';

const html = (s: string): string => renderToStaticMarkup(createElement('span', null, snippetNodes(s, 'm')));

describe('snippetParts', () => {
  it('cuts plain and marked parts', () => {
    expect(snippetParts(`готовим ${S}релиз${E} к пятнице`)).toEqual([
      { text: 'готовим ', hit: false },
      { text: 'релиз', hit: true },
      { text: ' к пятнице', hit: false },
    ]);
  });

  it('handles markers at both edges and adjacent hits', () => {
    expect(snippetParts(`${S}релиз${E}`)).toEqual([{ text: 'релиз', hit: true }]);
    expect(snippetParts(`${S}a${E}${S}b${E} c`)).toEqual([
      { text: 'ab', hit: true },
      { text: ' c', hit: false },
    ]);
    expect(snippetParts(`x ${S}end${E}`)).toEqual([
      { text: 'x ', hit: false },
      { text: 'end', hit: true },
    ]);
  });

  it('is tolerant of broken markers', () => {
    expect(snippetParts(`a ${S}open`)).toEqual([
      { text: 'a ', hit: false },
      { text: 'open', hit: true },
    ]);
    expect(snippetParts(`stray${E} end`)).toEqual([{ text: 'stray end', hit: false }]);
    expect(snippetParts(`${S}${S}x${E}${E}`)).toEqual([{ text: 'x', hit: true }]);
    expect(snippetParts('')).toEqual([]);
    expect(snippetParts(`${S}${E}`)).toEqual([]);
  });

  it('keeps unicode intact (surrogate pairs, combining marks, CJK)', () => {
    const parts = snippetParts(`🚀 ${S}релиз 🎉${E} 发布 é`);
    expect(parts.map((p) => p.text).join('')).toBe('🚀 релиз 🎉 发布 é');
    expect(parts[1]).toEqual({ text: 'релиз 🎉', hit: true });
    expect(snippetText(`${S}发布${E}`)).toBe('发布');
  });

  it('snippetHasHit / snippetText', () => {
    expect(snippetHasHit('plain')).toBe(false);
    expect(snippetHasHit(`a ${S}b${E}`)).toBe(true);
    expect(snippetText(`a ${S}b${E} c`)).toBe('a b c');
  });
});

describe('snippetNodes', () => {
  it('renders hits as <mark>, never as HTML', () => {
    expect(html(`a ${S}b${E} c`)).toBe('<span>a <mark class="m">b</mark> c</span>');
    expect(html(`<script>alert(1)</script> ${S}<b>x</b>${E}`)).toBe('<span>&lt;script&gt;alert(1)&lt;/script&gt; <mark class="m">&lt;b&gt;x&lt;/b&gt;</mark></span>');
    expect(html('plain & "quoted"')).toBe('<span>plain &amp; &quot;quoted&quot;</span>');
    expect(html('')).toBe('<span></span>');
  });
});
