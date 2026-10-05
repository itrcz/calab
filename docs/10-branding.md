# 10 — Бренд и домены

## Имя
Продукт называется **Calab**. Рабочее имя «Calaba» остаётся только во внутренних идентификаторах (npm-пакеты `@calaba/*`, Go-модуль, имена compose-контейнеров и volume, каталоги) — переименование их в пользовательском интерфейсе не видно и запланировано на после релиза (ADR при необходимости). Всё видимое пользователю — «Calab»: название приложения, окно, «О программе», лендинг, инсталляторы (`Calab-0.1.0-arm64.dmg`, `Calab Setup 0.1.0.exe`, `calab` для Linux), deep-link схема `calab://` (старая `calaba://` принимается как алиас), документы лицензии.

## Домены
Основной домен с 2.0.0 — `calab.io` (решение владельца 2026-10-02); каждый хост `calab.ru` остаётся алиасом без срока (правила совместимости — docs/06, «Домены: calab.io…»).

| Хост | Что | Обслуживает |
|---|---|---|
| `calab.io` | лендинг (Next.js static export, `apps/landing`; `/ru/` `/en/` `/es/` `/zh/`, `/` — выбор языка, ADR-0022) | Caddy `file_server` из `/srv/landing`; неизвестная локаль → `/en/`; `/download/*` → те же релизы, что на app |
| `app.calab.io` | приложение (веб-клиент, API, gateway, `/download/`) | Caddy → api :3000 + `/srv/web` |
| `releases.calab.io` | фид автообновления и установщики (S3) | Caddy → бакет |
| `rtc.calab.io` | LiveKit signal | Caddy → :7880 |
| `turn.calab.io` | TURN/TLS | Caddy layer4 → :5349 |
| `calab.ru` | старый адрес лендинга | 301 на `calab.io` (`LANDING_HOST_ALIASES`) |
| `app.calab.ru` | сохранённый сервер клиентов до 2.0.0 | как `app.` (`DOMAIN_LEGACY`) |
| `releases.calab.ru` | фид, зашитый в сборки до 2.0.0 | тот же фид (`RELEASES_HOST_ALIASES`) |
| `rtc.calab.ru`, `turn.calab.ru` | LiveKit/TURN для CSP сборок до 2.0.0; `rtc.calab.ru` пока отдаётся клиентам (`LIVEKIT_URL`) | как `rtc.`/`turn.` (`DOMAIN_ALIASES`, `RTC_PUBLIC_HOST`) |
| `meet.gptunnel.ru` | алиас приложения (бренд GPTunneL) | как `app.` |

Конфиг Caddy: `DOMAIN=calab.io`, `APP_HOST=app.calab.io` (по умолчанию = DOMAIN), `LANDING_HOST=calab.io` (пусто = без лендинга), `DOMAIN_ALT`/`DOMAIN_LEGACY` — дополнительные app-хосты, `DOMAIN_ALIASES` — дополнительные зоны для `rtc.`/`turn.`, `LANDING_HOST_ALIASES` / `RELEASES_HOST_ALIASES` — алиасы лендинга (301) и фида (тот же контент), `LANDING_HOST_MIRRORS` — зеркала лендинга (тот же сайт без редиректа). За прокси (`Caddyfile.behind-proxy`, образ веба): `BEHIND_PROXY_PORT` — порт HTTP, `API_UPSTREAM` — адрес API. Сервер: `PUBLIC_APP_URLS` — список разрешённых origin через запятую (`PUBLIC_APP_URL`/`_ALT` остаются для совместимости). LiveKit `turn.domain = turn.${DOMAIN}`; клиентам — `LIVEKIT_URL=wss://${RTC_PUBLIC_HOST:-rtc.${DOMAIN}}`. Почта — `noreply@calab.io`. DNS — Cloudflare, только DNS-only.

## Атрибуция
«Powered by GPTunneL» остаётся обязательной по лицензии (BSL 1.1, NOTICE) — на лендинге в футере, в «О программе», на экране входа.

## Лендинг: чёрный фон и контрастная типографика (2026-10-02)

