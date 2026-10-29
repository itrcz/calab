# iOS calendar widgets implementation plan

**Goal:** Ship-ready local implementation of four native iPhone calendar widgets, primary medium Today & Tomorrow, independently reviewed and verified on a physical phone; no autonomous merge.

**Architecture:** Existing WidgetKit extension + minimized server feed with session-bound read-only grant + shared Keychain/App Group cache + additive fenced WebView bridge. Shared-web calendar remains the action/details UI.

**Tech stack:** Go/sqlc/protobuf, TypeScript React/Expo, SwiftUI/WidgetKit/Keychain.

**Spec:** `docs/adr/0145-ios-calendar-widgets.md`.

**Base:** origin/main 6dc586f0; isolated existing worktree, branch codex/ios-calendar-widgets-20261026. Preserve unrelated .gitignore edit. Integration refreshed to origin/main `5e71164e` on October 27; unreleased migration/ADR moved to `00131`/`0138`.

## Global constraints

- Owner approved all four variants and this execution sequence. First Opus 5.5 reviews this plan; address important findings before implementation. No additional design approval needed.
- Lead implements alone. Two fresh Opus 5.5 implementation reviews for auth/protocol; record actual modelUsage, not model self-identification.
- No production mutation, merge, release or notification announcement. Keep credentials/device IDs/screenshots in ignored evidence.
- Existing access/plan/identity gates apply; no session token copying, broad native fetch or provider credentials.
- Typed proto source is authoritative; generated Go/TS committed. Native sources live outside generated ios/.
- Relevant tests only during iteration; root make lint, generation drift and final integrated checks before READY_TO_SHIP. Full server integration is a pre-merge gate, not a claim made from unit tests.

## Review focus

Privilege confusion (widget grant used as API JWT), exact-session revocation, SSO/account scope, cached data after account changes, bridge document races, redirects/origin changes, large responses and recurrence expansion, cross-day/all-day/DST, iOS scheduling limits, native entitlement/signing reproducibility, cold/warm navigation, availability of a real integrated device test without production deployment.

### Task 1: Server contract and scoped agenda

**Files:** proto/calaba/v1/event.proto; generated Go/TS; internal/calendar/widget*.go; internal/app/app.go, identityroutes.go, botroutes.go; focused app integration tests.

**Produces:** POST /api/me/calendar-widget -> grant+expiry; GET /api/calendar-widget?tz -> schema1 minimized agenda; additive migration 00131 preserves imported all-day DATE values (required by the timezone regression).

- [x] Write failing token and HTTP integration cases for cross-purpose rejection, exact-session revoked/disabled/expired denial, own events, policy/plan exclusions and date boundaries. Run focused tests; Expected: missing widget routes/types/behavior.
- [x] Add proto and generate; implement domain-separated grant, fresh auth callbacks, rate limits, minimized bounded projection using existing recurrence/CalDAV storage.
- [x] Classify routes explicitly, deny machines, install current policy and permission resolver for grant reads. Add no-store; prohibit redirect/query credentials.
- [x] Run go tests for calendar/auth and focused PG17 widget integration; Expected: pass, no skipped dependencies presented as pass. Verify generation drift.
- [x] Commit server contract and implementation.

### Task 2: Native shared storage, timeline and build wiring

**Files:** apps/mobile/modules/calab-session-activity/ios/CalabCalendar*.swift; module config/podspec; widgets/CalabCalendarWidgets.swift; plugins/withSessionActivity.js and tests; app.config.ts/env example.

**Consumes:** Task 1 JSON DTO and grant; **Produces:** configure/refresh/clear Expo methods, four WidgetKit configurations, shared signing capabilities.

