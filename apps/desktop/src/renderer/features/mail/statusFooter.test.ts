import { describe, expect, it } from 'vitest';
import { footerView, parseFooter, type FooterInput } from './statusFooter';

const base: FooterInput = { kind: 'syncing', email: 'it@unne.ai', multi: false, more: 0, engineFailed: false, code: null, phase: null, folder: { role: null, name: '' }, done: 0, total: 0 };
const v = (over: Partial<FooterInput>) => footerView({ ...base, ...over });
const nbsp = (s: string): string => s.replace(/\s/g, ' ');

describe('status footer texts (ru)', () => {
  it('parses the store key', () => {
    expect(parseFooter('')).toBeNull();
    expect(parseFooter('stalled\na1\n2')).toEqual({ kind: 'stalled', accountId: 'a1', more: 2 });
  });

  it('first sync: title, then «folder · done of total»', () => {
    expect(v({ kind: 'first' })).toMatchObject({ title: 'Загрузка писем', detail: '', action: null, problem: false });
    expect(v({ kind: 'first', phase: 'folders' })).toMatchObject({ title: 'Загрузка списка папок', detail: 'it@unne.ai' });
    const x = v({ kind: 'first', phase: 'headers', folder: { role: 'inbox', name: 'INBOX' }, done: 1200, total: 8400 });
    expect(x.title).toBe('Загрузка писем');
    expect(nbsp(x.detail)).toBe('Входящие · 1 200 из 8 400');
    expect(nbsp(v({ kind: 'first', phase: 'headers', folder: { role: 'inbox', name: 'INBOX' }, done: 1, total: 3, multi: true, more: 1 }).detail)).toBe('it@unne.ai · Входящие · 1 из 3 · +1 ещё');
  });

  it('background sync is just «Проверка почты»', () => {
    expect(v({ kind: 'syncing' })).toMatchObject({ title: 'Проверка почты', detail: '', action: null, problem: false });
    expect(v({ kind: 'syncing', more: 1 }).detail).toBe('+1 ещё');
  });

  it('problems: one short line, the account, a button', () => {
    expect(v({ kind: 'offline' })).toMatchObject({ title: 'Нет связи с сервером', detail: 'it@unne.ai', action: 'retry', problem: true });
    expect(v({ kind: 'stalled', more: 2 })).toMatchObject({ title: 'Синхронизация не отвечает', detail: 'it@unne.ai · +2 ещё', action: 'retry' });
    expect(v({ kind: 'auth_failed' })).toMatchObject({ title: 'Неверный пароль', action: 'password' });
    expect(v({ kind: 'error' }).title).toBe('Ошибка синхронизации');
    expect(v({ kind: 'error', code: 'AUTH_FAILED' }).title).toBe('Неверный пароль');
  });

  it('engine: restarting has no button, failed offers the report', () => {
    expect(v({ kind: 'engine' })).toMatchObject({ title: 'Почта перезапускается', action: null });
    expect(v({ kind: 'engine', engineFailed: true })).toMatchObject({ title: 'Почта не запускается', action: 'report' });
  });
});
