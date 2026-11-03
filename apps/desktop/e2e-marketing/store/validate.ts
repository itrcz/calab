import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasAlpha, pngInfo } from './png';
import { LOCALES, SCENES } from './scenes';
import { LAYOUTS } from './template';

/**
 * Required sizes (the store's own, not derived from the template): App Store 6.9" 1320×2868 and 6.5" 1284×2778,
 * Google Play phone 1080×1920.
 */
const REQUIRED = {
  'ios-6.9': [1320, 2868],
  'ios-6.5': [1284, 2778],
  android: [1080, 1920],
} as const;

/** Checks every store asset: exact size, alpha where it is forbidden / required, ≤ 1 MB for the 512 icon. Exits 1 with the list of problems. */
const STORE = resolve(import.meta.dirname, '../../../mobile/store');

interface Spec {
  path: string;
  w: number;
  h: number;
  alpha: boolean;
  maxBytes?: number;
}

const specs: Spec[] = [];
for (const lang of LOCALES) {
  SCENES.forEach((s, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${s.id}.png`;
    for (const [dir, l] of Object.entries(LAYOUTS))
      specs.push({
        path: `${dir}/${lang}/${name}`,
        w: l.w,
        h: l.h,
        alpha: false,
      });
  });
  specs.push({
    path: `feature/${lang}/feature-graphic.png`,
    w: 1024,
    h: 500,
    alpha: false,
  });
}
specs.push({ path: 'icons/icon-1024.png', w: 1024, h: 1024, alpha: false });
specs.push({
  path: 'icons/icon-512.png',
  w: 512,
  h: 512,
  alpha: true,
  maxBytes: 1024 * 1024,
});

const problems: string[] = [];
for (const [dir, [w, h]] of Object.entries(REQUIRED)) {
  const l = LAYOUTS[dir as keyof typeof LAYOUTS];
  if (l.w !== w || l.h !== h) problems.push(`template ${dir}: ${l.w}×${l.h}, store requires ${w}×${h}`);
}
for (const s of specs) {
  try {
    const file = join(STORE, s.path);
    const info = pngInfo(readFileSync(file));
    if (info.width !== s.w || info.height !== s.h) problems.push(`${s.path}: ${info.width}×${info.height}, expected ${s.w}×${s.h}`);
    if (!s.alpha && hasAlpha(info)) problems.push(`${s.path}: has an alpha channel, none allowed`);
    if (s.alpha && !hasAlpha(info)) problems.push(`${s.path}: no alpha channel, expected one`);
    if (s.maxBytes && statSync(file).size > s.maxBytes) problems.push(`${s.path}: ${statSync(file).size} bytes, max ${s.maxBytes}`);
  } catch (e) {
    problems.push(`${s.path}: ${(e as Error).message}`);
  }
}
if (problems.length > 0) {
  console.error(`store assets: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`store assets OK: ${specs.length} files checked`);
