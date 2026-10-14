import { describe, expect, it, vi } from 'vitest';
import { HostCallAudioSession } from './hostCallAudio';
import type { HostAudioState, HostCallAudioCapability } from '../../../shared/hostCallAudio';

const eventId='11111111-1111-4111-8111-111111111111', connectionId='22222222-2222-4222-8222-222222222222';
const controls={muted:false,deafened:false,volume:1,userVolumes:{}};
const input={eventId,connectionId,roomId:eventId,url:'wss://rtc.example.test',token:'a.b.c',relayOnly:false,bitrate:32000,canSpeak:true,controls};
const connected:HostAudioState={eventId,connectionId,phase:'connected',microphoneReady:true,muted:false,canSpeak:true,speakers:[]};
function fixture() {
 let emit:(s:HostAudioState)=>void=()=>undefined;
 let resolve!:(s:HostAudioState|null)=>void;
 const states:HostAudioState[]=[];
 const capability:HostCallAudioCapability={connect:()=>new Promise(r=>{resolve=r;}),control(){},disconnect(){},subscribe(fn){emit=fn;return ()=>{emit=()=>undefined;};}};
 const session=new HostCallAudioSession(capability,input,s=>states.push(s));
 return {session,states,reply:(s:HostAudioState|null)=>resolve(s),emit:(s:HostAudioState)=>emit(s)};
}
describe('native call audio ownership',()=>{
 it('releases the native transport and listener when the bridge rejects',async()=>{
  const disconnect=vi.fn(),unsubscribe=vi.fn();
  const cap:HostCallAudioCapability={connect:()=>Promise.reject(new Error('bridge gone')),control(){},disconnect,subscribe:()=>unsubscribe};
  const session=new HostCallAudioSession(cap,input,()=>undefined);
  await expect(session.start()).rejects.toThrow('bridge gone');
  expect(disconnect).toHaveBeenCalledWith(eventId,connectionId);
  expect(unsubscribe).toHaveBeenCalledOnce();expect(session.alive).toBe(false);
 });
 it('does not become ready before microphone publication',async()=>{
  const x=fixture();const run=x.session.start();x.reply({...connected,microphoneReady:false});
  await expect(run).rejects.toThrow();expect(x.session.connected).toBe(false);
 });
 it('ignores another connection and accepts only its own readiness',async()=>{
  const x=fixture();const run=x.session.start();x.emit({...connected,connectionId:eventId});expect(x.states).toEqual([]);
  x.reply(connected);await run;expect(x.session.connected).toBe(true);
 });
 it('cannot resurrect a call after end while native connect is pending',async()=>{
  const x=fixture();const run=x.session.start();x.session.stop();x.reply(connected);
  await expect(run).rejects.toThrow();x.emit(connected);expect(x.states).toEqual([]);expect(x.session.connected).toBe(false);
 });
 it('rejects a failed native join rather than falling back to hidden web capture',async()=>{
  const x=fixture();const run=x.session.start();x.reply({...connected,phase:'failed',error:'permission'});
  await expect(run).rejects.toThrow();expect(x.session.connected).toBe(false);
 });
});
