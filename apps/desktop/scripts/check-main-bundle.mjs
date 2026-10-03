// Guard for the Electron main bundle: dependencies must stay external. 2.2.0 shipped a main bundle where
// the bundler inlined the `electron` npm package (its index.js spawns `process.execPath install.js`), so
// every launch of the packaged app started another instance. Fails the build on that or on a bloated bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../out/main/', import.meta.url).pathname;
const MAX_BYTES = 700 * 1024; // 2.1.0: ~416 KB; the broken 2.2.0: ~1.1 MB
const forbidden = ['Electron failed to install correctly', 'ELECTRON_OVERRIDE_DIST_PATH'];
let bad = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  const p = join(dir, f);
  const src = readFileSync(p, 'utf8');
  for (const w of forbidden) {
    if (src.includes(w)) {
      console.error(`out/main/${f}: contains "${w}" — the electron npm package was bundled into main`);
      bad++;
    }
  }
  const size = statSync(p).size;
  if (size > MAX_BYTES) {
    console.error(`out/main/${f}: ${Math.round(size / 1024)} KB > ${MAX_BYTES / 1024} KB — dependencies are no longer external`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log('main bundle OK: dependencies external');
