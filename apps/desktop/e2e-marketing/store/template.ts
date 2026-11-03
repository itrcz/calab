/**
 * The store cards' look, in one place: brand colors, fonts, sizes, and the HTML template. Tweak the
 * gradient / font / headline size / frame here; headlines live in scenes.ts. Brand: docs/10-branding.md
 * (app icon gradient #3660FC → #404498, white mark).
 */
export const BRAND = {
  blue: '#3660FC',
  indigo: '#404498',
  /** The dark base of every card (behind the gradient glow). */
  ink: '#0B0E24',
  text: '#FFFFFF',
  /** The app's system font stack (docs/08-design.md «Типографика»). */
  font: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Inter, Roboto, 'Helvetica Neue', sans-serif`,
};

/** A card's background: two glow colors over the dark base, all from the brand / avatar tokens (docs/08, docs/10-branding.md). */
export interface Palette {
  /** Glow from the top edge. */
  top: string;
  /** Glow from the bottom right corner. */
  corner: string;
}

/** One palette per scene, alternating so the set reads as a row in the store (index = scene order, wraps). */
export const PALETTES: Palette[] = [
  { top: '#5a51d6', corner: BRAND.blue }, // avatar-3 violet
  { top: BRAND.blue, corner: BRAND.indigo }, // the brand blue (feature graphic)
  { top: '#0b6a80', corner: BRAND.blue }, // avatar-7 teal
  { top: '#7e3fa0', corner: BRAND.indigo }, // avatar-6 purple
  { top: '#0A84FF', corner: BRAND.indigo }, // the app accent
];

/** The device drawn around the capture: the iPhone (Dynamic Island, iOS status bar) or an Android phone (punch-hole camera, gesture pill). */
export type Frame = 'iphone' | 'android';

/** Screen size of each frame in pt (the capture's viewport) and its status bar height. */
export const SCREENS: Record<Frame, { w: number; h: number; bar: number }> = {
  iphone: { w: 390, h: 844, bar: 50 },
  android: { w: 412, h: 915, bar: 40 },
};

export interface Layout {
  frame: Frame;
  /** Card size in px. */
  w: number;
  h: number;
  /** Headline font size, subtitle font size, top padding of the text block. */
  font: number;
  sub: number;
  top: number;
  /** Y of the phone's top edge. */
  phoneTop: number;
  /** Phone frame width (its screen keeps the 390×844 aspect); the phone is cut by the card's bottom edge. */
  phoneW: number;
  /** Bezel width in px. */
  bezel: number;
}

/**
 * App Store: 6.9" 1320×2868 (required) and 6.5" 1284×2778; Google Play phone 1080×1920 (9:16; the allowed
 * range is 16:9..9:16, sides 320–3840). The whole phone fits under the text block on every card.
 */
export const LAYOUTS: Record<'ios-6.9' | 'ios-6.5' | 'android', Layout> = {
  'ios-6.9': {
    frame: 'iphone',
    w: 1320,
    h: 2868,
    font: 120,
    sub: 54,
    top: 200,
    phoneTop: 530,
    phoneW: 1090,
    bezel: 16,
  },
  'ios-6.5': {
    frame: 'iphone',
    w: 1284,
    h: 2778,
    font: 117,
    sub: 52,
    top: 190,
    phoneTop: 510,
    phoneW: 1060,
    bezel: 16,
  },
  android: {
    frame: 'android',
    w: 1080,
    h: 1920,
    font: 100,
    sub: 44,
    top: 110,
    phoneTop: 290,
    phoneW: 740,
    bezel: 12,
  },
};

/** The card: gradient background, one-line headline, the screenshot in a rounded phone with a soft shadow and a 9:41 status bar. */
export function cardHtml(l: Layout, headline: string, subtitle: string, shotDataUrl: string, pal: Palette): string {
  const SCREEN = SCREENS[l.frame];
  const android = l.frame === 'android';
  const inner = l.phoneW - l.bezel * 2;
  const screenH = Math.round((inner * SCREEN.h) / SCREEN.w);
  const radius = Math.round(inner * (android ? 0.08 : 0.13));
  const k = inner / SCREEN.w; // pt → px
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${l.w}px;height:${l.h}px;overflow:hidden}
body{position:relative;font-family:${BRAND.font};color:${BRAND.text};-webkit-font-smoothing:antialiased;
  background:
    radial-gradient(120% 60% at 50% 0%, ${pal.top} 0%, transparent 70%),
    radial-gradient(90% 55% at 100% 100%, ${pal.corner} 0%, transparent 75%),
    linear-gradient(180deg, #1B2160 0%, ${BRAND.ink} 100%)}
h1{position:absolute;left:0;right:0;top:${l.top}px;text-align:center;font-size:${l.font}px;font-weight:700;letter-spacing:-0.02em;line-height:1.1;white-space:nowrap;text-shadow:0 4px 30px rgba(11,14,36,.35)}
.sub{position:absolute;left:0;right:0;top:${l.top + Math.round(l.font * 1.2)}px;text-align:center;font-size:${l.sub}px;font-weight:500;line-height:1.2;white-space:nowrap;color:rgba(255,255,255,.8)}
.phone{position:absolute;left:50%;top:${l.phoneTop}px;width:${l.phoneW}px;margin-left:-${l.phoneW / 2}px;padding:${l.bezel}px;border-radius:${radius + l.bezel}px;
  background:#05060F;box-shadow:0 0 0 2px rgba(255,255,255,.14), 0 60px 140px rgba(5,8,40,.65), 0 20px 50px rgba(5,8,40,.45)}
.screen{position:relative;width:${inner}px;height:${screenH}px;border-radius:${radius}px;overflow:hidden;background:#0b0b0c}
.screen img{display:block;width:100%;height:100%}
.status{position:absolute;left:0;right:0;top:0;height:${Math.round(SCREEN.bar * k)}px;display:flex;align-items:${android ? 'center' : 'flex-end'};justify-content:space-between;padding:0 ${Math.round((android ? 22 : 34) * k)}px ${android ? 0 : Math.round(8 * k)}px;font-size:${Math.round((android ? 14 : 16) * k)}px;font-weight:600;color:#fff}
.status .r{display:flex;gap:${Math.round(6 * k)}px;align-items:center}
.punch{position:absolute;left:50%;top:${Math.round(11 * k)}px;width:${Math.round(14 * k)}px;height:${Math.round(14 * k)}px;margin-left:-${Math.round(7 * k)}px;border-radius:50%;background:#000;box-shadow:0 0 0 ${Math.round(1.5 * k)}px #15161a}
.pill{position:absolute;left:50%;bottom:${Math.round(8 * k)}px;width:${Math.round(108 * k)}px;height:${Math.max(3, Math.round(4 * k))}px;margin-left:-${Math.round(54 * k)}px;border-radius:99px;background:rgba(255,255,255,.88)}
.island{position:absolute;left:50%;top:${Math.round(11 * k)}px;width:${Math.round(112 * k)}px;height:${Math.round(32 * k)}px;margin-left:-${Math.round(56 * k)}px;border-radius:99px;background:#000}
.bat{width:${Math.round(25 * k)}px;height:${Math.round(12 * k)}px;border-radius:${Math.round(4 * k)}px;border:${Math.max(1, Math.round(k))}px solid rgba(255,255,255,.5);padding:${Math.round(1.5 * k)}px;position:relative}
.bat i{display:block;height:100%;width:80%;background:#fff;border-radius:${Math.round(2 * k)}px}
.sig{display:flex;gap:${Math.round(1.5 * k)}px;align-items:flex-end;height:${Math.round(11 * k)}px}
.sig i{display:block;width:${Math.round(3 * k)}px;background:#fff;border-radius:1px}
</style></head><body>
<h1>${escapeHtml(headline)}</h1>
<div class="sub">${escapeHtml(subtitle)}</div>
<div class="phone"><div class="screen"><img src="${shotDataUrl}">
<div class="status"><span style="padding-left:${android ? 0 : Math.round(8 * k)}px">9:41</span><span class="r"><span class="sig"><i style="height:35%"></i><i style="height:55%"></i><i style="height:78%"></i><i style="height:100%"></i></span><span class="bat"><i></i></span></span></div>
${android ? '<div class="punch"></div><div class="pill"></div>' : '<div class="island"></div>'}</div></div>
</body></html>`;
}

/** App icon artwork (1024 square), reused by the 512 icon and the feature graphic. */
export function featureHtml(w: number, h: number, headline: string, tagline: string, iconDataUrl: string): string {
  const icon = Math.round(h * 0.46);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{font-family:${BRAND.font};color:#fff;-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;gap:${Math.round(h * 0.09)}px;
  background:radial-gradient(90% 120% at 15% 0%, ${BRAND.blue} 0%, rgba(54,96,252,0) 65%),radial-gradient(70% 90% at 100% 100%, ${BRAND.indigo} 0%, rgba(64,68,152,0) 70%),linear-gradient(180deg,#1B2160,${BRAND.ink})}
img{width:${icon}px;height:${icon}px;border-radius:${Math.round(icon * 0.225)}px;box-shadow:0 20px 60px rgba(5,8,40,.6)}
h1{font-size:${Math.round(h * 0.17)}px;font-weight:700;letter-spacing:-0.02em;line-height:1.05}
p{margin-top:${Math.round(h * 0.03)}px;font-size:${Math.round(h * 0.06)}px;font-weight:500;color:rgba(255,255,255,.78);white-space:nowrap}
</style></head><body><img src="${iconDataUrl}"><div><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(tagline)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
