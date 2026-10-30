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

export interface Layout {
  /** Card size in px. */
  w: number;
  h: number;
  /** Headline font size, top padding and width of the text block. */
  font: number;
  top: number;
  /** Space between the headline and the phone's top edge. */
  gap: number;
  /** Phone frame width (its screen keeps the 390×844 aspect); the phone is cut by the card's bottom edge. */
  phoneW: number;
  /** Bezel width in px. */
  bezel: number;
}

/** iOS 1206×2622 (6.9" display); Google Play 1080×1920. The phone runs off the bottom edge, so the shorter card shows less of it. */
export const LAYOUTS: Record<'ios' | 'android', Layout> = {
  ios: { w: 1206, h: 2622, font: 112, top: 210, gap: 120, phoneW: 1010, bezel: 16 },
  android: { w: 1080, h: 1920, font: 100, top: 150, gap: 80, phoneW: 840, bezel: 14 },
};

const SCREEN = { w: 390, h: 844 };

/** The card: gradient background, one-line headline, the screenshot in a rounded phone with a soft shadow and a 9:41 status bar. */
export function cardHtml(l: Layout, headline: string, shotDataUrl: string): string {
  const inner = l.phoneW - l.bezel * 2;
  const screenH = Math.round((inner * SCREEN.h) / SCREEN.w);
  const radius = Math.round(inner * 0.13);
  const k = inner / SCREEN.w; // pt → px
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${l.w}px;height:${l.h}px;overflow:hidden}
body{position:relative;font-family:${BRAND.font};color:${BRAND.text};-webkit-font-smoothing:antialiased;
  background:
    radial-gradient(120% 70% at 50% 0%, ${BRAND.blue} 0%, rgba(54,96,252,0) 70%),
    radial-gradient(90% 60% at 100% 100%, ${BRAND.indigo} 0%, rgba(64,68,152,0) 75%),
    linear-gradient(180deg, #1B2160 0%, ${BRAND.ink} 100%)}
h1{position:absolute;left:0;right:0;top:${l.top}px;text-align:center;font-size:${l.font}px;font-weight:700;letter-spacing:-0.02em;line-height:1.1;white-space:nowrap;text-shadow:0 4px 30px rgba(11,14,36,.35)}
.phone{position:absolute;left:50%;top:${l.top + l.font + l.gap}px;width:${l.phoneW}px;margin-left:-${l.phoneW / 2}px;padding:${l.bezel}px;border-radius:${radius + l.bezel}px;
  background:#05060F;box-shadow:0 0 0 2px rgba(255,255,255,.14), 0 60px 140px rgba(5,8,40,.65), 0 20px 50px rgba(5,8,40,.45)}
.screen{position:relative;width:${inner}px;height:${screenH}px;border-radius:${radius}px;overflow:hidden;background:#0b0b0c}
.screen img{display:block;width:100%;height:100%}
.status{position:absolute;left:0;right:0;top:0;height:${Math.round(50 * k)}px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 ${Math.round(34 * k)}px ${Math.round(8 * k)}px;font-size:${Math.round(16 * k)}px;font-weight:600;color:#fff}
.status .r{display:flex;gap:${Math.round(6 * k)}px;align-items:center}
.island{position:absolute;left:50%;top:${Math.round(11 * k)}px;width:${Math.round(112 * k)}px;height:${Math.round(32 * k)}px;margin-left:-${Math.round(56 * k)}px;border-radius:99px;background:#000}
.bat{width:${Math.round(25 * k)}px;height:${Math.round(12 * k)}px;border-radius:${Math.round(4 * k)}px;border:${Math.max(1, Math.round(k))}px solid rgba(255,255,255,.5);padding:${Math.round(1.5 * k)}px;position:relative}
.bat i{display:block;height:100%;width:80%;background:#fff;border-radius:${Math.round(2 * k)}px}
.sig{display:flex;gap:${Math.round(1.5 * k)}px;align-items:flex-end;height:${Math.round(11 * k)}px}
.sig i{display:block;width:${Math.round(3 * k)}px;background:#fff;border-radius:1px}
</style></head><body>
<h1>${escapeHtml(headline)}</h1>
<div class="phone"><div class="screen"><img src="${shotDataUrl}">
<div class="status"><span style="padding-left:${Math.round(8 * k)}px">9:41</span><span class="r"><span class="sig"><i style="height:35%"></i><i style="height:55%"></i><i style="height:78%"></i><i style="height:100%"></i></span><span class="bat"><i></i></span></span></div>
<div class="island"></div></div></div>
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
