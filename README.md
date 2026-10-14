<p align="center"><b>English</b> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img src="apps/desktop/build/icons/web/icon-192.png" width="96" alt="Calab">
</p>

<h1 align="center">Calab</h1>

<p align="center">
  Your whole team in one window: voice rooms, chat, meetings and tasks — on your own server.<br>
  <sub>Self-hosted voice-first team messenger. macOS · Windows · Linux · Web.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue"></a>
  <a href="https://github.com/itrcz/calab/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/itrcz/calab/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Electron" src="https://img.shields.io/badge/desktop-Electron-47848F">
  <img alt="Go" src="https://img.shields.io/badge/server-Go-00ADD8">
  <img alt="LiveKit" src="https://img.shields.io/badge/media-LiveKit-ff6b35">
  <a href="https://calab.io/en/"><img alt="calab.io" src="https://img.shields.io/badge/site-calab.io-0A84FF"></a>
</p>

<p align="center">
  <img src="apps/landing/public/screens/en/voice.webp" width="880" alt="Calab during a planning meeting: a shared slide on the stage, participants’ cameras, the workspace rooms">
</p>

---

## What it is

Calab is a team messenger where **voice** comes first. Join a room and you hear your colleagues right away; next to it is a Telegram-style chat, a calendar with meetings and Linear-style task boards. Everything runs on your own server: one `docker compose`, PostgreSQL and LiveKit inside, no external services or subscriptions.

It is built for teams of up to 20–30 people in voice at once and up to 3 screen shares per room. The client is light: 0.05 % CPU outside a call and ≈ 7 % in voice on a MacBook Air M4.

## Features

### 🎙 Voice and video

<img src="apps/landing/public/screens/en/call.webp" width="880" alt="A one-on-one call in direct messages">

- **Voice rooms** — one click to join; who is talking is visible right in the room list; room status, timer and member limit.
- **Clean sound** — AEC3 echo cancellation and RNNoise noise suppression (no external services), Opus with DTX; voice activation or **push-to-talk** on any key, even in the background.
- **Musician mode** — a personal toggle that turns off echo cancellation, noise suppression and auto gain and switches Opus to a music profile (128 kbps mono / 192 kbps stereo, FEC, no DTX): play an instrument or sing live without the processing eating the sound. Headphones required; others see a guitar icon next to your name. Team and above.
- **Screen sharing** in AV1 or hardware H.264 with simulcast — each viewer gets the quality their connection allows; viewers can point and draw on top of the stream.
- **Camera** with background blur or a picture (built-in and workspace backgrounds).
- **One-on-one calls** in direct messages, with ringing, camera and screen sharing.
- **Meeting recordings** — the server records, GPTunneL transcribes; a card with the summary, audio and full transcript arrives in the room chat.
- **Soundboard**, moderation (server mute, disconnect, move by drag and drop), statuses.
- **Phone calls (SIP)** — connect your own SIP provider and dial a landline or mobile number from a voice room; the callee joins as a participant, everyone sees “Dialling → Ringing → On the call”. Provider settings, a call log, a “Place calls” permission that nobody has by default. Business plan and Enterprise ([ADR-0046](docs/adr/0046-sip-telephony.md)).
- **Temporary rooms** — a room for an hour or a day with a ready guest link and an optional calendar meeting: a Zoom replacement that disappears by itself ([ADR-0044](docs/adr/0044-temp-rooms.md)).

### 💬 Chat

<img src="apps/landing/public/screens/en/chat.webp" width="880" alt="The “general” room: a mockup with reactions, a reply and a sticker">

- Bubbles like Telegram: replies, **reactions**, forwarding to several chats, stickers, voice messages, files with previews, pins, read ticks.
- **Mentions**, per-room notifications, workspace search with morphology, `⌘K` quick switcher.
- **Direct messages** with an archive; the web app adapts to phones and installs to the home screen.

### 📅 Calendar and meetings

<table>
  <tr>
    <td width="50%"><img src="apps/landing/public/screens/en/calendar.webp" alt="The day view with a meeting card"></td>
    <td width="50%"><img src="apps/landing/public/screens/en/findtime.webp" alt="Find a time for four people"></td>
  </tr>
</table>

- A day view with meetings side by side, the meeting card with attendees and answers, the room with a “Go” button, recurring meetings, reminders.
- **Invitations by email** with `invite.ics` — the meeting lands in Apple, Google, Outlook or Yandex calendars; external attendees answer by link and join as guests.
- **Find a time** — colleagues’ busy columns, shared free windows and the nearest slots within everyone’s work hours.
- **CalDAV** — connect Yandex, iCloud, Fastmail or Nextcloud: your busy time counts, Calab meetings appear there by themselves.

### ✅ Task boards

<img src="apps/landing/public/screens/en/kanban.webp" width="880" alt="The Product board as a kanban">

