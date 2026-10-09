import { parseCallsState, type HostCallsCapability, type HostCallsOperation, type HostCallsState } from '../../shared/hostCalls';
import { parseMediaPermissionsState, unavailableMediaPermissions, type HostMediaPermissionsCapability, type MediaPermissionsOperation, type MediaPermissionsReply, type MediaPermissionsState } from '../../shared/hostPermissions';
import { parseNotificationState, parseNotificationTestResult, type HostNotificationTestResult, type HostNotificationState, type HostNotificationsCapability, type SessionActivityCapability, type SessionActivitySnapshot } from '../../shared/hostActivity';

export interface HostActivityBridge {
  mediaPermissionsVersion?: number;
  version: number; host: number; document: string; notificationsVersion?: number; notificationsTestVersion?: number; callsVersion?: number; callsMuteVersion?: number; callsAnswerVersion?: number; callsAudioVersion?: number;
  rotateDocument(): void;
  send(data: string): void;
}
declare global { interface Window { CalabHostActivity?: HostActivityBridge } }

// Native audioConnect may wait ~10 s for CallKit activation plus its own 15 s connect
// deadline (ADR-0079); the web side must outlive that worst case (25 s) with slack.
const AUDIO_CONNECT_TIMEOUT_MS = 30_000;
const CALLS_REQUEST_TIMEOUT_MS = 10_000;

