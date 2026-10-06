import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseHostActivityMessage } from '../../desktop/src/shared/hostActivity';
import { parseCallsState } from '../../desktop/src/shared/hostCalls';
import { ActivityProtocol, activityBootstrap } from './activityProtocol';

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
