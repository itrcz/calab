import { describe, expect, it, vi } from 'vitest';
import { createHostCapabilities } from './hostActivity';

const state = { microphone: 'granted', camera: 'denied' } as const;
const unavailable = { microphone: 'n/a', camera: 'n/a' };
function getMedia(h: ReturnType<typeof setup>) {
  const capability = h.caps.mediaPermissions;
  if (!capability) throw new Error('Expected native media permissions');
  return capability;
}

function setup(version?: number) {
  const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
  const send = vi.fn();
  const bridge = { version: 1, mediaPermissionsVersion: version, notificationsVersion: 1, host: 0, document: 'old', send,
    rotateDocument: () => { bridge.document = 'new'; } };
  const caps = createHostCapabilities({ CalabHostActivity: bridge,
    addEventListener: (name: string, cb: (event: CustomEvent<unknown>) => void) => handlers.set(name, cb),
  } as unknown as Window);
  const emit = (name: string, detail: object) => handlers.get(name)?.({ detail } as CustomEvent<unknown>);
  const ready = (permissions = 1) => emit('calab-host-activity-ready', { v: 1, host: 0, document: bridge.document, capability: 'notifications', notifications: 1, permissions });
  const reply = (extra: object = {}) => emit('calab-host-permissions', { v: 1, host: 0, document: bridge.document, request: 1, state, ...extra });
  return { caps, send, ready, reply };
}

describe('native media permission capability', () => {
  it('retains the old-host fallback and does not send operations rejected by the handshake', async () => {
    expect(setup().caps.mediaPermissions).toBeUndefined();
    const h = setup(1); const cap = getMedia(h);
    const first = cap.state(); h.ready(0);
    await expect(first).resolves.toEqual(unavailable);
    h.send.mockClear();
    await expect(cap.request('camera')).resolves.toEqual(unavailable);
    await expect(cap.openSettings()).resolves.toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('waits for document authority and requests only the selected permission', async () => {
    const h = setup(1); const cap = getMedia(h);
    const done = cap.request('microphone');
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ type: 'hello' });
    h.ready();
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ type: 'permissions', operation: 'request', kind: 'microphone' });
    h.reply(); await expect(done).resolves.toEqual(state);
    const settings = cap.openSettings();
    const sent = JSON.parse(String(h.send.mock.lastCall?.[0])) as Record<string, unknown>;
    expect(sent).toMatchObject({ type: 'permissions', operation: 'settings' });
    expect(sent).not.toHaveProperty('url');
    h.reply({ request: sent.request, opened: true }); await expect(settings).resolves.toBe(true);
  });

  it('rejects stale and malformed replies, and revocation settles pending work', async () => {
    const h = setup(1); h.ready(); const cap = getMedia(h);
    const settled = vi.fn(); const done = cap.request('camera').then(settled);
    for (const extra of [{ document: 'other' }, { host: 9 }, { request: '1' }, { opened: 'yes' }, { state: { microphone: 'granted' } }]) h.reply(extra);
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    h.caps.sessionActivity?.clear('logout'); await done;
    expect(settled).toHaveBeenCalledExactlyOnceWith(unavailable);
    h.reply({ document: 'old' }); expect(settled).toHaveBeenCalledOnce();
  });

  it('refreshes on foreground events without changing notification registration', () => {
    const h = setup(1); h.ready(); const media = vi.fn(); const notifications = vi.fn();
    const unsubscribe = getMedia(h).subscribe(media);
    h.caps.notifications?.subscribe(notifications);
    h.reply({ request: 0 }); expect(media).toHaveBeenCalledExactlyOnceWith(state);
    expect(notifications).not.toHaveBeenCalled();
    unsubscribe(); h.reply({ request: 0 }); expect(media).toHaveBeenCalledOnce();
  });

  it('bounds an unanswered prompt and ignores its late completion', async () => {
    vi.useFakeTimers();
    try {
      const h = setup(1); h.ready(); const cap = getMedia(h);
      const listener = vi.fn(); cap.subscribe(listener);
      const prompt = cap.request('camera');
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(prompt).resolves.toEqual(unavailable);
      h.reply(); expect(listener).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
