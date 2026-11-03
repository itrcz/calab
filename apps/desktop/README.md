# @calaba/desktop — Calab desktop client (Electron)

Voice-first team messenger: workspaces → text/voice rooms → chat, voice (LiveKit) and screen sharing. Architecture and rules: `docs/01-architecture.md`, `docs/02-media.md` (the echo rules are mandatory), `docs/04-data-model.md`, `docs/05-realtime-protocol.md`, ADR-0001/0004/0005/0012.

## Running

```bash
pnpm install                                   # also rebuilds uiohook-napi for Electron
pnpm infra:dev                                 # postgres, redis, livekit --dev (repo root)
# API server — see apps/server/README.md (REGISTRATION_MODE=open for local work)
CALABA_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop dev
```

| Command | What it does |
|---|---|
| `pnpm -F @calaba/desktop dev` | electron-vite dev (HMR in the renderer = a full page reload, see below) |
| `pnpm -F @calaba/desktop build` | production build + **installers** via electron-builder: mac dmg+zip (unsigned), on Windows nsis, on Linux AppImage+deb → `dist/` |
| `pnpm -F @calaba/desktop build:app` | build to `out/` only, no installers |
| `pnpm -F @calaba/desktop typecheck` / `lint` / `test` | TS strict (main, renderer, worklet), eslint, vitest (46 unit tests) |
| `CALABA_E2E_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop e2e` | Playwright for Electron: register → workspace → room → message → voice |
| `pnpm -F @calaba/desktop e2e:visual` (`:update` — перезаписать эталон) | Дизайн (docs/08): снимки против мок-API, layout-инварианты, axe-core, обход фокуса по Tab. Нужен dev LiveKit. Локально — только `dark-960` и только ~25 ключевых экранов (`KEY` в `screens.spec.ts`), в работе — `-g`; полная матрица (все экраны, `light`, `1440`) — nightly CI, `CALABA_VISUAL_ALL=1`. См. TESTING.md «1a» и «Parallel visual runs» ниже |


### Parallel visual runs (git worktrees)

**Locally: `dark-960` (the minimum window, 960×600) and only the key screens** (owner, 26.09). `screens.spec.ts` lists ~25 of them in `KEY` (login, onboarding first/screen/done, first run, main chat, message actions and one context menu, DMs, voice room states, stream stage + PiP, camera grid + PiP, noise popover, members panel + one member menu, workspace menu, ⌘K, three settings tabs, one room-settings tab, `i18n-en`); from the `misc` project only the web join card (dark 960) runs. Every other screen (each settings tab, every menu variant, toasts…) is `skip`ped unless `CALABA_VISUAL_ALL=1`; the code stays. Only the key `*-dark-960.png` darwin baselines are committed. The other configurations (`dark-1440`, `light-960`, `light-1440`), all other screens, the focus walk and the other web screens run only with `CALABA_VISUAL_ALL=1`, which the nightly CI workflow sets to cover the full matrix on Linux (`.github/workflows/visual-nightly.yml`, baselines in `__screenshots__/linux/`). While working on a feature, run only the touched screens with `-g`; the whole local set (29 tests, ~1.7 min with the build on an M-series Mac) is a pre-release check.

On the owner's machine it is always 1 worker; never run two Electron instances at once (`CALABA_VISUAL_WORKERS` defaults to 1, see `playwright.visual.config.ts`). Electron and the web chromium projects launch with `--mute-audio` — no room join/leave sounds during a run.

Every checkout on this machine shares one dev LiveKit. Two visual runs must not share the mock's port or its LiveKit room names, or their participants meet in one room. The main tree keeps the defaults: port 39170 and prefix `mock_`. The baseline for the auth shots is taken there, because the login screen prints the port. A **worktree** always runs with its own port and prefix:

```bash
CALABA_VISUAL_MOCK_PORT=39270 MOCK_LIVEKIT_ROOM_PREFIX=wt_ CALABA_VISUAL_OUT=test-results/wt \
  pnpm -F @calaba/desktop e2e:visual -g "<screens>"
```

Each screen is its own test named like its snapshot (`e2e-visual/screens.spec.ts`); the four configurations are Playwright projects (`dark-960`, `dark-1440`, `light-960`, `light-1440`; all but `dark-960` gated by `CALABA_VISUAL_ALL=1` above); focus walk and web screens are the `misc` project (locally only the join card).

