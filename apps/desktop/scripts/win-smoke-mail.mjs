#!/usr/bin/env node
/* global window -- page.evaluate callbacks run in the app renderer */
/**
 * win-smoke.yml helper (TESTING.md «Windows smoke»): drives an INSTALLED Calab build through the mail
 * engine without a Calab login — the IPC `mail:request` works on the login screen. Adds the
 * mail-fake-server.mjs account (IMAPS 3993 / SMTPS 3465), lets the first sync run, sends a message,
 * lists folders / messages, and reports whether the app and the engine are still alive.
 *
 *   node scripts/win-smoke-mail.mjs <path to Calab.exe> <userData dir> <out dir>
 *
 * Needs the desktop devDependencies installed (@playwright/test) and NODE_EXTRA_CA_CERTS pointing to the
 * fake server's CA (inherited by the app and its engine). Test only.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron } = require('@playwright/test');

const [exe, userData, out] = process.argv.slice(2);
if (!exe || !userData || !out) {
  console.error('usage: win-smoke-mail.mjs <exe> <userData> <out>');
  process.exit(2);
}
const report = (line) => {
  console.log(line);
  appendFileSync(join(out, 'summary.txt'), `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({
  executablePath: exe,
  args: ['--enable-logging', '--v=0'],
  env: { ...process.env, CALABA_USER_DATA: userData },
  timeout: 60_000,
});
let mainGone = null;
app.process().on('exit', (code, signal) => {
  mainGone = `code=${code} signal=${signal}`;
  report(`mail: MAIN PROCESS EXITED ${mainGone}`);
});
app.process().stderr?.on('data', (d) => appendFileSync(join(out, 'mail-app-stderr.txt'), d));

const page = await app.firstWindow({ timeout: 60_000 });
page.on('crash', () => report('mail: RENDERER CRASHED'));
page.on('console', (m) => appendFileSync(join(out, 'mail-console.txt'), `[${m.type()}] ${m.text()}\n`));
await page.waitForLoadState('domcontentloaded');
await sleep(5000);

const call = async (method, params = [], label = method) => {
  if (mainGone) return null;
  try {
    const r = await page.evaluate(([m, p]) => window.calaba.mail.request({ method: m, params: p }), [method, params]);
    report(`mail: ${label} -> ${JSON.stringify(r).slice(0, 600)}`);
    return r;
  } catch (e) {
    report(`mail: ${label} THREW ${String(e).slice(0, 600)}`);
    return null;
  }
};

const server = { imap: { host: '127.0.0.1', port: 3993, security: 'tls' }, smtp: { host: '127.0.0.1', port: 3465, security: 'tls' }, login: 'alice@example.test' };
await call('accounts.list');
const added = await call('accounts.add', [{ email: 'alice@example.test', password: 'secret', name: 'Alice', settings: server }]);
const accountId = added?.ok ? added.result.id : null;
await sleep(20_000); // first sync
const folders = accountId ? await call('folders.list', [accountId]) : null;
if (folders?.ok) await call('messages.list', [{ scope: accountId, folder: 'inbox', limit: 50 }], 'messages.list(inbox)');
await call('accounts.list', [], 'accounts.list (after sync)');

// A restart of the app with the account present: the engine is forked at startup (startMail).
if (!mainGone) {
  await app.close().catch(() => {});
  await sleep(3000);
  const again = await _electron.launch({
    executablePath: exe,
    args: ['--enable-logging', '--v=0'],
    env: { ...process.env, CALABA_USER_DATA: userData },
    timeout: 60_000,
  });
  let gone = null;
  again.process().on('exit', (code, signal) => {
    gone = `code=${code} signal=${signal}`;
    report(`mail: MAIN PROCESS EXITED after restart ${gone}`);
  });
  const p2 = await again.firstWindow({ timeout: 60_000 }).catch(() => null);
  p2?.on('crash', () => report('mail: RENDERER CRASHED after restart'));
  await sleep(30_000);
  if (p2 && !gone) {
    const r = await p2.evaluate(() => window.calaba.mail.request({ method: 'accounts.list', params: [] })).catch((e) => String(e));
    report(`mail: after restart accounts.list -> ${JSON.stringify(r).slice(0, 600)}`);
  }
  report(`mail: after restart main alive=${!gone}`);
  await again.close().catch(() => {});
}
report(`mail: done, main alive=${!mainGone}`);
process.exit(0);
