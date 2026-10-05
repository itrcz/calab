import { describe, expect, it } from 'vitest';
import { numberedName, safeFileName } from './fileName';

describe('safeFileName (downloads.uniquePath)', () => {
  it('keeps ordinary names', () => {
    expect(safeFileName('отчёт 2026.pdf')).toBe('отчёт 2026.pdf');
    expect(safeFileName('.env')).toBe('.env');
  });
  it('never escapes the folder', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\Windows\\win.ini')).toBe('win.ini');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.')).toBe('file');
    expect(safeFileName('a/..')).toBe('file');
    expect(safeFileName('')).toBe('file');
  });
  it('neutralises Windows reserved device names', () => {
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('nul.txt')).toBe('_nul.txt');
    expect(safeFileName('com1.log')).toBe('_com1.log');
    expect(safeFileName('console.txt')).toBe('console.txt');
  });
  it('drops trailing dots and spaces (Windows would rewrite them)', () => {
    expect(safeFileName('evil.exe.')).toBe('evil.exe');
    expect(safeFileName('name .txt  ')).toBe('name .txt');
    expect(safeFileName('...')).toBe('file');
  });
  it('replaces reserved and control characters', () => {
    expect(safeFileName('a:b*c?"d<e>f|g\u0001.txt')).toBe('a_b_c__d_e_f_g_.txt');
  });
  it('caps very long names and keeps the extension', () => {
    const n = safeFileName(`${'x'.repeat(500)}.pdf`);
    expect(n.length).toBe(200);
    expect(n.endsWith('.pdf')).toBe(true);
  });
  it('numbers duplicates before the extension', () => {
    expect(numberedName('a.pdf', 0)).toBe('a.pdf');
    expect(numberedName('a.pdf', 2)).toBe('a (2).pdf');
    expect(numberedName('.env', 1)).toBe('.env (1)');
    expect(numberedName('archive', 1)).toBe('archive (1)');
  });
});

describe('safeFileName — bidi controls', () => {
  it('drops right-to-left overrides that disguise the extension', () => {
    expect(safeFileName('photo‮gpj.exe')).toBe('photogpj.exe');
    expect(safeFileName('a⁦b⁩‏.png')).toBe('ab.png');
  });
});