По решению владельца сайт использует чистый чёрный фон, крупные белые заголовки
(800–850) и фирменный синий для действий и отдельных акцентов. Кнопки — круглые
(pill): основные синие с белым текстом, вторичные белые с чёрным. Серые разделители
и фоновые свечения не используются. Иерархия строится на типографике
и отступах; таблица тарифов использует тёмно-синее чередование строк.
Системная тёмная тема не меняет композицию сайта. Приложение сохраняет свои темы.
На четырёх языках одинаковы возможности и таблица тарифов, включая SSO/OIDC,
Active Directory/LDAPS и OAuth-клиенты в Business/Enterprise. QA-снимки сайта
хранятся вне репозитория; маркетинговые скриншоты приложения остаются в public/screens.

Главная рассказывает о совместной работе: первый экран с переключением реальных
сцен «Обсуждайте / Общайтесь / Делайте», голосовая комната, доска с карточкой задачи,
контроль доступа, тарифы и скачивание. Полный каталог и подробные измерения вынесены
на `/<locale>/features/`; полное сравнение тарифов раскрывается по запросу.
Motion: однократное раскрытие заголовка, появление сцен через IntersectionObserver,
появление карточки задачи и переход при переключении сцены. Только opacity/transform,
без бесконечных циклов, scroll listeners, перехвата прокрутки и скрытого видео.
При reduced motion все сцены доступны без анимации; без JS текст и первая сцена видны.

### Editorial assets and interaction (2026-10-02)

Landing assets in `apps/landing/public/editorial/` are generated with the built-in
image generation tool, then encoded as WebP. People are fictional editorial
illustrations, not customer testimonials or team members. Decorative images use
empty alt text. Original files remain outside the repository in generated_images.

- `team-conversation.webp`: candid photographic diptych, a woman in a cobalt
  sweater laughing during a laptop conversation and a man wearing headphones in
  a warm home studio; natural texture, no logos or text.
- `conversation-stickers.webp`: transparent die-cut cluster of a cobalt smiling
  speech bubble, acid yellow idea spark, white cursor and chrome audio waveform;
  tactile vinyl, off-white edges, no lettering. Real alpha is preserved in WebP.

The hero uses glyph proximity deformation (not a copied proprietary reference
font), offset portraits and contextual hover captions. The product showcase pins
only on large fine-pointer screens without reduced motion, with chat, voice and
board scenes. Native scrolling remains intact; buttons also select each scene.
Scroll listeners are active only while the showcase is intersecting the viewport,
and requestAnimationFrame is scheduled on input rather than an endless loop.
Mobile and reduced-motion variants use ordinary document flow and scene buttons.

### Reference layout study, 2026-10-02

Read-only reference: the owner's local Extrafazant HTML, Webflow CSS and custom
bundle in `/Users/macbook/Downloads/Extrafazant-local`. No reference fonts, artwork,
tracking scripts or implementation bundles are shipped with Calab.

Observed composition and its Calab adaptation:

- Reference hero: centered column, viewport-height opening, oversized uppercase
  heading with a contrasting alternate face. Calab now uses a centered two-line
  heading with a serif italic accent, compact explanation and installation actions.
- Reference introduction: equal columns; portrait at 4:5 rotated -3 degrees, a
  smaller portrait overlapping at +4 degrees, sticker above. Calab uses generated
  portraits in a left-hand paper-framed collage, with product explanation on right.
- Reference featured section: heading inside a viewport-height pin, centered cards
  approximately 80vh wide, 55vh stage, two additional 1.2-viewport scroll intervals.
  Calab uses 340svh total scroll space; chat, voice and board screenshots form a
  centered stack. The top frame translates down and fades near its exit, revealing
  the next frame. The heading remains inside the sticky composition.
- Below the demonstration, access control and pricing remain readable product
  sections rather than reproducing the reference agency's team/client claims.

The previous story CSS was replaced as one coherent section, not layered with
additional competing overrides. Browser inspection was denied by Browser Use;
source analysis and a production build are not visual acceptance evidence.

### Owner refinements: conference row and larger screens

