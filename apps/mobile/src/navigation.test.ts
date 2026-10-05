import { describe, expect, it } from 'vitest';
import { decideNavigation, decideNewWindow, isAppSubframe, isAppUrl } from './navigation';

const ORIGIN = 'https://app.example.com';

/** Lookalikes of ORIGIN that a prefix or suffix match would let in. Ones with credentials go nowhere. */
const LOOKALIKES = [
  'https://app.example.com.evil.test/',
  'https://app.example.com@evil.test/',
  'https://app.example.com:443@evil.test/',
  'https://evil.test/?https://app.example.com',
  'https://evil.test/#https://app.example.com',
  'https://evilapp.example.com/',
  'https://app.example.co/',
  'https://sub.app.example.com/',
  'https://app.example.com:8443/',
  'http://app.example.com/',
];

describe('isAppUrl', () => {
  it('accepts documents of the exact origin', () => {
    expect(isAppUrl('https://app.example.com', ORIGIN)).toBe(true);
    expect(isAppUrl('https://app.example.com/', ORIGIN)).toBe(true);
    expect(isAppUrl('https://APP.example.com:443/invite/x?y=1#z', ORIGIN)).toBe(true);
  });

  it.each(LOOKALIKES)('rejects the lookalike %s', (url) => {
    expect(isAppUrl(url, ORIGIN)).toBe(false);
  });

  it.each(['https://user:pw@app.example.com/', 'https://user@app.example.com/', 'not a url', ''])('rejects %j', (url) => {
    expect(isAppUrl(url, ORIGIN)).toBe(false);
  });
});

const outOrBlock = (url: string) => (url.includes('@') ? 'block' : 'external');

describe('decideNavigation', () => {
  // iOS events (react-native-webview 13.16.1): isTopFrame is request.URL == request.mainDocumentURL.
  const top = (url: string) => decideNavigation({ url, isTopFrame: true, mainDocumentURL: url }, ORIGIN);
  const frame = (url: string) => decideNavigation({ url, isTopFrame: false, mainDocumentURL: `${ORIGIN}/chat` }, ORIGIN);
  // Android events carry neither isTopFrame nor mainDocumentURL.
  const unknown = (url: string) => decideNavigation({ url }, ORIGIN);

  it('loads the app origin in any frame', () => {
    expect(top('https://app.example.com/chat')).toBe('load');
    expect(frame('https://app.example.com/embed')).toBe('load');
    expect(unknown('https://app.example.com/')).toBe('load');
  });

  it.each(LOOKALIKES)('never loads the lookalike %s in the top frame', (url) => {
    expect(top(url)).toBe(outOrBlock(url));
  });

  it('hands top-frame links out to the OS, never with credentials', () => {
    expect(top('https://docs.example.org/page')).toBe('external');
    expect(top('mailto:sales@example.com?subject=Plan')).toBe('external');
    expect(top('https://user:pw@docs.example.org/')).toBe('block');
    expect(top('https://user:pw@app.example.com/')).toBe('block');
    expect(top('mailto:')).toBe('block');
    expect(top('mailto:%0Aa@b.c')).toBe('block');
  });

  it.each([
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/hosts',
    'blob:https://app.example.com/0b1c',
    'about:blank',
    'tel:+10000000000',
    'sms:+10000000000',
    'intent://scan#Intent;scheme=zxing;end',
    'calab://join/x',
    'itms-services://?action=download-manifest&url=https://evil.test/m.plist',
    'ws://app.example.com/gateway',
    'not a url',
  ])('blocks %s in every frame', (url) => {
    expect(top(url)).toBe('block');
    expect(frame(url === 'about:blank' ? 'about:blank#x' : url)).toBe('block');
    expect(unknown(url)).toBe('block');
  });

  it('lets third-party https iframes load in place, without credentials', () => {
    expect(frame('https://widget.example.org/app')).toBe('load');
    expect(frame('https://app.example.com.evil.test/')).toBe('load');
    expect(frame('https://user:pw@widget.example.org/')).toBe('block');
    expect(frame('http://widget.example.org/')).toBe('block');
    expect(frame('mailto:a@b.c')).toBe('block');
  });

  it('lets an iframe be empty', () => {
    expect(frame('about:blank')).toBe('load');
    expect(frame('about:srcdoc')).toBe('load');
  });

  it('never loads another origin without frame identity (Android), only hands links out', () => {
    expect(decideNavigation({ url: 'https://outside.example/' }, 'https://app.example')).toBe('external');
    expect(unknown('https://widget.example.org/app')).toBe('external');
    expect(unknown('http://widget.example.org/')).toBe('external');
    expect(unknown('mailto:sales@example.com')).toBe('external');
    expect(unknown('https://user:pw@widget.example.org/')).toBe('block');
    expect(unknown('about:blank')).toBe('block');
    expect(unknown('about:srcdoc')).toBe('block');
  });

  it.each(LOOKALIKES)('never loads the lookalike %s without frame identity', (url) => {
    expect(unknown(url)).toBe(outOrBlock(url));
  });

  it('lets an iframe load only when the top document is proven to be the app (iOS)', () => {
    const sub = (mainDocumentURL?: string) =>
      decideNavigation(
        mainDocumentURL === undefined
          ? { url: 'https://widget.example.org/app', isTopFrame: false }
          : { url: 'https://widget.example.org/app', isTopFrame: false, mainDocumentURL },
        ORIGIN,
      );
    expect(sub(`${ORIGIN}/`)).toBe('load');
    expect(sub(undefined)).toBe('external');
    expect(sub('https://outside.example/')).toBe('external');
    expect(sub('https://app.example.com.evil.test/')).toBe('external');
    expect(decideNavigation({ url: 'about:blank', isTopFrame: false }, ORIGIN)).toBe('block');
  });
});

describe('isAppSubframe', () => {
  it('needs isTopFrame false and the app as the top document', () => {
    expect(isAppSubframe({ url: 'https://w.example.org/', isTopFrame: false, mainDocumentURL: `${ORIGIN}/x` }, ORIGIN)).toBe(true);
    expect(isAppSubframe({ url: 'https://w.example.org/', isTopFrame: true, mainDocumentURL: `${ORIGIN}/x` }, ORIGIN)).toBe(false);
    expect(isAppSubframe({ url: 'https://w.example.org/', isTopFrame: false }, ORIGIN)).toBe(false);
    expect(isAppSubframe({ url: 'https://w.example.org/' }, ORIGIN)).toBe(false);
  });
});

describe('decideNewWindow', () => {
  it('opens links out in the OS', () => {
    expect(decideNewWindow('https://docs.example.org/x', ORIGIN)).toBe('external');
    expect(decideNewWindow('http://docs.example.org/x', ORIGIN)).toBe('external');
    expect(decideNewWindow('mailto:a@b.c', ORIGIN)).toBe('external');
  });

  it.each(LOOKALIKES)('treats the lookalike %s as a link out, not the app', (url) => {
    expect(decideNewWindow(url, ORIGIN)).toBe(outOrBlock(url));
  });

  it.each([
    'https://app.example.com/api/files/1',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/hosts',
    'blob:https://app.example.com/0b1c',
    'calab://join/x',
    'tel:+10000000000',
    'https://user:pw@docs.example.org/',
    '',
  ])('drops %j', (url) => {
    expect(decideNewWindow(url, ORIGIN)).toBe('block');
  });
});
