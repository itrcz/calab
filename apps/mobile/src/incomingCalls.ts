import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { parseCallsState, type HostCallsState, type HostCallsOperation } from '../../desktop/src/shared/hostCalls';
interface NativeCalls {
 callsState(document:string):Promise<unknown>;
 bindCalls(document:string,binding:string,version:string,token:string):Promise<boolean>;
 settleCall(document:string,actionId:string,result:string):Promise<void>;
 syncCall(document:string,eventId:string,phase:string):Promise<void>;
 addListener(name:'onCallsChanged',callback:(value:{document:string;state:unknown})=>void):{remove():void};
}
const native=Platform.OS==='ios' ? requireOptionalNativeModule<NativeCalls>('CalabIncomingCalls'):null;
export async function callsOperation(document:string,operation:HostCallsOperation):Promise<{state:HostCallsState;bound?:boolean}> {
 try {
  let bound:boolean|undefined;
  if(operation.operation==='bind')bound=await native?.bindCalls(document,operation.binding,operation.version,operation.token) ?? false;
  if(operation.operation==='settle')await native?.settleCall(document,operation.actionId,operation.result);
  if(operation.operation==='sync')await native?.syncCall(document,operation.eventId,operation.phase);
  const state=parseCallsState(await native?.callsState(document)) ?? {supported:false};
  return {state,...(bound!==undefined ? {bound}: {})};
 } catch {return {state:{supported:false}};}
}
export function subscribeCalls(callback:(document:string,state:HostCallsState)=>void):()=>void {
 const sub=native?.addListener('onCallsChanged',value=>{const state=parseCallsState(value.state);if(state)callback(value.document,state);});
 return ()=>sub?.remove();
}
export function callsReply(host:number,document:string,request:number,value:{state:HostCallsState;bound?:boolean}):string {
 return `window.dispatchEvent(new CustomEvent('calab-host-calls', {detail: ${JSON.stringify({v:1,host,document,request,...value})}})); true;`;
}
