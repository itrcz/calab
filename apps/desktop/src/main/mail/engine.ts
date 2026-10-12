/**
 * The mail engine (ADR-0080 §2): a utilityProcess forked by main (src/main/mail/index.ts), built as
 * out/main/mailEngine.js. Talks to main only: MailToEngine in, MailFromEngine out (shared/mail.ts).
 * No Electron main-process APIs, no Calab session.
 */
import type { MailEvent, MailFromEngine, MailToEngine } from '../../shared/mail';
import { createHandlers, dispatch } from './handlers';

const port = process.parentPort;
const handlers = createHandlers();

function send(msg: MailFromEngine): void {
  port.postMessage(msg);
}

/** Push an event to the renderer (T1: coalesce ≤ 1 per folder per 250 ms before calling this). */
export function emit(event: MailEvent): void {
  send({ kind: 'event', event });
}

port.on('message', (e) => {
  const msg = e.data as MailToEngine | null;
  if (msg?.kind !== 'request') return;
  void dispatch(handlers, msg.req).then((res) => {
    send({ kind: 'response', res });
  });
});