The hero is followed by eight fictional conference portraits in one horizontal
row (scrollable on narrow screens), with place labels and a static speaking
indicator. `public/editorial/conference-eight.webp` was generated with built-in
imagegen as an equal 4×2 photographic atlas: eight different adults joining from
an office in a suit, a sofa, a beach lounger, a studio, a library, a kitchen, a
meeting room and a terrace. Natural webcam perspectives, warm editorial grading,
no names, UI or logos. CSS selects atlas cells; no generated person is presented
as a real customer. The original image remains outside the repository.

Navigation uses a drawn SVG underline on hover/keyboard focus. Initial load has
one finite staggered glyph/header/copy entrance; reduced motion disables it.

Latest owner direction supersedes the earlier compact featured-stack dimensions:
remove the pinned heading and tabs, expand the screenshot stage to the available
viewport (up to 1680px wrapper), and show voice/video, chat, calendar and tasks.
Calendar/chat crops prioritize the populated upper area; the desktop voice scene
keeps the full frame so participants remain visible. Small labeled navigation dots
retain direct access without occupying the screenshot area. This is implemented
and production-build checked; runtime visual acceptance remains pending access.

### Interactive refinements

Portraits now retain their original aspect ratios. Hover/focus expands the selected
card and displaces neighbours; the desktop conference strip extends beyond the
viewport with clipped edges, while mobile retains horizontal scrolling. The intro
collage uses the same reveal principle with paper borders and independent layers.
Conference motion has one transform owner per layer: stable button slots, animated
faces, and a translating row. Selecting an edge card shifts the row just enough to
contain its enlarged face with a 24px inset. Selection follows actual pointer
movement and visible faces, preventing layout-induced hover switches. Keyboard
focus uses the same containment; mobile scrolls the selected card into view and
reduced motion disables transitions.
A new generated transparent `editorial/access-sticker.webp` replaces control icons:
built-in imagegen prompt describes a cobalt key, yellow star keyring and smiling
white padlock, flat tactile screenprint, off-white die-cut edge, no text or backdrop.

The centered white navigation island has three bold links and an animated drawn
underline. Section CTA arrows swap sides on hover/focus. The footer has a bounded
8-image cursor trail, emitted every 100px of pointer movement, fading in 1.1s;
leaving cancels animations. Touch and reduced motion do not emit trails.

Product screenshots now float centered with intrinsic proportions and a soft
shadow, no large background frame. Cursor captions explain the active feature in
a marquee which runs only while hovered. The hero uses real Manrope variable
weight (200–800), not scale transforms: fixed glyph advance boxes avoid shifting.
Font source: google/fonts `ofl/manrope/Manrope[wght].ttf`, SIL OFL license included
in `public/fonts/manrope-OFL.txt`. Alternate line reverses the proximity weight.

The blue hero line retains a contrasting italic serif: Source Serif 4 variable
italic (weight 300 at rest, 800 near pointer). Google Fonts source and SIL OFL
license are saved alongside the self-hosted font. The white line remains Manrope.

The latest hero typography is uppercase without trailing periods: Roboto Condensed
variable for the white line and upright Source Serif 4 variable for the blue line,
matching the owner's uppercase reference. Both retain opposing weight proximity.
Roboto Condensed is self-hosted from google/fonts/ofl/robotocondensed with OFL.

### Sticker expansion and postcard row

Eight built-in imagegen assets are stored in `public/editorial/sticker-*.webp`,
all with preserved alpha. Prompt set: Windows four-pane window and cursor; silver
Mac laptop and apple charm; Linux penguin with terminal; FAQ question speech bubble;
pricing ticket and coin; video camera and audio waves; waving chat bubbles and
heart; checklist and pencil. Shared prompt: isolated die-cut editorial screenprint,
cobalt/acid yellow/off-white, thick imperfect outlines, paper grain, transparent
background, no lettering or watermark. The original generated PNGs stay outside
Git. Platforms, FAQ and pricing use their own stickers; the footer trail cycles
through all eight. Eight scroll-progress thresholds emit themed stickers at random
left/right edge positions for 1.9 seconds. Reduced motion/touch skip this effect.

