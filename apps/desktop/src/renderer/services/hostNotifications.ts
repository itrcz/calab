import { PushProvider, PushCapabilitiesResponseSchema, RegisterPushDeviceRequestSchema, RegisterPushDeviceResponseSchema, ResolvePushRequestSchema, ResolvePushResponseSchema, UnregisterPushDeviceRequestSchema } from '@calaba/protocol';
import type { HostNotificationState, HostNotificationsCapability, HostPushReference } from '../../shared/hostActivity';
import { body, call, callEmpty } from '../lib/api/client';
import { platform } from '../platform';
import { useSession } from '../stores/session';
import { usePrefs } from '../stores/prefs';
import { HOME } from '../stores/dms';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { useCall } from '../stores/call';
import { localAuthority } from '../features/identity/model';
import { HostNotificationPrompt } from '../lib/notifyPermission';

interface Identity { session: string; mentions: boolean; all: boolean }
interface Endpoint { id: string; version: bigint }
export interface HostPushApi {
 capabilities: (signal: AbortSignal) => Promise<{ appId: string; environment: string }[]>;
 register: (state: HostNotificationState, identity: Identity, signal: AbortSignal) => Promise<Endpoint>;
 unregister: (endpoint: Endpoint) => Promise<void>;
 resolve: (reference: HostPushReference, signal: AbortSignal) => Promise<{ roomId: string; workspaceId: string }>;
 open: (roomId: string, workspaceId: string) => void;
}
const api: HostPushApi = {
 capabilities: async (signal) => (await call('GET', '/api/me/push-capabilities', PushCapabilitiesResponseSchema, undefined, signal)).providers
   .filter(p => p.provider === PushProvider.APNS).map(p => ({ appId: p.appId, environment: p.environment })),
 register: (state, identity, signal) => call('POST', '/api/me/push-devices', RegisterPushDeviceResponseSchema,
   body(RegisterPushDeviceRequestSchema, { provider: PushProvider.APNS, appId: state.appId ?? '', environment: state.environment ?? '',
     installationId: state.installationId ?? '', token: state.token ?? '', notificationsEnabled: true, callsEnabled: false,
     mentionsEnabled: identity.mentions, allEnabled: identity.all }), signal),
 unregister: endpoint => callEmpty('DELETE', `/api/me/push-devices/${endpoint.id}`, body(UnregisterPushDeviceRequestSchema, { version: endpoint.version })),
 resolve: (reference, signal) => call('POST', '/api/me/push-resolve', ResolvePushResponseSchema,
   body(ResolvePushRequestSchema, { binding: reference.binding, eventId: reference.eventId }), signal),
 open: (roomId, workspaceId) => useUi.getState().openRoom(workspaceId || HOME, roomId),
};

