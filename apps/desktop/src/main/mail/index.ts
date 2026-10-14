import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage, utilityProcess } from 'electron';
import { IPC } from '../../shared/ipc';
import type { MailAccount, MailEngineAccount, MailEvent, MailReply, MailServerSettings, MailVerified } from '../../shared/mail';
import { log } from '../logging';
import { isOwnPage } from '../windows';
import { MailAccountsFile, serverSettings } from './accounts';
import { handleMailScheme } from './attachmentProtocol';
import { MailRouter, parseCall, type EngineChild } from './router';

export { installMailGuards } from './frameGuard';

// out/main/mailEngine.js: the second input of the main build (electron.vite.config.ts), next to
// index.js both in dev (electron-vite builds main into out/ too) and inside app.asar.
const ENGINE = join(fileURLToPath(new URL('.', import.meta.url)), 'mailEngine.js');

function dataDir(): string {
  return join(app.getPath('userData'), 'mail');
}

function fork(): EngineChild {
  if (!app.isReady()) throw new Error('utilityProcess before app ready');
  // stdout and stderr piped. stdout must NOT be 'inherit': a Windows GUI launch (Start menu /
  // shortcut) has no console, and Chromium's child launcher CHECK-fails on the missing stdout
  // handle (base/process/launch_win.cc) and kills main right after the fork (0x80000003) —
  // 3.1.1..3.2.0 crashed exactly there whenever a mail account existed. stderr is piped too: the
  // router keeps its last lines and logs them when the engine exits (§2).
  const child = utilityProcess.fork(ENGINE, [], { serviceName: 'Calab Mail', stdio: ['ignore', 'pipe', 'pipe'] });
  // Dev: the engine's warnings still reach the terminal. Packaged: every engine line goes to
  // main.log (3.1.3 — a live engine was invisible there, only its exit was logged). The engine never
  // writes secrets to stderr (engine.ts `log`). Capped so a chatty engine cannot flood the log.
  if (!app.isPackaged) {
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  } else {
    child.stdout?.on('data', engineLines());
    child.stderr?.on('data', engineLines());
  }
  return child;
}

/** At most this many engine lines per minute reach main.log (CALABA_MAIL_DEBUG=1 raises it). */
const ENGINE_LOG_PER_MIN = process.env['CALABA_MAIL_DEBUG'] === '1' ? 5000 : 200;

/** Splits the engine's stderr into lines for electron-log, rate-capped per minute. */
function engineLines(): (d: Buffer) => void {
  let rest = '';
  let windowStart = Date.now();
  let count = 0;
  let dropped = 0;
  return (d) => {
    rest += d.toString('utf8');
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trimEnd();
      if (!line) continue;
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        if (dropped) log.warn('mail engine: lines dropped', { count: dropped });
        windowStart = now;
        count = 0;
        dropped = 0;
      }
      if (++count > ENGINE_LOG_PER_MIN) {
        dropped++;
        continue;
      }
      log.info(`mail engine: ${line.slice(0, 1000)}`);
    }
  };
}

function broadcast(event: MailEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    // A window closing / its renderer gone mid-loop must not throw into the engine's message handler.
    try {
      if (w.isDestroyed() || w.webContents.isDestroyed() || !isOwnPage(w.webContents.getURL())) continue;
      w.webContents.send(IPC.mailEvent, event);
    } catch (e) {
      log.warn('mail: event not delivered', { error: String(e) });
    }
  }
}

let accountsFile: MailAccountsFile | null = null;

function accounts(): MailAccountsFile {
  accountsFile ??= new MailAccountsFile(
    join(dataDir(), 'accounts.bin'),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
    (m) => log.warn(m),
  );
  return accountsFile;
}

let router: MailRouter | null = null;

function getRouter(): MailRouter {
  router ??= new MailRouter({
    fork,
    broadcast,
    log: (m, meta, level) => (level === 'info' ? log.info(m, meta ?? {}) : log.warn(m, meta ?? {})),
    // Every fresh engine first learns where its data is and which accounts exist (with passwords).
    onSpawn: (post) => {
      post({ kind: 'init', dataDir: dataDir() });
      post({ kind: 'accounts', accounts: accounts().all() });
    },
  });
  return router;
}

function pushAccounts(): void {
  const r = getRouter();
  if (!r.post({ kind: 'accounts', accounts: accounts().all() })) r.start();
}

// ---------------------------------------------------------------- account calls handled in main

