import { parsePushReference, type HostPushReference } from './hostActivity';

export interface HostCallAction extends HostPushReference {
 actionId: string;
 action: 'ring' | 'answer' | 'end';
}
export interface HostCallsState {
 supported: boolean;
 appId?: string;
 environment?: 'development' | 'production';
 installationId?: string;
 token?: string;
 actions?: HostCallAction[];
 audioActive?: boolean;
}
export type HostCallResult = 'ringing' | 'accepted' | 'ended' | 'failed';
export type HostCallsOperation =
 | { operation:'status' }
 | { operation:'bind'; binding:string; version:string; token:string }
 | { operation:'settle'; actionId:string; result:HostCallResult }
 | { operation:'sync'; eventId:string; phase:'connected'|'ended' };
export interface HostCallsCapability {
 state:()=>Promise<HostCallsState>;
 subscribe:(listener:(state:HostCallsState)=>void)=>()=>void;
 bind:(binding:string,version:bigint,token:string)=>Promise<boolean>;
 settle:(actionId:string,result:HostCallResult)=>void;
 sync:(eventId:string,phase:'connected'|'ended')=>void;
 clear:(reason?:'logout')=>void;
}
const uuid = (value:unknown):value is string => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value!=='00000000-0000-0000-0000-000000000000';
export function parseCallsOperation(value:Record<string,unknown>):HostCallsOperation|null {
 const keys=Object.keys(value).sort().join(',');
 if(keys==='operation' && value.operation==='status')return {operation:'status'};
 if(keys==='binding,operation,token,version' && value.operation==='bind' && uuid(value.binding) && typeof value.version==='string' && /^[1-9][0-9]{0,18}$/.test(value.version) && typeof value.token==='string' && /^[0-9a-f]{32,512}$/i.test(value.token))return value as unknown as HostCallsOperation;
 if(keys==='actionId,operation,result' && value.operation==='settle' && uuid(value.actionId) && ['ringing','accepted','ended','failed'].includes(String(value.result)))return value as unknown as HostCallsOperation;
 if(keys==='eventId,operation,phase' && value.operation==='sync' && uuid(value.eventId) && ['connected','ended'].includes(String(value.phase)))return value as unknown as HostCallsOperation;
 return null;
}
export function parseCallsState(value:unknown):HostCallsState|null {
 if(!value || typeof value!=='object' || Array.isArray(value))return null;
 const s=value as Record<string,unknown>;
 if(typeof s.supported!=='boolean' || Object.keys(s).some(k=>!['supported','token','appId','environment','installationId','actions','audioActive'].includes(k)))return null;
 if(!s.supported)return Object.keys(s).length===1 ? {supported:false}:null;
 if(s.token!==undefined && (typeof s.token!=='string' || !/^[0-9a-f]{32,512}$/i.test(s.token) || typeof s.appId!=='string' || !/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(s.appId) || s.appId.length>255 || !['development','production'].includes(String(s.environment)) || !uuid(s.installationId)))return null;
 if(s.audioActive!==undefined && typeof s.audioActive!=='boolean')return null;
 if(s.actions!==undefined && (!Array.isArray(s.actions) || s.actions.length>8 || s.actions.some(a=> {
  if(!a || typeof a!=='object' || Array.isArray(a))return true;
  const r=a as Record<string,unknown>;
  return Object.keys(r).sort().join(',')!=='action,actionId,binding,eventId,expiresAt' || !uuid(r.actionId) || !['ring','answer','end'].includes(String(r.action)) || !parsePushReference({binding:r.binding,eventId:r.eventId,expiresAt:r.expiresAt}) || Number(r.expiresAt)>Date.now()+60_000;
 })))return null;
 return value as HostCallsState;
}
