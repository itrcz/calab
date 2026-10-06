import { CallState, PushProvider, PushCapabilitiesResponseSchema, RegisterPushDeviceRequestSchema, RegisterPushDeviceResponseSchema, ResolvePushRequestSchema, ResolvePushResponseSchema, type Call } from '@calaba/protocol';
import type { HostCallAction, HostCallsCapability, HostCallsState } from '../../shared/hostCalls';
import type { HostPushReference } from '../../shared/hostActivity';
import { ApiError, body, call } from '../lib/api/client';
import { platform } from '../platform';
import { useSession } from '../stores/session';
import { useCall } from '../stores/call';
import { useVoice } from '../stores/voice';
import { onCallRing, ownsHostCall, performHostCallAction, setHostCallMuted, setHostIncomingOwnership } from './call';

export interface IncomingCallApi {
 capabilities:(signal:AbortSignal)=>Promise<{appId:string;environment:string}[]>;
 register:(state:HostCallsState,signal:AbortSignal)=>Promise<{id:string;version:bigint}>;
 resolve:(reference:HostPushReference,signal:AbortSignal)=>Promise<Call|undefined>;
 ring:(call:Call)=>void;
 owns:(callId:string)=>boolean;
 act:(callId:string,action:'answer'|'end',signal:AbortSignal,isCurrent:()=>boolean,isSessionCurrent:()=>boolean)=>Promise<boolean>;
 release:(callId:string)=>void;
 mute:(callId:string,muted:boolean)=>boolean;
}
const api:IncomingCallApi={
 capabilities:async(signal)=>(await call('GET','/api/me/push-capabilities',PushCapabilitiesResponseSchema,undefined,signal)).providers.filter(p=>p.provider===PushProvider.VOIP),
 register:(s,signal)=>call('POST','/api/me/push-devices',RegisterPushDeviceResponseSchema,body(RegisterPushDeviceRequestSchema,{
  provider:PushProvider.VOIP,appId:s.appId??'',environment:s.environment??'',installationId:s.installationId??'',token:s.token??'',callsEnabled:true,notificationsEnabled:false,mentionsEnabled:false,allEnabled:false,
 }),signal),
 resolve:async(reference,signal)=>(await call('POST','/api/me/push-resolve',ResolvePushResponseSchema,body(ResolvePushRequestSchema,reference),signal)).call,
 ring(value){setHostIncomingOwnership(value.id,true);if(value.state===CallState.RINGING)onCallRing(value,undefined); },
 act:performHostCallAction,
 owns:ownsHostCall,
 mute:setHostCallMuted,
 release:id=>setHostIncomingOwnership(id,false),
};

