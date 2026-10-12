import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { app, BrowserWindow, utilityProcess } from 'electron';
import { IPC } from '../../shared/ipc';
import type { MailEvent, MailReply } from '../../shared/mail';
import { log } from '../logging';
import { isOwnPage } from '../windows';
import { MailRouter, type EngineChild } from './router';

// out/main/mailEngine.js: the second input of the main build (electron.vite.config.ts), next to
// index.js both in dev (electron-vite builds main into out/ too) and inside app.asar.
const ENGINE = join(fileURLToPath(new URL('.', import.meta.url)), 'mailEngine.js');

function fork(): EngineChild {
  if (!app.isReady()) throw new Error('utilityProcess before app ready');
  log.info('mail: starting engine');
  return utilityProcess.fork(ENGINE, [], { serviceName: 'Calab Mail' });
}

function broadcast(event: MailEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !isOwnPage(w.webContents.getURL())) continue;
    w.webContents.send(IPC.mailEvent, event);
  }
}

let router: MailRouter | null = null;

function getRouter(): MailRouter {
  router ??= new MailRouter({ fork, broadcast, log: (m, meta) => log.warn(m, meta ?? {}) });
  return router;
}

/**
 * One renderer call (IPC `mail:request`). The engine is forked lazily on the first call (ADR-0080 §2;
 * T1: also at start when an account exists).
 */
export function mailRequest(call: unknown): Promise<MailReply> {
  return getRouter().request(call);
}

/** On quit: kill the engine without restarting it. */
export function shutdownMail(): void {
  router?.shutdown();
}
