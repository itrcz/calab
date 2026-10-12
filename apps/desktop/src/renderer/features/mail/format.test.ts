import { describe, expect, it } from 'vitest';
import { forwardSubject, initialText, quoteLines, replyRecipients, replySubject, resolveLogin, suggest } from './compose';
import { mailInitials, mailListTime, providerOf } from './format';

describe('mailListTime (Apple Mail)', () => {
  const now = new Date(2026, 9, 12, 15, 0);
  it('today — the time, this year — day and month, older — the date', () => {
    expect(mailListTime(new Date(2026, 9, 12, 9, 5).getTime(), now)).toMatch(/09:05|9:05/);
    const thisYear = mailListTime(new Date(2026, 2, 3, 10).getTime(), now);
    expect(thisYear).toMatch(/3/);
    expect(thisYear).not.toMatch(/2026/);
    expect(mailListTime(new Date(2025, 11, 31, 10).getTime(), now)).toMatch(/2025/);
  });
});

describe('initials and providers', () => {
  it('two letters from the name, else the address', () => {
    expect(mailInitials({ name: 'Анна Петрова', address: 'a@x.io' })).toBe('АП');
    expect(mailInitials({ name: '', address: 'bob@x.io' })).toBe('B');
  });
  it('knows the app-password providers by domain', () => {
    expect(providerOf('a@gmail.com')).toBe('gmail');
    expect(providerOf('a@ya.ru')).toBe('yandex');
    expect(providerOf('a@bk.ru')).toBe('mailru');
    expect(providerOf('a@me.com')).toBe('icloud');
    expect(providerOf('a@outlook.com')).toBe('microsoft');
    expect(providerOf('a@firm.example')).toBe('other');
  });
  it('resolves autoconfig login templates', () => {
    expect(resolveLogin('%EMAILLOCALPART%', 'anna@x.io')).toBe('anna');
    expect(resolveLogin('%EMAILADDRESS%', 'anna@x.io')).toBe('anna@x.io');
  });
});

describe('reply / forward prefill', () => {
  const msg = {
    from: { name: 'Igor', address: 'Igor@x.io' },
    to: [{ name: 'Me', address: 'me@x.io' }, { name: 'Dima', address: 'dima@x.io' }],
    cc: [{ name: '', address: 'olga@x.io' }, { name: 'Me again', address: 'ME@x.io' }],
    replyTo: [],
  };
  it('reply goes to the sender (or Reply-To); reply all adds the others to Cc, never me', () => {
    expect(replyRecipients(msg, ['me@x.io'], false)).toEqual({ to: [{ name: 'Igor', address: 'igor@x.io' }], cc: [] });
    expect(replyRecipients({ ...msg, replyTo: [{ name: 'List', address: 'list@x.io' }] }, ['me@x.io'], false).to).toEqual([{ name: 'List', address: 'list@x.io' }]);
    expect(replyRecipients(msg, ['me@x.io'], true).cc.map((a) => a.address)).toEqual(['dima@x.io', 'olga@x.io']);
  });
  it('replying to my own message goes to its recipients', () => {
    const mine = { ...msg, from: { name: 'Me', address: 'me@x.io' }, to: [{ name: 'Igor', address: 'igor@x.io' }], cc: [] };
    expect(replyRecipients(mine, ['me@x.io'], false).to).toEqual([{ name: 'Igor', address: 'igor@x.io' }]);
  });
  it('subjects get one prefix', () => {
    expect(replySubject('Plan')).toBe('Re: Plan');
    expect(replySubject('RE: Plan')).toBe('RE: Plan');
    expect(replySubject('Ответ: план')).toBe('Ответ: план');
    expect(forwardSubject('Plan')).toBe('Fwd: Plan');
    expect(forwardSubject('Fw: Plan')).toBe('Fw: Plan');
  });
  it('signature and quote', () => {
    expect(initialText('— Анна')).toBe('\n\n-- \n— Анна');
    expect(initialText('')).toBe('');
    expect(quoteLines('a\n> b')).toBe('> a\n>> b');
  });
  it('suggests by name or address prefix, skipping chosen ones', () => {
    const pool = [
      { name: 'Anna Petrova', address: 'anna@x.io' },
      { name: 'Ivan', address: 'ivan.petrov@y.io' },
      { name: 'Bob', address: 'bob@z.io' },
    ];
    expect(suggest(pool, 'pet', []).map((a) => a.address)).toEqual(['anna@x.io', 'ivan.petrov@y.io']);
    expect(suggest(pool, 'an', [{ name: '', address: 'anna@x.io' }]).map((a) => a.address)).toEqual(['ivan.petrov@y.io']);
  });
});
