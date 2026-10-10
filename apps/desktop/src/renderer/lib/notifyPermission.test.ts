import { describe, expect, it, vi } from 'vitest';
import { notifyStepView, readNotifyState, requestNotify, testNotification, HostNotificationPrompt } from './notifyPermission';
import type { HostNotificationsCapability } from '../../shared/hostActivity';

function host(permission: 'default' | 'granted' | 'denied' | 'unsupported' = 'default'): HostNotificationsCapability {
  return { state: vi.fn().mockResolvedValue({ permission }), subscribe: () => () => undefined, clear: vi.fn(), acknowledge: vi.fn() };
}

describe('notification test chooses the real platform', () => {
  it('uses the native test with no browser Notification API', async () => {
    const native = { ...host(), test: vi.fn().mockResolvedValue('scheduled') };
    await expect(testNotification('Sample', native)).resolves.toBe('scheduled');
    expect(native.test).toHaveBeenCalledWith('Sample');
    expect(native.state).not.toHaveBeenCalled();
  });
  it('offers an update for an old binary and survives native failures', async () => {
    await expect(testNotification('Sample', host())).resolves.toBe('update');
    await expect(testNotification('Sample', { ...host(), test: vi.fn().mockRejectedValue(new Error('unavailable')) })).resolves.toBe('failed');
  });
  it('never constructs a browser notification after denial, but preserves granted browser tests', async () => {
    const show = vi.fn();
    const browser = { permission: 'default', requestPermission: vi.fn().mockResolvedValue('denied') };
    await expect(testNotification('Sample', undefined, browser, show)).resolves.toBe('denied');
    expect(show).not.toHaveBeenCalled();
    browser.requestPermission.mockResolvedValue('granted');
    await expect(testNotification('Sample', undefined, browser, show)).resolves.toBe('scheduled');
    expect(show).toHaveBeenCalledWith('Sample');
  });
});

describe('contextual native permission prompt', () => {
  it('asks an eligible foreground session once and records the choice', async () => {
    const native = host(); const offered = vi.fn();
    vi.mocked(native.state).mockResolvedValueOnce({ permission: 'default' }).mockResolvedValue({ permission: 'denied' });
    const prompt = new HostNotificationPrompt(native, () => 'session', offered);
    await Promise.all([prompt.update(), prompt.update()]); await prompt.update();
    expect(native.state).toHaveBeenCalledTimes(2);
    expect(native.state).toHaveBeenLastCalledWith(true); expect(offered).toHaveBeenCalledOnce();
  });
  it.each(['denied', 'granted', 'unsupported'] as const)('never prompts %s', async permission => {
    const native = host(permission); const prompt = new HostNotificationPrompt(native, () => 'session', vi.fn());
    await prompt.update(); expect(native.state).toHaveBeenCalledExactlyOnceWith();
  });
  it('does not ask while ineligible, after logout, or after a foreground/session change during the probe', async () => {
    const native = host(); let eligible: string | null = null;
    const offered = vi.fn(); const prompt = new HostNotificationPrompt(native, () => eligible, offered);
    await prompt.update(); expect(native.state).not.toHaveBeenCalled();
    let finish!: (s: { permission: 'default' }) => void;
    vi.mocked(native.state).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    eligible = 'first'; const pending = prompt.update(); eligible = 'second'; finish({ permission: 'default' }); await pending;
    expect(native.state).toHaveBeenCalledExactlyOnceWith(); expect(offered).not.toHaveBeenCalled();
  });
  it('ignores the result of a revoked session and retries a deferred background request later', async () => {
    const native = host(); let eligible: string | null = 'first'; const offered = vi.fn();
    const prompt = new HostNotificationPrompt(native, () => eligible, offered);
    await prompt.update(); expect(offered).not.toHaveBeenCalled();
    vi.mocked(native.state).mockResolvedValueOnce({ permission: 'default' }).mockImplementationOnce(() => { eligible = null; return Promise.resolve({ permission: 'granted' }); });
    await prompt.update(); expect(offered).not.toHaveBeenCalled();
  });
});

describe('notification permission (onboarding)', () => {
  it('maps every state to what the step shows; default is never shown as denied', () => {
    expect(notifyStepView('default')).toEqual({ note: null, primary: 'enable', later: true });
    expect(notifyStepView('granted')).toEqual({ note: 'granted', primary: 'continue', later: false });
    expect(notifyStepView('denied')).toEqual({ note: 'denied', primary: 'continue-without', later: false });
    expect(notifyStepView('unsupported')).toEqual({ note: 'unsupported', primary: 'continue', later: false });
  });

  it('reads the state; no API → unsupported', () => {
    expect(readNotifyState(undefined)).toBe('unsupported');
    expect(readNotifyState({ permission: 'default' })).toBe('unsupported'); // no requestPermission
    expect(readNotifyState({ permission: 'default', requestPermission: () => Promise.resolve('default') })).toBe('default');
    expect(readNotifyState({ permission: 'granted', requestPermission: () => Promise.resolve('granted') })).toBe('granted');
  });

  it('asks with the promise API, the callback API, and survives a throwing one', async () => {
    await expect(requestNotify({ permission: 'default', requestPermission: () => Promise.resolve('granted') })).resolves.toBe('granted');
    await expect(requestNotify({ permission: 'default', requestPermission: () => Promise.resolve('denied') })).resolves.toBe('denied');
    // Old Safari: callback only, returns undefined.
    await expect(
      requestNotify({
        permission: 'default',
        requestPermission: (cb) => {
          cb?.('granted');
          return undefined;
        },
      }),
    ).resolves.toBe('granted');
    await expect(
      requestNotify({
        permission: 'default',
        requestPermission: () => {
          throw new Error('not allowed');
        },
      }),
    ).resolves.toBe('default');
    await expect(requestNotify(undefined)).resolves.toBe('unsupported');
  });
});
