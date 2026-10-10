import { describe, expect, it, vi } from 'vitest';
import { HostPushController, installHostNotifications, type HostPushApi } from './hostNotifications';
import type { HostNotificationState, HostNotificationsCapability } from '../../shared/hostActivity';
import { useSession } from '../stores/session';
import { usePrefs } from '../stores/prefs';
import { useVoice } from '../stores/voice';
import { useCall } from '../stores/call';
import { SessionAuthorityKind } from '@calaba/protocol';
vi.mock('../platform', () => ({ platform: { auth: { onLoggedOut: () => () => undefined } } }));

const state: HostNotificationState = { permission: 'granted', appId: 'dev.calab.test', environment: 'development',
 installationId: '00000000-0000-0000-0000-000000000001', token: 'aa'.repeat(32) };
const tap = () => ({ binding: '00000000-0000-0000-0000-000000000002', eventId: '00000000-0000-0000-0000-000000000003', expiresAt: Date.now() + 60_000 });
function harness(initial: HostNotificationState = state) {
 const capability: HostNotificationsCapability = { state: vi.fn().mockResolvedValue(initial), subscribe: () => () => undefined, clear: vi.fn(), acknowledge: vi.fn() };
 const api: HostPushApi = { capabilities: vi.fn().mockResolvedValue([{ appId: state.appId, environment: state.environment }]),
  register: vi.fn().mockResolvedValue({ id: 'endpoint', version: 1n }), unregister: vi.fn().mockResolvedValue(undefined),
  resolve: vi.fn().mockResolvedValue({ roomId: 'room', workspaceId: '' }), open: vi.fn() };
 const controller = new HostPushController(capability, api);
 const start = async () => { controller.update({ session: 'first', mentions: true, all: false }); await Promise.resolve(); await controller.settled(); };
 return { controller, capability, api, start };
}

it('only offers permission to an onboarded local user in the foreground outside calls, preserving Later', async () => {
 const saved = { session: useSession.getState(), prefs: usePrefs.getState(), voice: useVoice.getState(), call: useCall.getState() };
 const windowEvents = new EventTarget(); const documentEvents = new EventTarget();
 let visibilityState = 'hidden';
 Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibilityState });
 vi.stubGlobal('window', windowEvents); vi.stubGlobal('document', documentEvents);
 let stop: () => void = () => undefined;
 try {
  useSession.setState({ status: 'authed', sessionId: 'first', authority: null, me: { user: { isGuest: false, isBot: false } } as never });
  usePrefs.setState({ onboarded: true, nativeNotifyOffered: false, notifyMentions: true, notifyAll: false });
  useVoice.setState({ phase: 'idle', joining: null }); useCall.setState({ phase: 'idle' });
  const native = harness({ permission: 'default' }).capability;
  stop = installHostNotifications(native);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  useCall.setState({ phase: 'incoming' }); visibilityState = 'visible'; documentEvents.dispatchEvent(new Event('visibilitychange'));
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  usePrefs.setState({ nativeNotifyOffered: true }); useCall.setState({ phase: 'idle' });
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  usePrefs.setState({ nativeNotifyOffered: false, onboarded: false });
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  useSession.setState({ authority: { kind: SessionAuthorityKind.WORKSPACE_SSO } as never }); usePrefs.setState({ onboarded: true });
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  useSession.setState({ authority: null, me: { user: { isGuest: true } } as never });
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  useSession.setState({ me: { user: { isBot: true } } as never });
  await flush(); expect(native.state).not.toHaveBeenCalledWith(true);
  vi.mocked(native.state).mockImplementation(ask => Promise.resolve({ permission: ask ? 'denied' : 'default' }));
  useSession.setState({ me: { user: { isGuest: false, isBot: false } } as never }); await flush();
  expect(native.state).toHaveBeenCalledWith(true); expect(usePrefs.getState().nativeNotifyOffered).toBe(true);
 } finally {
  stop(); useSession.setState(saved.session); usePrefs.setState(saved.prefs); useVoice.setState(saved.voice); useCall.setState(saved.call); vi.unstubAllGlobals();
 }
});
describe('session-bound shared-web message push', () => {
 it('never registers unavailable builds, denied permission, or mismatched provider config', async () => {
  for (const initial of [{ permission: 'unsupported' }, { permission: 'denied' }] as HostNotificationState[]) {
   const h = harness(initial); await h.start(); expect(h.api.register).not.toHaveBeenCalled();
  }
  const h = harness(); vi.mocked(h.api.capabilities).mockResolvedValue([]); await h.start(); expect(h.api.register).not.toHaveBeenCalled();
 });
 it('idempotently registers/rotates and projects existing global preferences without session credentials', async () => {
  const h = harness(); await h.start(); h.controller.accept(state); await h.controller.settled(); expect(h.api.register).toHaveBeenCalledTimes(1);
  expect(h.api.register).toHaveBeenCalledWith(state, { session: 'first', mentions: true, all: false }, expect.any(AbortSignal));
  h.controller.accept({ ...state, token: 'bb'.repeat(32) }); await h.controller.settled(); expect(h.api.register).toHaveBeenCalledTimes(2);
  h.controller.update({ session: 'first', mentions: false, all: false }); await Promise.resolve(); await h.controller.settled(); expect(h.api.unregister).toHaveBeenCalledTimes(1);
  h.controller.update({ session: 'first', mentions: false, all: true }); await Promise.resolve(); await h.controller.settled();
  expect(vi.mocked(h.api.register).mock.lastCall?.[1]).toMatchObject({ mentions: false, all: true });
 });
 it('drops delayed permission/token response from the previous account after logout and document revoke', async () => {
  const h = harness(); let finish: (value: HostNotificationState) => void = () => undefined;
  vi.mocked(h.capability.state).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  h.controller.update({ session: 'first', mentions: true, all: false }); h.controller.update(null);
  h.controller.update({ session: 'second', mentions: true, all: false }); await Promise.resolve(); await h.controller.settled();
  finish({ ...state, tap: tap() }); await Promise.resolve(); await h.controller.settled();
  expect(h.api.register).toHaveBeenCalledTimes(1); expect(h.api.resolve).not.toHaveBeenCalled(); expect(h.capability.clear).toHaveBeenCalledTimes(1);
 });
 it('resolves opaque cold taps under current web auth, dedupes, and rejects foreign/expired references safely', async () => {
  const h = harness({ ...state, tap: tap() }); await h.start();
  expect(h.api.open).toHaveBeenCalledWith('room', ''); h.controller.accept({ ...state, tap: tap() }); await h.controller.settled(); expect(h.api.resolve).toHaveBeenCalledTimes(1);
  h.controller.accept({ ...state, tap: { ...tap(), eventId: 'expired', expiresAt: 0 } }); await h.controller.settled(); expect(h.api.resolve).toHaveBeenCalledTimes(1);
  const other = harness(); vi.mocked(other.api.resolve).mockRejectedValue(new Error('foreign or inaccessible receipt')); await other.start();
  other.controller.accept({ ...state, tap: tap() }); await other.controller.settled(); expect(other.api.open).not.toHaveBeenCalled();
 });
 it('never routes a resolve that finishes after account switch, or cleans an endpoint using the next account', async () => {
  const h = harness(); await h.start(); let finish: (route: {roomId: string; workspaceId: string}) => void = () => undefined;
  vi.mocked(h.api.resolve).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  h.controller.accept({ ...state, tap: tap() }); await Promise.resolve();
  h.controller.update({ session: 'second', mentions: true, all: false }); finish({roomId:'private',workspaceId:'ws'}); await Promise.resolve(); await h.controller.settled();
  expect(h.api.open).not.toHaveBeenCalled(); expect(h.api.unregister).not.toHaveBeenCalled();
 });
});


