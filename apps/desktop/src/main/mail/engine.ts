/**
 * The mail engine (ADR-0088 §2): a utilityProcess forked by main (src/main/mail/index.ts), built as
 * out/main/mailEngine.js. Talks to main only: MailToEngine in, MailFromEngine out (shared/mail.ts).
 * No Electron main-process APIs, no Calab session. Passwords arrive from main in memory (`accounts`)
 * and are never logged or sent back.
 */
import type { MailEngineAccount, MailEvent, MailFromEngine, MailRequest, MailResponse, MailToEngine } from '../../shared/mail';
import { classify } from './errors';
import { EventCoalescer } from './events';
import { createHandlers, dispatch } from './handlers';
import { ImapFlowSession, verifyImap } from './imap';
import { realDiscoverNet } from './net';
import { MailEngine } from './service';
import { smtpSend, verifySmtp } from './send';

const port = process.parentPort;

function send(msg: MailFromEngine): void {
  port.postMessage(msg);
}

const coalescer = new EventCoalescer((event) => send({ kind: 'event', event }));

/** Push an event to the renderer, coalesced (≤ 1 per type per folder per 250 ms, events.ts). */
export function emit(event: MailEvent): void {
  coalescer.emit(event);
}

function log(message: string, meta?: Record<string, unknown>): void {
  // The engine has no electron-log: stderr reaches main's console in dev. Never pass secrets here.
  console.warn(message, meta ?? {});
}

let engine: MailEngine | null = null;
let handlers = createHandlers();
let accountsChain: Promise<void> = Promise.resolve();

function start(dataDir: string): void {
  if (engine) return;
  engine = new MailEngine({
    dataDir,
    emit,
    connectImap: (a: MailEngineAccount) => ImapFlowSession.open({ server: a.imap, login: a.login, password: a.password }),
    verifyImap: (l) => verifyImap(l),
    verifySmtp: (l) => verifySmtp(l),
    smtpSend: (a, env, raw) => smtpSend({ server: a.smtp, login: a.login, password: a.password }, env, raw),
    discoverNet: realDiscoverNet(),
    log,
  });
  handlers = engine.handlers();
}

async function answer(id: number, fn: () => Promise<unknown>): Promise<void> {
  let res: MailResponse;
  try {
    res = { id, ok: true, result: await fn() };
  } catch (e) {
    const err = e as { code?: unknown; discovery?: unknown };
    const c = classify(e);
    res = { id, ok: false, error: err.discovery ? { ...c, discovery: err.discovery as never } : c };
  }
  send({ kind: 'response', res });
}

port.on('message', (e) => {
  const msg = e.data as MailToEngine | null;
  switch (msg?.kind) {
    case 'init':
      start(msg.dataDir);
      return;
    case 'accounts': {
      const list = msg.accounts;
      // Applied in order (a stop of one account must finish before the next list is applied).
      accountsChain = accountsChain
        .then(() => engine?.setAccounts(list))
        .catch((err: unknown) => {
          log('mail: applying accounts failed', { code: classify(err).code });
        });
      return;
    }
    case 'verify': {
      const input = msg.input;
      void answer(msg.id, () => (engine ? engine.verify(input) : Promise.reject(new Error('engine not initialized'))));
      return;
    }
    case 'attachment': {
      const { messageId, attachmentId } = msg;
      void answer(msg.id, () => accountsChain.then(() => (engine ? engine.attachment(messageId, attachmentId) : Promise.reject(new Error('engine not initialized')))));
      return;
    }
    case 'request': {
      const req: MailRequest = msg.req;
      // Wait for a pending account list so a call right after `accounts` sees it.
      void accountsChain.then(() => dispatch(handlers, req)).then((res) => send({ kind: 'response', res }));
      return;
    }
    default:
      return;
  }
});
