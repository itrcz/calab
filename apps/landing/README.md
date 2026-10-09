# @calaba/landing — calab.io

Marketing landing for **Calab**. Next.js 15 (`output: 'export'`) + Tailwind v4, no server: the build is plain static
files in `out/`. Localized (ADR-0022 §3): `ru` (source), `en`, `es`, `zh-CN`.

## Commands

```sh
pnpm -F @calaba/landing dev        # http://localhost:3000
pnpm -F @calaba/landing build      # → apps/landing/out (index.html, ru/ en/ es/ zh/, 404.html, robots.txt, sitemap.xml, manifest)
pnpm -F @calaba/landing lint
pnpm -F @calaba/landing typecheck
pnpm -F @calaba/landing assets     # regenerate public/screens/<lang>/*.webp and public/og/<lang>.png
```

Preview the export: `npx -y serve apps/landing/out` (or `python3 -m http.server -d apps/landing/out`).

## Localization

- Routes: `/ru/`, `/en/`, `/es/`, `/zh/` and `/<locale>/bots/` (Bot API page, ADR-0031; docs link: ru → `docs/19-bot-api.md`, others → `.en.md`) — pages per locale (`src/app/[locale]/`, `generateStaticParams`,
  `dynamicParams = false`), `<html lang>`, title/description/OG, canonical and `hreflang` (+ `x-default → /en/`) per locale.
- `/` is `out/index.html` from `src/app/index.html/route.ts`: a content-less redirect page (no React runtime). Order:
  the switcher's saved choice (`localStorage['calab.locale']`, only with unexpired storage permission) → `navigator.languages` (first supported: ru/uk/be/kk →
  `ru`, zh* → `zh`, es* → `es`, en* → `en`) → `/en/`. Query and `#hash` are kept, so old `calab.io/#download` links
  (release notes, `/download/` fallback in Caddy) land on `/<locale>/#download`. Without JS: `<noscript>` meta refresh
  to `/en/`. In `next dev` it is served at `/index.html`, not `/`.
- Texts: `src/i18n/<locale>.ts`, typed by `ru.ts` (`Dict`): a missing or extra key fails `typecheck`. `{name}`
  placeholders become links/`<code>` via `rich()` (`src/lib/rich.tsx`) — keep them in every locale. Terms follow
  `docs/i18n-glossary.md` (workspace/espacio/工作区, room/sala/房间, screen share/pantalla compartida/屏幕共享 …);
  «Powered by GPTunneL» and product/tech names are never translated. es/zh are agent translations, native review pending.
- Language switcher: header pill (`locale-switcher.tsx`, native `<details>` + links, works without JS); names in their own
  language (Русский · English · Español · 中文); with JS and permission it saves the choice and keeps the page path.
- `404.html` is shared by all locales (English + links to each language). Caddy redirects unknown locale prefixes
  (`/de/`, `/pt-BR/…`) to `/en/` and `/ru` → `/ru/`.
- Screenshots follow the page: `Screen` (`components/ui.tsx`) loads `public/screens/<lang>/<name>` — the app UI *and*
  its team (names, rooms, chat, meetings, board) in that language, dark theme in both page themes. OpenGraph image per
  locale: `public/og/<lang>.png`. The home page carries schema.org `SoftwareApplication` JSON-LD in its language.
- `public/llms.txt` (summary + links, llmstxt.org format) and `public/llms-full.txt` (full text) are served at the site root as-is; keep their plan table, limits and feature list in sync with `src/i18n/en.ts` and the README, and mark unreleased features as planned.

## Public agreements and browser preferences

RU uses Gromtekh / RUB 6 and 18 per employee/day; other locales use Unne / USD $0.10 and $0.30.
`content/legal.json` is the RU edition; `content/legal-global.json` is the English Global edition.
Six documents × four locale paths; canonical legal URLs use RU or EN respectively. ES/ZH
keep localized navigation and explicitly identify English legal text. The previous monthly
edition is kept in `content/legal-archive/` and is not imported into pages.

The corner panel uses `lib/site-preferences.ts`; consent is optional-off by default, versioned
and expires after 180 days. It controls real language persistence in both the switcher and
the root redirect. Analytics/marketing categories are prepared but inactive. Before enabling
a provider: disclose recipients/purposes/lifetimes, bump the consent version, update parser
and root-router validation together, and gate loading plus withdrawal through the purpose
check. Never add a tracker via an unconditional script. Only preferences are active now.
Run `pnpm -F @calaba/landing test:preferences` for consent and root-router regression checks.
No analytics SDK, third-party CMP or payment functionality is enabled by these pages.

## Where it is served