it('pagehide disposal invalidates the document without purging a cold tap as logout', async () => {
 const h = harness(); await h.start(); h.controller.dispose();
 expect(h.capability.clear).toHaveBeenLastCalledWith(); expect(h.api.unregister).not.toHaveBeenCalled();
});
it('a retained tap retries after transient resolve failure and is acknowledged only on success', async () => {
 const h = harness(); await h.start(); vi.mocked(h.api.resolve).mockRejectedValueOnce(new Error('offline'));
 const retained = {...state,tap:tap()}; h.controller.accept(retained); await h.controller.settled();
 expect(h.api.open).not.toHaveBeenCalled(); expect(h.capability.acknowledge).not.toHaveBeenCalled();
 h.controller.accept(retained); await h.controller.settled();
 expect(h.api.resolve).toHaveBeenCalledTimes(2); expect(h.api.open).toHaveBeenCalledOnce(); expect(h.capability.acknowledge).toHaveBeenCalledWith(retained.tap);
});

it('revokes a registration that completes while the same session disables alerts, and retries failed cleanup', async () => {
 const h = harness(); let finish: (endpoint: {id: string; version: bigint}) => void = () => undefined;
 vi.mocked(h.api.register).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
 h.controller.update({ session: 'first', mentions: true, all: false });
 await vi.waitFor(() => expect(h.api.register).toHaveBeenCalledOnce());
 const signal = vi.mocked(h.api.register).mock.calls[0]?.[2];
 vi.mocked(h.api.unregister).mockRejectedValueOnce(new Error('offline'));
 h.controller.update({ session: 'first', mentions: false, all: false });
 expect(signal?.aborted).toBe(false);
 finish({id:'endpoint',version:1n}); await Promise.resolve(); await h.controller.settled();
 expect(h.api.unregister).toHaveBeenCalledWith({id:'endpoint',version:1n});
 h.controller.accept(state); await h.controller.settled();
 expect(h.api.unregister).toHaveBeenCalledTimes(2);
});