/** Only the shared cookie session/READY/calls/voice own business state and RTC. */
export class HostIncomingController {
 private session:string|null=null;
 private ready=false;
 private revision=0;
 private abort=new AbortController();
 private fingerprint='';
 private registration=Promise.resolve();
 private work=new Set<Promise<void>>();
 private eventWork=new Map<string,Promise<void>>();
 private queued=new Map<string,HostCallAction>();
 private handled=new Set<string>();
 private routes=new Map<string,{callId:string;roomId:string;expiresAt:number}>();
 private deadline:ReturnType<typeof setTimeout>|undefined;
 constructor(private readonly capability:HostCallsCapability,private readonly api:IncomingCallApi){}
 update(session:string|null,ready:boolean):void {
  if(this.session===session && this.ready===ready)return;
  if(this.session && this.session!==session)this.revoke();
  this.session=session;this.ready=ready;
  if(session){const revision=this.revision;void this.capability.state().then(s=>{if(revision===this.revision)this.accept(s);});}
  this.drain();
 }
 revoke():void {
  this.abort.abort();this.abort=new AbortController();this.revision++;this.session=null;this.ready=false;this.fingerprint='';
  for(const route of this.routes.values())this.api.release(route.callId);
  this.routes.clear();this.queued.clear();this.handled.clear();clearTimeout(this.deadline);
  this.capability.clear('logout');
 }
 accept(state:HostCallsState):void {
  if(!this.session || !state.supported)return;
  const revision=this.revision;const signal=this.abort.signal;
  if(state.token){
   const token=state.token;
   const fingerprint=JSON.stringify([state.token,state.appId,state.environment]);
   this.registration=this.registration.then(async()=>{
    if(revision!==this.revision || fingerprint===this.fingerprint)return;
    const providers=await this.api.capabilities(signal);
    if(revision!==this.revision || !providers.some(p=>p.appId===state.appId && p.environment===state.environment))return;
    const endpoint=await this.api.register(state,signal);
    if(revision!==this.revision)return;
    if(await this.capability.bind(endpoint.id,endpoint.version,token) && revision===this.revision)this.fingerprint=fingerprint;
   }).catch(()=>undefined);
  }
  for(const action of [...(state.actions??[])].sort((a,b)=>['ring','answer','mute','unmute','end'].indexOf(a.action)-['ring','answer','mute','unmute','end'].indexOf(b.action)))if(!this.handled.has(action.actionId) && !this.queued.has(action.actionId))this.queued.set(action.actionId,action);
  this.drain();
 }
 private drain():void {
  clearTimeout(this.deadline);
  for(const [id,action] of this.queued){
   if(action.expiresAt<=Date.now()){this.queued.delete(id);this.handled.add(id);this.capability.settle(id,'failed');continue;}
   if(!this.session || !this.ready)continue;
   this.queued.delete(id);this.handled.add(id);
   if(this.handled.size>128)this.handled.delete(this.handled.values().next().value as string);
   const revision=this.revision;
   const parent=this.abort.signal;
   const job=(this.eventWork.get(action.eventId) ?? Promise.resolve()).then(async()=>{
    // Ring and answer share a receipt and run serially. Start the request budget only
    // when this action runs, while retaining the native action's absolute expiry.
    const bounded=new AbortController();const abort=()=>bounded.abort();parent.addEventListener('abort',abort,{once:true});
    if(parent.aborted)bounded.abort();
    const timer=setTimeout(abort,Math.max(0,Math.min(6000,action.expiresAt-Date.now())));
    try{await this.perform(action,revision,bounded.signal);}finally{clearTimeout(timer);parent.removeEventListener('abort',abort);}
   }).finally(()=>{this.work.delete(job);if(this.eventWork.get(action.eventId)===job)this.eventWork.delete(action.eventId);});
   this.work.add(job);this.eventWork.set(action.eventId,job);
  }
  if(this.queued.size){const next=Math.min(...Array.from(this.queued.values(),a=>a.expiresAt));this.deadline=setTimeout(()=>this.drain(),Math.max(1,next-Date.now()));}
 }
 private async resolve(action:HostCallAction,signal:AbortSignal,current:()=>boolean):Promise<Call|undefined> {
  // APNs can reach the device before its HTTP response commits delivered_at. Retry only the
  // authenticated unavailable receipt, always through unchanged session/version/call policy.
  while(current()) {
   try{return await this.api.resolve({binding:action.binding,eventId:action.eventId,expiresAt:action.expiresAt},signal);}
   catch(error){
    if(!(error instanceof ApiError) || error.status!==404 || !current())throw error;
    await new Promise<void>((resolve,reject)=>{
     const abort=()=>{clearTimeout(timer);reject(new Error('action cancelled'));};
     const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},200);
     signal.addEventListener('abort',abort,{once:true});
     if(signal.aborted)abort();
    });
   }
  }
  throw new Error('action expired');
 }
 private async perform(action:HostCallAction,revision:number,signal:AbortSignal):Promise<void> {
  const current=()=>revision===this.revision && !!this.session && this.ready && !signal.aborted && action.expiresAt>Date.now();
  try{
   if(!current()){if(revision===this.revision)this.capability.settle(action.actionId,'failed');return;}
   let route=this.routes.get(action.eventId);
   if(action.action==='mute' || action.action==='unmute'){
    // An ongoing call outlives its ring receipt. Only this document's accepted route may
    // control its microphone; never resolve a fresh receipt or create ownership here.
    const muted=action.action==='mute';
    const success=!!route && this.api.owns(route.callId) && this.api.mute(route.callId,muted);
    this.capability.settle(action.actionId,success ? muted ? 'muted':'unmuted':'failed');
    return;
   }
   if(action.action!=='end' || !route){
    const value=await this.resolve(action,signal,current);
    if(!current())return;
    if(!value || (value.state!==CallState.RINGING && !(value.state===CallState.ACTIVE && this.api.owns(value.id))))throw new Error('call unavailable');
    route={callId:value.id,roomId:value.dmRoomId,expiresAt:action.expiresAt};this.routes.set(action.eventId,route);this.api.ring(value);
   }
   if(!current()){if(revision===this.revision)this.capability.settle(action.actionId,'failed');return;}
   if(action.action==='ring'){this.capability.settle(action.actionId,'ringing');return;}
   const success=await this.api.act(route.callId,action.action,signal,current,()=>revision===this.revision && !!this.session);
   if(!current())return;
   this.capability.settle(action.actionId,success ? action.action==='answer' ? 'accepted':'ended':'failed');
   if(!success || action.action==='end'){this.api.release(route.callId);this.routes.delete(action.eventId);}
  }catch{if(revision===this.revision){this.capability.settle(action.actionId,'failed');const route=this.routes.get(action.eventId);if(route)this.api.release(route.callId);this.routes.delete(action.eventId);}}
 }
 sync(callId:string|null,phase:string,voiceRoom:string|null,voiceStatus:string,muted=false):void {
  for(const [event,route] of this.routes){
   if(callId!==route.callId || phase==='idle'){
    this.capability.sync(event,'ended');this.api.release(route.callId);this.routes.delete(event);
   }else if(phase==='active' && voiceRoom===route.roomId && voiceStatus==='connected'){
    this.capability.sync(event,'connected');this.capability.syncMuted?.(event,muted);
   }
  }
 }
 async settled():Promise<void>{await this.registration;await Promise.all(this.work);}
 dispose():void{
  this.abort.abort();this.revision++;this.session=null;this.ready=false;clearTimeout(this.deadline);
  for(const route of this.routes.values())this.api.release(route.callId);
  this.routes.clear();this.queued.clear();this.capability.clear();
 }
}
export function installHostIncomingCalls(capability=platform.incomingCalls, incomingApi:IncomingCallApi=api):()=>void {
 if(!capability)return ()=>undefined;
 const controller=new HostIncomingController(capability,incomingApi);
 let anonymousCleared=false;
 let revokedSession:string|null=null;
 let previousSync='';
 const update=()=>{
  const s=useSession.getState();if(s.status==='booting' || s.status==='offline')return;
  if(s.status==='anon'){if(!anonymousCleared)controller.revoke();anonymousCleared=true;return;}
  anonymousCleared=false;controller.update(s.sessionId && s.sessionId!==revokedSession ? s.sessionId:null,s.ready && s.gateway==='ready');
 };
 const sync=(force=false)=>{const c=useCall.getState();const v=useVoice.getState();const muted=v.muted||v.deafened||v.serverMuted;const next=JSON.stringify([c.call?.id,c.phase,v.roomId,v.phase,muted]);if(!force && next===previousSync)return;previousSync=next;controller.sync(c.call?.id??null,c.phase,v.roomId,v.phase,muted);};
 const subs=[useSession.subscribe(update),useCall.subscribe(()=>sync()),useVoice.subscribe(()=>sync()),capability.subscribe(s=>{controller.accept(s);sync(true);}),platform.auth.onLoggedOut(()=>{revokedSession=useSession.getState().sessionId;controller.revoke();})];
 const pagehide=()=>controller.dispose();window.addEventListener('pagehide',pagehide);update();
 return ()=>{for(const sub of subs)sub();window.removeEventListener('pagehide',pagehide);controller.dispose();};
}
