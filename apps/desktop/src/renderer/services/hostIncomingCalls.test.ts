import { describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { CallSchema, CallState } from '@calaba/protocol';
import { HostIncomingController, installHostIncomingCalls, type IncomingCallApi } from './hostIncomingCalls';
import { useSession } from '../stores/session';
import { wakeGateway } from './gateway';
import { ApiError } from '../lib/api/client';
import type { HostCallsCapability, HostCallsState } from '../../shared/hostCalls';
vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
const auth=vi.hoisted(()=>({callback:()=>{}}));
vi.mock('../platform',()=>({platform:{auth:{onLoggedOut:(cb:()=>void)=>{auth.callback=cb;return ()=>{};}}}}));
vi.mock('./gateway',()=>({wakeGateway:vi.fn()}));
vi.mock('./call',()=>({onCallRing:vi.fn(),ownsHostCall:vi.fn(),performHostCallAction:vi.fn(),setHostCallMuted:vi.fn(),setHostIncomingOwnership:vi.fn()}));
const reference={binding:'11111111-1111-4111-8111-111111111111',eventId:'22222222-2222-4222-8222-222222222222',expiresAt:Date.now()+45000};
const actionId='44444444-4444-4444-8444-444444444444';
const state:HostCallsState={supported:true,token:'aa'.repeat(32),appId:'test.calab.app',environment:'development',installationId:'33333333-3333-4333-8333-333333333333',actions:[{...reference,actionId,action:'answer'}]};
function harness(){
 const capability:HostCallsCapability={state:vi.fn().mockResolvedValue(state),subscribe:()=>()=>{},bind:vi.fn().mockResolvedValue(true),settle:vi.fn(),sync:vi.fn(),syncMuted:vi.fn(),clear:vi.fn()};
 const api:IncomingCallApi={capabilities:vi.fn().mockResolvedValue([{appId:state.appId,environment:state.environment}]),register:vi.fn().mockResolvedValue({id:reference.binding,version:1n}),resolve:vi.fn().mockResolvedValue(create(CallSchema,{id:'call',state:CallState.RINGING})),ring:vi.fn(),owns:vi.fn().mockReturnValue(false),act:vi.fn().mockResolvedValue(true),release:vi.fn(),mute:vi.fn().mockReturnValue(true)};
 const controller=new HostIncomingController(capability,api);return {capability,api,controller};
}
describe('authenticated shared-web incoming action boundary',()=>{
 it('waits for existing gateway bootstrap then answers once through common call service',async()=>{
  const h=harness();h.controller.update('session',false);await Promise.resolve();await h.controller.settled();
  expect(h.api.register).toHaveBeenCalledOnce();expect(h.api.act).not.toHaveBeenCalled();
  h.controller.update('session',true);await h.controller.settled();
  expect(h.api.resolve).toHaveBeenCalledWith(reference,expect.any(AbortSignal));
  expect(h.api.act).toHaveBeenCalledWith('call','answer',expect.any(AbortSignal),expect.any(Function),expect.any(Function));expect(h.capability.settle).toHaveBeenCalledWith(actionId,'accepted');
  h.controller.accept(state);await h.controller.settled();expect(h.api.act).toHaveBeenCalledOnce();
 });
 it('rejects stale/cancelled/foreign ring instead of fulfilling answer',async()=>{
  const h=harness();vi.mocked(h.api.resolve).mockRejectedValue(new Error('cancelled'));h.controller.update('session',true);await Promise.resolve();await h.controller.settled();
  expect(h.api.act).not.toHaveBeenCalled();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'failed');
 });
 it('drops asynchronous resolve on logout and clears native binding synchronously',async()=>{
  const h=harness();let resolve:(call:ReturnType<typeof create<typeof CallSchema>>)=>void=()=>{};
  vi.mocked(h.api.resolve).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
  h.controller.update('session',true);await vi.waitFor(()=>expect(h.api.resolve).toHaveBeenCalledOnce());
  h.controller.update(null,false);expect(h.capability.clear).toHaveBeenCalledWith('logout');
  resolve(create(CallSchema,{id:'old',state:CallState.RINGING}));await h.controller.settled();expect(h.api.act).not.toHaveBeenCalled();
 });
 it('fails queued actions at expiry without web readiness and leaves ordinary reload distinct',async()=>{
  vi.useFakeTimers();try{
   const h=harness();h.controller.update('session',false);await Promise.resolve();await h.controller.settled();
   await vi.advanceTimersByTimeAsync(46000);expect(h.api.act).not.toHaveBeenCalled();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'failed');
   h.controller.dispose();expect(h.capability.clear).toHaveBeenLastCalledWith();
  }finally{vi.useRealTimers();}
 });
 it('never registers an unsupported build and never treats server ACTIVE as a fresh incoming answer',async()=>{
  const h=harness();vi.mocked(h.capability.state).mockResolvedValueOnce({supported:false});h.controller.update('session',true);await Promise.resolve();await h.controller.settled();expect(h.api.register).not.toHaveBeenCalled();
  vi.mocked(h.api.resolve).mockResolvedValueOnce(create(CallSchema,{id:'taken',state:CallState.ACTIVE}));h.controller.accept(state);await h.controller.settled();expect(h.api.act).not.toHaveBeenCalled();
 });
});


