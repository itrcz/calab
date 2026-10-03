import { createElement, type ReactNode } from 'react';
import { snippetParts } from './snippet';

/**
 * A highlighted snippet as React nodes: plain parts as text, hits as <mark className>. Only text
 * nodes — React escapes them, so a snippet holding «<script>» stays text (no HTML injection).
 */
export function snippetNodes(text: string, markClass: string): ReactNode {
  const parts = snippetParts(text);
  if (parts.length === 0) return '';
  if (parts.length === 1 && !parts[0]?.hit) return parts[0]?.text ?? '';
  return parts.map((p, i) => (p.hit ? createElement('mark', { key: i, className: markClass }, p.text) : p.text));
}