- [x] Write failing native model tests (Swift command harness) for decoding, half-open day grouping, DST/all-day, timeline expiry and deep link validation; plugin tests for idempotent source/entitlement generation. Expected: missing behavior.
- [x] Implement serialized Keychain/container storage with generation fencing, bounded URLSession fetch and cache expiry. Pin origin, refuse redirects, clear on auth refusal.
- [x] Build reusable native views: Today/Tomorrow primary, next small, agenda large, rectangular Lock Screen. Native colors, localization, privacy labels and accessibility.
- [x] Extend existing extension bundle and plugin without duplicating targets; add opt-in App Group/Keychain configuration. Verify prebuild twice.
- [x] Run native harness, mobile tests/typecheck and iOS build. Expected: pass; no entitlement ambiguity.
- [x] Commit native layer.

### Task 3: Web bridge and navigation

**Files:** shared/hostCalendarWidget.ts, shared/hostActivity.ts; renderer/platform/hostActivity.ts/types.ts; renderer/services/calendarWidget.ts, session.ts and calendar navigation; mobile/src/activityProtocol.ts/App.tsx/calendarWidget.ts; focused tests.

**Consumes:** scoped issuance API, optional native methods; **Produces:** automatic session provisioning, bounded refreshes, logout clearing, safe event/day/create navigation.

- [x] Write failing bridge/document/logout/renewal and strict deeplink tests. Expected: unsupported calendar capability/route.
- [x] Extend optional capability without changing old-host behavior; issue only after ready/authenticated, discard stale results, refresh on foreground/calendar changes with debounce, clear on logout/identity loss.
- [x] Handle validated calendar URL for cold/warm launches and dispatch existing calendar day/details/create flow after readiness; missing/denied event falls back gracefully.
- [x] Run focused shared/web/mobile tests and typechecks; Expected: pass including old host compatibility.
- [x] Commit integrated layer.

### Task 4: Reviews and physical iPhone acceptance

**Files:** docs/mobile/calendar-widgets.md, TESTING.md brief scenarios; ignored local evidence.

- [x] Review whole integrated diff with Opus 5.5; second fresh security/protocol review. Fix important findings with regression cases and verify final changed diff. Original source confirmations name `9757702c`; two integration/delta confirmations name final code `88d62cbdfe662cd9e2db54f19588217387c62a4b`; no blocker/major remains.
- [x] Run required root lint/typechecks/generation/native build checks on final implementation; record exact SHA, environment and results. Root lint was executed and has seven unchanged baseline marketing errors; it is not a green release gate.
- [x] Provision existing Apple team capabilities and signed development build. Install a separately named dev bundle, scheme and storage groups alongside the existing TestFlight app. Use isolated PG17/Redis, branch API/web and a trusted HTTPS tunnel with synthetic test account/events for unreleased behavior.
- [x] Add all four real widgets and inspect actual synthetic data; test dark/Lock Screen, empty/account switch, cold/warm event/day/add links, extension-only fetch, explicit logout and remote-revoke Home Screen clearing. Record each observed result separately from simulator/mock evidence.
- [ ] Extended distribution acceptance: light mode, device locale/timezone change, first unlock and Lock Screen cleanup after remote revocation. Normal background refresh latency remains system-controlled and was not measured.
- [x] Document required production server/web rollout and new binary, known iOS refresh limits and any unverified gate. Commit docs/evidence summary without private data.
- [x] Prepare commits and review/check/device evidence for a reviewable PR. Owner requested progressing toward rollout on October 27 after inspecting the widgets. Do not merge; server deployment and distribution remain separate gates.

## Plan review incorporated

Actual reviewer modelUsage: claude-opus-5-5. See ADR review resolutions: separate dev install and HTTPS full-stack phone setup; reinstall marker and cross-process flock; explicit privacy redaction; seven-day cache with stale label; scoped SSO; policy exclusions versus 5xx; all-day date fields/timezone invalidation. Task 1 includes completeUntil, both-direction token confusion cases and explicit machine denial. Task 2 includes these storage/timezone/reinstall cases and feature-disabled bundle. Task 4 includes remote session revocation and records whether WidgetKit developer mode was used.