The owner removed the hero kicker, reduced its description to 14px, selected a
new contrasting Cormorant Garamond variable serif (300–700, bundled OFL), and asked
for a wavy underline with a blue arrow on the discover link. Conference portraits
are now oversized colored postcards with caption bands, slight alternating tilt,
hover expansion and clipped desktop edges, based on the supplied screenshots.

### Source-based motion audit

Re-read `cdn.odyn.dev/auto/g6yf/bundle.js` from the supplied local reference and
its Webflow CSS, specifically Fe (drawn lines), Re (variable weights), Xe (image
trail), Ge (interactive collage), plus `.btn-link_arrow-wrap`.

- Fe rotates a shared index through underline variants, draws for .5s using
  power2.inOut, and erases toward the end rather than rewinding the stroke.
  Calab now rotates original path variants and draws/erases forward in .5s.
- Re uses 400px Euclidean proximity, a delta threshold of 1, cached character
  centers and a .4s power2.out retarget. Calab uses that radius/ease/duration,
  global pointer coordinates and a finite rAF loop; the prior CSS transition and
  heading-leave reset were removed. Centers refresh after font load, reveal,
  resize and scroll. Font-supported weight ranges remain specific to our fonts.
- Xe accumulates abs(dx)+abs(dy), threshold innerWidth/8. Spawn starts at scale1.3,
  elastic settles over .6s; drift is movement delta ×4 over1.5s power4.out; then
  .1s hold and .3s back-in shrink. Calab's bounded pool now samples those motions,
  uses viewport-relative spacing, and lets existing stickers finish on leave.
- Discover link: serif500, gap .375em, square arrow1em, arrow SVG .5em;
  two wrappers translate vertically100% over .525s with
  cubic-bezier(.175,.885,.32,1.275). Underline remains below at130% of text height.
- The collage sticker is now an interactive third layer; hover/focus displaces
  the other layers with .8s cubic-bezier(.3,.075,0,1), including the sticker.
- Screens retain floating intrinsic proportions. Upcoming colored edges and
  four named progress controls reveal order/count without a large backplate.

Build/type/lint evidence is in `/tmp/calaba-motion-audit-build.log`; browser-based
visual acceptance is still pending the previously denied Browser Use access.

Photo-card hover now reveals two randomly selected existing sticker assets from
different edges, with continuous random edge coordinates, depth, size and rotation,
and a 65ms stagger. Decorations sit behind
an opaque card surface, have no hit targets and do not affect layout. Conference
portraits and the two intro photos share this component; focus/tap also activates
it, while reduced motion displays the same state without transitions.
Desktop card sections and the footer trail allow vertical overflow above adjacent
sections; horizontal clipping happens at the page edge, not at section boundaries.

The screenshot showcase now uses opaque, scattered sheets with colored outlines.
Each mount samples offsets, rotation and departure direction once; scrolling moves
successive screenshots to the center and slides previous ones beyond the viewport.
Reverse scrolling retraces the same positions. There is no screenshot opacity
animation, cursor description or labeled preview rail. Colored navigation dots and
the current/total count remain; touch and reduced-motion use direct slide selection.

The control section is a connected infographic: a central Calab hub links own-server
hosting, OIDC/LDAPS sign-in, OAuth applications and role-based access. Enterprise
and Business eligibility is labeled per capability. A compact foundation row names
BSL 1.1 source availability and HTTPS/WSS/DTLS-SRTP transport protection; it makes no
open-source or end-to-end encryption claim. The pricing comparison CTA is removed.
On small screens the hub precedes a two-column capability grid without connectors.

### Scenario photographs (2026-10-02)

The eight portrait cards now show meetings, learning, design reviews, support,
planning, onboarding, remote work and pair work. Each card names the scenario and
its purpose. Existing intro photos remain unchanged. New individual assets live at
`apps/landing/public/editorial/usecase-<scenario>.webp`.

Generated with the built-in imagegen tool. Shared prompt: one portrait 4:5 candid
editorial photograph, fictional adults visibly working, natural light and skin,
subtle film grain, everyday workspace, warm neutrals and small blue accents.
Nobody looks at the photographer. No posed headshots, text overlays, logos,
watermarks or decorative frames. Screens at an angle or from behind, no fake
legible UI. Important faces and activity inside the central 85% for cropping.

