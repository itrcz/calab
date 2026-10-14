// Landing v3 / README images (docs/09 #139) from the raw captures of
// apps/desktop/e2e-marketing/landing.spec.ts in apps/landing/shots/ (git-ignored):
// <scene>-<locale>@2x.png — the web client at 1440×900 CSS px, device scale 2, dark theme, the UI and
// the team in the landing locale (ru, en, es, zh → folder zh-CN).
// Output, per locale (folder = the locale's BCP 47 tag, as <html lang>):
// - public/screens/<lang>/<name>@2x.webp — the crop at full resolution, <name>.webp — a 1x
//   Lanczos resample and, for crops wider than 720 px, <name>-720.webp (phones); every file ≤ 300 KB (quality steps down from 88 until it fits).
// - public/og/<lang>.png — 1200×630 OpenGraph card: the hero window on the brand gradient.
// The README files (README*.md) use public/screens/<lang>/<name>.webp directly.
// Usage: pnpm -F @calaba/landing assets
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'shots');
const out = join(root, 'public/screens');
const og = join(root, 'public/og');
const SCALE = 2;
const LOCALES = { ru: 'ru', en: 'en', es: 'es', zh: 'zh-CN' };
const MAX = 300_000;

// Crops in CSS px of the 1440×900 window (null = the whole window). The sizes here are the
// width/height the pages use (src/lib/screens.ts) — change both together.
export const CROPS = {
  // hero: the whole window in a call — the shared slide on the stage, cameras, the room list
  voice: null,
  // chat: the room header (with «… печатает») and a narrow feed down to the composer: the mockup's end, a reply
  // quote, short lines of four people with reactions, my last one read (the capture's window is 930×800)
  chat: { left: 330, top: 40, width: 600, height: 760 },
  // one-to-one call: the DM with «Звонок · 00:00 · Завершить», the island
  call: { left: 0, top: 30, width: 1440, height: 870 },
  // calendar: the day with the planning meeting's card
  calendar: { left: 330, top: 30, width: 1110, height: 870 },
  // «Подобрать время»: busy columns, the green free window, the picked slot
  findtime: { left: 330, top: 30, width: 1110, height: 870 },
  // boards
  kanban: { left: 330, top: 30, width: 1110, height: 600 },
  timeline: { left: 330, top: 30, width: 1110, height: 870 },
  task: { left: 930, top: 30, width: 510, height: 870 },
  // the guest's waiting card
  guest: { left: 420, top: 220, width: 600, height: 460 },
  // landing v4 (e2e-marketing/landing-v4.spec.ts): SIP dialer popover over the room header and the members
  sipdial: { left: 330, top: 30, width: 1110, height: 300 },
  // the phone line in the room list («В разговоре 02:14») + the members column
  siproom: { left: 0, top: 30, width: 1440, height: 500 },
  // workspace settings → Телефония: the provider card / the connection test and the call journal
  sipsettings: { left: 250, top: 120, width: 940, height: 660 },
  siplog: { left: 250, top: 120, width: 940, height: 660 },
  // the «Продажи» web app open from its rail icon (the tip with its name), the bot's daily summary
  // laid over the bottom right (OVERLAYS below)
  webapps: { left: 0, top: 30, width: 1440, height: 870 },
  // Calab 2.0 (e2e-marketing/landing-v2.spec.ts)
  // the task panel with two named checklists
  checklists: { left: 960, top: 30, width: 480, height: 870 },
  // board settings windows: «Фичи», «Вебхук» (Business)
  boardfeatures: { left: 250, top: 120, width: 940, height: 660 },
  boardhook: { left: 250, top: 120, width: 940, height: 660 },
  // workspace settings → SSO: the connection, the sign-in policy
  sso: { left: 250, top: 120, width: 940, height: 660 },
  ssopolicy: { left: 250, top: 120, width: 940, height: 660 },
  // «Разрешить вход в приложение?» (OAuth consent)
  consent: { left: 440, top: 215, width: 560, height: 480 },
  // built-in «Calab Stikers»: chat and the picker
  stickerchat: { left: 330, top: 30, width: 1110, height: 870 },
  stickerpicker: { left: 330, top: 30, width: 1110, height: 870 },
  // the room list: people in a voice room and «Войти»
  voicelist: { left: 0, top: 30, width: 340, height: 440 },
  // Landing 3.3 (e2e-marketing/landing-v5.spec.ts, landing-mail.spec.ts)
  // the desktop mail client (Electron, its window is 1440×758 CSS px on the capture machine)
  mail: { left: 0, top: 0, width: 1440, height: 758 },
  // the board with the opened task on «История»
  taskhistory: { left: 330, top: 30, width: 1110, height: 870 },
  // settings → Уведомления: the task triggers / their end with «Передавать боту»
  notify: { left: 260, top: 130, width: 920, height: 640 },
  notifyrelay: { left: 260, top: 130, width: 920, height: 640 },
  // a video meeting in «Галерея»: the 2 × 2 camera grid only (tiles at 341,214–1189,694 + 12 px)
  gallery: { left: 329, top: 202, width: 872, height: 504 },
  // «Диск» as tiles: folders (one restricted), files with thumbnails, the storage meter (window 1060×600)
  disk: { left: 70, top: 30, width: 990, height: 570 },
  // «Вики»: the page tree with branches open and a page with a cover, a checklist, a table and two carets (window 1060×780)
  wiki: { left: 70, top: 30, width: 990, height: 750 },
  // ⌘K with the unified search sections
  search: { left: 390, top: 115, width: 660, height: 650 },
  // the phone (iPhone 14 viewport, 390×844): rooms, chat, «В голосе», a board
  'phone-rooms': { left: 0, top: 0, width: 390, height: 844 },
  'phone-chat': { left: 0, top: 0, width: 390, height: 844 },
  'phone-voice': { left: 0, top: 0, width: 390, height: 844 },
  'phone-board': { left: 0, top: 0, width: 390, height: 844 },
};