it('revocation blocks still-authed session updates until a new login identity appears', async()=>{
 const h=harness();vi.mocked(h.capability.state).mockResolvedValue({...state,actions:[]});
 useSession.setState({status:'authed',sessionId:'first',ready:true,gateway:'ready'});
 const dispose=installHostIncomingCalls(h.capability,h.api);
 await vi.waitFor(()=>expect(h.api.register).toHaveBeenCalledOnce());
 auth.callback();useSession.setState({gateway:'resuming'});useSession.setState({gateway:'ready'});
 await Promise.resolve();await Promise.resolve();expect(h.api.register).toHaveBeenCalledOnce();
 useSession.setState({sessionId:'second'});await vi.waitFor(()=>expect(h.api.register).toHaveBeenCalledTimes(2));dispose();
});

it('retries the delivered-receipt race within the same authenticated action deadline', async()=>{
 vi.useFakeTimers();try{
  const h=harness();vi.mocked(h.api.resolve).mockRejectedValueOnce(new ApiError('ERROR_CODE_NOT_FOUND','not committed',404));
  h.controller.update('session',true);await vi.advanceTimersByTimeAsync(0);
  expect(h.api.resolve).toHaveBeenCalledOnce();expect(h.api.act).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);await h.controller.settled();
  expect(h.api.resolve).toHaveBeenCalledTimes(2);expect(h.api.act).toHaveBeenCalledOnce();
  expect(h.capability.settle).toHaveBeenCalledWith(actionId,'accepted');h.controller.dispose();
 }finally{vi.useRealTimers();}
});
it('bounds unavailable-receipt retries and does not retry an auth denial', async()=>{
 vi.useFakeTimers();try{
  const h=harness();vi.mocked(h.api.resolve).mockRejectedValue(new ApiError('ERROR_CODE_NOT_FOUND','cancelled',404));
  h.controller.update('session',true);await vi.advanceTimersByTimeAsync(6100);await h.controller.settled();
  expect(h.api.act).not.toHaveBeenCalled();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'failed');
  const attempts=vi.mocked(h.api.resolve).mock.calls.length;await vi.advanceTimersByTimeAsync(2000);
  expect(h.api.resolve).toHaveBeenCalledTimes(attempts);h.controller.dispose();
  const denied=harness();vi.mocked(denied.api.resolve).mockRejectedValue(new ApiError('ERROR_CODE_UNAUTHORIZED','revoked',401));
  denied.controller.update('session',true);await vi.advanceTimersByTimeAsync(0);await denied.controller.settled();
  expect(denied.api.resolve).toHaveBeenCalledOnce();expect(denied.api.act).not.toHaveBeenCalled();denied.controller.dispose();
 }finally{vi.useRealTimers();}
});

it('gives an answer its request budget after a slow ring resolve, within the native deadline', async()=>{
 vi.useFakeTimers();try{
  const h=harness();const now=Date.now();
  const ring={...reference,expiresAt:now+45000,action:'ring' as const,actionId:'55555555-5555-4555-8555-555555555555'};
  const answer={...reference,expiresAt:now+10000,action:'answer' as const,actionId};
  vi.mocked(h.capability.state).mockResolvedValue({...state,actions:[ring,answer]});
  vi.mocked(h.api.resolve).mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(create(CallSchema,{id:'call',state:CallState.RINGING})),4000)));
  h.controller.update('session',true);
  await vi.advanceTimersByTimeAsync(8100);await h.controller.settled();
  expect(h.api.act).toHaveBeenCalledOnce();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'accepted');
  h.controller.dispose();
 }finally{vi.useRealTimers();}
});

it('reconciles an authenticated ACTIVE receipt only with the common local accept owner',async()=>{
 const h=harness();vi.mocked(h.api.resolve).mockResolvedValue(create(CallSchema,{id:'call',state:CallState.ACTIVE}));
 vi.mocked(h.api.owns).mockReturnValue(true);h.controller.update('session',true);
 await Promise.resolve();await h.controller.settled();
 expect(h.api.act).toHaveBeenCalledOnce();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'accepted');
 h.controller.dispose();
});
it('never grants a fresh request window to an answer that expired behind ring',async()=>{
 vi.useFakeTimers();try{
  const h=harness();const now=Date.now();
  vi.mocked(h.capability.state).mockResolvedValue({...state,actions:[
   {...reference,expiresAt:now+45000,action:'ring',actionId:'55555555-5555-4555-8555-555555555555'},
   {...reference,expiresAt:now+2000,action:'answer',actionId},
  ]});
  vi.mocked(h.api.resolve).mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(create(CallSchema,{id:'call',state:CallState.RINGING})),4000)));
  h.controller.update('session',true);await vi.advanceTimersByTimeAsync(4100);await h.controller.settled();
  expect(h.api.act).not.toHaveBeenCalled();expect(h.capability.settle).toHaveBeenCalledWith(actionId,'failed');
  h.controller.dispose();
 }finally{vi.useRealTimers();}
});

