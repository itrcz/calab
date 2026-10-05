import { beforeEach, describe, expect, it, vi } from 'vitest';
const mem = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
const navigate = vi.fn();
vi.stubGlobal('window', Object.assign(globalThis, { addEventListener: vi.fn() }));
vi.stubGlobal('document', { addEventListener: vi.fn() });
vi.stubGlobal('navigator', { userAgent: 'Chrome/150', onLine: true });
vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/sso/complete', search: '', assign: navigate });
const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchSpy);
const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const local = { accessToken: 'local', sessionId: 'session-local', accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const scoped = {
  accessToken: 'scope',
  refreshToken: '',
  sessionId: 'session-scope',
  accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  authority: { kind: 'SESSION_AUTHORITY_KIND_WORKSPACE_SSO', workspaceId: 'a' },
};
let platform: ReturnType<(typeof import('./web'))['createWebPlatform']>;
beforeEach(async () => {
  delete window.CalabHostActivity;
  vi.resetModules();
  mem.clear();
  fetchSpy.mockReset();
  navigate.mockReset();
  platform = (await import('./web')).createWebPlatform();
});
function pending(purpose: string, sessionId = ''): void {
  mem.set('calab-sso-flow', JSON.stringify({ purpose, workspaceId: 'a', flowId: 'flow', expiresAt: Date.now() + 240_000, sessionId }));
}
describe('web generated SSO adapter', () => {
  it('phone host rejects external SSO before creating flow or navigating', async () => {
    window.CalabHostActivity = { version: 1, host: 0, document: 'phone', send: vi.fn(), rotateDocument: vi.fn() };
    const result = await platform.auth.ssoBegin({ workspaceId: 'a', purpose: 'login' });
    expect(result).toMatchObject({ ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(mem.has('calab-sso-flow')).toBe(false);
  });
  it('anonymous restore retains pending standalone flow and finishes with a scoped bearer', async () => {
    pending('login');
    fetchSpy.mockResolvedValueOnce(json(401, {}));
    expect(await platform.auth.restore()).toBeNull();
    expect(mem.has('calab-sso-flow')).toBe(true);
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: scoped })).mockResolvedValueOnce(json(200, { me: {} }));
    const result = await platform.finishSso?.();
    expect(result?.ok).toBe(true);
    expect(await platform.auth.accessToken()).toBe('scope');
    expect(mem.get('calab-sso-workspace')).toBe('a');
    expect(JSON.stringify([...mem])).not.toContain('scope-refresh');
  });
  it('step-up preserves the local bearer and sends the bound initiating session', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    pending('step_up', local.sessionId);
    fetchSpy.mockResolvedValueOnce(json(200, { assurance: { workspaceId: 'a' } }));
    const result = await platform.finishSso?.();
    expect(result?.ok).toBe(true);
    expect(await platform.auth.accessToken()).toBe('local');
    const init = fetchSpy.mock.calls.at(-1)?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer local');
  });
  it('rejects account substitution and expired pending flow without finish', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    pending('link', 'different-session');
    expect((await platform.finishSso?.())?.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    mem.set(
      'calab-sso-flow',
      JSON.stringify({ purpose: 'link', workspaceId: 'a', flowId: 'flow', sessionId: local.sessionId, expiresAt: 0 }),
    );
    expect((await platform.finishSso?.())?.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('cancel during begin cannot navigate or revive pending state', async () => {
    fetchSpy.mockResolvedValueOnce(json(401, {}));
    let release!: (res: Response) => void;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const begin = platform.auth.ssoBegin({ workspaceId: 'a', purpose: 'login' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await platform.auth.ssoCancel('pending');
    release(
      json(200, {
        flowId: 'flow',
        authorizationUrl: 'https://idp.test/authorize',
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      }),
    );
    expect((await begin).ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(mem.has('calab-sso-flow')).toBe(false);
  });
  it('a failed local login does not change scoped refresh context', async () => {
    mem.set('calab-sso-workspace', 'a');
    platform = (await import('./web')).createWebPlatform();
    pending('login');
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: scoped })).mockResolvedValueOnce(json(200, { me: {} }));
    expect((await platform.finishSso?.())?.ok).toBe(true);
    fetchSpy.mockResolvedValueOnce(json(401, {}));
    expect((await platform.auth.login({ serverUrl: '', email: 'e', password: 'bad' })).ok).toBe(false);
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: scoped }));
    await platform.auth.forceRefresh();
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('/api/auth/sso/workspaces/a/refresh');
  });
  it('scoped logout then guest join restores normal refresh context', async () => {
    pending('login');
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: scoped })).mockResolvedValueOnce(json(200, { me: {} }));
    await platform.finishSso?.();
    fetchSpy.mockResolvedValueOnce(json(200, {}));
    await platform.auth.logout(false);
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {}, roomId: 'guest-room', workspaceId: 'guest-ws' }));
    expect((await platform.auth.guestJoin('invite', 'Guest')).ok).toBe(true);
    expect(mem.has('calab-sso-workspace')).toBe(false);
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local }));
    await platform.auth.forceRefresh();
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('/api/auth/refresh');
  });
  it('late guest response cannot replace a newly installed local account', async () => {
    let release!: (res: Response) => void;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const pending = platform.auth.guestJoin('invite', 'Guest');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'owner', password: 'p' });
    release(json(200, { tokens: { ...local, accessToken: 'guest' }, me: {} }));
    expect((await pending).ok).toBe(false);
    expect(await platform.auth.accessToken()).toBe('local');
  });
  it('late logout cannot erase the new local session', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'owner', password: 'p' });
    let release!: (res: Response) => void;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const pending = platform.auth.logout(false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'owner', password: 'p' });
    release(json(200, {}));
    await pending;
    expect(await platform.auth.accessToken()).toBe('local');
  });

  it('round-trips only the same-session opaque consent route through step-up', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'owner', password: 'p' });
    const handle = 'x'.repeat(43);
    Object.assign(location, { pathname: '/oauth/consent', search: `?request=${handle}&redirect_uri=https://evil.test` });
    fetchSpy.mockResolvedValueOnce(
      json(200, {
        flowId: 'flow',
        authorizationUrl: 'https://idp.test/authorize',
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      }),
    );
    expect((await platform.auth.ssoBegin({ workspaceId: 'a', purpose: 'step_up' })).ok).toBe(true);
    expect(mem.get('calab-sso-flow')).toContain(`/oauth/consent?request=${handle}`);
    expect(mem.get('calab-sso-flow')).not.toContain('evil.test');
    fetchSpy.mockResolvedValueOnce(json(200, { assurance: { workspaceId: 'a' } }));
    const completed = await platform.finishSso?.();
    expect(completed?.ok && completed.data.returnTo).toBe(`/oauth/consent?request=${handle}`);
    expect(mem.has('calab-sso-flow')).toBe(false);
    expect((await platform.finishSso?.())?.ok).toBe(false);
    Object.assign(location, { pathname: '/sso/complete', search: '' });
  });
  it('never returns arbitrary or account-substituted consent navigation', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { tokens: local, me: {} }));
    await platform.auth.login({ serverUrl: '', email: 'owner', password: 'p' });
    mem.set(
      'calab-sso-flow',
      JSON.stringify({
        purpose: 'step_up',
        workspaceId: 'a',
        flowId: 'flow',
        expiresAt: Date.now() + 240_000,
        sessionId: local.sessionId,
        returnTo: 'https://evil.test/oauth/consent?request=' + 'x'.repeat(43),
      }),
    );
    fetchSpy.mockResolvedValueOnce(json(200, { assurance: { workspaceId: 'a' } }));
    const result = await platform.finishSso?.();
    expect(result?.ok && result.data.returnTo).toBeUndefined();
    mem.set(
      'calab-sso-flow',
      JSON.stringify({
        purpose: 'step_up',
        workspaceId: 'a',
        flowId: 'flow',
        expiresAt: Date.now() + 240_000,
        sessionId: 'other',
        returnTo: '/oauth/consent?request=' + 'x'.repeat(43),
      }),
    );
    expect((await platform.finishSso?.())?.ok).toBe(false);
    expect(mem.has('calab-sso-flow')).toBe(false);
  });
});
