import { expect, it, vi } from 'vitest';
import { CalendarWidgetSync } from './widgetSync';

it('a late grant for the previous session cannot restore its calendar', async () => {
  let finish!: (g: { token: string; expiresAt: string }) => void;
  const first = new Promise<{ token: string; expiresAt: string }>(resolve => { finish = resolve; });
  let calls = 0;
  const capability = { bind: vi.fn(() => Promise.resolve(false)), clear: vi.fn(() => Promise.resolve(true)), configure: vi.fn(() => Promise.resolve(true)), refresh: vi.fn(() => Promise.resolve(true)) };
  const sync = new CalendarWidgetSync(capability, async () => ++calls === 1 ? first : { token: 'new.token.signature', expiresAt: '2099-01-01T00:00:00Z' });
  sync.session('first'); await vi.waitFor(() => expect(calls).toBe(1));
  sync.session(null);
  sync.session('second'); await vi.waitFor(() => expect(capability.configure).toHaveBeenCalledWith('new.token.signature', '2099-01-01T00:00:00Z'));
  finish({ token: 'old.token.signature', expiresAt: '2099-01-01T00:00:00Z' });
  await Promise.resolve(); await Promise.resolve();
  expect(capability.configure).toHaveBeenCalledOnce();
  expect(capability.clear.mock.calls.length).toBe(1);
});


it('a cold web document preserves the same native session cache', async () => {
  const capability = { bind: vi.fn(() => Promise.resolve(true)), clear: vi.fn(() => Promise.resolve(true)), configure: vi.fn(() => Promise.resolve(true)), refresh: vi.fn(() => Promise.resolve(true)) };
  const issue = vi.fn();
  const sync = new CalendarWidgetSync(capability, issue);
  sync.session('same-owner-and-session');
  await vi.waitFor(() => expect(capability.refresh).toHaveBeenCalledOnce());
  expect(capability.clear).not.toHaveBeenCalled();
  expect(issue).not.toHaveBeenCalled();
  capability.refresh.mockResolvedValue(false);
  issue.mockResolvedValue({ token: 'replacement', expiresAt: '2099-01-01T00:00:00Z' });
  sync.refresh();
  await vi.waitFor(() => expect(issue).toHaveBeenCalledOnce());
});
