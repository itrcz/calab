#!/usr/bin/env node
/**
 * Camera background diagnostic (ADR-0035, «Windows: фон не работает»): builds bgProbe.html with
 * Vite exactly like the app bundles the processor (worker + MediaPipe WASM + model + pictures),
 * packs it into an app.asar next to a minimal main with the app's webPreferences and loads it over
 * file:// — the packaged app's situation — then (optionally) the same page over http in
 * Playwright's Chromium. Prints one JSON report per run; no LiveKit, no server.
 *
 *   node scripts/bg-probe.mjs [--out report.json] [--no-chromium]
 *   PROBE_FLAGS='--ignore-gpu-blocklist;--use-angle=swiftshader --enable-unsafe-swiftshader' node scripts/bg-probe.mjs
 *
 * PROBE_FLAGS: `;`-separated Electron flag sets, one run each ('' = defaults). Used by
 * .github/workflows/bg-probe.yml (workflow_dispatch, Windows / macOS runners).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, normalize } from 'node:path';
import { build } from 'vite';
import { _electron as electron, chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL('../e2e-media/', import.meta.url));
process.on('exit', (code) => console.log(`bg-probe exit ${code}`));
const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const withChromium = !argv.includes('--no-chromium');
const flagSets = (process.env.PROBE_FLAGS ?? '').split(';').map((s) => s.trim().split(/\s+/).filter(Boolean));
const MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'];
const KINDS = (process.env.PROBE_KINDS ?? 'blur-strong,image').split(',');

const work = mkdtempSync(join(tmpdir(), 'calab-bg-probe-'));
const asciiRoot = join(work, 'ascii');
const web = join(work, 'web');
const report = { platform: process.platform, arch: process.arch, runs: [] };

const MAIN = `
const { app, BrowserWindow } = require('electron');
const { join } = require('path');
app.whenReady().then(async () => {
  const gpu = await app.getGPUInfo('basic').catch((e) => String(e));
  console.log('PROBE_GPU ' + JSON.stringify({ features: app.getGPUFeatureStatus(), gpu }));
  const win = new BrowserWindow({
    width: 800, height: 600, show: true,
    // The app's webPreferences (src/main/windows.ts) without the preload.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
  await win.loadFile(join(__dirname, 'web', 'bgProbe.html'));
  // Self-driven (no Playwright, which cannot attach to every layout): run and write the report.
  const out = process.env.PROBE_SELF_OUT;
  if (!out) return;
  const res = { label: 'electron packaged (self-driven)', url: win.webContents.getURL(), gpu, kinds: [] };
  try {
    res.env = await win.webContents.executeJavaScript('new Promise((r) => { const t = setInterval(() => { if (globalThis.__probe) { clearInterval(t); r(globalThis.__probe.env()); } }, 100); })');
    for (const k of ['image', 'blur-strong']) res.kinds.push(await win.webContents.executeJavaScript('globalThis.__probe.run(' + JSON.stringify(k) + ')'));
    res.kinds.push(await win.webContents.executeJavaScript('globalThis.__probe.run("blur-strong", 30000, { model: "multiclass" })'));
  } catch (e) {
    res.error = String(e);
  }
  require('fs').writeFileSync(out, JSON.stringify(res));
  app.quit();
});
`;

async function buildPage() {
  await build({
    root: HERE,
    base: './',
    logLevel: 'warn',
    configFile: false,
    worker: { format: 'es' },
    build: { outDir: web, emptyOutDir: true, minify: true, target: 'es2022', rollupOptions: { input: join(HERE, 'bgProbe.html') } },
  });
}

async function probePage(page, label, extra = {}) {
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
  page.on('worker', (w) => logs.push(`[worker] ${w.url().split('/').pop()}`));
  await page.waitForFunction(() => '__probe' in globalThis, null, { timeout: 30_000 });
  const run = { label, ...extra, env: await page.evaluate(() => globalThis.__probe.env()), kinds: [] };
  // Every kind as shipped (multiclass on a hardware GL, landscape on software GL), then blur with
  // multiclass forced (the 16 MB model from app.asar even on WARP / SwiftShader), then blur with
  // the GPU delegate forced to fail (the CPU fallback, landscape).
  const cases = [...KINDS.map((k) => [k, null]), ['blur-strong', { model: 'multiclass' }], ['blur-strong', { failGpu: true }]];
  for (const [kind, tune] of cases) {
    try {
      run.kinds.push(await page.evaluate(([k, t]) => globalThis.__probe.run(k, 30_000, t), [kind, tune]));
    } catch (err) {
      run.kinds.push({ kind, tune, error: String(err).slice(0, 600) });
    }
  }
  run.logs = logs;
  report.runs.push(run);
  console.log(JSON.stringify(run, null, 2));
}

/**
 * `packaged`: the installed layout — a copy of Electron with our app.asar in its resources, under
 * a non-ASCII path with a space like a Windows profile «C:\\Users\\Иван Петров\\…» (Windows only:
 * the macOS bundle cannot be copied as is); otherwise `electron app.asar` from an ASCII path.
 */
