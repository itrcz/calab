import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseHostActivityMessage } from '../../desktop/src/shared/hostActivity';
import { parseCallsState } from '../../desktop/src/shared/hostCalls';
import { ActivityProtocol, activityBootstrap, activityReady, linkEvent } from './activityProtocol';

const document = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const hello = (doc = document, host = 0) => JSON.stringify({ v: 1, type: 'hello', host, document: doc });
const activity = (seq = 1, generation = 1, doc = document, status = 'connected') => JSON.stringify({
  v: 1, type: 'activity', host: 0, document: doc, seq, snapshot: { generation, status, muted: false, language: 'ru' },
});

describe('bounded host activity contract', () => {
  it('rejects unknown versions, fields, statuses, identifiers, oversized and malformed input', () => {
    for (const raw of ['{', 'x'.repeat(2049), hello().replace('"v":1', '"v":2'),
      hello().replace('"type":"hello"', '"type":"board"'), activity().replace('connected', 'connecting'),
      activity().replace('"muted":false', '"muted":"false"'),
      activity().replace('"language":"ru"', '"language":"ru","roomName":"Private"'),
      activity().replace('"generation":1', '"generation":-1')]) expect(parseHostActivityMessage(raw)).toBeNull();
  });
  it('requires a handshake and rejects stale document, remount, sequence and call generations', () => {
    const protocol = new ActivityProtocol(0);
    expect(protocol.accept(activity())).toBeNull();
    expect(protocol.accept(hello(document, 1))).toBeNull();
    expect(protocol.accept(hello())).toEqual({ type: 'ready', document });
    expect(protocol.accept(activity(1, 2))?.type).toBe('publish');
    expect(protocol.accept(activity(1, 2))).toBeNull();
    expect(protocol.accept(activity(2, 1))).toBeNull();
    expect(protocol.accept(activity(3, 2, other))).toBeNull();
    expect(protocol.accept(activity(3, 2, document, 'reconnecting'))?.type).toBe('publish');
    protocol.reset();
    expect(protocol.accept(activity(4, 3))).toBeNull();
    expect(new ActivityProtocol(1).accept(hello())).toBeNull();
    expect(new ActivityProtocol(1).belongsTo(0)).toBe(false);
  });
  it('revocation ends and clears authority; repeated hello cannot reset order', () => {
    const protocol = new ActivityProtocol(0);
    protocol.accept(hello());
    protocol.accept(activity());
    expect(protocol.accept(hello())).toBeNull();
    expect(protocol.accept(activity())).toBeNull();
    expect(protocol.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 2 }))).toEqual({ type: 'end' });
    expect(protocol.accept(activity(3))).toBeNull();
    expect(protocol.accept(hello(other))?.type).toBe('ready');
  });
  it('does not declare a bridge in an iframe and gives the main document an immutable local id', () => {
    const send = vi.fn();
    const child: Record<string, unknown> = { top: {}, ReactNativeWebView: { postMessage: send }, crypto: { randomUUID: () => document } };
    runInNewContext(activityBootstrap(3), { window: child, crypto: child.crypto });
    expect(child.CalabHostActivity).toBeUndefined();
    const top: Record<string, unknown> = { ReactNativeWebView: { postMessage: send }, crypto: child.crypto };
    top.top = top;
    runInNewContext(activityBootstrap(3), { window: top, crypto: top.crypto });
    expect(Object.getOwnPropertyDescriptor(top, 'CalabHostActivity')?.writable).toBe(false);
    expect(top.CalabHostActivity).toMatchObject({ version: 1, host: 3, document });
    expect((top.CalabHostActivity as Record<string, unknown>).platform).toBeUndefined();
  });
  it('announces the platform when given (additive: the web side falls back to the user agent)', () => {
    for (const platform of ['ios', 'android'] as const) {
      const top: Record<string, unknown> = { ReactNativeWebView: { postMessage: vi.fn() }, crypto: { randomUUID: () => document } };
      top.top = top;
      runInNewContext(activityBootstrap(3, false, platform), { window: top, crypto: top.crypto });
      expect(top.CalabHostActivity).toMatchObject({ version: 1, host: 3, platform });
    }
  });
});