Scene prompts:
- **meetings:** A candid small team meeting: a woman in a cobalt blouse explaining a paper diagram to a man in a dark suit at a light wood office table, open laptop with indistinct video call, natural gestures and attentive faces, side-angle view. Both are visibly working together, not posing.
- **learning:** An adult woman taking an online course at her apartment desk, wearing over-ear headphones, writing notes in a paper notebook while attentively watching an open laptop, side three-quarter view with laptop keyboard and notebook clearly visible, warm window light.
- **design:** Two young adult designers at a creative studio desk reviewing a colorful printed layout next to a laptop, one pointing at the paper while the other uses a stylus tablet, focused collaboration, bright natural daylight.
- **support:** An adult male customer support specialist in a blue shirt wearing a subtle microphone headset, seated in a relaxed office, speaking while typing on a laptop, side three-quarter view, natural engaged expression.
- **planning:** A small team of three adults planning a project in a workshop office, arranging colorful sticky notes on a whiteboard with no legible text, one holds notebook and another reaches toward the board, candid documentary composition.
- **onboarding:** An experienced female colleague guiding a new male coworker at a shared office desk, both leaning toward an open laptop, mentor pointing to the display, friendly focused interaction, candid side angle.
- **remote:** An adult man with wireless earbuds working from a sunny covered terrace, seated at a wooden table typing on a laptop with notebook beside it, casual linen shirt, distant sea and greenery, visibly working rather than posing.
- **pairing:** Two software developers collaborating at a home-office desk, a woman with headphones explaining something on a laptop and a man checking his own keyboard, side view with both hands and computers visible, realistic lived-in workspace.

### Extended stickers and quiet hero trail

Six built-in imagegen assets were added at `public/editorial/sticker-{headphones,calendar,rocket,coffee,highfive,lightning}.webp`, resized to fit 420px with alpha preserved. The shared prompt requests a single centered transparent die-cut sticker, bold irregular black contour, solid warm off-white cut-out edge, cobalt blue and acid lemon yellow, tactile screenprint grain and a compact hand-drawn silhouette; no text, logos, scenery, frames or checkerboard. Final subjects:
- **headphones:** oversized cobalt-blue over-ear headphones with a playful tiny lemon-yellow music spark
- **calendar:** a chunky off-white desk calendar with a bold cobalt-blue checkmark and a lemon-yellow folded corner, no numbers or letters
- **rocket:** a squat playful cobalt-blue rocket with an off-white porthole and a bright lemon-yellow flame
- **coffee:** A squat cobalt-blue ceramic coffee mug with white handle and a single yellow zigzag steam shape; flat three-ink graphic, no glow, lighting or shadows.
- **highfive:** two stylized hands giving a high five, one cobalt blue and one lemon yellow, energetic small impact marks
- **lightning:** a bold lemon-yellow lightning bolt with a cobalt-blue offset shadow and two small off-white stars

Hero and footer now share a finite cursor trail. Hero uses three 125px elements,
a minimum travel of max(260px, viewport/4), a 450ms emission interval and a 1500ms
lifetime. Footer retains eight 180px elements, viewport/8 travel and 1900ms motion.
The full 14-sticker library is randomly sampled without immediate repeats and is
also used by photo cards. Buttons render above the trail; pointer events pass
through decorations. Touch/reduced-motion disable the trail, and hidden/offscreen
sections cancel active animations. No idle animation loop or React pointer state.

### Direct scenario-to-product flow

The duplicate two-person intro collage, its paragraph and its interface CTA have
been removed from the homepage. Scenario cards now lead directly to the short
localized heading “Вот где всё происходит” and the screenshot showcase. Desktop
keeps the opaque scattered-sheet scroll motion. Non-pinned layouts (touch, narrow
screens and reduced motion) use a native horizontal scroll-snap strip with a peek
of the next screen, intrinsic image height, synchronized navigation dots and arrow
key support. Reduced motion switches screens without smooth scrolling.