/** Event-driven session projection. Native receives no Calab auth/session or product route table. */
export class HostPushController {
 private identity: Identity | null = null;
 private endpoint: Endpoint | null = null;
 private fingerprint = '';
 private revision = 0;
 private abort = new AbortController();
 private seen = new Set<string>();
 private operation = Promise.resolve();
 constructor(private readonly capability: HostNotificationsCapability, private readonly api: HostPushApi) {}
 update(identity: Identity | null): void {
  if (JSON.stringify(identity) === JSON.stringify(this.identity)) return;
  const accountChanged = this.identity !== null && this.identity.session !== identity?.session;
  this.revision++;
  if (accountChanged) {
   this.abort.abort(); this.abort = new AbortController();
   // Common auth logout/revocation deletes the old server endpoint. Never delete it using a new user's credentials.
   this.endpoint = null; this.fingerprint = ''; this.seen.clear();
   this.capability.clear('logout');
  }
  this.identity = identity;
  const revision = this.revision;
  if (identity) void this.capability.state().then(state => { if (revision === this.revision) this.accept(state); });
 }
 accept(state: HostNotificationState): void {
  const revision = this.revision;
  const identity = this.identity;
  const signal = this.abort.signal;
  if (!identity) return;
  this.operation = this.operation.then(async () => {
   if (revision !== this.revision) return;
   if (state.permission !== 'granted' || !state.token || (!identity.mentions && !identity.all)) {
    if (this.endpoint) {
     const old = this.endpoint; await this.api.unregister(old);
     if (this.endpoint === old) { this.endpoint = null; this.fingerprint = ''; }
    }
   } else {
    const fingerprint = JSON.stringify([state.token, state.appId, state.environment, identity.mentions, identity.all]);
    if (fingerprint !== this.fingerprint) {
     const providers = await this.api.capabilities(signal);
     if (revision !== this.revision || !providers.some(p => p.appId === state.appId && p.environment === state.environment)) return;
     const endpoint = await this.api.register(state, identity, signal);
     // A preference update must retain an in-flight binding so its next serialized operation can revoke it.
     if (this.identity?.session !== identity.session) return;
     this.endpoint = endpoint; this.fingerprint = fingerprint;
    }
   }
   if (revision !== this.revision || !state.tap || state.tap.expiresAt <= Date.now() || this.seen.has(state.tap.eventId)) return;
   const route = await this.api.resolve(state.tap, signal);
   if (revision === this.revision) {
    this.seen.add(state.tap.eventId);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value as string);
    this.api.open(route.roomId, route.workspaceId); this.capability.acknowledge(state.tap); }
  }).catch(() => undefined); // Optional transport/old server/network never breaks login or media.
 }
 async settled(): Promise<void> { await this.operation; }
 dispose(): void {
  this.abort.abort(); this.revision++; this.identity = null; this.endpoint = null; this.fingerprint = ''; this.seen.clear();
  this.capability.clear(); // Document disposal is distinct from auth logout; retained cold taps survive a reload.
 }
}

export function installHostNotifications(capability = platform.notifications): () => void {
 if (!capability) return () => undefined;
 const controller = new HostPushController(capability, api);
 let revokedSession: string | null = null;
 let disposed = false;
 const prompt = new HostNotificationPrompt(capability, () => {
  const s = useSession.getState(); const p = usePrefs.getState();
  if (disposed || document.visibilityState !== 'visible' || s.status !== 'authed' || !s.sessionId ||
      s.sessionId === revokedSession || !localAuthority(s.authority) || !s.me?.user || s.me.user.isGuest || s.me.user.isBot ||
      !p.onboarded || p.nativeNotifyOffered || (!p.notifyMentions && !p.notifyAll) ||
      useVoice.getState().phase !== 'idle' || useVoice.getState().joining || useCall.getState().phase !== 'idle') return null;
  return s.sessionId;
 }, () => usePrefs.getState().setPrefs({ nativeNotifyOffered: true }));
 const update = () => {
  const s = useSession.getState();
  if (s.status === 'offline') return; // Keep the current endpoint during a transient disconnect.
  const p = usePrefs.getState();
  controller.update(s.status === 'authed' && s.sessionId && s.sessionId !== revokedSession ?
    { session: s.sessionId, mentions: p.notifyMentions, all: p.notifyAll } : null);
  void prompt.update();
 };
 const subscriptions = [useSession.subscribe(update), usePrefs.subscribe(update),
  useVoice.subscribe((state, previous) => { if (state.phase !== previous.phase || state.joining !== previous.joining) update(); }),
  useCall.subscribe((state, previous) => { if (state.phase !== previous.phase) update(); }),
  capability.subscribe(state => controller.accept(state)),
  platform.auth.onLoggedOut(() => { revokedSession = useSession.getState().sessionId; controller.update(null); })];
 // A reload is a document boundary, not user logout: the session-bound server endpoint stays live.
 const pagehide = () => { disposed = true; controller.dispose(); };
 window.addEventListener('pagehide', pagehide);
 document.addEventListener('visibilitychange', update);
 window.addEventListener('focus', update);
 update();
 return () => { disposed = true; for (const unsub of subscriptions) unsub(); window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); controller.dispose(); };
}
