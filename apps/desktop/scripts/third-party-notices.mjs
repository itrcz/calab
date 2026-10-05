#!/usr/bin/env node
// Builds THIRD-PARTY-NOTICES.txt: every third-party package shipped with Calab, with its
// licence text. Sources:
//   1. package roots recorded by the build (scripts/bundledPackages.ts) — bundled code;
//   2. production dependencies installed next to the app (`pnpm licenses list --prod`),
//      e.g. electron-updater and the native uiohook-napi (desktop only, --with-prod).
// Usage: node scripts/third-party-notices.mjs --bundled <json>... [--with-prod] --out <file>
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const bundledFiles = [];
let out = '';
let withProd = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bundled') bundledFiles.push(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--with-prod') withProd = true;
}
if (!out) throw new Error('--out is required');

const roots = new Set();
for (const f of bundledFiles) if (existsSync(f)) for (const r of JSON.parse(readFileSync(f, 'utf8'))) roots.add(r);

if (withProd) {
  // Run pnpm through node only when npm_execpath is its JS entry (pnpm.cjs; the native @pnpm/exe binary is
  // spawned directly): on Windows there is only a
  // pnpm.cmd shim, which execFileSync cannot spawn without a shell (pnpm/action-setup v6 no longer adds pnpm.exe).
  // `--filter .`: only this app's production tree. Without it pnpm lists every workspace
  // project's prod deps (the phone host's Expo CLI brings node-forge, GPL-2.0 dual licence),
  // none of which is packaged into the desktop app.
  const pnpmArgs = ['licenses', 'list', '--json', '--prod', '--filter', '.'];
  const execPath = process.env.npm_execpath;
  const [cmd, argv] = execPath && /pnpm/i.test(execPath) && /\.c?js$/i.test(execPath)
    ? [process.execPath, [execPath, ...pnpmArgs]]
    : ['pnpm', pnpmArgs];
  const json = JSON.parse(
    execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20, shell: cmd === 'pnpm' && process.platform === 'win32' }),
  );
  // With the hoisted node-linker the reported .pnpm paths may not exist: fall back to the
  // package resolved by name from this app.
  const byName = (name) => {
    try {
      return dirname(require.resolve(`${name}/package.json`, { paths: [process.cwd()] }));
    } catch {
      for (const base of [join(process.cwd(), 'node_modules'), join(process.cwd(), '..', '..', 'node_modules')]) {
        if (existsSync(join(base, name, 'package.json'))) return join(base, name);
      }
      return null;
    }
  };
  for (const list of Object.values(json)) {
    for (const p of list) {
      const found = (p.paths ?? []).find((path) => existsSync(join(path, 'package.json'))) ?? byName(p.name);
      if (found) roots.add(found);
    }
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const pkgs = new Map();
for (const root of roots) {
  const pj = join(root, 'package.json');
  if (!existsSync(pj)) continue;
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  if (!p.name || p.name.startsWith('@calaba/')) continue; // our own workspace packages
  const key = `${p.name}@${p.version}`;
  if (pkgs.has(key)) continue;
  const license = typeof p.license === 'string' ? p.license : (p.license?.type ?? (p.licenses ?? []).map((l) => l.type).join(' OR ')) || 'UNKNOWN';
  const files = readdirSync(root).filter((f) => LICENSE_FILE.test(f)).sort();
  const texts = files.map((f) => readFileSync(join(root, f), 'utf8').trim());
  const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  pkgs.set(key, { name: p.name, version: p.version, license, url: p.homepage ?? repo ?? '', texts });
}

// Bundled sources under another licence than the package declares (checked by hand).
const EMBEDDED = {
  'uiohook-napi': `Includes libuiohook (Copyright (C) 2006-2023 Alexander Barker), licensed under the
GNU Lesser General Public License v3.0 or later (https://www.gnu.org/licenses/lgpl-3.0.txt).
libuiohook (LGPL-3.0) собран в нативный модуль uiohook-napi; исходный код Calab и патч
(patches/uiohook-napi@1.5.5.patch) доступны, что позволяет пересборку и перелинковку
(LGPL §4). libuiohook source: https://github.com/kwhat/libuiohook`,
};
// Packages without a licence file of their own: the text from our copy (checked by hand).
// fileURLToPath, not URL.pathname: on Windows the pathname is /D:/… and path.join makes D:\\D:\\…
const here = dirname(fileURLToPath(import.meta.url));
const MEDIAPIPE_LICENSE = join(here, '..', 'resources', 'mediapipe', 'LICENSE');
const LICENSE_TEXT = { '@mediapipe/tasks-vision': MEDIAPIPE_LICENSE };
for (const p of pkgs.values()) {
  if (!p.texts.length && LICENSE_TEXT[p.name]) p.texts.push(readFileSync(LICENSE_TEXT[p.name], 'utf8').trim());
}

// Non-npm components shipped with every build (desktop and web): the camera background models
// (ADR-0035: selfie_multiclass_256x256 and selfie_segmenter_landscape, resources/mediapipe/SOURCE.txt).
const MODEL_SOURCE = join(here, '..', 'resources', 'mediapipe', 'SOURCE.txt');
if (existsSync(MODEL_SOURCE)) {
  pkgs.set('mediapipe-image-segmenter-models', {
    name: 'MediaPipe Image Segmenter models (Selfie Multiclass 256x256, Selfie Segmenter landscape)',
    version: 'multiclass float32, landscape float16',
    license: 'Apache-2.0',
    url: 'https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter',
    texts: [readFileSync(MODEL_SOURCE, 'utf8').trim(), readFileSync(MEDIAPIPE_LICENSE, 'utf8').trim()],
  });
}

// Bundled emoji fallback font (#44): OFL font build + CC-BY 4.0 Twemoji artwork (attribution).
const FONT_DIR = join(here, '..', 'src', 'renderer', 'assets', 'fonts');
if (existsSync(join(FONT_DIR, 'LICENSE.txt'))) {
  pkgs.set('twemoji-colr-font', {
    name: 'Twemoji COLR font',
    version: '15.0.3',
    license: 'OFL-1.1 (font), CC-BY-4.0 (Twemoji artwork, Copyright 2020 Twitter, Inc and other contributors)',
    url: 'https://github.com/mrdrogdrog/twemoji-color-font',
    texts: [readFileSync(join(FONT_DIR, 'SOURCE.txt'), 'utf8').trim(), readFileSync(join(FONT_DIR, 'LICENSE.txt'), 'utf8').trim()],
  });
}

for (const p of pkgs.values()) {
  const extra = EMBEDDED[p.name];
  if (extra) {
    p.license = `${p.license} (bundles libuiohook: LGPL-3.0-or-later)`;
    p.texts.unshift(extra);
  }
}

// Licence audit: no copyleft that would bind the product (GPL/AGPL/SSPL/EUPL); LGPL only
// where listed above (dynamic/relinkable use). Fails the build.
const FORBIDDEN = /\b(A?GPL|SSPL|EUPL)(?![-\w]*LGPL)/i;
const bad = [...pkgs.values()].filter((p) => FORBIDDEN.test(p.license.replace(/LGPL[-\w.]*/gi, '')));
if (bad.length) {
  console.error(`licence audit failed: ${bad.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`);
  process.exit(1);
}

const sorted = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const bar = '='.repeat(78);
let text = `Calab — third-party software notices

Calab is licensed under the Business Source License 1.1 (see LICENSE, NOTICE and
COMMERCIAL-LICENSE.md).
It includes the following third-party components, each under its own licence.
The desktop app also ships Electron and Chromium; their licences are in the app
bundle (LICENSE.electron.txt, LICENSES.chromium.html).

Components: ${sorted.length}
`;
for (const p of sorted) {
  text += `\n${bar}\n${p.name} ${p.version}\nLicense: ${p.license}${p.url ? `\n${p.url}` : ''}\n${bar}\n\n`;
  text += p.texts.length ? p.texts.join('\n\n---\n\n') + '\n' : `(No licence file in the package; licence: ${p.license}.)\n`;
}
// Full texts required by the LGPL (it incorporates the GPL) for the embedded libuiohook.
if (sorted.some((p) => EMBEDDED[p.name])) {
  for (const f of ['lgpl-3.0.txt', 'gpl-3.0.txt']) {
    text += `\n${bar}\n${f === 'lgpl-3.0.txt' ? 'GNU Lesser General Public License v3.0' : 'GNU General Public License v3.0 (incorporated by the LGPL)'}\n${bar}\n\n`;
    text += readFileSync(join(here, '..', 'build', 'licenses', f), 'utf8');
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(`third-party notices: ${sorted.length} packages → ${out}`);
