import { parseCallsState, type HostCallsCapability, type HostCallsOperation, type HostCallsState } from '../../shared/hostCalls';
import { parseNotificationState, type HostNotificationState, type HostNotificationsCapability, type SessionActivityCapability, type SessionActivitySnapshot } from '../../shared/hostActivity';

export interface HostActivityBridge {
  version: number; host: number; document: string; notificationsVersion?: number; callsVersion?: number; callsMuteVersion?: number;
  rotateDocument(): void;
  send(data: string): void;
}
declare global { interface Window { CalabHostActivity?: HostActivityBridge } }

/** One document/sequence authority for both optional capabilities; old hosts keep v1 activity. */
export function createHostCapabilities(win: Window = window): {
  sessionActivity?: SessionActivityCapability; notifications?: HostNotificationsCapability; incomingCalls?: HostCallsCapability;
} {
  const bridge = win.CalabHostActivity;
  if (!bridge || bridge.version !== 1) return {};
  let ready = false;
  let pendingLogout = false;
  let activityEnabled = false;
  let sequence = 0;
  let requestId = 0;
  let latest: SessionActivitySnapshot | null = null;
  const callListeners = new Set<(state:HostCallsState)=>void>();
  const callsPending = new Map<number,{operation:HostCallsOperation;resolve:(value:{state:HostCallsState;bound?:boolean})=>void;timer:ReturnType<typeof setTimeout>}>();
  const listeners = new Set<(state: HostNotificationState) => void>();
  const pending = new Map<number, { operation: 'status' | 'request'; resolve: (state: HostNotificationState) => void; timer: ReturnType<typeof setTimeout> }>();
  const send = (type: 'hello' | 'activity' | 'revoke' | 'notifications' | 'calls', fields: object = {}) => {
    const base = { v: 1, type, host: bridge.host, document: bridge.document };
    bridge.send(JSON.stringify(type === 'hello' ? base : { ...base, seq: ++sequence, ...fields }));
  };
  const settle = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ permission: 'unsupported' }); }
    pending.clear();
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
    if (pendingLogout) { pendingLogout = false; revoke('logout'); return; }
    if (latest && activityEnabled) send('activity', { snapshot: latest });
    if (a.notifications === 1) for (const [request, p] of pending) send('notifications', { request, operation: p.operation });
    else { for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ permission: 'unsupported' }); } pending.clear(); }
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
    const timer=setTimeout(()=>{callsPending.delete(request);resolve({state:{supported:false}});},10_000);
    callsPending.set(request,{operation,resolve,timer});
    if(ready)send('calls',{request,...operation});else send('hello');
  });
  return {
    ...(bridge.callsVersion===1 ? {incomingCalls:{
      state:async()=> (await requestCall({operation:'status'})).state,
      bind:async(binding,version,token)=>(await requestCall({operation:'bind',binding,version:String(version),token})).bound===true,
      subscribe(listener){callListeners.add(listener);return ()=>callListeners.delete(listener);},
      settle(actionId,result){if(ready)send('calls',{request:++requestId,operation:'settle',actionId,result});},
      sync(eventId,phase){if(ready)send('calls',{request:++requestId,operation:'sync',eventId,phase});},
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
      state: (ask = false) => new Promise<HostNotificationState>((resolve) => {
        const request = ++requestId;
        const operation = ask ? 'request' : 'status';
        const timer = setTimeout(() => { pending.delete(request); resolve({ permission: 'unsupported' }); }, 15_000);
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
