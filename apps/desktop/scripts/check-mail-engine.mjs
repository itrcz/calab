#!/usr/bin/env node
// Regression check for 3.1.0 (ADR-0088 §2): the packaged mail engine died on load because a library
// it imported was resolved from electron-builder's node_modules copy (a wrong `entities` major under
// htmlparser2). The engine's libraries are now bundled into out/main/mailEngine.js; this loads the
// built engine from a temp copy of out/main with NO node_modules anywhere above it, under Electron's
// own Node (ELECTRON_RUN_AS_NODE), so any import left external — or failing at module evaluation —
// fails the build. `process.parentPort` (utilityProcess only) is stubbed; nothing is started.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outMain = fileURLToPath(new URL('../out/main/', import.meta.url));
const electron = require('electron'); // the binary path when required from Node

const dir = mkdtempSync(join(tmpdir(), 'calab-mail-engine-'));
try {
  cpSync(outMain, join(dir, 'main'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const code = "process.parentPort = { on() {}, postMessage() {} }; await import('./main/mailEngine.js'); console.log('mail engine loaded');";
  const r = spawnSync(electron, ['--input-type=module', '-e', code], {
    cwd: dir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0 || !r.stdout.includes('mail engine loaded')) {
    console.error(`out/main/mailEngine.js does not load without node_modules (exit ${String(r.status)}${r.signal ? `, ${r.signal}` : ''}):`);
    console.error((r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n').slice(0, 20).join('\n'));
    process.exit(1);
  }
  console.log('mail engine OK: loads without node_modules');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