/** One document/sequence authority for both optional capabilities; old hosts keep v1 activity. */
export function createHostCapabilities(win: Window = window): {
  mediaPermissions?: HostMediaPermissionsCapability;
  sessionActivity?: SessionActivityCapability; notifications?: HostNotificationsCapability; incomingCalls?: HostCallsCapability;
} {
  const bridge = win.CalabHostActivity;
  if (!bridge || bridge.version !== 1) return {};
  let ready = false;
  let pendingLogout = false;
  let activityEnabled = false;
  let permissionsEnabled = false;
  let sequence = 0;
  let requestId = 0;
  let latest: SessionActivitySnapshot | null = null;
  const callListeners = new Set<(state:HostCallsState)=>void>();
  const callsPending = new Map<number,{operation:HostCallsOperation;resolve:(value:{state:HostCallsState;bound?:boolean})=>void;timer:ReturnType<typeof setTimeout>}>();
  const listeners = new Set<(state: HostNotificationState) => void>();
  const pending = new Map<number, { operation: 'status' | 'request'; resolve: (state: HostNotificationState) => void; timer: ReturnType<typeof setTimeout> }>();
  const tests = new Map<number, { body: string; resolve: (result: HostNotificationTestResult) => void; timer: ReturnType<typeof setTimeout> }>();
  const permissions = new Map<number, { operation: MediaPermissionsOperation; resolve: (reply: MediaPermissionsReply) => void; timer: ReturnType<typeof setTimeout> }>();
  const permissionListeners = new Set<(state: MediaPermissionsState) => void>();
  const send = (type: 'hello' | 'activity' | 'revoke' | 'notifications' | 'calls' | 'permissions', fields: object = {}) => {
    const base = { v: 1, type, host: bridge.host, document: bridge.document };
    bridge.send(JSON.stringify(type === 'hello' ? base : { ...base, seq: ++sequence, ...fields }));
  };
  const settle = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ permission: 'unsupported' }); }
    pending.clear();
    for (const p of tests.values()) { clearTimeout(p.timer); p.resolve('unsupported'); }
    tests.clear();
    for (const p of permissions.values()) { clearTimeout(p.timer); p.resolve({ state: unavailableMediaPermissions() }); }
    permissions.clear();
    for (const p of callsPending.values()) { clearTimeout(p.timer); p.resolve({state:{supported:false}}); }
    callsPending.clear();
  };
  const revoke = (reason?: 'logout') => {
    latest = null;
    // A cold anonymous page must acquire the native document grant before clearing the
    // persisted endpoint binding. Never lose that logout behind a second capability clear.
    if (!ready && (reason === 'logout' || pendingLogout)) {
      pendingLogout = true;
      settle();
      send('hello');
      return;
    }
    send('revoke', reason ? { reason } : {});
    bridge.rotateDocument();
    ready = false;
    activityEnabled = false;
    permissionsEnabled = false;
    settle();
  };
  win.addEventListener('calab-host-activity-ready', (event) => {
    const ack: unknown = (event as CustomEvent<unknown>).detail;
    if (!ack || typeof ack !== 'object') return;
    const a = ack as Record<string, unknown>;
    if (a.v !== 1 || a.document !== bridge.document || a.host !== bridge.host ||
      (a.capability !== 'sessionActivity' && a.capability !== 'notifications')) return;
    ready = true;
    activityEnabled = a.capability === 'sessionActivity';
    permissionsEnabled = a.permissions === 1;
    if (pendingLogout) { pendingLogout = false; revoke('logout'); return; }
    if (latest && activityEnabled) send('activity', { snapshot: latest });
    if (a.notifications === 1) for (const [request, p] of pending) send('notifications', { request, operation: p.operation });
    else { for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ permission: 'unsupported' }); } pending.clear(); }
    if (a.notifications === 1) for (const [request, p] of tests) send('notifications', { request, operation: 'test', body: p.body });
    else { for (const p of tests.values()) { clearTimeout(p.timer); p.resolve('unsupported'); } tests.clear(); }
    if (permissionsEnabled) for (const [request, p] of permissions) send('permissions', { request, ...p.operation });
    else { for (const p of permissions.values()) { clearTimeout(p.timer); p.resolve({ state: unavailableMediaPermissions() }); } permissions.clear(); }
    if(a.calls===1)for(const [request,p] of callsPending)send('calls',{request,...p.operation});
    else { for(const p of callsPending.values()){clearTimeout(p.timer);p.resolve({state:{supported:false}});} callsPending.clear(); }
  });
  win.addEventListener('calab-host-notifications', (event) => {
    const raw: unknown = (event as CustomEvent<unknown>).detail;
    if (!ready || !raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    if (e.v !== 1 || e.document !== bridge.document || e.host !== bridge.host) return;
    const state = parseNotificationState(e.state);
    if (!state) return;
    const p = pending.get(Number(e.request));
    if (p) { clearTimeout(p.timer); pending.delete(Number(e.request)); p.resolve(state); }
    if (p || e.request === 0) for (const listener of listeners) listener(state);
  });
  win.addEventListener('calab-host-notification-test', event => {
    const raw: unknown = (event as CustomEvent<unknown>).detail;
    if (!ready || !raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    if (e.v !== 1 || e.document !== bridge.document || e.host !== bridge.host) return;
    const result = parseNotificationTestResult(e.result);
    const p = tests.get(Number(e.request));
    if (p && result) { clearTimeout(p.timer); tests.delete(Number(e.request)); p.resolve(result); }
  });
  win.addEventListener('calab-host-permissions', event => {
    const raw: unknown = (event as CustomEvent<unknown>).detail;
    if (!ready || !raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    if (!permissionsEnabled || e.v !== 1 || e.document !== bridge.document || e.host !== bridge.host ||
        typeof e.request !== 'number' || !Number.isSafeInteger(e.request) || e.request < 0 ||
        (e.opened !== undefined && typeof e.opened !== 'boolean')) return;
    const state = parseMediaPermissionsState(e.state); if (!state) return;
    const p = permissions.get(e.request);
    if (p) { clearTimeout(p.timer); permissions.delete(e.request); p.resolve({ state, ...(typeof e.opened === 'boolean' ? { opened: e.opened } : {}) }); }
    if (p || e.request === 0) for (const listener of permissionListeners) listener(state);
  });
  win.addEventListener('calab-host-calls', event => {
    const raw:unknown=(event as CustomEvent<unknown>).detail;
    if(!ready || !raw || typeof raw!=='object')return;
    const e=raw as Record<string,unknown>;
    if(e.v!==1 || e.document!==bridge.document || e.host!==bridge.host)return;
    const state=parseCallsState(e.state);if(!state)return;
    const p=callsPending.get(Number(e.request));
    if(p){clearTimeout(p.timer);callsPending.delete(Number(e.request));p.resolve({state,...(typeof e.bound==='boolean' ? {bound:e.bound}: {})});}
    if(p || e.request===0)for(const listener of callListeners)listener(state);
  });
  const requestCall=(operation:HostCallsOperation)=>new Promise<{state:HostCallsState;bound?:boolean}>(resolve=>{
    const request=++requestId;
    const timer=setTimeout(()=>{callsPending.delete(request);resolve({state:{supported:false}});},operation.operation==='audioConnect'?AUDIO_CONNECT_TIMEOUT_MS:CALLS_REQUEST_TIMEOUT_MS);
    callsPending.set(request,{operation,resolve,timer});
    if(ready)send('calls',{request,...operation});else send('hello');
  });
  const requestPermissions = (operation: MediaPermissionsOperation) => new Promise<MediaPermissionsReply>(resolve => {
    if (ready && !permissionsEnabled) { resolve({ state: unavailableMediaPermissions() }); return; }
    const request = ++requestId;
    const timer = setTimeout(() => { permissions.delete(request); resolve({ state: unavailableMediaPermissions() }); }, operation.operation === 'request' ? 60_000 : 10_000);
    permissions.set(request, { operation, resolve, timer });
    if (ready) send('permissions', { request, ...operation }); else send('hello');
  });
  return {
    ...(bridge.mediaPermissionsVersion === 1 ? { mediaPermissions: {
      state: async () => (await requestPermissions({ operation: 'status' })).state,
      request: async kind => (await requestPermissions({ operation: 'request', kind })).state,
      openSettings: async () => (await requestPermissions({ operation: 'settings' })).opened === true,
      subscribe(listener) { permissionListeners.add(listener); return () => permissionListeners.delete(listener); },
    } satisfies HostMediaPermissionsCapability } : {}),
    ...(bridge.callsVersion===1 ? {incomingCalls:{
      ...(bridge.callsAudioVersion===1 ? {audio:{
        connect: async input => (await requestCall({operation:'audioConnect',...input})).state.media ?? null,
        control(eventId,connectionId,controls){if(ready)send('calls',{request:++requestId,operation:'audioControl',eventId,connectionId,controls});},
        disconnect(eventId,connectionId){if(ready)send('calls',{request:++requestId,operation:'audioDisconnect',eventId,connectionId});},
        subscribe(listener){const onState=(s:HostCallsState)=>{if(s.media)listener(s.media);};callListeners.add(onState);return ()=>callListeners.delete(onState);},
      }} : {}),
      state:async()=> (await requestCall({operation:'status'})).state,
      bind:async(binding,version,token)=>(await requestCall({operation:'bind',binding,version:String(version),token})).bound===true,
      subscribe(listener){callListeners.add(listener);return ()=>callListeners.delete(listener);},
      settle(actionId,result){if(ready)send('calls',{request:++requestId,operation:'settle',actionId,result});},
      sync(eventId,phase){if(ready)send('calls',{request:++requestId,operation:'sync',eventId,phase});},
      ...(bridge.callsAnswerVersion===1 ? {syncAccepted(eventId:string){if(ready)send('calls',{request:++requestId,operation:'sync',eventId,phase:'accepted'});}} : {}),
      ...(bridge.callsMuteVersion===1 ? {syncMuted(eventId:string,muted:boolean){if(ready)send('calls',{request:++requestId,operation:'sync',eventId,phase:muted?'muted':'unmuted'});}} : {}),
      clear:revoke,
    } satisfies HostCallsCapability}: {}),
    sessionActivity: {
      publish(snapshot) {
        latest = snapshot;
        if (ready) { if (activityEnabled) send('activity', { snapshot }); }
        else send('hello');
      },
      clear: revoke,
    },
    ...(bridge.notificationsVersion === 1 ? { notifications: {
      ...(bridge.notificationsTestVersion === 1 ? { test: (body: string) => new Promise<HostNotificationTestResult>(resolve => {
        if (!body.trim() || body.length > 512) { resolve('failed'); return; }
        const request = ++requestId;
        const timer = setTimeout(() => { tests.delete(request); resolve('failed'); }, 60_000);
        tests.set(request, { body, resolve, timer });
        if (ready) send('notifications', { request, operation: 'test', body }); else send('hello');
      }) } : {}),
      state: (ask = false) => new Promise<HostNotificationState>((resolve) => {
        const request = ++requestId;
        const operation = ask ? 'request' : 'status';
        const timer = setTimeout(() => { pending.delete(request); resolve({ permission: 'unsupported' }); }, ask ? 60_000 : 15_000);
        pending.set(request, { operation, resolve, timer });
        if (ready) send('notifications', { request, operation });
        else send('hello');
      }),
      subscribe(listener: (state: HostNotificationState) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      acknowledge(reference) { if (ready) send('notifications', { request: ++requestId, operation: 'ack', eventId: reference.eventId }); },
      // Revocation invalidates native callbacks synchronously via the shared native document boundary.
      clear: revoke,
    } satisfies HostNotificationsCapability } : {}),
  };
}

export function createHostActivity(win: Window = window): SessionActivityCapability | undefined {
  return createHostCapabilities(win).sessionActivity;
}
