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
  // Run pnpm through node when we were started by pnpm (npm_execpath = pnpm.cjs): on Windows there is only a
  // pnpm.cmd shim, which execFileSync cannot spawn without a shell (pnpm/action-setup v6 no longer adds pnpm.exe).
  const pnpmArgs = ['licenses', 'list', '--json', '--prod'];
  const execPath = process.env.npm_execpath;
  const [cmd, argv] = execPath && /pnpm/i.test(execPath) && !/\.(cmd|exe)$/i.test(execPath)
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
  const here = dirname(new URL(import.meta.url).pathname);
  for (const f of ['lgpl-3.0.txt', 'gpl-3.0.txt']) {
    text += `\n${bar}\n${f === 'lgpl-3.0.txt' ? 'GNU Lesser General Public License v3.0' : 'GNU General Public License v3.0 (incorporated by the LGPL)'}\n${bar}\n\n`;
    text += readFileSync(join(here, '..', 'build', 'licenses', f), 'utf8');
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(`third-party notices: ${sorted.length} packages → ${out}`);