it('accepts calls only in the current document and rejects credentials/unknown actions', () => {
 const p = new ActivityProtocol(0); p.accept(hello());
 const value = {v:1,type:'calls',host:0,document,seq:1,request:1,operation:'status'};
 expect(p.accept(JSON.stringify(value))).toMatchObject({type:'calls',operation:'status'});
 expect(p.accept(JSON.stringify({...value,seq:2,document:other}))).toBeNull();
 expect(p.accept(JSON.stringify({...value,seq:2,token:'secret'}))).toBeNull();
 expect(p.accept(JSON.stringify({...value,seq:2,operation:'nativeLogin'}))).toBeNull();
 p.reset(); expect(p.accept(JSON.stringify({...value,seq:3}))).toBeNull();
});
it('bounds pending native call actions and accepts only opaque unexpired references', () => {
 const action={binding:document,eventId:other,expiresAt:Date.now()+10000,actionId:document,action:'answer'};
 expect(parseCallsState({supported:true,actions:[action]})).toMatchObject({actions:[action]});
 for(const value of [{supported:true,actions:Array(9).fill(action)},
  {supported:true,actions:[{...action,expiresAt:Date.now()-1}]},
  {supported:true,actions:[{...action,expiresAt:Date.now()+61000}]},
  {supported:true,actions:[{...action,accessToken:'private'}]},
  {supported:true,actions:[{...action,action:'nativeLogin'}]},
  {supported:false,actions:[action]}])expect(parseCallsState(value)).toBeNull();
});

it('validates optional microphone sync and bounded native mute actions under the same document',()=>{
 const p=new ActivityProtocol(0);p.accept(hello());
 const value={v:1,type:'calls',host:0,document,seq:1,request:1,operation:'sync',eventId:other,phase:'muted'};
 expect(p.accept(JSON.stringify(value))).toMatchObject({operation:'sync',phase:'muted'});
 expect(p.accept(JSON.stringify({...value,seq:2,document:other}))).toBeNull();
 const action={binding:document,eventId:other,expiresAt:Date.now()+10000,actionId:document,action:'mute'};
 expect(parseCallsState({supported:true,actions:[action]})).toMatchObject({actions:[action]});
 expect(parseCallsState({supported:true,actions:[{...action,muted:'yes'}]})).toBeNull();
});

describe('native room audio bridge (ADR-0149)', () => {
  const connectionId = '33333333-3333-4333-8333-333333333333';
  const value = { v: 1, type: 'roomAudio', host: 0, document, seq: 1, request: 2, operation: 'disconnect', connectionId };
  const send = (protocol: ActivityProtocol, change: object = {}) => protocol.accept(JSON.stringify({ ...value, ...change }));
  it('accepts only the current document in sequence and hands native the operation alone', () => {
    const p = new ActivityProtocol(0);
    expect(send(p)).toBeNull();
    p.accept(hello());
    expect(send(p)).toEqual({ type: 'roomAudio', document, request: 2, operation: { operation: 'disconnect', connectionId } });
    expect(send(p)).toBeNull();
    expect(send(p, { seq: 2, document: other })).toBeNull();
    expect(send(p, { seq: 2, host: 1 })).toBeNull();
    expect(send(p, { seq: 2, request: 0 })).toBeNull();
    expect(send(p, { seq: 2, token: 'secret' })).toBeNull();
    expect(send(p, { seq: 2, operation: 'nativeLogin' })).toBeNull();
    expect(send(p, { seq: 2 })?.type).toBe('roomAudio');
    expect(p.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 3 }))).toEqual({ type: 'end' });
    expect(send(p, { seq: 4 })).toBeNull();
  });
  it('advertises the capability only when iOS native reports support', () => {
    const bridge = (nativeAudio: boolean, platform: 'ios' | 'android', roomAudio?: boolean) => {
      const top: Record<string, unknown> = { ReactNativeWebView: { postMessage: vi.fn() }, crypto: { randomUUID: () => document } };
      top.top = top;
      runInNewContext(activityBootstrap(3, nativeAudio, platform, roomAudio), { window: top, crypto: top.crypto });
      return top.CalabHostActivity as Record<string, unknown>;
    };
    expect(bridge(true, 'ios').roomAudioVersion).toBeUndefined();
    expect(bridge(true, 'ios', false).roomAudioVersion).toBeUndefined();
    expect(bridge(false, 'ios', true).roomAudioVersion).toBe(1);
    expect(bridge(false, 'android', true).roomAudioVersion).toBeUndefined();
    expect(activityBootstrap(3)).not.toContain('roomAudioVersion');
  });
  it('leaves the bootstrap of a build without room audio byte-identical', () => {
    const line = (calls: string) => `value: Object.freeze({version: 1, notificationsVersion: 1, notificationsTestVersion: 1, mediaPermissionsVersion: 1, callsVersion: 1, callsMuteVersion: 1, callsAnswerVersion: 1, ${calls} platform: 'ios', host: 3, get document() { return documentId; },`;
    expect(activityBootstrap(3, false, 'ios')).toContain(line(''));
    expect(activityBootstrap(3, true, 'ios')).toContain(line('callsAudioVersion: 1,'));
    expect(activityBootstrap(3, true, 'ios', true)).toContain(line('callsAudioVersion: 1, roomAudioVersion: 1,'));
  });
});