```bash
pnpm -F @calaba/desktop e2e:visual -g "voice-pip$"                                    # one screen, dark-960
CALABA_VISUAL_ALL=1 pnpm -F @calaba/desktop e2e:visual -g "voice-pip$"                # one screen, all 4 configs
pnpm -F @calaba/desktop e2e:visual:update -g "voice-camera-(grid|pip)$"               # re-record two screens (dark-960)
CALABA_VISUAL_ALL=1 npx playwright test --config playwright.visual.config.ts --list   # all names, all projects
```

Every test starts from a clean seeded state (`e2e-visual/app.ts`: mock reset, storage wiped, reload, sign-in), so any screen runs alone.

**Why the baselines changed with the split.** In the old single sequential test, axe runs on earlier screens (`checkpoint` → `expectAccessible`) changed how Chromium lays out later text: 15 px system text came out ~10 % narrower, with identical computed styles and fonts. A fresh page — what users see — renders it wider. The per-screen tests reload before every screen and match the real rendering. Don't reintroduce shared state between screens. When `CALABA_VISUAL_WORKERS` is raised above the default (1) — only with `CALABA_VISUAL_ALL=1`, off the owner's machine — workers run in parallel, each with its own Electron app, mock port (base + 1 + worker) and LiveKit room prefix.

`auth-*` snapshots from a worktree show 39270; do not commit them (`git checkout -- 'e2e-visual/__screenshots__/darwin/auth-*'`).

### Environment variables

| Variable | Purpose |
|---|---|
| `CALABA_SERVER_URL` | API address (overrides the value saved in settings). There are no hosts in the code: when the variable is unset, the user enters the address on the login screen |
| `MAIN_VITE_DEFAULT_SERVER_URL` | Build-time default server for installers (`.env.production`: `https://app.calab.io`). First run only: a saved server (e.g. `https://app.calab.ru` from builds before 2.0.0) is never rewritten (docs/06 «Домены») |
| `MAIN_VITE_UPDATE_FEED` | Build time. The pinned update feed, the only one updates are auto-installed from (https only). `.env.production` sets `https://releases.calab.io/` for `build` (builds before 2.0.0 use `https://releases.calab.ru/` — the same feed); `build-release.sh` passes `UPDATE_FEED`. Empty (dev, `electron-vite dev`) → notify-only |
| `MAIN_VITE_UPDATES_SIGNED=1` | Build time, only for signed + notarized macOS builds (`build-release.sh`: `SIGN=1 NOTARIZE=1`; CI: when signing is real). Enables macOS auto-install (Squirrel.Mac refuses unsigned updates) |
| `CALABA_UPDATE_URL` | Runtime, **notify-only** feed override for testing (https only): replaces the feed and disables auto-install. Not settable from the UI |
| `CALABA_USER_DATA` | Separate profile directory (tests, two instances on one machine) |
| `CALABA_MULTI_INSTANCE=1` | Disable the single-instance lock (a second instance for local testing) |
| `CALABA_FAKE_MEDIA=1` | Fake Chromium devices: the mic beeps, the screen is a test pattern, no OS permission prompts. Automation only |
| `CALABA_MAC_SYSTEM_AUDIO=0` | Do not enable the Chromium features for macOS system audio |
| `CALABA_FORCE_RELAY=1` | Test flag: ICE relay only (checks the TURN path) |
| `REMOTE_DEBUGGING_PORT` | (electron-vite dev) CDP port for automation |

### Updates

electron-updater, generic provider; the logic is a pure state machine in `src/main/updateFlow.ts` (unit-tested with a fake updater), wired to Electron in `src/main/updater.ts`.

- **Feed trust** (`src/shared/updateFeed.ts`). Unsigned Windows and AppImage updates are checked only by the sha512 in `latest*.yml`, which comes from the same host. So automatic download and install happen **only** from the build-time feed `MAIN_VITE_UPDATE_FEED` (https). The server, the renderer and runtime env cannot change that feed.
  - Without a build feed, the feed is derived from the server (`https://app.X` → `https://releases.X/`, any other host → `https://<host>/download/`) and used for notify-only.
  - `CALABA_UPDATE_URL` is a notify-only override.
  - Dev (unpackaged) builds never check.
