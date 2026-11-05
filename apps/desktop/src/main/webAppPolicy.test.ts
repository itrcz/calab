import { describe, expect, it } from 'vitest';
import {
  consentRequest,
  dropLru,
  mayNavigate,
  mayNavigateFrame,
  originOf,
  parseAppId,
  parseBounds,
  partitionOf,
  permissionCheck,
  permissionDecision,
  resolveWithRemembered,
  sameEndpoint,
  sameSite,
  signInAllowed,
  signInAnswer,
  siteOf,
  touchLru,
  windowOpenDecision,
  workspaceSignIn,
} from './webAppPolicy';

describe('permissionDecision (ADR-0050 §4 policy table)', () => {
  const table: [string, string[], ReturnType<typeof permissionDecision>][] = [
    ['media', ['audio'], { kind: 'ask', ask: ['microphone'] }],
    ['media', ['video'], { kind: 'ask', ask: ['camera'] }],
    ['media', ['audio', 'video'], { kind: 'ask', ask: ['camera', 'microphone'] }],
    ['media', [], { kind: 'deny' }],
    ['notifications', [], { kind: 'ask', ask: ['notifications'] }],
    ['geolocation', [], { kind: 'ask', ask: ['geolocation'] }],
    ['clipboard-read', [], { kind: 'ask', ask: ['clipboard-read'] }],
    ['clipboard-sanitized-write', [], { kind: 'allow' }],
  ];
  for (const [p, types, want] of table) {
    it(`${p} ${types.join('+')}`, () => expect(permissionDecision(p, types)).toEqual(want));
  }
  for (const p of [
    'hid',
    'serial',
    'usb',
    'midi',
    'midiSysex',
    'pointerLock',
    'keyboardLock',
    'fullscreen',
    'display-capture',
    'openExternal',
    'idle-detection',
    'window-management',
    'storage-access',
    'top-level-storage-access',
    'mediaKeySystem',
    'speaker-selection',
    'unknown',
  ]) {
    it(`${p} is refused`, () => expect(permissionDecision(p)).toEqual({ kind: 'deny' }));
  }
});

describe('permission memory', () => {
  it('check grants only allowed or remembered-granted kinds', () => {
    expect(permissionCheck('clipboard-sanitized-write', undefined, {})).toBe(true);
    expect(permissionCheck('hid', undefined, {})).toBe(false);
    expect(permissionCheck('media', 'audio', {})).toBe(false);
    expect(permissionCheck('media', 'audio', { microphone: true })).toBe(true);
    expect(permissionCheck('media', 'video', { microphone: true })).toBe(false);
    expect(permissionCheck('media', undefined, { microphone: true })).toBe(false);
    expect(permissionCheck('media', undefined, { microphone: true, camera: true })).toBe(true);
    expect(permissionCheck('notifications', undefined, { notifications: false })).toBe(false);
  });
  it('request asks only what is not remembered; one remembered refusal refuses', () => {
    expect(resolveWithRemembered(['camera', 'microphone'], {})).toEqual({ ask: ['camera', 'microphone'] });
    expect(resolveWithRemembered(['camera', 'microphone'], { camera: true })).toEqual({ ask: ['microphone'] });
    expect(resolveWithRemembered(['camera', 'microphone'], { camera: true, microphone: true })).toEqual({ grant: true });
    expect(resolveWithRemembered(['camera', 'microphone'], { camera: false })).toEqual({ grant: false });
  });
});

