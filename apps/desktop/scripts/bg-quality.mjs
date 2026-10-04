#!/usr/bin/env node
/**
 * Camera background edge quality and cost, 2.0 (landscape) vs 2.1 (multiclass) (ADR-0035 addendum
 * 2.1): the app's processor (e2e-media/bgProbePage.ts `shoot`) over still pictures of people as a
 * 15 fps camera in Chromium on the GPU; one PNG of the processed 1280×720 output per picture,
 * variant and kind, plus the worker's stats and, with --bench, the browser's CPU.
 *
 *   node scripts/bg-quality.mjs --out <dir> [--picture a.jpg,b.jpg] [--sway 24] [--bench 20] [--kinds image,blur-strong]
 *
 * Default pictures: the team webcam frames in e2e-marketing/photos (curly hair, glasses + headset,
 * grey hair). CPU numbers are relative to the same machine only (docs/14 «Фон камеры»).
 */
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

/** CPU seconds used so far by Playwright's Chromium processes (macOS / Linux `ps`). */
function browserCpu() {
  let sum = 0;
  for (const line of execFileSync('ps', ['-A', '-o', 'time=,command=']).toString().split('\n')) {
    if (!line.includes('ms-playwright')) continue;
    const t = line.trim().split(/\s+/)[0] ?? '';
    const parts = t.split(/[:-]/).map(Number);
    sum += parts.reduce((acc, x) => acc * 60 + x, 0);
  }
  return sum;
}

const HERE = fileURLToPath(new URL('../e2e-media/', import.meta.url));
const PHOTOS = fileURLToPath(new URL('../e2e-marketing/photos/', import.meta.url));
const arg = (k, d = '') => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const pictures = arg('--picture', ['anna-camera.jpg', 'grigory-camera.jpg', 'dina-avatar.jpg', 'vera-avatar.jpg'].map((f) => join(PHOTOS, f)).join(',')).split(',');
const outDir = arg('--out');
const sway = Number(arg('--sway', '0'));
const only = arg('--only');
const kinds = arg('--kinds', 'image,blur-strong').split(',');
// --bench <s>: also the browser's CPU (% of one core) over <s> seconds per variant, after a 4 s warm-up.
const bench = Number(arg('--bench', '0'));
if (!outDir) throw new Error('--out is required');
mkdirSync(outDir, { recursive: true });

const VARIANTS = {
  // 2.0: landscape 256×144, smoothstep(0.3, 0.7), 8/s on the GPU.
  landscape: { model: 'landscape' },
  // 2.1 (as shipped): multiclass 256×256, person = 1 − background, smoothstep(0.5, 0.85), 8/s.
  multiclass: {},
  // No processor at all: the CPU baseline (bench only).
  ...(bench ? { none: null } : {}),
};

const work = mkdtempSync(join(tmpdir(), 'calab-bg-quality-'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webp': 'image/webp', '.tflite': 'application/octet-stream', '.json': 'application/json' };
try {
  await build({ root: HERE, base: './', logLevel: 'warn', configFile: false, worker: { format: 'es' }, build: { outDir: work, emptyOutDir: true, target: 'es2022', rollupOptions: { input: join(HERE, 'bgProbe.html') } } });
  const server = createServer((req, res) => {
    const path = normalize(join(work, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')));
    if (!path.startsWith(work) || !existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text().slice(0, 200)}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/bgProbe.html`);
  await page.waitForFunction(() => '__probe' in globalThis);
  console.log('env', JSON.stringify(await page.evaluate(() => globalThis.__probe.env())));
  const summary = {};
  for (const file of pictures) {
    const name = basename(file).replace(/\.[^.]+$/, '');
    const pic = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
    for (const [variant, tune] of Object.entries(VARIANTS)) {
      if (only && !only.split(',').includes(variant)) continue;
      for (const kind of tune === null ? ['none'] : kinds) {
        const settle = bench ? (bench + 5) * 1000 : 7000;
        const pending = page.evaluate(([k, p, t, s, ms]) => globalThis.__probe.shoot(k, p, t, s, ms), [kind, pic, tune ?? {}, sway, settle]);
        let cpu = null;
        if (bench) {
          await new Promise((r) => setTimeout(r, 4000));
          const c0 = browserCpu();
          const t0 = Date.now();
          await new Promise((r) => setTimeout(r, bench * 1000));
          cpu = Math.round(((browserCpu() - c0) / ((Date.now() - t0) / 1000)) * 1000) / 10;
        }
        const r = await pending;
        writeFileSync(join(outDir, `bg-${name}-${variant}-${kind}.png`), Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
        summary[`${name} ${variant} ${kind}`] = { cpu, stats: r.stats, last: r.states.at(-1) };
        console.log(name, variant, kind, `cpu ${cpu ?? '-'} %`, JSON.stringify(r.stats), JSON.stringify(r.states.at(-1)));
      }
    }
  }
  writeFileSync(join(outDir, 'bg-quality.json'), JSON.stringify(summary, null, 2));
  await browser.close();
  server.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
