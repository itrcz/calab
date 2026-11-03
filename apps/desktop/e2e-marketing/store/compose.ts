import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { stripAlpha } from './png';
import { LOCALES, SCENES } from './scenes';
import { cardHtml, featureHtml, LAYOUTS } from './template';

/**
 * Builds the store assets from the raw captures (store-shots.spec.ts) with Chromium rendering the HTML
 * template (template.ts): store/ios|android/<lang>/NN-<id>.png, store/icons/*, store/feature/<lang>/*.
 * `pnpm -F @calaba/desktop screenshots:store` runs capture → compose → validate.
 */
const MOBILE = resolve(import.meta.dirname, '../../../mobile');
export const STORE = join(MOBILE, 'store');
const RAW = join(STORE, 'raw');

/** The app icon (apps/mobile/assets, docs/10-branding.md) and the feature graphic's tagline. */
const ICON = join(MOBILE, 'assets/icon-1024.png');
const TAGLINE = { ru: 'Голос и чат для команды', en: 'Voice and chat for your team' };

const png = (p: string): string => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const render = async (html: string, w: number, h: number, path: string, alpha = false): Promise<void> => {
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const buf = await page.screenshot({ type: 'png', omitBackground: alpha, clip: { x: 0, y: 0, width: w, height: h } });
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, alpha ? buf : stripAlpha(buf));
      console.log('store', path.slice(STORE.length + 1));
    };

    for (const lang of LOCALES as ('ru' | 'en')[]) {
      for (const [i, scene] of SCENES.entries()) {
        const name = `${String(i + 1).padStart(2, '0')}-${scene.id}.png`;
        const shot = png(join(RAW, lang, name));
        for (const [os, l] of Object.entries(LAYOUTS)) await render(cardHtml(l, scene.headline[lang], shot), l.w, l.h, join(STORE, os, lang, name));
      }
      await render(featureHtml(1024, 500, 'Calab', TAGLINE[lang], png(ICON)), 1024, 500, join(STORE, 'feature', lang, 'feature-graphic.png'));
    }

    // Icons: the App Store one is the 1024 artwork as is (opaque); the Play one is 512 with rounded transparent corners.
    mkdirSync(join(STORE, 'icons'), { recursive: true });
    writeFileSync(join(STORE, 'icons/icon-1024.png'), stripAlpha(readFileSync(ICON)));
    await render(
      `<!doctype html><body style="margin:0;background:transparent"><img src="${png(ICON)}" style="display:block;width:512px;height:512px;border-radius:115px"></body>`,
      512,
      512,
      join(STORE, 'icons/icon-512.png'),
      true,
    );
  } finally {
    await browser.close();
  }
}

await main();
