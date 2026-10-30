import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from '@playwright/test';
import { fresh, shoot, withStore } from './store/harness';
import { LOCALES, SCENES } from './store/scenes';

/**
 * Raw store captures (apps/desktop/README.md «Store screenshots»): every scene of store/scenes.ts in every
 * language, the web client in WebKit on an iPhone 14 viewport at 3x (1170×2532) →
 * apps/mobile/store/raw/<lang>/NN-<id>.png (git-ignored; store/compose.ts builds the cards).
 * Needs dist-web (`pnpm build:web`).
 */
const RAW = resolve(import.meta.dirname, '../../mobile/store/raw');

/** CALABA_STORE_SCENES=tasks,calendar: only these scenes (a tweak loop). */
const only = process.env['CALABA_STORE_SCENES']?.split(',');

for (const short of LOCALES) {
  test(`store shots ${short}`, async () => {
    test.setTimeout(900_000);
    mkdirSync(join(RAW, short), { recursive: true });
    await withStore(short, async (ctx) => {
      for (const [i, scene] of SCENES.entries()) {
        if (only && !only.includes(scene.id)) continue;
        await fresh(ctx);
        await scene.run(ctx);
        await shoot(ctx.page, join(RAW, short, `${String(i + 1).padStart(2, '0')}-${scene.id}.png`));
        console.log('store', short, scene.id);
      }
    });
  });
}