describe('host link event (ADR-0142)', () => {
  it('advertises links in the ack and dispatches the exact detail the page checks', () => {
    expect(activityReady(0, document)).toContain('"links":1');
    const dispatchEvent = vi.fn();
    class CustomEvent { constructor(readonly type: string, readonly init: { detail: unknown }) {} }
    runInNewContext(linkEvent(3, document, 'https://calab.example.com/t/INV-820'), { window: { dispatchEvent }, CustomEvent });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe('calab-host-link');
    expect(event.init.detail).toEqual({ v: 1, host: 3, document, url: 'https://calab.example.com/t/INV-820' });
  });
  it('exposes the handshaken document only between hello and revocation', () => {
    const protocol = new ActivityProtocol(0);
    expect(protocol.current()).toBeNull();
    protocol.accept(hello());
    expect(protocol.current()).toBe(document);
    protocol.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 1 }));
    expect(protocol.current()).toBeNull();
  });
});

describe('Android host channel (DEV-5033, ADR-0070 Android)', () => {
  it('has no JS frame proof: the patched WebMessageListener is the boundary, hello goes straight to ready', () => {
    const p = new ActivityProtocol(0);
    expect(p.accept(JSON.stringify({ v: 1, type: 'proof', host: 0, document, nonce: '1-abc' }))).toBeNull();
    expect(p.current()).toBeNull();
    expect(p.accept(hello())).toEqual({ type: 'ready', document });
    expect(p.accept(activity())?.type).toBe('publish');
    expect(p.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 2, reason: 'logout' }))).toEqual({ type: 'end', reason: 'logout' });
    expect(p.current()).toBeNull();
  });
  it('advertises only notifications and links, so the web keeps its own permission and call paths', () => {
    const top: Record<string, unknown> = { ReactNativeWebView: { postMessage: vi.fn() }, crypto: { randomUUID: () => document } };
    top.top = top;
    runInNewContext(activityBootstrap(3, true, 'android'), { window: top, crypto: top.crypto });
    const bridge = top.CalabHostActivity as Record<string, unknown>;
    expect(bridge).toMatchObject({ version: 1, notificationsVersion: 1, notificationsTestVersion: 1, platform: 'android' });
    for (const key of ['mediaPermissionsVersion', 'callsVersion', 'callsMuteVersion', 'callsAnswerVersion', 'callsAudioVersion']) expect(bridge[key]).toBeUndefined();
    expect(activityBootstrap(3)).toContain('callsVersion: 1');
    const ready = activityReady(3, document, false, true);
    expect(ready).toContain('"links":1');
    expect(ready).not.toContain('"calls"');
    expect(ready).not.toContain('"permissions"');
  });
});
