// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { create } from 'zustand';

const fixture = vi.hoisted(() => ({ setBadge: vi.fn() }));
vi.mock('../platform', () => ({ platform: { notifications: { setBadge: fixture.setBadge }, app: { setBadge: fixture.setBadge } } }));
const session = create(() => ({ ready: false }));
const rooms = create(() => ({ count: 0 }));
vi.doMock('../stores/session', () => ({ useSession: session }));
vi.doMock('../stores/rooms', () => ({ useRooms: rooms, badgeCount: (s: {count: number}) => s.count }));

it('preserves the push count until READY, updates reads, and reconciles an unchanged count on foreground', async () => {
  const { startAppBadge } = await import('./badge');
  startAppBadge();
  rooms.setState({ count: 7 });
  expect(fixture.setBadge).not.toHaveBeenCalled();
  session.setState({ ready: true });
  expect(fixture.setBadge).toHaveBeenLastCalledWith(7);
  rooms.setState({ count: 0 });
  expect(fixture.setBadge).toHaveBeenLastCalledWith(0);
  fixture.setBadge.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(fixture.setBadge).toHaveBeenCalledExactlyOnceWith(0);
  session.setState({ ready: false });
  rooms.setState({ count: 3 });
  expect(fixture.setBadge).toHaveBeenCalledTimes(1);
});
