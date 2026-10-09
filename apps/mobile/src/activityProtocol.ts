import type { HostCallsOperation } from '../../desktop/src/shared/hostCalls';
import { parseHostActivityMessage, type SessionActivitySnapshot } from '../../desktop/src/shared/hostActivity';

export type ActivityAction =
  | ({ type:'calls'; document:string; request:number } & HostCallsOperation)
  | { type: 'ready'; document: string }
  | { type: 'publish'; document: string; snapshot: SessionActivitySnapshot }
  | { type: 'end' }
  | { type: 'notifications'; document: string; request: number; operation: 'status' | 'request' | 'clear' | 'ack' | 'test'; eventId?: string; body?: string };

/** Native has already proved frame, origin and current document. JS narrows schema and order. */
export class ActivityProtocol {
  private document: string | null = null;
  private sequence = 0;
  private generation = 0;

  constructor(private readonly host: number) {}

  belongsTo(host: number): boolean { return this.host === host; }

  isCurrent(document: string): boolean { return this.document === document; }

  reset(): void { this.document = null; this.sequence = 0; this.generation = 0; }

  accept(raw: string): ActivityAction | null {
    const message = parseHostActivityMessage(raw);
    if (!message || message.host !== this.host) return null;
    if (message.type === 'hello') {
      if (this.document === message.document) return null;
      this.reset();
      this.document = message.document;
      return { type: 'ready', document: message.document };
    }
    if (message.document !== this.document || message.seq <= this.sequence) return null;
    this.sequence = message.seq;
    if (message.type === 'revoke') { this.reset(); return { type: 'end' }; }
    if (message.type === 'calls') return { ...message, type:'calls' };
    if (message.type === 'notifications') return { type: 'notifications', document: message.document, request: message.request, operation: message.operation, ...(message.eventId ? { eventId: message.eventId } : {}), ...(message.body ? { body: message.body } : {}) };
    if (message.snapshot.generation < this.generation) return null;
    this.generation = message.snapshot.generation;
    return { type: 'publish', document: message.document, snapshot: message.snapshot };
  }
}

/** Declaration only, main frame only. Native validation is the actual authority boundary. */
export function activityBootstrap(host: number, nativeAudio = false): string {
  return `(() => {
    if (window !== window.top || !window.ReactNativeWebView || !window.crypto?.randomUUID) return;
    let documentId = crypto.randomUUID();
    Object.defineProperty(window, 'CalabHostActivity', { configurable: false, writable: false,
      value: Object.freeze({version: 1, notificationsVersion: 1, notificationsTestVersion: 1, callsVersion: 1, callsMuteVersion: 1, callsAnswerVersion: 1, ${nativeAudio ? 'callsAudioVersion: 1,' : ''} host: ${String(host)}, get document() { return documentId; },
        rotateDocument: () => { documentId = crypto.randomUUID(); },
        send: (data) => window.ReactNativeWebView.postMessage(data)}) });
  })(); true;`;
}

export function activityReady(host: number, document: string, activity = true): string {
  const detail = JSON.stringify({ v: 1, host, document, capability: activity ? 'sessionActivity' : 'notifications', notifications: 1, calls: 1 });
  return `window.dispatchEvent(new CustomEvent('calab-host-activity-ready', {detail: ${detail}})); true;`;
}