<table>
  <tr>
    <td width="68%"><img src="apps/landing/public/screens/en/timeline.webp" alt="The board timeline"></td>
    <td width="32%"><img src="apps/landing/public/screens/en/task.webp" alt="The task panel with comments"></td>
  </tr>
</table>

- **Kanban, list and timeline** (Gantt with milestones and a “today” line), in the spirit of Linear, with its keyboard shortcuts.
- Statuses, priorities, labels, milestones, due dates; several assignees with a lead, subtasks and relations.
- Comments like chat — reactions, stickers, voice messages — mixed with the change history.
- Filters, saved views, bulk actions; **create a task from any message**; a task link unfolds into a card in the chat.

- **Approvals** — assign approvers and how many approvals are needed (all or N of M); a task can’t move on until it is approved ([ADR-0049](docs/adr/0049-task-approvals.md)).
### 📚 Wiki

<img src="apps/landing/public/screens/en/wiki.webp" width="880" alt="Team wiki">

Pages and sub-pages like Notion: a rich editor with tables, checklists, code and images, real-time co-editing with live cursors, version history with restore, access per page and public read-only links.

### 🗂️ Disk

<img src="apps/landing/public/screens/en/disk.webp" width="880" alt="Team drive">

Folders and files of the workspace: drag & drop upload, tiles or list, access per folder (private folders are hidden even from admins), public file links, trash with auto-cleanup and a clear storage meter.

### 📝 Notes

Up to 20 private shelves with your own names and emoji — like Saved Messages in Telegram, only several. Drag messages and files onto a shelf, forward to it, pin and search.

### 🚪 Guests and approval

<img src="apps/landing/public/screens/en/guest.webp" width="360" alt="A guest waiting for the organizer’s approval">

A guest link leads straight into a room — no sign-up. With approval turned on (per room or per link), the guest waits on this screen until the organizer clicks “Let in”.

### 🧩 Web apps

An admin pins site shortcuts (Grafana, the wiki, the CRM) under the workspace icon in the left rail. A click opens the site full-window inside Calab and the call keeps going; logins are kept separately per app, camera and microphone only with your permission ([ADR-0050](docs/adr/0050-workspace-apps.md)).

### 🤖 Bots and SDK

A bot is a member with a token: the same REST and gateway as the app, rights through roles. It reads and writes chat, answers `/commands`, talks in voice rooms (LiveKit, Node / Python / Go) and works with boards within its rights; events arrive over WebSocket or a webhook with an HMAC signature. Bot API v2 adds the calendar (meetings, free/busy, finding a time), member profiles, invitations, badges, guest admission and meeting recording, plus buttons under messages ([ADR-0051](docs/adr/0051-bot-api-v2.md)).

```ts
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.io' });
bot.on('message', (m) => bot.reply(m, m.content));
await bot.start();
```

SDK — [`packages/bot-sdk`](packages/bot-sdk), examples — [`examples/bots`](examples/bots) (echo, voice echo, TTS, Python), docs — [docs/19-bot-api.en.md](docs/19-bot-api.en.md) · [Русский](docs/19-bot-api.md).

### 🔒 Self-hosted and secure