const fail = (code: 'INVALID' | 'NOT_FOUND', message: string): MailReply => ({ ok: false, error: { code, message } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Host / port / security and an optional certificate pin (§4); anything else is dropped. */
const server = (v: unknown): MailServerSettings | null => serverSettings(v);

/** Settings without the pins: what decides whether a change needs a login check. */
const unpinned = (s: MailServerSettings): MailServerSettings => ({ host: s.host, port: s.port, security: s.security });

/** The account as the renderer sees it (state from the engine; never the password). */
async function accountReply(id: string): Promise<MailReply> {
  const r = await getRouter().request({ method: 'accounts.list', params: [] });
  if (!r.ok) return r;
  const acc = (r.result as MailAccount[]).find((a) => a.id === id);
  return acc ? { ok: true, result: acc } : fail('NOT_FOUND', 'account not found');
}

async function verify(input: { email: string; password: string; settings?: { imap: MailServerSettings; smtp: MailServerSettings; login: string } }): Promise<MailReply> {
  // Deadline `verify` (60 s, MAIL_METHOD_TIMEOUT_MS): discovery ≤ 10 s + IMAP and SMTP logins.
  return await getRouter().internal({ kind: 'verify', input });
}

const adding = new Set<string>();

async function addAccount(input: unknown): Promise<MailReply> {
  if (!isObj(input) || typeof input['email'] !== 'string' || typeof input['password'] !== 'string' || input['password'].length > 1024) return fail('INVALID', 'bad account input');
  const email = input['email'].trim().toLowerCase();
  const password = input['password'];
  const name = typeof input['name'] === 'string' ? input['name'].trim().slice(0, 200) : '';
  let settings: { imap: MailServerSettings; smtp: MailServerSettings; login: string } | undefined;
  if (input['settings'] !== undefined) {
    const s = input['settings'];
    const imap = isObj(s) ? server(s['imap']) : null;
    const smtp = isObj(s) ? server(s['smtp']) : null;
    if (!isObj(s) || !imap || !smtp || typeof s['login'] !== 'string') return fail('INVALID', 'bad server settings');
    settings = { imap, smtp, login: s['login'].trim() };
  }
  if (accounts().byEmail(email) || adding.has(email)) return fail('INVALID', 'this address is already added');
  adding.add(email);
  try {
    const r = await verify({ email, password, ...(settings ? { settings } : {}) });
    if (!r.ok) return r;
    const v = r.result as MailVerified;
    const acc: MailEngineAccount = { id: `a${randomBytes(8).toString('hex')}`, email, name, provider: v.provider, imap: v.imap, smtp: v.smtp, login: v.login, password };
    accounts().put(acc);
    pushAccounts();
    return await accountReply(acc.id);
  } finally {
    adding.delete(email);
  }
}

async function updateAccount(id: unknown, patch: unknown): Promise<MailReply> {
  const cur = typeof id === 'string' ? accounts().get(id) : null;
  if (!cur) return fail('NOT_FOUND', 'account not found');
  if (!isObj(patch)) return fail('INVALID', 'bad patch');
  const next: MailEngineAccount = { ...cur };
  if (typeof patch['name'] === 'string') next.name = patch['name'].trim().slice(0, 200);
  const imap = patch['imap'] === undefined ? cur.imap : server(patch['imap']);
  const smtp = patch['smtp'] === undefined ? cur.smtp : server(patch['smtp']);
  const login = patch['login'] === undefined ? cur.login : typeof patch['login'] === 'string' ? patch['login'].trim() : null;
  if (!imap || !smtp || !login) return fail('INVALID', 'bad server settings');
  if (JSON.stringify([unpinned(imap), unpinned(smtp), login]) !== JSON.stringify([unpinned(cur.imap), unpinned(cur.smtp), cur.login])) {
    const r = await verify({ email: cur.email, password: cur.password, settings: { imap, smtp, login } });
    if (!r.ok) return r;
    const v = r.result as MailVerified;
    Object.assign(next, { imap: v.imap, smtp: v.smtp, login: v.login });
  } else {
    // Only a pin changed (trust a new certificate / «Сбросить»): the same servers and password, no
    // login needed; the sync reconnects with the new pin and reports how it went (§4).
    Object.assign(next, { imap, smtp });
  }
  accounts().put(next);
  pushAccounts();
  return accountReply(next.id);
}

async function setPassword(id: unknown, password: unknown): Promise<MailReply> {
  const cur = typeof id === 'string' ? accounts().get(id) : null;
  if (!cur) return fail('NOT_FOUND', 'account not found');
  if (typeof password !== 'string' || !password || password.length > 1024) return fail('INVALID', 'bad password');
  const r = await verify({ email: cur.email, password, settings: { imap: cur.imap, smtp: cur.smtp, login: cur.login } });
  if (!r.ok) return r;
  accounts().put({ ...cur, password });
  pushAccounts();
  return accountReply(cur.id);
}

function removeAccount(id: unknown): MailReply {
  if (typeof id !== 'string' || !accounts().remove(id)) return fail('NOT_FOUND', 'account not found');
  // The engine stops the sync and deletes userData/mail/<id> when it sees the new list.
  pushAccounts();
  return { ok: true, result: undefined };
}

/**
 * One renderer call (IPC `mail:request`). Account changes are handled here (passwords live in main,
 * §3); everything else goes to the engine, forked on demand.
 */
export function mailRequest(call: unknown): Promise<MailReply> {
  const c = parseCall(call);
  if (!c) return getRouter().request(call);
  const [a, b] = c.params;
  switch (c.method) {
    case 'accounts.add':
      return addAccount(a);
    case 'accounts.update':
      return updateAccount(a, b);
    case 'accounts.setPassword':
      return setPassword(a, b);
    case 'accounts.remove':
      return Promise.resolve(removeAccount(a));
    default:
      return getRouter().request(c);
  }
}

/**
 * On app ready (one hook in main/index.ts): the `calaba-mail://` handler, and the engine right away
 * when an account exists (ADR-0088 §2) — new mail notifies without opening the section.
 */
export function startMail(): void {
  // Mail is optional: whatever fails here is logged, and the app (window, tray, IPC) starts anyway.
  try {
    handleMailScheme((messageId, attachmentId) => getRouter().internal({ kind: 'attachment', messageId, attachmentId }));
  } catch (e) {
    log.error('mail: scheme handler not installed', e);
  }
  try {
    if (accounts().all().length) getRouter().start();
  } catch (e) {
    log.error('mail: engine not started', e);
  }
}

/** On quit: kill the engine without restarting it. */
export function shutdownMail(): void {
  try {
    router?.shutdown();
  } catch (e) {
    log.warn('mail: shutdown failed', { error: String(e) });
  }
}