describe('navigation', () => {
  it('top level: https anywhere, http only to private hosts, no other scheme', () => {
    expect(mayNavigate('https://accounts.example.com/sso?x=1')).toBe(true);
    expect(mayNavigate('http://10.0.0.5/app')).toBe(true);
    expect(mayNavigate('http://example.com/')).toBe(false);
    // SSO redirects: long queries and hosts the saved-address rule would refuse are fine over https.
    expect(mayNavigate(`https://idp.example.com/saml?SAMLRequest=${'a'.repeat(4000)}`)).toBe(true);
    expect(mayNavigate('https://my_host.example.com/')).toBe(true);
    expect(mayNavigate('http://user@10.0.0.5/')).toBe(true);
    expect(mayNavigate('http://10.0.0.5@evil.com/')).toBe(false);
    expect(mayNavigate('https:///x')).toBe(false);
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'calab://join/x', 'calaba-api://api/api/me', 'zoommtg://x', 'mailto:a@b.c']) {
      expect(mayNavigate(u), u).toBe(false);
    }
  });
  it('sub-frames: web content only', () => {
    for (const u of ['https://www.youtube.com/embed/x', 'about:blank', 'about:srcdoc', 'blob:https://a.test/1', 'data:image/png;base64,AA==']) {
      expect(mayNavigateFrame(u), u).toBe(true);
    }
    for (const u of ['file:///x', 'javascript:1', 'calab://x', 'about:config']) expect(mayNavigateFrame(u), u).toBe(false);
  });
});

describe('originOf (permission memory key)', () => {
  it('is the scheme and host of an http(s) page', () => {
    expect(originOf('https://Meet.Example.com:8443/room?x=1')).toBe('https://meet.example.com:8443');
    expect(originOf('https://user:pw@a.test/x')).toBe('https://a.test');
    expect(originOf('http://10.0.0.5')).toBe('http://10.0.0.5');
    expect(originOf('https://evil.test/')).not.toBe(originOf('https://meet.example.com/'));
    for (const u of ['', 'about:blank', 'file:///x', 'data:text/html,x']) expect(originOf(u), u).toBe('');
  });
});

describe('windowOpenDecision (ADR-0050 §4)', () => {
  const app = 'https://grafana.example.com/d/1';
  const table: [string, string, string, ReturnType<typeof windowOpenDecision>][] = [
    // OAuth / SSO popups (window.open with features) stay in Calab, with the app's session.
    [app, 'https://accounts.google.com/o/oauth2/auth?x', 'new-window', 'child'],
    [app, 'about:blank', 'new-window', 'child'],
    // The same site in a new tab → a child window; another site → the browser.
    [app, 'https://docs.example.com/page', 'foreground-tab', 'child'],
    [app, 'https://other.test/', 'foreground-tab', 'external'],
    [app, 'https://other.test/', 'background-tab', 'external'],
    // http to a public host: never inside Calab.
    [app, 'http://other.test/', 'new-window', 'external'],
    // Other schemes are refused.
    [app, 'file:///etc/passwd', 'new-window', 'deny'],
    [app, 'javascript:alert(1)', 'foreground-tab', 'deny'],
    [app, 'calab://join/x', 'foreground-tab', 'deny'],
    [app, 'about:blank', 'foreground-tab', 'deny'],
  ];
  for (const [opener, url, disp, want] of table) {
    it(`${url} (${disp}) → ${want}`, () => expect(windowOpenDecision(opener, url, disp)).toBe(want));
  }
});

describe('sites', () => {
  it('registrable domain, approximated', () => {
    expect(siteOf('https://a.b.example.com/x')).toBe('example.com');
    expect(siteOf('https://shop.example.co.uk/')).toBe('example.co.uk');
    expect(siteOf('https://mail.yandex.ru/')).toBe('yandex.ru');
    expect(siteOf('http://10.0.0.5:8080/')).toBe('10.0.0.5');
    expect(siteOf('https://user@Example.COM./')).toBe('example.com');
    expect(siteOf('about:blank')).toBe('');
    expect(sameSite('https://a.example.com', 'https://b.example.com/x')).toBe(true);
    expect(sameSite('https://example.com', 'https://example.org')).toBe(false);
    expect(sameSite('about:blank', 'about:blank')).toBe(false);
  });
});