- **Identity 2.0** — workspace-scoped OIDC SSO, LDAPS lifecycle sync and OAuth/OIDC clients for “Sign in with Calab”, with explicit linking, consent and owner recovery. Requires a positive workspace grant plus Business or operator-approved on-prem Enterprise. Keycloak 26.4.7 RP evidence is available; live Entra ID, AD FS and Windows AD compatibility remains unverified. Setup and activation gates: [deployment guide](docs/06-deployment.md#identity-20-настройка-и-приёмка).
- **Works everywhere**: UDP → ICE/TCP → TURN/UDP 443 → TURN/TLS 443 automatically; one public IP; tested behind VPNs.
- Media — DTLS-SRTP; API — HTTPS/WSS, HSTS, strict CSP, argon2id, refresh-token rotation with reuse detection, rate limits. Ordinary web refresh uses `HttpOnly/SameSite=Strict`; identity browser binding, scoped SSO refresh and root authorize resolver cookies use `Secure/HttpOnly/SameSite=Lax` for browser redirects ([cookie contract](docs/plans/release-2.0-identity.md#браузерный-consent-и-cookies)). No end-to-end encryption yet: media goes through your own media server.
- Every right (rooms, boards, calendar) is checked on the server; the LiveKit grant mirrors the rights.
- **Roles by function** — separate rights for boards, members, bots, integrations, journals, events and recordings; private and closed rooms and boards that even administrators can’t see ([ADR-0048](docs/adr/0048-roles-v2.md)).
- **Docker Compose** with hardened containers, automatic Let’s Encrypt certificates, daily backups with verified restore, Prometheus metrics; PostgreSQL 17 or 18.

## Roadmap

Planned, not available yet:

- **Voice AI assistant** — a voice AI assistant in rooms (in testing).
- **IVR** — a voice menu and internal extension numbers for phone calls (SIP).
- **Wiki** — a team knowledge base.
- **Disk** — shared file storage for the workspace.

## Quick start

### Your own server

You need a Linux host with a public IP, Docker + Compose and a domain with A records for `app`, `rtc`, `turn` (and `@` for the site).

```bash
git clone https://github.com/itrcz/calab.git && cd calab
cp infra/docker/.env.example infra/docker/.env   # DOMAIN, secrets — see the comments
infra/docker/deploy.sh                            # Caddy, LiveKit, API, Postgres, Valkey
```

Ports: `80/443` TCP, `443/UDP`, `7881/TCP`, `7882/UDP`. The first registered user becomes the server owner; everyone else joins by invitation. The full guide, backups and hardening — [docs/06-deployment.md](docs/06-deployment.md).

### The app

Builds for macOS, Windows and Linux are at [calab.io](https://calab.io/en/#download) and on your server at `https://app.<domain>/download/`; the web app is at `https://app.<domain>`. What’s new in each version — [CHANGELOG.md](CHANGELOG.md) (in Russian; the same text goes into [GitHub Releases](https://github.com/itrcz/calab/releases)).

### Development

```bash
corepack enable && pnpm install && make gen       # protobuf → Go + TS
pnpm infra:dev                                    # Postgres, Valkey, LiveKit --dev
cd apps/server && go run ./cmd/server serve       # API on :3000
pnpm -F @calaba/desktop dev                       # Electron
```

Checks: `make lint` from the repository root, `make test` (Go + TS), `make test-integration` with an isolated test environment. Visual suites are disabled by the owner; Identity 2.0 final acceptance commands are in [TESTING.md](TESTING.md#identity-20-final-acceptance). Architecture: [overview](docs/01-architecture.md) · [media](docs/02-media.md) · [network](docs/03-network.md) · [data model and rights](docs/04-data-model.md) · [realtime protocol](docs/05-realtime-protocol.md) · [design system](docs/08-design.md) · [ADR](docs/adr/).

## Plans

| | Free | Team | Business | Enterprise (your own server) |
|---|---|---|---|---|
| Voice room | up to 5 people | up to 15 people | up to 50 people | unlimited |
| Workspace members | up to 50 | up to 100 | up to 500 | unlimited |
| Audio quality | up to “Normal” | any, up to “Excellent” | any | any |
| Screen sharing and camera quality | up to 720p / 15 fps | no quality limits | no quality limits | no quality limits |
| Screen shares at once in a room | 1 | 2 | 5 | unlimited |
| Cameras at once in a room | 3 | 10 | 25 | unlimited |
| Files | 5 GB per workspace | 300 GB per workspace | 1 TB per workspace | unlimited |
| Bots | 1 | 5 | 20 | unlimited |
| Sticker packs | 1 | unlimited | unlimited | unlimited |
| Task boards | 3 | 30 | 50 | unlimited |
| Calendar | ✓ | ✓ | ✓ | ✓ |
| CalDAV sync | — | ✓ | ✓ | ✓ |
| Task approvals | ✓ | ✓ | ✓ | ✓ |
| Embedded web apps | ✓ | ✓ | ✓ | ✓ |
| Identity 2.0: SSO / directory / OAuth provider | — | — | positive workspace grant | positive grant + operator workspace allowlist |
| Telephony (SIP) | — | — | ✓ | ✓ |
| White-label | — | — | — | ✓ |
| Support | — | support | priority | — |
| Price | free | on request (**it@gptunnel.ai**) | on request (**it@gptunnel.ai**) | free for non-commercial use (BSL 1.1, “Powered by GPTunneL”); commercial licence on request |

Free, Team and Business are cloud plans of a workspace ([ADR-0024](docs/adr/0024-plans-and-limits.md)); Enterprise is your own server with no plan limits. CalDAV belongs to a person: it works if any of their workspaces is on Team or above. Details — [calab.io/en/#pricing](https://calab.io/en/#pricing) and [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

## Licence

**Business Source License 1.1** — [LICENSE](LICENSE).

- Non-commercial use (personal, non-profits, education, evaluation up to 30 days) is **free**, with “Powered by GPTunneL” in the interface and the [NOTICE](NOTICE) kept.
- Commercial use — under a GPTunneL licence: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), **it@gptunnel.ai**.
- Every version becomes Apache-2.0 four years after its release.

Calab and GPTunneL names and logos are trademarks, see [TRADEMARKS.md](TRADEMARKS.md).

## Contributing and security

Pull requests are welcome with a CLA — [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately to **it@gptunnel.ai**, see [SECURITY.md](SECURITY.md).

<p align="center"><sub>© 2026 GPTunneL · Powered by <a href="https://gptunnel.ai">GPTunneL</a></sub></p>
