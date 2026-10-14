import type { Browser } from '@playwright/test';
import type { Copy } from './copy';

/**
 * Pictures for the landing scenes drawn by Chromium from HTML/SVG (deterministic): the design
 * mockup posted in the chat and the pages of the web apps. People (avatars, camera frames)
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

/** The «Продажи» web app's page in one language (landing-v4.spec.ts, the webapps scene). */
export interface SalesCopy {
  title: string;
  sub: string;
  range: [string, string, string];
  export: string;
  /** label, value, change (positive). */
  kpis: [string, string, string][];
  chart: string;
  plan: string;
  fact: string;
  /** Eight week labels under the bars. */
  weeks: string[];
  funnel: string;
  /** Stage, count. */
  stages: [string, string][];
  table: string;
  cols: [string, string, string, string];
  /** Client, stage pill index (0 negotiation, 1 proposal, 2 contract, 3 paid), amount; the manager is people[i]. */
  rows: [string, number, string][];
  pills: [string, string, string, string];
  /** The month goal card (under the bot's summary in the landing composite): title, caption. */
  goal: [string, string];
}

/** A sales dashboard as a team would plug it into the rail (fills the app screen): KPI row, weekly revenue vs plan, funnel, top deals. */
export function salesHtml(t: SalesCopy, people: { name: string; avatar: string }[]): string {
  const card = 'background:#18191d;border:1px solid #2a2b31;border-radius:14px';
  const spark = (seed: number): string => {
    const pts: string[] = [];
    for (let i = 0; i <= 12; i++) pts.push(`${i * 10},${(26 - i * 1.4 - 6 * Math.sin(i * 0.9 + seed)).toFixed(1)}`);
    return `<svg width="120" height="34" viewBox="0 0 120 34"><polyline fill="none" stroke="#30d158" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}"/></svg>`;
  };
  const kpis = t.kpis
    .map(
      ([label, value, delta], i) => `<div style="${card};padding:18px 20px;display:flex;flex-direction:column;gap:6px">
      <div style="font-size:14px;color:#9a9ba3">${label}</div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px">
        <div style="font-size:30px;font-weight:700;letter-spacing:-.01em;color:#f5f5f7;white-space:nowrap">${value}</div>${spark(i * 1.3)}</div>
      <div style="font-size:13px;font-weight:600;color:#30d158">▲ ${delta}</div></div>`,
    )
    .join('');
  const fact = [62, 70, 58, 76, 81, 74, 88, 96];
  const plan = [64, 66, 68, 70, 72, 74, 78, 82];
  const W = 640;
  const H = 210;
  const bw = 44;
  const step = W / fact.length;
  const y = (v: number): number => H - (v / 100) * H;
  const bars = fact
    .map((v, i) => `<rect x="${(i * step + (step - bw) / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw}" height="${(H - y(v)).toFixed(1)}" rx="7" fill="${i === fact.length - 1 ? '#0a84ff' : '#2f5ea8'}"/>`)
    .join('');
  const planLine = plan.map((v, i) => `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const weeks = t.weeks.map((w) => `<span style="flex:1;text-align:center">${w}</span>`).join('');
  const num = (s: string): number => Number(s.replace(/\D/g, '')) || 1;
  const max = num(t.stages[0]?.[1] ?? '1');
  const funnel = t.stages
    .map(([name, n]) => {
      const pct = Math.max(12, Math.round((num(n) / max) * 100));
      return `<div style="margin:0 0 16px"><div style="display:flex;justify-content:space-between;font-size:14px;margin:0 0 7px"><span style="color:#c7c7cf">${name}</span><b style="color:#f5f5f7">${n}</b></div>
        <div style="height:10px;border-radius:5px;background:#24252b"><div style="height:10px;border-radius:5px;width:${pct}%;background:linear-gradient(90deg,#0a84ff,#5e5ce6)"></div></div></div>`;
    })
    .join('');
  const tones: [string, string][] = [
    ['#2c2414', '#ffd60a'],
    ['#14243a', '#64a8ff'],
    ['#2a1a33', '#d48cff'],
    ['#12301c', '#30d158'],
  ];
  const rows = t.rows
    .map(([client, pill, amount], i) => {
      const p = people[i];
      const [bg, fg] = tones[pill] ?? ['#222', '#fff'];
      return `<tr style="border-top:1px solid #24252b"><td style="padding:11px 0;color:#f5f5f7;font-weight:600">${client}</td>
        <td><span style="display:inline-flex;align-items:center;gap:10px;color:#c7c7cf"><img src="${p?.avatar ?? ''}" style="width:26px;height:26px;border-radius:50%;object-fit:cover">${p?.name ?? ''}</span></td>
        <td><span style="padding:4px 10px;border-radius:999px;background:${bg};color:${fg};font-size:13px;font-weight:600">${t.pills[pill] ?? ''}</span></td>
        <td style="text-align:right;color:#f5f5f7;font-weight:600;font-variant-numeric:tabular-nums">${amount}</td></tr>`;
    })
    .join('');
  return `<div style="min-height:100vh;box-sizing:border-box;background:#111214;color:#f5f5f7;padding:22px 28px;font-size:15px">
    <div style="display:flex;align-items:center;gap:14px;margin:0 0 20px">
      <span style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#30d158,#0a84ff);display:inline-flex;align-items:center;justify-content:center">
        <svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 15l4-5 3 3 6-8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <div><div style="font-size:22px;font-weight:700">${t.title}</div><div style="font-size:13px;color:#9a9ba3">${t.sub}</div></div>
      <div style="margin-left:auto;display:flex;gap:4px;padding:3px;border-radius:10px;background:#1d1e23;font-size:14px">
        ${t.range.map((r, i) => `<span style="padding:6px 14px;border-radius:8px;${i === 2 ? 'background:#34353c;color:#fff' : 'color:#9a9ba3'}">${r}</span>`).join('')}</div>
      <span style="padding:8px 16px;border-radius:10px;background:#0a84ff;font-size:14px;font-weight:600">${t.export}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">${kpis}</div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:16px">
      <div style="${card};padding:18px 22px">
        <div style="display:flex;align-items:center;gap:18px;margin:0 0 14px"><b style="font-size:16px">${t.chart}</b>
          <span style="margin-left:auto;font-size:13px;color:#9a9ba3;display:inline-flex;align-items:center;gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:#2f5ea8;display:inline-block"></i>${t.fact}</span>
          <span style="font-size:13px;color:#9a9ba3;display:inline-flex;align-items:center;gap:6px"><i style="width:14px;height:0;border-top:2px dashed #ff9f0a;display:inline-block"></i>${t.plan}</span></div>
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%">
          <g stroke="#26272d">${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}"/>`).join('')}</g>
          ${bars}<polyline fill="none" stroke="#ff9f0a" stroke-width="2.5" stroke-dasharray="6 5" points="${planLine}"/></svg>
        <div style="display:flex;font-size:12px;color:#8e8f97;margin-top:8px">${weeks}</div>
      </div>
      <div style="${card};padding:18px 22px"><b style="font-size:16px;display:block;margin:0 0 18px">${t.funnel}</b>${funnel}</div>
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:16px">
    <div style="${card};padding:14px 22px 4px">
      <b style="font-size:16px">${t.table}</b>
      <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:14px">
        <tr style="color:#8e8f97;font-size:12px;text-align:left"><th style="padding:8px 0;font-weight:500">${t.cols[0]}</th><th style="font-weight:500">${t.cols[1]}</th><th style="font-weight:500">${t.cols[2]}</th><th style="font-weight:500;text-align:right">${t.cols[3]}</th></tr>
        ${rows}</table>
    </div>
    <div style="${card};padding:18px 22px"><b style="font-size:16px">${t.goal[0]}</b>
      <div style="font-size:40px;font-weight:700;margin:18px 0 10px">82%</div>
      <div style="height:12px;border-radius:6px;background:#24252b"><div style="height:12px;width:82%;border-radius:6px;background:linear-gradient(90deg,#30d158,#0a84ff)"></div></div>
      <div style="font-size:13px;color:#9a9ba3;margin-top:10px">${t.goal[1]}</div></div>
    </div>
  </div>`;
}

/** A whole HTML document around a body made here (the web app's site serves it as is). */
export function pageHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;padding:0;background:#111214;font-family:${FONT};-webkit-font-smoothing:antialiased}</style></head><body>${body}</body></html>`;
}

/** The rail icon of a web app (128×128): a rounded tile with a glyph. */
export function appIconHtml(kind: 'sales' | 'wiki' | 'support' | 'bot'): string {
  const bg = { sales: 'linear-gradient(135deg,#30d158,#0a84ff)', wiki: 'linear-gradient(135deg,#ffd60a,#ff9f0a)', support: 'linear-gradient(135deg,#bf5af2,#5e5ce6)', bot: 'linear-gradient(135deg,#ff9f0a,#ff375f)' }[kind];
  const glyph = {
    sales: '<path d="M12 46l14-17 10 10 18-24" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
    wiki: '<path d="M16 12h22a8 8 0 0 1 8 8v32H24a8 8 0 0 1-8-8z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><path d="M25 26h13M25 36h9" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
    support: '<path d="M12 36a20 20 0 0 1 40 0v6a6 6 0 0 1-6 6h-4V34h10M12 34h10v14h-4a6 6 0 0 1-6-6z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>',
    bot: '<rect x="12" y="20" width="40" height="30" rx="10" fill="none" stroke="#fff" stroke-width="6"/><circle cx="25" cy="35" r="4" fill="#fff"/><circle cx="39" cy="35" r="4" fill="#fff"/><path d="M32 20v-8" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="10" r="4" fill="#fff"/>',
  }[kind];
  return `<div style="width:128px;height:128px;border-radius:28px;background:${bg};display:flex;align-items:center;justify-content:center"><svg width="80" height="80" viewBox="0 0 64 64">${glyph}</svg></div>`;
}
