import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { parseRoomAudioStatus, type HostRoomAudioOperation, type HostRoomAudioStatus } from '../../desktop/src/shared/hostRoomAudio';

interface NativeRoomAudio {
 roomAudioEnabled?:boolean;
 operation(document:string,operation:HostRoomAudioOperation):Promise<void>;
 state(document:string):Promise<unknown>;
 addListener(name:'onRoomAudioChanged',callback:(value:{document:string;state:unknown})=>void):{remove():void};
}
// A build or iOS version without native room audio has no module or leaves the flag off: rooms stay on the web path.
const available=Platform.OS==='ios' ? requireOptionalNativeModule<NativeRoomAudio>('CalabRoomAudio'):null;
const native=available?.roomAudioEnabled===true ? available:null;
export const roomAudioEnabled=native!==null;
/**
 * `supported: false` is only the missing module. A native failure says `failed` instead: the page must not
 * read it as "no native audio" and fall back while a session may still hold the audio.
 */
export async function roomAudioOperation(document:string,operation:HostRoomAudioOperation):Promise<HostRoomAudioStatus> {
 if(!native)return {supported:false};
 let failed=false;
 if(operation.operation!=='status') {
  try {await native.operation(document,operation);} catch {failed=true;}
 }
 try {
  const status=parseRoomAudioStatus(await native.state(document));
  if(status?.supported)return failed ? {...status,failed:true}:status;
 } catch {/* unknown state, as below */}
 return {supported:true,failed:true};
}
export function subscribeRoomAudio(callback:(document:string,state:HostRoomAudioStatus)=>void):()=>void {
 const sub=native?.addListener('onRoomAudioChanged',value=>{const state=parseRoomAudioStatus(value.state);if(state)callback(value.document,state);});
 return ()=>sub?.remove();
}
export function roomAudioReply(host:number,document:string,request:number,state:HostRoomAudioStatus):string {
 return `window.dispatchEvent(new CustomEvent('calab-host-room-audio', {detail: ${JSON.stringify({v:1,host,document,request,state})}})); true;`;
}
