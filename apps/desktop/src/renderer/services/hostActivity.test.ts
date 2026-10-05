import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoice } from '../stores/voice';
import { useSession } from '../stores/session';
import { installHostActivity } from './hostActivity';
import type { SessionActivitySnapshot } from '../../shared/hostActivity';

const { revoked } = vi.hoisted(() => ({ revoked: { callback: (): void => undefined } }));
vi.mock('../platform', () => ({ platform: { auth: { onLoggedOut: (callback: () => void) => {
  revoked.callback = callback;
  return () => undefined;
} } } }));
vi.mock('../i18n', () => ({ getLocale: () => 'ru', subscribeLocale: () => () => undefined }));

let dispose: () => void = () => undefined;
const publish = vi.fn<(snapshot: SessionActivitySnapshot) => void>();
const clear = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  useVoice.setState({ roomId: null, joinedAt: null, phase: 'idle', muted: false, deafened: false, serverMuted: false, canSpeak: true });
  useSession.setState({ status: 'authed', sessionId: 'secret-session-id' });
  publish.mockClear(); clear.mockClear();
});
afterEach(() => { dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('single-source voice activity projection', () => {
  it('uses actual connection phase and mute, ends on leave/logout, and never sends product identity', () => {
    dispose = installHostActivity({ publish, clear });
    useVoice.setState({ roomId: 'private-room', joinedAt: 123, phase: 'connecting' });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'ended' });
    useVoice.setState({ phase: 'connected' });
    const generation: unknown = publish.mock.lastCall?.[0]?.generation;
    expect(publish.mock.lastCall?.[0]).toEqual({ generation, status: 'connected', muted: false, language: 'ru' });
    useVoice.setState({ phase: 'reconnecting', serverMuted: true });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ generation, status: 'reconnecting', muted: true });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('private-room');
    expect(JSON.stringify(publish.mock.calls)).not.toContain('secret-session-id');
    useVoice.setState({ phase: 'idle', roomId: null });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'ended' });
    revoked.callback();
    expect(clear).toHaveBeenCalledOnce();
    useSession.setState({ status: 'anon' });
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('has no idle timers and ignores speaking ticks; heartbeats exist only in active voice', () => {
    dispose = installHostActivity({ publish, clear });
    expect(vi.getTimerCount()).toBe(0);
    useVoice.setState({ roomId: 'room', joinedAt: 1, phase: 'connected' });
    expect(vi.getTimerCount()).toBe(1);
    const calls = publish.mock.calls.length;
    useVoice.setState({ levelDb: -20, speaking: { someone: true }, trackEpoch: 100 });
    expect(publish).toHaveBeenCalledTimes(calls);
    vi.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenCalledTimes(calls + 1);
    useVoice.setState({ roomId: null, phase: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('revocation immediately stops the lease even before asynchronous session teardown finishes', () => {
    dispose = installHostActivity({ publish, clear });
    useVoice.setState({ roomId: 'room', joinedAt: 1, phase: 'connected' });
    revoked.callback();
    const calls = publish.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    useVoice.setState({ muted: true });
    vi.advanceTimersByTime(90_000);
    expect(publish).toHaveBeenCalledTimes(calls);
    useSession.setState({ sessionId: 'new-authenticated-session' });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'connected' });
  });
});
