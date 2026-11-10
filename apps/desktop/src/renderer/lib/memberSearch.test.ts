import { describe, expect, it } from 'vitest';
import { matchStrings, parseQuery, phoneDigits } from './memberSearch';

const ivan = { names: ['Иван Петров', 'ivan_p', 'ivan'], hidden: ['ivan.petrov@calab.io', '+7 (999) 123-45-67', '101'] };
const m = (q: string): ReturnType<typeof matchStrings> => matchStrings(ivan.names, ivan.hidden, q);

describe('member matcher', () => {
  it('ignores case and folds ё', () => {
    expect(m('ИВАН')?.rank).toBe(1);
    expect(matchStrings(['Фёдор Соколов'], [], 'федор')?.rank).toBe(1);
    expect(matchStrings(['Федор'], [], 'фёдор')?.rank).toBe(0);
  });

  it('needs every word of a multi-word query, in any field or order', () => {
    expect(m('иван петров')?.rank).toBe(1);
    expect(m('петров иван')).not.toBeNull();
    expect(m('иван сидоров')).toBeNull();
    expect(matchStrings(['Иван Петров', 'Продажи'], [], 'иван продаж')).not.toBeNull();
  });

  it('ranks exact, prefix, word start, inside, contact', () => {
    expect(matchStrings(['Вера'], [], 'вера')?.rank).toBe(0);
    expect(matchStrings(['Вера'], [], 'ве')?.rank).toBe(1);
    expect(matchStrings(['Мария Вера'], [], 'вер')?.rank).toBe(2);
    expect(matchStrings(['Аверин'], [], 'вер')?.rank).toBe(3);
    expect(matchStrings(['Анна'], ['x@y.io'], 'x@y')?.rank).toBe(4);
  });

  it('matches email by substring including the local part, and reports it as the hint', () => {
    expect(m('petrov@')).toMatchObject({ rank: 4, hint: 'ivan.petrov@calab.io' });
    expect(m('calab.io')?.hint).toBe('ivan.petrov@calab.io');
    expect(m('ivan.pet')?.hint).toBe('ivan.petrov@calab.io');
  });

  it('matches a phone by digits in any format, 8 = +7', () => {
    for (const q of ['+7 999 123-45-67', '8 (999) 123 45 67', '89991234567', '999-123', '(999)', '1234567', '9991234567']) {
      expect(m(q)?.hint, q).toBe('+7 (999) 123-45-67');
    }
    expect(m('8 999 123')?.hint).toBe('+7 (999) 123-45-67');
    expect(m('+7 999 555')).toBeNull();
    // A leading 8 inside the number (a St Petersburg code) is not the trunk prefix.
    expect(matchStrings(['Олег'], ['+7 (812) 555-10-20'], '8125551')?.hint).toBe('+7 (812) 555-10-20');
    expect(matchStrings(['Олег'], ['+7 (812) 555-10-20'], 'олег 812-555')).not.toBeNull();
  });

  it('matches the internal extension and mixes a name with a number', () => {
    expect(m('101')?.hint).toBe('101');
    expect(m('иван 999')).not.toBeNull();
    expect(m('сидор 999')).toBeNull();
  });

  it('does not treat one or two digits as a phone, and an empty query matches all', () => {
    expect(parseQuery('99').phone).toBe('');
    expect(m('77')).toBeNull();
    expect(m('')?.rank).toBe(0);
    expect(parseQuery('8 999').phone).toBe('7999');
  });

  it('normalizes stored phone formats', () => {
    expect(phoneDigits('8 (999) 123-45-67')).toBe('79991234567');
    expect(phoneDigits('9991234567')).toBe('79991234567');
    expect(phoneDigits('+380 44 123 45 67')).toBe('380441234567');
  });
});
