import { describe, expect, it } from 'vitest';
import { foldSearch, searchWords, splitHits } from './highlight';

describe('search hits', () => {
  it('drops one-letter words and lower-cases', () => {
    expect(searchWords('  Релиз  в  15 ')).toEqual(['релиз', '15']);
  });

  it('splits into plain / hit parts (odd = hit), case-insensitive', () => {
    expect(splitHits('Релиз сегодня, релиз завтра', ['релиз'])).toEqual(['', 'Релиз', ' сегодня, ', 'релиз', ' завтра']);
  });

  it('escapes regex characters and keeps text without words', () => {
    expect(splitHits('a (b) c', ['(b)'])).toEqual(['a ', '(b)', ' c']);
    expect(splitHits('text', [])).toEqual(['text']);
  });

  it('treats «е» and «ё» as one letter both ways (CBF-169), keeping the text as written', () => {
    expect(splitHits('Позвонить Фёдоров', ['федоров'])).toEqual(['Позвонить ', 'Фёдоров', '']);
    expect(splitHits('Федоров и ЁЛКА', ['фёдоров', 'елка'])).toEqual(['', 'Федоров', ' и ', 'ЁЛКА', '']);
    expect(foldSearch('Фёдор ЁЖ')).toBe('федор еж');
  });
});