describe('LRU of live views (ADR-0050 §5: at most 2)', () => {
  it('keeps the two most recent and evicts the rest', () => {
    let s = touchLru([], 'a');
    expect(s).toEqual({ order: ['a'], evicted: [] });
    s = touchLru(s.order, 'b');
    expect(s).toEqual({ order: ['b', 'a'], evicted: [] });
    s = touchLru(s.order, 'a');
    expect(s).toEqual({ order: ['a', 'b'], evicted: [] });
    s = touchLru(s.order, 'c');
    expect(s).toEqual({ order: ['c', 'a'], evicted: ['b'] });
    expect(dropLru(s.order, 'c')).toEqual(['a']);
    expect(touchLru(['x', 'y', 'z'], 'w', 1)).toEqual({ order: ['w'], evicted: ['x', 'y', 'z'] });
  });
});

describe('IPC arguments', () => {
  it('bounds are validated and scaled by the page zoom', () => {
    expect(parseBounds({ x: 72, y: 70.4, width: 800.6, height: 500 })).toEqual({ x: 72, y: 70, width: 801, height: 500 });
    expect(parseBounds({ x: 10, y: 10, width: 100, height: 100 }, 1.25)).toEqual({ x: 13, y: 13, width: 125, height: 125 });
    expect(() => parseBounds({ x: -1, y: 0, width: 1, height: 1 })).toThrow();
    expect(() => parseBounds({ x: 0, y: 0, width: Number.NaN, height: 1 })).toThrow();
    expect(() => parseBounds(null)).toThrow();
  });
  it('app ids are UUIDs (they name the partition)', () => {
    expect(parseAppId('0190A5B4-7C1D-7E2F-8A9B-0C1D2E3F4A5B')).toBe('0190a5b4-7c1d-7e2f-8a9b-0c1d2e3f4a5b');
    expect(partitionOf('x')).toBe('persist:app-x');
    for (const bad of ['', '../x', 'a'.repeat(36), 1, null]) expect(() => parseAppId(bad)).toThrow();
  });
});

