import type { Browser } from '@playwright/test';
import type { Copy } from './copy';

/**
 * Pictures for the landing scenes drawn by Chromium from HTML/SVG (deterministic): the screen-share
 * slide and the design mockup posted in the chat. People (avatars, camera frames)
 * are real photos (photos.ts), stickers the built-in Calab ones (seed.ts).
 */

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif`;

export async function render(browser: Browser, html: string, width: number, height: number, opts: { transparent?: boolean; scale?: number } = {}): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: opts.scale ?? 1 });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;${opts.transparent ? 'background:transparent;' : ''}font-family:${FONT};-webkit-font-smoothing:antialiased}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    return await page.screenshot({ type: 'png', omitBackground: opts.transparent === true });
  } finally {
    await page.close();
  }
}

/** The release slide Вера shares (1280×720). */
export function slideHtml(c: Copy): string {
  const items = c.slide.items
    .map(
      (t, i) => `<li style="display:flex;align-items:center;gap:22px;margin:0 0 22px">
        <span style="width:38px;height:38px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;${
          i < c.slide.done ? 'background:#30d158;color:#06270f' : 'background:#2c2c34;color:#8e8e98;border:2px solid #3a3a44;box-sizing:border-box'
        }">${i < c.slide.done ? '✓' : ''}</span>
        <span style="font-size:34px;color:${i < c.slide.done ? '#f5f5f7' : '#c7c7cf'}">${t}</span></li>`,
    )
    .join('');
  return `<div style="width:1280px;height:720px;box-sizing:border-box;padding:72px 96px;background:linear-gradient(135deg,#15161c 0%,#1d2233 60%,#1a2a4a 100%);color:#f5f5f7;position:relative">
    <div style="font-size:26px;font-weight:600;color:#6fb1ff;letter-spacing:.02em">${c.slide.eyebrow}</div>
    <div style="font-size:76px;font-weight:700;margin:14px 0 44px;letter-spacing:-0.02em">${c.slide.title}</div>
    <ul style="list-style:none;padding:0;margin:0">${items}</ul>
    <div style="position:absolute;right:96px;bottom:64px;padding:14px 26px;border-radius:999px;background:#0a84ff;color:#fff;font-size:26px;font-weight:600">${c.slide.footer}</div>
    <div style="position:absolute;right:96px;top:72px;display:flex;gap:10px;align-items:center;font-size:24px;font-weight:700;color:#c7c7cf">
      <span style="width:34px;height:34px;border-radius:10px;background:#0a84ff;display:inline-block"></span>${c.company}</div>
  </div>`;
}

/** The home page mockup Вера posts in the chat (1600×1000): a landing hero with a product window. */
export function mockupHtml(c: Copy): string {
  const m = c.chat.mockup;
  const bars = [72, 54, 88, 40, 66]
    .map((w, i) => `<div style="height:14px;border-radius:7px;background:${i === 0 ? '#0a84ff' : '#2c2f3a'};width:${w}%;margin:0 0 16px"></div>`)
    .join('');
  return `<div style="width:1600px;height:900px;background:radial-gradient(70% 60% at 50% 0%,#1f3b6b 0%,#101217 70%);color:#f5f5f7;box-sizing:border-box;padding:40px 80px">
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:24px">
      <div style="display:flex;align-items:center;gap:14px;font-weight:700;font-size:28px"><span style="width:40px;height:40px;border-radius:12px;background:#0a84ff;display:inline-block"></span>${c.company}</div>
      <div style="display:flex;gap:40px;color:#b8bcc8">${m.nav.map((n) => `<span>${n}</span>`).join('')}</div>
    </div>
    <div style="text-align:center;margin-top:70px">
      <div style="font-size:78px;font-weight:800;letter-spacing:-0.02em">${m.title}</div>
      <div style="font-size:32px;color:#b8bcc8;margin-top:22px">${m.lead}</div>
      <div style="display:flex;gap:18px;justify-content:center;margin-top:44px">
        <span style="padding:20px 40px;border-radius:999px;background:#0a84ff;font-size:26px;font-weight:600">${m.cta}</span>
        <span style="padding:20px 40px;border-radius:999px;background:rgba(10,132,255,.18);color:#6fb1ff;font-size:26px;font-weight:600">${m.secondary}</span>
      </div>
    </div>
    <div style="margin:56px auto 0;width:1080px;height:360px;border-radius:24px 24px 0 0;background:#1b1d24;border:2px solid #2c2f3a;border-bottom:0;display:flex;overflow:hidden">
      <div style="width:220px;background:#15171d;padding:34px 24px;box-sizing:border-box">${bars}</div>
      <div style="flex:1;padding:34px;box-sizing:border-box">
        <div style="display:flex;gap:16px;margin-bottom:26px">${['#5b8def', '#f2994a', '#bb6bd9'].map((col) => `<span style="width:44px;height:44px;border-radius:50%;background:${col};display:inline-block"></span>`).join('')}</div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:80%;margin-bottom:18px"></div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:62%;margin-bottom:18px"></div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:70%"></div>
      </div>
    </div>
  </div>`;
}

/** A tiny valid one-page PDF (the chat shows name, size and an icon). */
export function pdfBytes(title: string): Buffer {
  const text = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n% ${title.replace(/[^\x20-\x7e]/g, '?')}\n${'% regression report line\n'.repeat(9000)}trailer<</Root 1 0 R>>\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}