- **Checks:** 10 s after start, then every hour (the period is shifted by a random ±5 min per run, so clients do not hit the feed on the hour), plus «Проверить» in Settings → «О программе». Wake from sleep, screen unlock and the network coming back (the renderer's `online` event over IPC) trigger a debounced check, at most once per 10 min. «Проверять обновления автоматически» (Settings → «Приложение», default on) off → only «Проверить» checks.
- **Calls:** while the user is in a call / stream (tray state `inVoice` from the renderer) a found update is not downloaded; it waits as «available» and downloads when the call ends. A download already running keeps going.
- **Auto** needs the build feed, «Автоматически обновлять» on, and one of: Windows, Linux AppImage, or macOS built with `MAIN_VITE_UPDATES_SIGNED=1`. The update downloads in the background (progress in «О программе»). A banner in the bottom island then says «Calab X готова» with «Перезапустить» (and ✕: hidden until the next check, which re-announces it), and the tray menu gets «Перезапустить для обновления X». Quitting without pressing it installs the update too.
- **Notify only** covers everything else: no build feed, the runtime override, unsigned macOS, Linux deb/other, or the setting off (default on). A system notification «Доступна версия X — Скачать» opens the human download page: `https://<server>/download/`, or the build feed when there is no server.
- **Errors** go to the log only (`logs/main.log`, `[update]`); «О программе» shows «Не удалось проверить обновления». No toasts.

## Web client (ADR-0015)

The same renderer runs in a browser at `https://app.<domain>`. Platform differences live in `src/renderer/platform/` (`electron.ts` — preload bridge, `web.ts` — browser APIs). The choice is made at build time: `VITE_PLATFORM=web` (`.env.web`), and the other branch is dropped from the bundle.

| Command | What it does |
|---|---|
| `pnpm -F @calaba/desktop build:web` | `dist-web/` (Vite `--mode web`) + check that no Electron code reached the bundle (`scripts/check-web-bundle.mjs`) |
| `pnpm -F @calaba/desktop preview:web` | serves `dist-web` on :4173, proxies `/api` and `/gateway` to `CALABA_WEB_PROXY` (default `http://127.0.0.1:3000`) |
| `pnpm -F @calaba/desktop dev:web` | the same with HMR on :5174 |
| `CALABA_WEB_URL=… pnpm -F @calaba/desktop e2e:web` | Playwright: Chromium + Firefox |

- **Auth.** Requests carry `X-Client: web`. The server puts the refresh token into the `calaba_refresh` cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/auth); the access token is kept in memory only. Refresh is a `POST /api/auth/refresh` with an empty body. If the server returns the refresh token in the response body instead (no cookie mode), it is kept in memory only. Tabs serialize refresh with Web Locks.
- **API.** Same-origin `fetch` with Bearer and one repeat after refresh on a 401. Images go through a blob: URL of an authenticated fetch (`MediaImg` / `useMediaUrl`).
- **Web vs desktop:** PTT works only while the tab is focused; the screen is chosen in the browser's own picker (capture happens before `/stream/request` — the click's user activation is needed); notifications use the Notification API; downloads use `a[download]`; invites use `/join/<code>`; there is no tray, auto-update or autostart.
- **Phone layout (ADR-0021, stage A).** At ≤ 768 px the web build switches to one column (`lib/mobile.ts`, `features/shell/MobileShell.tsx`; CSS variant `mobile:` = `:root.web` + the media query, so Electron never matches): the room full screen with ☰ in its header, rail + rooms + the bottom island in a left drawer (☰ / edge swipe), members in a right drawer, the voice strip at the bottom (mute, deafen, hold-to-talk in PTT mode, hang up). The shell is `100dvh` and follows `visualViewport` only while the keyboard is up (composer above the keyboard, sheets lifted by `--kb-inset`), iOS safe areas, 16 px fields, no programmatic focus of fields on phones (`lib/phone.ts`, docs/08 «Мобильный веб»); menus and popovers are bottom sheets, `Modal` is a bottom sheet, settings a full-height sheet. PWA: `manifest.webmanifest` + install-only `sw.js` (no fetch handler, no cache). Tests (self-contained: mock API + `dist-web`; dev LiveKit for voice):
  - e2e: `pnpm build:web && pnpm e2e:web --project iphone-14 --project pixel-7 --project webkit-iphone-14 --project webkit-iphone-se-3rd-gen` — Chromium with fake media and WebKit (the iOS Safari engine; no fake mic, voice joins listen-only, PTT held from the keyboard). Mock on `CALABA_MOBILE_MOCK_PORT` (default 39470); `CALABA_MOBILE_SHOTS=<dir>` saves the screens.
  - visual: `pnpm e2e:visual:mobile` (`:update` to re-record) — `e2e-visual/mobile.visual.spec.ts` in WebKit on iPhone 14 (390, snapshots in `e2e-visual/__screenshots__/webkit-iphone/`), iPhone SE 3rd gen (375) and 14 Pro Max (430) (layout invariants + axe only); one test per screen (`-g "m-chat"`): `m-login`, `m-join`, `m-onboarding`, `m-chat`, `m-drawer`, `m-members`, `m-voice`, `m-dm-list`, `m-dm-chat`, `m-settings` + unsnapshotted `m-chat-empty`, `m-sheet`, `m-dialog`, `m-keyboard` (stubbed `visualViewport`). The notch / home indicator are simulated (`--safe-top` 47, `--safe-bottom` 34). `MOCK_LIVEKIT_ROOM_PREFIX` defaults to `mobile_`; `CALABA_MOBILE_SHOTS=<dir>` saves every device's screens.