`https://calab.io` — Caddy `file_server` from `/srv/landing` (see `docs/10-branding.md`, `LANDING_HOST`); the old
`https://calab.ru` redirects there (301, same path — `LANDING_HOST_ALIASES`).
Copy the contents of `out/` there. `trailingSlash: true`, so every page `/x/` is exported as `x/index.html`.
Links: «Открыть в браузере» → `https://app.calab.io`, downloads → direct links to the stable names
`https://releases.calab.io/latest/<file>` (`DOWNLOADS` in `src/lib/site.ts`; the main button picks the visitor's OS
in the browser, the version comes from `latest/VERSION`, never versioned file names), licence and support → the public CALAB intake form (`CONTACT_FORM_URL`), source → `https://github.com/itrcz/calab` (`REPO_URL` in `src/lib/site.ts`; LICENSE/SECURITY/TRADEMARKS links point to `blob/main/…`).

## Design

Follows `docs/08-design.md`: system font stack, one accent (`#0A84FF`/`#007AFF`, white-on-accent fills use
`#0071e3`), 4 px grid, solid materials only (no `backdrop-filter`, the sticky header too), light/dark
via `prefers-color-scheme` only, motion only under `prefers-reduced-motion: no-preference`, no infinite animations.
Tokens live in `src/app/globals.css`. Landing v3 (docs/09 #139): hero with the whole app window, then sections in
the order voice/video → sound quality → phone calls (SIP) → chat → calendar → boards → notes → guests → web apps → bots → self-hosted →
performance (measured numbers only, docs/14-energy.md / docs/18) → pricing (Free · Team · Business · Enterprise = your own server) → download → FAQ.
Landing v4 added the SIP, sound, web-apps and performance blocks and the four-plan table; plan limits live in `src/i18n/*.ts`
(`pricing.table.cells`), keep them equal to the server's plans (ADR-0024) and to the `README*.md` tables.
Screenshots sit in a solid dark `.shot-frame` (the app is dark in every shot). All components are server components
except `download-primary.tsx` (OS detection + `latest/VERSION`), the language switcher and the cookie preferences controls; the FAQ uses native
`<details>`, so the page works without JS (the Next runtime chunk still ships, ~100 kB).

Performance: the hero shot is preloaded with its `srcset` and `fetchpriority=high` (phone 720 w ≈ 30 KB, 1x ≈ 80 KB,
2x ≈ 170 KB); every other shot is lazy with `sizes`, so phones fetch the `-720` files. Lighthouse on the built page
(served compressed, as Caddy does): mobile 99 / 100 / 100 / 100 (perf / a11y / best practices / SEO), desktop 100.

## Updating screenshots

Every scene is captured per language with that language's team (docs/09 #139).

1. Captures — `apps/desktop/e2e-marketing/landing.spec.ts`: the production web build (`dist-web`) served by the mock
   API, Chromium at 1440×900 CSS px, device scale 2, dark. Data per language: `e2e-marketing/copy.ts`; people are real
   photos (avatars and camera frames, `e2e-marketing/photos/`, the person→photo table in `photos.ts`); stickers are
   the built-in Calab ones (`apps/server/internal/builtinstickers`); the shared slide and the chat mockup are drawn by
   Chromium (`art.ts`);
   the scene data is set on the mock before sign-in (`seed.ts`). Dev LiveKit running (`pnpm infra:dev`) for the voice
   and call scenes; one Playwright run at a time:
   ```sh
   pnpm -F @calaba/desktop build:web
   cd apps/desktop
   CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ pnpm exec playwright test --config playwright.marketing.config.ts landing
   ```
   `CALABA_LANDING_LOCALES=ru,en` narrows the languages, `-g "landing kanban"` one scene. Raw PNGs land in
   `apps/landing/shots/<scene>-<locale>@2x.png` (git-ignored). Scenes: `voice` (hero: stream + cameras), `chat`,
   `call`, `calendar`, `findtime`, `kanban`, `timeline`, `task`, `notes`, `guest`.
   Landing v4 scenes (`sipdial`, `siproom`, `sipsettings`, `siplog`, `webapps`) are in `e2e-marketing/landing-v4.spec.ts`
   (`... playwright test --config playwright.marketing.config.ts landing-v4`): the mock's SIP account and calls
   (`setSip`, `placeSipCall`), the rail apps via `mock.dispatch(workspaceAppUpsert)` and a local dashboard page as the "site".
2. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` crops (CSS px at the top of the script, equal to
   `src/lib/screens.ts`), writes `public/screens/<lang>/<name>@2x.webp`, `<name>.webp` (1x) and `<name>-720.webp`
   (phones), each ≤ 300 KB, and `public/og/<lang>.png` (1200×630). `node scripts/assets.mjs --only=sipdial,webapps` regenerates
   just those images (no other raw captures needed; OpenGraph is redrawn only when `voice` is listed). The READMEs (`README*.md`) use the same files.
3. Rebuild and commit `public/screens` and `public/og`.

## TODO

- Telegram channel in the footer when there is one (contact now: the CALAB intake form).
- FAQ hardware estimate («ориентировочно 4 vCPU и 8 ГБ» for up to 30 users) comes from the compose memory limits,
  not a load test — refine after the load test.
