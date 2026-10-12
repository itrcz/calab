#!/usr/bin/env node
/* global window -- page.evaluate callbacks run in the app renderer */
/**
 * win-smoke.yml helper (TESTING.md «Windows smoke»): the auto-update path on an INSTALLED build.
 * Launches it (default userData, as a user), adds the fake-server mail account when the build has
 * mail (so the engine runs during the update), waits until electron-updater has downloaded the
 * newer release from the real feed, then quits the app the way «Выход» does (app.quit → install on
 * quit). The workflow then checks which version ended up installed and launches it.
 *
 *   node scripts/win-smoke-update.mjs <path to Calab.exe> <out dir>
 *
 * Needs the desktop devDependencies installed (@playwright/test). Test only.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron } = require('@playwright/test');

const [exe, out] = process.argv.slice(2);
const report = (line) => {
  console.log(line);
  appendFileSync(join(out, 'summary.txt'), `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mainLog = join(process.env.APPDATA ?? '', 'Calaba', 'logs', 'main.log');

const app = await _electron.launch({ executablePath: exe, args: [], timeout: 60_000 });
app.process().on('exit', (code, signal) => report(`update: old main exited code=${code} signal=${signal}`));
const page = await app.firstWindow({ timeout: 60_000 });
await sleep(5000);
const added = await page
  .evaluate(() =>
    window.calaba.mail
      ? window.calaba.mail.request({
          method: 'accounts.add',
          params: [{ email: 'alice@example.test', password: 'secret', name: 'Alice', settings: { imap: { host: '127.0.0.1', port: 3993, security: 'tls' }, smtp: { host: '127.0.0.1', port: 3465, security: 'tls' }, login: 'alice@example.test' } }],
        })
      : 'no mail in this build',
  )
  .catch((e) => String(e));
report(`update: mail account -> ${JSON.stringify(added).slice(0, 200)}`);

let downloaded = false;
for (let i = 0; i < 90 && !downloaded; i++) {
  await sleep(2000);
  downloaded = existsSync(mainLog) && readFileSync(mainLog, 'utf8').includes('[update] downloaded');
}
report(`update: downloaded=${downloaded}`);
await sleep(5000);
// What «Выход» does: app.quit(); electron-updater installs the pending update on quit.
await app.evaluate(({ app: a }) => a.quit()).catch((e) => report(`update: quit threw ${String(e).slice(0, 200)}`));
await sleep(5000);
process.exit(0);
