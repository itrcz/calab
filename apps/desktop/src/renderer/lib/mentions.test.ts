import { create } from '@bufbuild/protobuf';
import { MessageKind, MessageSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { applyMention, codeRanges, exactNames, filterCandidates, filterSpecial, fromWire, mentionQuery, mentionsMe, toWire } from './mentions';

const ANNA = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const ANNA2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const BORIS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03';

describe('toWire', () => {
  const known = new Map([
    ['Анна Смирнова', ANNA],
    ['Анна', ANNA2],
    ['Борис', BORIS],
  ]);

  it('names with spaces, longest first, text around', () => {
    expect(toWire('привет @Анна Смирнова и @Анна, как дела?', known)).toBe(`привет @${ANNA} и @${ANNA2}, как дела?`);
    expect(toWire('@Борис\n@Борис!', known)).toBe(`@${BORIS}\n@${BORIS}!`);
  });

  it('keeps @everyone / @here and unknown names', () => {
    expect(toWire('@everyone @here @Вера', known)).toBe('@everyone @here @Вера');
  });

  it('does not match inside words, e-mails or longer names', () => {
    expect(toWire('mail@Борис @Борисович @Анна_1', known)).toBe('mail@Борис @Борисович @Анна_1');
  });

  it('leaves code spans and blocks untouched', () => {
    expect(toWire('`@Борис` ```\n@Борис\n``` @Борис', known)).toBe(`\`@Борис\` \`\`\`\n@Борис\n\`\`\` @${BORIS}`);
  });
});

describe('fromWire', () => {
  const names: Record<string, string> = { [ANNA]: 'Анна Смирнова', [BORIS]: 'Борис' };

  it('ids → names, map for the way back; unknown ids stay', () => {
    const unknown = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aff';
    const r = fromWire(`@${ANNA.toUpperCase()} и @${BORIS}, @${unknown} @here \`@${BORIS}\``, (id) => names[id]);
    expect(r.text).toBe(`@Анна Смирнова и @Борис, @${unknown} @here \`@${BORIS}\``);
    expect([...r.mentions]).toEqual([
      ['Анна Смирнова', ANNA],
      ['Борис', BORIS],
    ]);
    expect(toWire(r.text, r.mentions)).toBe(`@${ANNA} и @${BORIS}, @${unknown} @here \`@${BORIS}\``);
  });

  it('ignores ids glued to a word', () => {
    expect(fromWire(`x@${BORIS}`, (id) => names[id]).text).toBe(`x@${BORIS}`);
  });
});

describe('exactNames', () => {
  it('drops duplicate names and names that shadow @everyone / @here', () => {
    const m = exactNames([
      { id: ANNA, name: 'Анна' },
      { id: ANNA2, name: 'Анна' },
      { id: BORIS, name: 'Борис' },
      { id: 'x', name: 'Everyone' },
    ]);
    expect([...m]).toEqual([['Борис', BORIS]]);
  });
});

describe('mentionQuery', () => {
  it('finds the query before the caret', () => {
    expect(mentionQuery('привет @Ан', 10)).toEqual({ start: 7, query: 'Ан' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('@Анна См', 8)).toEqual({ start: 0, query: 'Анна См' });
  });

  it('no query after a boundary break, in code, in e-mails', () => {
    expect(mentionQuery('mail@x', 6)).toBeNull();
    expect(mentionQuery('`@Ан', 4)).toBeNull();
    expect(mentionQuery('@Анна\nт', 7)).toBeNull();
    expect(mentionQuery('@ Ан', 4)).toBeNull();
    expect(mentionQuery('@Ан, ', 5)).toBeNull();
    expect(mentionQuery('без собаки', 10)).toBeNull();
  });
});

describe('filters', () => {
  const list = [
    { id: ANNA, name: 'Анна Смирнова', alt: [] },
    { id: BORIS, name: 'Борис Петров', alt: ['Боб'] },
    { id: ANNA2, name: 'Смирнов', alt: [] },
  ];

  it('prefix of the name ranks above a word prefix', () => {
    expect(filterCandidates('смир', list).map((c) => c.id)).toEqual([ANNA2, ANNA]);
    expect(filterCandidates('боб', list).map((c) => c.id)).toEqual([BORIS]);
    expect(filterCandidates('', list)).toHaveLength(3);
    expect(filterCandidates('zz', list)).toEqual([]);
  });

  it('special mentions by English and Russian words', () => {
    expect(filterSpecial('')).toEqual(['everyone', 'here']);
    expect(filterSpecial('все')).toEqual(['everyone']);
    expect(filterSpecial('he')).toEqual(['here']);
  });
});

describe('applyMention / codeRanges', () => {
  it('replaces the query and adds one space', () => {
    expect(applyMention('привет @Ан', 7, 10, 'Анна Смирнова')).toEqual({ text: 'привет @Анна Смирнова ', caret: 22 });
    expect(applyMention('@Бо как', 0, 3, 'Борис')).toEqual({ text: '@Борис как', caret: 7 });
  });

  it('code ranges: blocks and spans', () => {
    expect(codeRanges('a `b` ```c`d``` e')).toEqual([
      [2, 5],
      [6, 15],
    ]);
  });
});

describe('mentionsMe', () => {
  const ME = ANNA;
  const OTHER = BORIS;

  it('direct mention (any case), @everyone / @here', () => {
    expect(mentionsMe({ content: `привет @${ME.toUpperCase()}`, authorId: OTHER }, ME)).toBe(true);
    expect(mentionsMe({ content: '@here созвон', authorId: OTHER }, ME)).toBe(true);
    expect(mentionsMe({ content: '@everyone', authorId: OTHER }, ME)).toBe(true);
    expect(mentionsMe({ content: `@${ANNA2}`, authorId: OTHER }, ME)).toBe(false);
  });

  it('never for my own messages, guests cannot mention everyone, code does not count', () => {
    expect(mentionsMe({ content: `@${ME} @here`, authorId: ME }, ME)).toBe(false);
    expect(mentionsMe({ content: '@here', authorId: OTHER }, ME, false)).toBe(false); // no MENTION_EVERYONE
    expect(mentionsMe({ content: `@${ME}`, authorId: OTHER }, ME, false)).toBe(true);
    expect(mentionsMe({ content: `\`@${ME}\` \`\`\`\n@here\n\`\`\``, authorId: OTHER }, ME)).toBe(false);
    expect(mentionsMe({ content: `mail@${ME}`, authorId: OTHER }, ME)).toBe(false);
  });

  it('never for a forwarded copy (ADR-0033: someone else’s text notifies nobody)', () => {
    expect(mentionsMe({ content: `@${ME} @here`, authorId: OTHER, forward: { authorId: OTHER } }, ME)).toBe(false);
  });

  it('my achievement card mentions me (ADR-0061: its author is the recipient)', () => {
    const card = (authorId: string, forward?: unknown) =>
      create(MessageSchema, {
        authorId,
        kind: MessageKind.SYSTEM,
        system: { payload: { case: 'achievement', value: { achievementId: 'a1', grantId: 'g1', note: 'за релиз', grantedBy: OTHER } } },
        ...(forward ? { forward: { authorId: OTHER } } : {}),
      });
    expect(mentionsMe(card(ME), ME)).toBe(true);
    expect(mentionsMe(card(OTHER), ME)).toBe(false); // someone else's card
    expect(mentionsMe(card(ME, true), ME)).toBe(false); // a forwarded copy
    expect(mentionsMe(card(ME), '')).toBe(false);
    // A birthday card is authored by its person too, yet mentions nobody.
    const bday = create(MessageSchema, { authorId: ME, kind: MessageKind.SYSTEM, system: { payload: { case: 'birthday', value: { day: 1, month: 2 } } } });
    expect(mentionsMe(bday, ME)).toBe(false);
  });
});
