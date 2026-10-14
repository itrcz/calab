import { DEFAULT_LOCALE, hreflangAlternates, LOCALE_INFO, LOCALE_STORAGE_KEY, LOCALES, localePath } from '@/i18n/locales';
import { SITE_URL } from '@/lib/site';
import { PREFERENCES_KEY, PREFERENCES_TTL, PREFERENCES_VERSION } from '@/lib/site-preferences';

// `/` — the language router (ADR-0022 §3): no content, no React runtime. Order: the switcher's saved choice
// (localStorage) → navigator.languages (first one we support: ru/uk/be/kk → ru, zh* → zh, es* → es,
// en* → en) → /en/. Query and #hash are kept, so old /#download links land on /<locale>/#download.
// Without JS: <meta refresh> to /en/ plus plain links. Exported as out/index.html (static route handler).
export const dynamic = 'force-static';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const script = `(function(){var L=${JSON.stringify(LOCALES)},l=null;
try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(PREFERENCES_KEY)})),n=Date.now();
if(p&&p.version===${PREFERENCES_VERSION}&&typeof p.savedAt==="number"&&Number.isFinite(p.savedAt)&&p.savedAt<=n&&typeof p.expiresAt==="number"&&Number.isFinite(p.expiresAt)&&p.expiresAt>n&&p.expiresAt<=p.savedAt+${PREFERENCES_TTL}&&typeof p.language==="boolean"&&p.analytics===false&&p.marketing===false&&p.language){l=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}
else{localStorage.removeItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}}catch(e){try{localStorage.removeItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch(e){}}
if(L.indexOf(l)<0){l=${JSON.stringify(DEFAULT_LOCALE)};var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];
for(var i=0;i<n.length;i++){var p=String(n[i]).toLowerCase().split(/[-_]/)[0],m=/^(ru|uk|be|kk)$/.test(p)?"ru":p==="zh"||p==="es"||p==="en"?p:null;if(m){l=m;break}}}
location.replace("/"+l+"/"+location.search+location.hash)})()`;

const alternates = Object.entries(hreflangAlternates())
  .map(([lang, path]) => `<link rel="alternate" hreflang="${lang}" href="${SITE_URL}${path}">`)
  .join('\n');

const links = LOCALES.map(
  (l) => `<a href="${localePath(l)}" hreflang="${LOCALE_INFO[l].lang}" lang="${LOCALE_INFO[l].lang}">${esc(LOCALE_INFO[l].name)}</a>`,
).join(' · ');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calab</title>
<meta name="robots" content="noindex, follow">
<meta name="color-scheme" content="light dark">
${alternates}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>${script}</script>
<noscript><meta http-equiv="refresh" content="0; url=${localePath(DEFAULT_LOCALE)}"></noscript>
<style>html{background:#fff;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}@media (prefers-color-scheme:dark){html{background:#0e0e10;color:#f5f5f7}}body{margin:0;padding:48px 16px;text-align:center}a{color:inherit}</style>
</head>
<body>
<noscript><p>${links}</p></noscript>
</body>
</html>
`;

export function GET(): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