// A second capture laid over a crop as a floating card (CSS px from the crop's right / bottom edge,
// rounded, a hairline border and a soft shadow): webapps = the sales dashboard + the bot's daily summary.
const OVERLAYS = {
  webapps: { from: 'webapps-bot', right: 36, bottom: 36, radius: 16 },
};

/** sharp composite inputs: the card's shadow, the rounded card, its border — at the crop's bottom right. */
async function floating(file, cw, ch, bw, bh, { right, bottom, radius }) {
  const r = radius * SCALE;
  const left = bw - right * SCALE - cw;
  const top = bh - bottom * SCALE - ch;
  const blur = 24 * SCALE;
  const shadow = await sharp(Buffer.from(`<svg width="${cw + blur * 2}" height="${ch + blur * 2}" xmlns="http://www.w3.org/2000/svg"><rect x="${blur}" y="${blur + 8 * SCALE}" width="${cw}" height="${ch}" rx="${r}" fill="#000" fill-opacity=".7"/></svg>`))
    .blur(blur / 2)
    .png()
    .toBuffer();
  const card = await sharp(file)
    .composite([{ input: Buffer.from(`<svg width="${cw}" height="${ch}"><rect width="${cw}" height="${ch}" rx="${r}" ry="${r}"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const border = Buffer.from(`<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${cw - 2}" height="${ch - 2}" rx="${r - 1}" fill="none" stroke="#ffffff" stroke-opacity=".14" stroke-width="2"/></svg>`);
  return [
    { input: shadow, left: left - blur, top: top - blur },
    { input: card, left, top },
    { input: border, left, top },
  ];
}

// `--only=sipdial,siproom` regenerates just those images (raw captures of the other scenes are not needed,
// the existing files stay untouched; the OpenGraph cards are redrawn only when `voice` is in the list).
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');

const scaled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * SCALE)]));

async function webp(pipeline, file) {
  for (let q = 88; q >= 40; q -= 6) {
    const buf = await pipeline.clone().webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= MAX || q <= 46) {
      await sharp(buf).toFile(file);
      return buf.length;
    }
  }
  return 0;
}

let total = 0;
for (const [short, lang] of Object.entries(LOCALES)) {
  const dir = join(out, lang);
  if (!only) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, crop] of Object.entries(CROPS)) {
    if (only && !only.includes(name)) continue;
    const path = join(src, `${name}-${short}@2x.png`);
    if (!existsSync(path)) throw new Error(`missing ${path}: run the landing captures first`);
    let base = crop ? sharp(path).extract(scaled(crop)) : sharp(path);
    const layer = OVERLAYS[name];
    if (layer) {
      const card = join(src, `${layer.from}-${short}@2x.png`);
      if (!existsSync(card)) throw new Error(`missing ${card}: run the landing captures first`);
      const { width: cw = 0, height: ch = 0 } = await sharp(card).metadata();
      const { width: bw, height: bh } = scaled(crop ?? { width: 1440, height: 900 });
      // Flattened first: sharp composites after a resize, and the 1x copies are resized.
      base = sharp(await sharp(await base.png().toBuffer()).composite(await floating(card, cw, ch, bw, bh, layer)).png().toBuffer());
    }
    const { width } = crop ?? { width: 1440 };
    const big = await webp(base.clone(), join(dir, `${name}@2x.webp`));
    const small = await webp(base.clone().resize({ width, kernel: 'lanczos3' }), join(dir, `${name}.webp`));
    // Phones: a 720 px wide file (the 1x one would be 2× too large for a 390 pt screen at 2x).
    const phone = width > 720 ? await webp(base.clone().resize({ width: 720, kernel: 'lanczos3' }), join(dir, `${name}-720.webp`)) : 0;
    total += big + small + phone;
    console.log(`${lang}/${name}: @2x ${(big / 1000).toFixed(0)} KB, 1x ${(small / 1000).toFixed(0)} KB${phone ? `, 720 ${(phone / 1000).toFixed(0)} KB` : ''}`);
  }

  if (only && !only.includes('voice')) continue;
  // OpenGraph: the hero window (top part) on a dark brand gradient, 1200×630.
  await mkdir(og, { recursive: true });
  const shot = await sharp(join(src, `voice-${short}@2x.png`))
    .resize({ width: 1080, kernel: 'lanczos3' })
    .extract({ left: 0, top: 0, width: 1080, height: 560 })
    .composite([{ input: Buffer.from('<svg width="1080" height="560"><rect width="1080" height="560" rx="18" ry="18"/></svg>'), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const bg = Buffer.from(
    `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#1f4fa0"/><stop offset="1" stop-color="#0e0e10"/></radialGradient></defs><rect width="1200" height="630" fill="url(#g)"/></svg>`,
  );
  await sharp(bg)
    .composite([{ input: shot, left: 60, top: 70 }])
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(join(og, `${lang}.png`));
}
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
