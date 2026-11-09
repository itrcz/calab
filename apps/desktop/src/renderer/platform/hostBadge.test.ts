import { describe, expect, it, vi } from 'vitest';
import { createHostCapabilities } from './hostActivity';
import { parseHostActivityMessage } from '../../shared/hostActivity';

describe('native app badge', () => {
  const document = '00000000-0000-4000-8000-000000000001';
  const envelope = { v: 1, type: 'notifications', host: 0, document, seq: 1, request: 1, operation: 'badge' };
  it('accepts zero and bounded integers, rejecting malformed counts and extra fields', () => {
    for (const count of [0, 1, 99999]) expect(parseHostActivityMessage(JSON.stringify({ ...envelope, count }))).not.toBeNull();
    for (const count of [-1, 0.5, 100000, null, '3']) expect(parseHostActivityMessage(JSON.stringify({ ...envelope, count }))).toBeNull();
    expect(parseHostActivityMessage(JSON.stringify({ ...envelope, count: 3, token: 'foreign' }))).toBeNull();
  });
  function setup(version?: number) {
    const callbacks = new Map<string, (e: CustomEvent) => void>();
    const send = vi.fn();
    const bridge = { version: 1, notificationsVersion: 1, notificationsBadgeVersion: version,
      host: 0, document, send, rotateDocument() { this.document = '00000000-0000-4000-8000-000000000002'; } };
    const cap = createHostCapabilities({ CalabHostActivity: bridge,
      addEventListener: (name: string, cb: (e: CustomEvent) => void) => callbacks.set(name, cb),
    } as unknown as Window).notifications;
    if (!cap) throw new Error("notification capability missing");
    const ready = () => callbacks.get('calab-host-activity-ready')?.({ detail: { v: 1, host: 0,
      document: bridge.document, capability: 'notifications', notifications: 1 } } as CustomEvent);
    return { cap, send, ready, bridge };
  }
  it('is optional and sends only the latest count after the document handshake', () => {
    expect(setup().cap.setBadge).toBeUndefined();
    const h = setup(1);
    h.cap.setBadge?.(3); h.cap.setBadge?.(5);
    expect(h.send.mock.calls.every(c => (JSON.parse(String(c[0])) as {type: string}).type === 'hello')).toBe(true);
    h.ready();
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ operation: 'badge', count: 5, document });
    h.cap.setBadge?.(0);
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ operation: 'badge', count: 0 });
  });
  it('never replays an old account count after logout', () => {
    const h = setup(1); h.cap.setBadge?.(7); h.ready(); h.cap.clear('logout');
    h.ready();
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ type: 'revoke', reason: 'logout' });
    h.cap.setBadge?.(2);
    expect(JSON.parse(String(h.send.mock.lastCall?.[0]))).toMatchObject({ operation: 'badge', count: 2, document: h.bridge.document });
  });
});