- **Codecs.** The stream codec is AV1 if the browser can encode it, otherwise VP9, otherwise VP8. In Firefox, if the microphone runs at a sample rate other than 48 kHz, RNNoise is turned off and built-in noise suppression is used.

## Structure

```
src/main/            Node process (privileges): windows, auth broker, calaba-api:// proxy, tray,
                     deep links, PTT (uiohook), desktopCapturer, updater, logs
  auth.ts            refresh token only in main (safeStorage), single-flight access token refresh
  apiProtocol.ts     calaba-api://api/<path> → <server>/<path> + Bearer (no CORS; <img> works)
  windows.ts         main window (size/position remembered), stream pop-out only via window.open
src/preload/         narrow typed bridge window.calaba (api.d.ts)
src/shared/ipc.ts    IPC contract main ↔ renderer
src/renderer/
  app/               root, theme, Tailwind v4 tokens (dark/light)
  i18n/              t() + ru dictionary (keys are typed; to add en, add a second dictionary)
  lib/api            typed REST over the generated schemas (protojson: enum names, uint64 as strings)
  lib/gateway        WS gateway client (binary protobuf): HELLO/IDENTIFY/RESUME, heartbeat+jitter, backoff 1→30 s, close codes
  lib/markdown       markdown-lite → AST → React (no HTML)
  lib/media          mic pipeline + RNNoise/VAD worklet, screen share (AV1 simulcast), getStats
  lib/permissions.ts UI helpers on top of computePermissions (the client only hides UI)
  lib/voiceLogic.ts  pure mute/deafen/gate/link-quality rules
  stores/            zustand: session, workspaces, rooms, messages, voice, ui, prefs, toasts
  services/          bootstrap/session, gateway + dispatch → stores, chat, voice (VoiceEngine), notify, profile sync
  features/          auth, shell (rail, rooms, «me» panel, voice bar, members), chat, voice (stream), workspace, settings
```

Business logic lives in `services/` and `stores/`; components only render and call them.

## Key decisions

- **The refresh token is never in the renderer.** Main stores it with `safeStorage` (Keychain/DPAPI/libsecret). If the OS has no keyring, it is kept in memory only (you log in again after a restart). The renderer only gets a short-lived access token (for gateway IDENTIFY).
- **API through `calaba-api://`.** The server has no CORS, and the renderer's origin is `file://`/localhost. Main forwards requests, adds the Bearer token and repeats an idempotent GET once after a 401. Files and thumbnails are plain `<img src="calaba-api://api/api/files/…">`. Uploads use XHR (progress) with a streamed body.
- **Gateway:** binary protobuf frames, `seq` deduplication, RESUME after a drop, `powerMonitor.resume` → immediate reconnect. Close codes: 4004 → refresh + reconnect (otherwise the login screen), 4008 before READY → the «слишком много устройств» screen with no retry loop, 4010 → the login screen. The client subscribes (SUBSCRIBE) to the open room, because the server sends TYPING_START only for subscribed rooms.
- **Voice** (docs/02, ADR-0004):
  - remote audio plays only through `<audio>` (`webAudioMix: false`);
  - the output device is switched with `setSinkId` on the same elements;
  - per-participant volume goes up to 100 % (a boost would need WebAudio);
  - UI sounds also play through `<audio>`.
