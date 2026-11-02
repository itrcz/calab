import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '@calaba/protocol';
import { useCall } from '../stores/call';
import { useVoice } from '../stores/voice';
import { installHostMediaSession } from './hostMediaSession';
import type { HostMediaSession } from '../../shared/hostActivity';

const { leave, locale } = vi.hoisted(() => ({ leave: vi.fn(() => Promise.resolve()), locale: { value: 'ru', listener: (): void => undefined } }));
vi.mock('./voice', () => ({ voice: { leave } }));
vi.mock('../platform', () => ({ platform: {} }));
vi.mock('../i18n', () => ({ getLocale: () => locale.value, subscribeLocale: (cb: () => void) => { locale.listener = cb; return () => undefined; } }));

let dispose: () => void = () => undefined;
const set = vi.fn<(session: HostMediaSession, language: 'ru' | 'en') => void>();
let onLeave: () => void = () => undefined;
const capability = { set, onLeave: (listener: () => void) => { onLeave = listener; return () => { onLeave = () => undefined; }; } };

beforeEach(() => {
  vi.useFakeTimers();
  locale.value = 'ru';
  useVoice.setState({ roomId: null, phase: 'idle' });
  useCall.setState({ call: null, phase: 'idle', own: null });
  set.mockClear(); leave.mockClear();
});
afterEach(() => { dispose(); vi.useRealTimers(); });

describe('Android host media session (board #141)', () => {
  it('installs nothing without the capability', () => {
    dispose = installHostMediaSession(undefined);
    useVoice.setState({ roomId: 'room', phase: 'connected' });
    expect(set).not.toHaveBeenCalled();
  });
  it('reports room, call and none on change only, without timers or identifiers', () => {
    dispose = installHostMediaSession(capability);
    expect(set).not.toHaveBeenCalled();
    useVoice.setState({ roomId: 'private-room', phase: 'connecting' });
    expect(set).not.toHaveBeenCalled();
    useVoice.setState({ phase: 'connected' });
    expect(set).toHaveBeenLastCalledWith('room', 'ru');
    useVoice.setState({ phase: 'reconnecting', levelDb: -20, speaking: { someone: true } });
    expect(set).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    locale.value = 'en'; locale.listener();
    expect(set).toHaveBeenLastCalledWith('room', 'en');
    useCall.setState({ phase: 'active', call: { id: 'c', dmRoomId: 'private-room' } as Call });
    expect(set).toHaveBeenLastCalledWith('call', 'en');
    useVoice.setState({ roomId: null, phase: 'idle' });
    expect(set).toHaveBeenLastCalledWith('none', 'en');
    expect(set).toHaveBeenCalledTimes(4);
  });
  it('the host notification action leaves the voice session', () => {
    dispose = installHostMediaSession(capability);
    onLeave();
    expect(leave).toHaveBeenCalledOnce();
  });
});