async function probeElectron(flags, packaged = '') {
  const appRoot = packaged ? join(work, packaged) : asciiRoot;
  const app = join(work, 'app-src');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'calab-bg-probe', version: '0.0.0', main: 'main.cjs' }));
  writeFileSync(join(app, 'main.cjs'), MAIN);
  cpSync(web, join(app, 'web'), { recursive: true });
  const asar = require('@electron/asar');
  let exe = require('electron');
  let packed = join(appRoot, 'app.asar');
  if (packaged) {
    cpSync(dirname(exe), appRoot, { recursive: true });
    exe = join(appRoot, basename(exe));
    packed = join(appRoot, 'resources', 'app.asar');
    rmSync(join(appRoot, 'resources', 'default_app.asar'), { force: true });
  }
  mkdirSync(dirname(packed), { recursive: true });
  rmSync(packed, { force: true });
  await asar.createPackage(app, packed);
  const mainLogs = [];
  if (packaged) {
    const out = join(work, 'self.json');
    rmSync(out, { force: true });
    const child = spawn(exe, [...MEDIA, ...flags], { env: { ...process.env, PROBE_SELF_OUT: out }, stdio: 'ignore' });
    const code = await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill();
        r('timeout');
      }, 120_000);
      child.on('exit', (c) => {
        clearTimeout(t);
        r(c);
      });
      child.on('error', (e) => r(String(e)));
    });
    const res = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { label: 'electron packaged (self-driven)', error: `no report, exit ${code}` };
    res.path = appRoot;
    report.runs.push(res);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const eapp = await electron.launch({ executablePath: exe, args: [...MEDIA, ...flags, packed], timeout: 60_000 });
  eapp.on('console', (m) => mainLogs.push(m.text()));
  mainLogs.push(JSON.stringify(await eapp.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), gpu: await app.getGPUInfo('basic').catch((e) => String(e)) }))));
  try {
    const page = await eapp.firstWindow();
    await probePage(page, `electron file:// asar${packaged ? ' packaged, non-ASCII path' : ''} ${flags.join(' ') || '(default flags)'}`, { electron: await eapp.evaluate(() => process.versions.electron), mainLogs });
  } finally {
    await eapp.close().catch(() => undefined);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webp': 'image/webp', '.tflite': 'application/octet-stream', '.json': 'application/json' };

async function probeChromium() {
  const server = createServer((req, res) => {
    const path = normalize(join(web, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')));
    if (!path.startsWith(web) || !existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ args: MEDIA });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/bgProbe.html`);
    await probePage(page, 'chromium http', { chromium: browser.version() });
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  await buildPage();
  for (const flags of flagSets) {
    try {
      await probeElectron(flags);
    } catch (err) {
      report.runs.push({ label: `electron ${flags.join(' ')}`, error: String(err).slice(0, 1000) });
      console.log(`electron run failed: ${String(err)}`);
    }
  }
  if (process.platform === 'win32') {
    // A non-ASCII copy («Иван Петров\\Calab») could not be spawned on the runner (ENOENT): ASCII only.
    for (const dir of ['Calab']) {
      try {
        await probeElectron([], dir);
      } catch (err) {
        report.runs.push({ label: `electron packaged ${dir}`, error: String(err).slice(0, 1000) });
      }
    }
  }
  if (withChromium) {
    try {
      await probeChromium();
    } catch (err) {
      report.runs.push({ label: 'chromium http', error: String(err).slice(0, 1000) });
    }
  }
} finally {
  if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));
  rmSync(work, { recursive: true, force: true });
}
