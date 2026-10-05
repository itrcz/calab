import { describe, expect, it, vi } from 'vitest';
import { createHostActivity, createHostCapabilities } from './hostActivity';
import type { SessionActivitySnapshot } from '../../shared/hostActivity';

const snapshot: SessionActivitySnapshot = { generation: 1, status: 'connected', muted: true, language: 'en' };

describe('optional phone activity platform', () => {
  it('leaves ordinary browsers and old hosts without a capability', () => {
    expect(createHostActivity({} as Window)).toBeUndefined();
    expect(createHostActivity({ CalabHostActivity: { version: 2 } } as Window)).toBeUndefined();
  });
  it('waits for a matching version/capability/document acknowledgement and re-handshakes after revoke', () => {
    let ready: (event: CustomEvent<unknown>) => void = () => undefined;
    const send = vi.fn();
    const win = {
      CalabHostActivity: { version: 1, host: 0, document: 'document', send, rotateDocument: vi.fn() },
      addEventListener: (name: string, callback: typeof ready) => { if (name === 'calab-host-activity-ready') ready = callback; },
    } as unknown as Window;
    const capability = createHostActivity(win);
    capability?.publish(snapshot);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({ type: 'hello' });
    const ack = { v: 1, host: 0, document: 'document', capability: 'sessionActivity' };
    ready({ detail: { ...ack, document: 'old' } } as CustomEvent<unknown>);
    expect(send).toHaveBeenCalledTimes(1);
    ready({ detail: ack } as CustomEvent<unknown>);
    expect(JSON.parse(String(send.mock.calls[1]?.[0]))).toMatchObject({ type: 'activity', seq: 1, snapshot });
    capability?.clear();
    expect(JSON.parse(String(send.mock.calls[2]?.[0]))).toMatchObject({ type: 'revoke', seq: 2 });
    capability?.publish(snapshot);
    expect(JSON.parse(String(send.mock.calls[3]?.[0]))).toMatchObject({ type: 'hello' });
  });
  it('rotates document identity on logout and rejects a delayed acknowledgement of the old session', () => {
    let ready: (event: CustomEvent<unknown>) => void = () => undefined;
    const send = vi.fn();
    const bridge = { version: 1, host: 0, document: 'old', send, rotateDocument: () => { bridge.document = 'new'; } };
    const capability = createHostActivity({ CalabHostActivity: bridge,
      addEventListener: (name: string, callback: typeof ready) => { if (name === 'calab-host-activity-ready') ready = callback; },
    } as unknown as Window);
    capability?.publish(snapshot);
    capability?.clear();
    capability?.publish(snapshot);
    const calls = send.mock.calls.length;
    ready({ detail: { v: 1, host: 0, document: 'old', capability: 'sessionActivity' } } as CustomEvent<unknown>);
    expect(send).toHaveBeenCalledTimes(calls);
    ready({ detail: { v: 1, host: 0, document: 'new', capability: 'sessionActivity' } } as CustomEvent<unknown>);
    expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({ type: 'activity', document: 'new' });
  });
});

it('clears a persisted native binding only after a cold anonymous document has authority', () => {
 const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
 const send = vi.fn();
 const bridge = {version:1,callsVersion:1,host:0,document:'cold',send,rotateDocument:()=>{bridge.document='next';}};
 const cap=createHostCapabilities({CalabHostActivity:bridge,addEventListener:(name:string,cb:(event:CustomEvent<unknown>)=>void)=>handlers.set(name,cb)} as unknown as Window);
 cap.incomingCalls?.clear('logout');cap.sessionActivity?.clear();
 expect(bridge.document).toBe('cold');
 expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({type:'hello',document:'cold'});
 handlers.get('calab-host-activity-ready')?.({detail:{v:1,host:0,document:'cold',capability:'notifications',calls:1}} as CustomEvent<unknown>);
 expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({type:'revoke',reason:'logout',document:'cold'});
 expect(bridge.document).toBe('next');
});


it('shares logout revoke before document rotation, preserves cold taps through permission probes and negotiates without ActivityKit', async () => {
 const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
 const send = vi.fn();
 const bridge = { version:1, notificationsVersion:1, host:0, document:'00000000-0000-0000-0000-000000000001', send,
  rotateDocument: () => { bridge.document = '00000000-0000-0000-0000-000000000002'; } };
 const cap = createHostCapabilities({CalabHostActivity:bridge, addEventListener: (name: string, callback: (event: CustomEvent<unknown>) => void) => handlers.set(name, callback)} as unknown as Window);
 const promise = cap.notifications?.state();
 handlers.get('calab-host-activity-ready')?.({detail:{v:1,host:0,document:bridge.document,capability:'notifications',notifications:1}} as CustomEvent<unknown>);
 expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({type:'notifications',operation:'status'});
 const listener = vi.fn(); cap.notifications?.subscribe(listener);
 const tap = {binding:bridge.document,eventId:bridge.document,expiresAt:Date.now()+60_000};
 handlers.get('calab-host-notifications')?.({detail:{v:1,host:0,document:bridge.document,request:1,state:{permission:'default',tap}}} as CustomEvent<unknown>);
 await expect(promise).resolves.toMatchObject({tap}); expect(listener).toHaveBeenCalledOnce();
 // Permission probes do not acknowledge/consume routing references.
 expect(send.mock.calls.some(c => String(c[0]).includes('ack'))).toBe(false);
 cap.sessionActivity?.clear('logout');
 expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({type:'revoke',reason:'logout',document:'00000000-0000-0000-0000-000000000001'});
 const next = cap.notifications?.state();
 handlers.get('calab-host-notifications')?.({detail:{v:1,host:0,document:'00000000-0000-0000-0000-000000000001',request:0,state:{permission:'default',tap}}} as CustomEvent<unknown>);
 expect(listener).toHaveBeenCalledOnce();
 cap.notifications?.clear(); await expect(next).resolves.toMatchObject({permission:'unsupported'});
});