describe('workspaceSignIn (ADR-0159)', () => {
  const server = 'https://app.calab.io';
  const ws = '01a0da5f-326c-7369-a76d-57f9527e8d83';
  const other = '11111111-2222-4333-8444-555555555555';
  const home = 'https://support.example.com/';
  const params = (over: Record<string, string | null> = {}): string => {
    const q = new URLSearchParams({
      client_id: 'calab_client_x',
      redirect_uri: 'https://support.example.com/oauth2/callback',
      response_type: 'code',
      scope: 'openid profile email',
      state: 's',
      nonce: 'n',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
    for (const [k, v] of Object.entries(over)) if (v === null) q.delete(k);
    else q.set(k, v);
    return q.toString();
  };
  const authorize = (over: Record<string, string | null> = {}, wsId = ws, origin = server): string => `${origin}/oidc/workspaces/${wsId}/authorize?${params(over)}`;

  it('answers the app workspace sign-in of our server, silently first', () => {
    const r = workspaceSignIn(authorize(), server, ws, home);
    if (!r) throw new Error('no sign-in');
    expect(new URL(r.silent).searchParams.get('prompt')).toBe('none');
    expect(new URL(r.interactive).searchParams.has('prompt')).toBe(false);
    expect(r.redirectUri).toBe('https://support.example.com/oauth2/callback');
  });
  it.each([
    ['another workspace', authorize({}, other)],
    ['another server', authorize({}, ws, 'https://evil.example.com')],
    ['http server', authorize({}, ws, 'http://app.calab.io')],
    ['another path', `${server}/oidc/workspaces/${ws}/token?${params()}`],
    ['a path suffix', `${server}/oidc/workspaces/${ws}/authorize/x?${params()}`],
    ['userinfo in the url', `https://u:p@app.calab.io/oidc/workspaces/${ws}/authorize?${params()}`],
    ['a fragment', `${authorize()}#x`],
    ['redirect to another site', authorize({ redirect_uri: 'https://evil.example.com/cb' })],
    ['redirect to a sibling host', authorize({ redirect_uri: 'https://other.example.com/oauth2/callback' })],
    ['redirect over http', authorize({ redirect_uri: 'http://support.example.com/cb' })],
    ['redirect with userinfo', authorize({ redirect_uri: 'https://x@support.example.com/cb' })],
    ['the site asks for prompt', authorize({ prompt: 'login' })],
    ['the site asks for silence itself', authorize({ prompt: 'none' })],
    ['max_age', authorize({ max_age: '0' })],
    ['a login hint', authorize({ login_hint: 'a@b.c' })],
    ['a request object', authorize({ request: 'x' })],
    ['no PKCE', authorize({ code_challenge: null })],
    ['plain PKCE', authorize({ code_challenge_method: 'plain' })],
    ['no nonce', authorize({ nonce: null })],
    ['implicit flow', authorize({ response_type: 'token' })],
    ['a duplicated parameter', `${authorize()}&redirect_uri=https%3A%2F%2Fevil.example.com%2Fcb`],
  ])('leaves %s to the site', (_name, url) => {
    expect(workspaceSignIn(url, server, ws, home)).toBeNull();
  });
  it('needs a known workspace and a valid app address', () => {
    expect(workspaceSignIn(authorize(), server, '', home)).toBeNull();
    expect(workspaceSignIn(authorize(), server, ws, 'not a url')).toBeNull();
    expect(workspaceSignIn(authorize(), '', ws, home)).toBeNull();
  });
  it('allows a private http app to get its answer over http', () => {
    const r = workspaceSignIn(authorize({ redirect_uri: 'http://intranet.local/cb' }), server, ws, 'http://intranet.local/');
    expect(r?.redirectUri).toBe('http://intranet.local/cb');
  });
});

describe('signInAnswer / consentRequest / sameEndpoint (ADR-0159)', () => {
  const server = 'https://app.calab.io';
  const cb = 'https://support.example.com/oauth2/callback';
  it('a code for the redirect_uri goes to the view', () => {
    expect(signInAnswer(`${cb}?code=abc&state=s&iss=x`, server, cb)).toEqual({ kind: 'code', url: `${cb}?code=abc&state=s&iss=x` });
  });
  it('consent_required asks once; other errors fall back', () => {
    expect(signInAnswer(`${cb}?error=consent_required&state=s`, server, cb)).toEqual({ kind: 'consent' });
    for (const err of ['login_required', 'interaction_required', 'access_denied', 'invalid_scope'])
      expect(signInAnswer(`${cb}?error=${err}`, server, cb)).toEqual({ kind: 'fallback' });
    expect(signInAnswer(null, server, cb)).toEqual({ kind: 'fallback' });
    expect(signInAnswer(`${cb}?code=a&error=x`, server, cb)).toEqual({ kind: 'fallback' });
  });
  it('a code addressed elsewhere is never loaded', () => {
    expect(signInAnswer('https://evil.example.com/oauth2/callback?code=a', server, cb)).toEqual({ kind: 'fallback' });
    expect(signInAnswer('https://support.example.com/other?code=a', server, cb)).toEqual({ kind: 'fallback' });
  });
  it('consent handle only from our server consent page', () => {
    const h = `calab_oh_${'a'.repeat(43)}`;
    expect(consentRequest(`/oauth/consent?request=${h}`, server)).toBe(h);
    expect(consentRequest(`https://evil.example.com/oauth/consent?request=${h}`, server)).toBeNull();
    expect(consentRequest(`/oauth/consent?request=${h}&request=${h}`, server)).toBeNull();
    expect(consentRequest('/oauth/consent?request=short', server)).toBeNull();
    expect(consentRequest(`/sign-in?request=${h}`, server)).toBeNull();
  });
  it('sameEndpoint compares origin and path', () => {
    expect(sameEndpoint(`${cb}?code=1`, cb)).toBe(true);
    expect(sameEndpoint('https://support.example.com:8443/oauth2/callback', cb)).toBe(false);
    expect(sameEndpoint(`${cb}#x`, cb)).toBe(false);
  });
  it('limits sign-ins per app per minute', () => {
    const now = 1_000_000;
    expect(signInAllowed([now - 1000, now - 2000], now)).toBe(true);
    expect(signInAllowed([now - 1000, now - 2000, now - 3000], now)).toBe(false);
    expect(signInAllowed([now - 61_000, now - 62_000, now - 63_000], now)).toBe(true);
  });
});