- **Mic, two layers.** Explicit mute/deafen = LiveKit `track.mute()` (the server derives voice-state `muted` from this through webhooks). The VAD gate and PTT only switch `mediaStreamTrack.enabled`: silence + DTX, no signalling. So a pause in speech does not become a «mute» event for everyone.
- **Stream** (ADR-0012):
  - AV1 + simulcast, L1T3 per layer, a 640×360 layer for the PiP;
  - `POST /api/rooms/{id}/stream/request` before publishing (a 409 means the limit is reached);
  - `autoSubscribe: false`: audio is subscribed automatically; the screen and its sound only when the stream is watched (PiP / expanded).
- **Camera** (ADR-0018, `services/camera.ts`, `lib/media/cameraLogic.ts`, `features/voice/CameraTiles.tsx`):
  - VP9 + simulcast 180/360/720p (L1T3 per layer), `contentHint: motion`, ceilings 0.15 / 0.5 / 1.5 Mbps;
  - capture → `POST /api/rooms/{id}/camera/request` (409 = camera limit) → publish; off = unpublish + `…/camera/stop`; `VOICE_CAMERA_STOP` stops it locally with a toast;
  - all cameras subscribed except «Не показывать видео»; «Экономить трафик» keeps only the featured / PiP camera at ≤ 360p; CPU-limited encoder → 360p capture;
  - chat open: PiP of the active speaker's camera; call view: up to 6 tiles (`tileLayout.ts`), a watched stream stays primary with cameras in the strip.
- **Pop-out stream window.** A same-origin child window (`window.open` + React portal) shows the same MediaStreamTrack. The large element in the main window stays attached, so adaptive stream keeps the top layer.
- **«N смотрят»** is computed through the LiveKit data topic `calaba.watch` (an ephemeral in-call signal; docs/05 allows data channels for this).
- **Unread messages** — `Room.last_message_id` from READY vs `ReadState`, then MESSAGE_CREATE.
- **Voice reconnect.** When LiveKit cannot resume the session itself (disconnect reason other than «user left», «removed by a moderator», «room closed»), the client repeats `/join`: 1, 2, 4… s, up to 5 attempts.
- **Dev media stats** (Settings → Приложение): an overlay in the voice room with the ICE path, RTT, loss, bitrates and encoder/decoder per layer.
- **Synced settings.** RNNoise, RED, `mic_mode`, the PTT key and the personal voice bitrate cap are stored in `UserSettings` (PATCH /api/me, USER_UPDATE). Defaults for new users are set by the server.

## Packaging and signing

`electron-builder.yml`: `mac.identity: null` (unsigned until the Developer ID arrives), hardened runtime and entitlements (`build/entitlements.mac.plist`) are ready. `protocols: calab://` (+ the pre-rename alias `calaba://`) is registered in Info.plist. The icon is the default Electron one (artwork TBD).

## Store screenshots (App Store / Google Play, board #111)

`pnpm -F @calaba/desktop screenshots:store` — capture → compose → validate (WebKit/Chromium only, no Electron; builds `dist-web` first).

- **Capture** (`e2e-marketing/store-shots.spec.ts`): the web client on an iPhone 14 viewport at 3x against the marketing mock, ru + en, dark; raw 1170×2532 shots go to `apps/mobile/store/raw/` (git-ignored). `CALABA_STORE_SCENES=tasks,calendar` captures only some scenes.
- **Scenes** live in one list, `e2e-marketing/store/scenes.ts`: `id`, headline ru/en, `run` (how to reach the screen). Adding a screen = adding an entry; shared mock data is in `store/harness.ts`.
- **Compose** (`store/compose.ts`): Chromium renders the HTML template `store/template.ts` — gradient, font, headline size, phone frame/shadow and status bar are all tweaked there (brand colors from docs/10-branding.md; the app's system font stack). No Figma needed in phase 1: the background and frame assets are this template.
- **Output** (committed) in `apps/mobile/store/`: `ios/{ru,en}/NN-<id>.png` 1206×2622, `android/{ru,en}/NN-<id>.png` 1080×1920, `icons/icon-1024.png` (no alpha, from `apps/mobile/assets/icon-1024.png`), `icons/icon-512.png` (alpha), `feature/{ru,en}/feature-graphic.png` 1024×500.
- **Validate** (`store/validate.ts`): exact sizes, no alpha where forbidden, icon-512 ≤ 1 MB; exits 1 listing the problems.