for (const action of ['mute','unmute'] as const) {
 it(`routes system ${action} only to the accepted local call, beyond the ring receipt lifetime`,async()=>{
  const h=harness();h.controller.update('session',true);await Promise.resolve();await h.controller.settled();
  vi.mocked(h.api.owns).mockReturnValue(true);vi.mocked(h.api.resolve).mockClear();
  const control={...reference,expiresAt:Date.now()+10000,actionId:'66666666-6666-4666-8666-666666666666',action};
  h.controller.accept({...state,actions:[control]});await h.controller.settled();
  expect(h.api.resolve).not.toHaveBeenCalled();expect(h.api.mute).toHaveBeenCalledWith('call',action==='mute');
  expect(h.capability.settle).toHaveBeenLastCalledWith(control.actionId,action==='mute'?'muted':'unmuted');
  h.controller.accept({...state,actions:[control]});await h.controller.settled();expect(h.api.mute).toHaveBeenCalledOnce();
  h.controller.sync('call','active','','connected',true);expect(h.capability.syncMuted).toHaveBeenCalledWith(reference.eventId,true);
  h.controller.dispose();
 });
}
it('fails foreign, unowned and expired microphone actions without ending the call',async()=>{
 const h=harness();h.controller.update('session',true);await Promise.resolve();await h.controller.settled();
 const control={...reference,expiresAt:Date.now()+10000,actionId:'66666666-6666-4666-8666-666666666666',action:'mute' as const};
 h.controller.accept({...state,actions:[control]});await h.controller.settled();
 expect(h.api.mute).not.toHaveBeenCalled();expect(h.capability.settle).toHaveBeenLastCalledWith(control.actionId,'failed');
 vi.mocked(h.api.owns).mockReturnValue(true);
 h.controller.accept({...state,actions:[{...control,actionId:'77777777-7777-4777-8777-777777777777',eventId:'foreign'}]});
 h.controller.accept({...state,actions:[{...control,actionId:'88888888-8888-4888-8888-888888888888',expiresAt:Date.now()-1}]});
 await h.controller.settled();expect(h.api.mute).not.toHaveBeenCalled();expect(h.api.release).not.toHaveBeenCalled();
 h.controller.dispose();
});

it('syncs a web-button answer before media connects, only for the confirmed local owner',async()=>{
 const h=harness();const syncAccepted=vi.fn();Object.assign(h.capability,{syncAccepted});
 h.controller.update('session',true);await Promise.resolve();await h.controller.settled();
 h.controller.sync('call','active','','connecting');expect(syncAccepted).not.toHaveBeenCalled();
 vi.mocked(h.api.owns).mockReturnValue(true);
 h.controller.sync('call','active','','connecting');expect(syncAccepted).toHaveBeenCalledWith(reference.eventId);
 h.controller.dispose();
});

it('wakes a hidden disconnected gateway on fresh call actions without bypassing READY',async()=>{
 vi.mocked(wakeGateway).mockClear();
 const h=harness();h.controller.update('session',false);await Promise.resolve();await h.controller.settled();
 expect(wakeGateway).toHaveBeenCalledOnce();expect(h.api.act).not.toHaveBeenCalled();
 h.controller.accept(state);expect(wakeGateway).toHaveBeenCalledOnce();
 h.controller.update('session',true);await h.controller.settled();
 expect(h.api.act).toHaveBeenCalledOnce();h.controller.dispose();
});

it('replays an already connected web answer when its ring receipt resolves late',async()=>{
 const h=harness();const syncAccepted=vi.fn();Object.assign(h.capability,{syncAccepted});
 vi.mocked(h.capability.state).mockResolvedValue({...state,actions:[{...reference,actionId,action:'ring'}]});
 let resolve!:(value:ReturnType<typeof create<typeof CallSchema>>)=>void;
 vi.mocked(h.api.resolve).mockReturnValue(new Promise(done=>{resolve=done;}));
 h.controller.update('session',true);await vi.waitFor(()=>expect(h.api.resolve).toHaveBeenCalledOnce());
 vi.mocked(h.api.owns).mockReturnValue(true);
 h.controller.sync('call','active','dm','connected',true);
 expect(syncAccepted).not.toHaveBeenCalled();
 resolve(create(CallSchema,{id:'call',dmRoomId:'dm',state:CallState.ACTIVE}));await h.controller.settled();
 expect(syncAccepted).toHaveBeenCalledWith(reference.eventId);
 expect(h.capability.sync).toHaveBeenCalledWith(reference.eventId,'connected');
 expect(h.capability.syncMuted).toHaveBeenCalledWith(reference.eventId,true);
 h.controller.dispose();
});
