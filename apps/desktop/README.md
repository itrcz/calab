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
| `pnpm -F @calaba/desktop e2e:visual` (`:update` — перезаписать эталон) | Дизайн (docs/08): снимки dark/light × 960/1440 против мок-API, layout-инварианты, axe-core, обход фокуса по Tab. Нужен dev LiveKit. См. TESTING.md «1a» |

### Environment variables

| Variable | Purpose |
|---|---|
| `CALABA_SERVER_URL` | API address (overrides the value saved in settings). There are no hosts in the code: when the variable is unset, the user enters the address on the login screen |
| `MAIN_VITE_DEFAULT_SERVER_URL` | Build-time default server for installers (`.env.production`: `https://app.calab.ru`) |
| `MAIN_VITE_UPDATE_FEED` | Build time. The pinned update feed, the only one updates are auto-installed from (https only). `.env.production` sets `https://releases.calab.ru/` for `build`; `build-release.sh` passes `UPDATE_FEED`. Empty (dev, `electron-vite dev`) → notify-only |
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
- **Checks:** 10 s after start, then every 6 h, plus «Проверить» in Settings → «О программе». There is also a debounced re-check after wake from sleep, and after a failed check once the network goes offline → online.
- **Auto** needs the build feed, «Автоматически обновлять» on, and one of: Windows, Linux AppImage, or macOS built with `MAIN_VITE_UPDATES_SIGNED=1`. The update downloads in the background (progress in «О программе»). A banner above the self panel then says «Обновление X готово» with «Перезапустить». Quitting without pressing it installs the update too.
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
- **Pop-out stream window.** A same-origin child window (`window.open` + React portal) shows the same MediaStreamTrack. The large element in the main window stays attached, so adaptive stream keeps the top layer.
- **«N смотрят»** is computed through the LiveKit data topic `calaba.watch` (an ephemeral in-call signal; docs/05 allows data channels for this).
- **Unread messages** — `Room.last_message_id` from READY vs `ReadState`, then MESSAGE_CREATE.
- **Voice reconnect.** When LiveKit cannot resume the session itself (disconnect reason other than «user left», «removed by a moderator», «room closed»), the client repeats `/join`: 1, 2, 4… s, up to 5 attempts.
- **Dev media stats** (Settings → Приложение): an overlay in the voice room with the ICE path, RTT, loss, bitrates and encoder/decoder per layer.
- **Synced settings.** RNNoise, RED, `mic_mode`, the PTT key and the personal voice bitrate cap are stored in `UserSettings` (PATCH /api/me, USER_UPDATE). Defaults for new users are set by the server.

## Packaging and signing

`electron-builder.yml`: `mac.identity: null` (unsigned until the Developer ID arrives), hardened runtime and entitlements (`build/entitlements.mac.plist`) are ready. `protocols: calab://` (+ the pre-rename alias `calaba://`) is registered in Info.plist. The icon is the default Electron one (artwork TBD).
