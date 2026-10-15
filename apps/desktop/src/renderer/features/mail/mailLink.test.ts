import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeAddPayload, parseAddPayload, parseAddressList, parseMailLink } from './mailLink';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('calab://mail/<payload> (ADR-0088 §12)', () => {
  it('decodes email:password; the first colon separates', () => {
    expect(parseMailLink(`calab://mail/${b64url('Anna@Example.com:pa:ss:word')}`)).toEqual({ kind: 'add', email: 'anna@example.com', password: 'pa:ss:word' });
  });

  it('takes a bare email (no password) and the old scheme', () => {
    expect(parseMailLink(`calaba://mail/${b64url('bob@example.org')}`)).toEqual({ kind: 'add', email: 'bob@example.org', password: '' });
  });

  it('keeps unicode passwords and accepts padding', () => {
    const payload = Buffer.from('k@x.ru:пароль✓', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(parseAddPayload(payload)).toEqual({ email: 'k@x.ru', password: 'пароль✓' });
  });

  it('encodes the add payload back (ADR-0101: the reset page builds the link)', () => {
    const payload = encodeAddPayload('boris@calab.io', 'pa:ss:word✓');
    expect(payload).toBe(b64url('boris@calab.io:pa:ss:word✓'));
    expect(parseAddPayload(payload)).toEqual({ email: 'boris@calab.io', password: 'pa:ss:word✓' });
  });

  it('rejects damaged payloads', () => {
    expect(parseMailLink('calab://mail/***')).toEqual({ kind: 'invalid' });
    expect(parseMailLink(`calab://mail/${b64url('not-an-email:pw')}`)).toEqual({ kind: 'invalid' });
    expect(decodeBase64Url('A')).toBeNull();
    expect(decodeBase64Url(b64url('ÿ').slice(0, 2) + '__')).toBeNull();
  });

  it('opens a message by account and id', () => {
    expect(parseMailLink('calab://mail/acc-1/m%2F42')).toEqual({ kind: 'open', accountId: 'acc-1', messageId: 'm/42' });
  });

  it('is not a mail link otherwise', () => {
    expect(parseMailLink('calab://join/abcd')).toBeNull();
    expect(parseMailLink('https://calab.io/#mail=abc')).toBeNull();
  });
});

describe('compose links', () => {
  it('parses mailto: with cc, subject and body', () => {
    expect(parseMailLink('mailto:Ann%20<ann@x.io>,bob@y.io?cc=c@z.io&subject=Hi%20there&body=Line+1%0ALine 2')).toEqual({
      kind: 'compose',
      to: [
        { name: 'Ann', address: 'ann@x.io' },
        { name: '', address: 'bob@y.io' },
      ],
      cc: [{ name: '', address: 'c@z.io' }],
      subject: 'Hi there',
      body: 'Line 1\nLine 2',
    });
  });

  it('parses calab://mail/compose?to=', () => {
    expect(parseMailLink('calab://mail/compose?to=a@b.co&subject=x')).toMatchObject({ kind: 'compose', to: [{ address: 'a@b.co' }], subject: 'x' });
  });

  it('drops bad addresses', () => {
    expect(parseAddressList('x, "Q" <q@w.e>; nope@')).toEqual([{ name: 'Q', address: 'q@w.e' }]);
  });
});
