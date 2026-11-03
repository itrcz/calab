import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from '@playwright/test';
import { fresh, shoot, withStore, type Platform } from './store/harness';
import { LOCALES, SCENES } from './store/scenes';

/**
 * Raw store captures (apps/desktop/README.md «Store screenshots»): every scene of store/scenes.ts in every
 * language, the web client in WebKit on an iPhone 14 viewport at 3x (1170×2532) →
 * apps/mobile/store/raw/<ios|android>/<lang>/NN-<id>.png (git-ignored; store/compose.ts builds the cards).
 * Needs dist-web (`pnpm build:web`).
 */
const RAW = resolve(import.meta.dirname, '../../mobile/store/raw');
const PLATFORMS: Platform[] = ['ios', 'android'];

/** CALABA_STORE_SCENES=tasks,calendar: only these scenes (a tweak loop). */
const only = process.env['CALABA_STORE_SCENES']?.split(',');

for (const platform of PLATFORMS) {
  for (const short of LOCALES) {
    test(`store shots ${platform} ${short}`, async () => {
      test.setTimeout(900_000);
      mkdirSync(join(RAW, platform, short), { recursive: true });
      // A scene that joins a call (`live`) gets its own browser and mock: the app would rejoin it on every later reload.
      for (const group of [SCENES.filter((x) => !x.live), SCENES.filter((x) => x.live)]) {
        const todo = group.filter((x) => !only || only.includes(x.id));
        if (todo.length === 0) continue;
        await withStore(short, platform, async (ctx) => {
          for (const scene of todo) {
            await fresh(ctx);
            await scene.run(ctx);
            await shoot(ctx.page, join(RAW, platform, short, `${String(SCENES.indexOf(scene) + 1).padStart(2, '0')}-${scene.id}.png`));
            console.log('store', platform, short, scene.id);
          }
        });
      }
    });
  }
}
