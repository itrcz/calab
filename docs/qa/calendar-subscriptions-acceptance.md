# Calendar subscriptions: local acceptance

2026-10-29. Base: `2f574cf9e`. Scope and API: [ADR-0147](../adr/0147-calendar-export-subscription.md).
Status: implemented locally, suitable for a draft PR review, not deployed.
Release gates remain open below.

QR codes contain an ordinary HTTPS connection URL and can be scanned on Android
as well as iPhone. The caption names a phone camera, not a specific platform.
Apple Calendar has the direct subscription action; Google Calendar URL setup
uses its computer web UI before the calendar appears on the phone. Android
system-calendar subscription has not been verified on a physical device.

## Verified

- `go test ./...`: passed after replacing subscription mutations with admitted
  transactions. Existing invitation/CalDAV ICS tests remain green.
- `go test -race -tags integration ./internal/calendar ./internal/app -run
  'TestCalendar|TestBuildICS|TestICS|TestIdentity.*(Route|Mutation)|Test.*Bot.*Route'`:
  passed with an isolated PostgreSQL 17 database and Redis instance.
- Final subscription integration cases, also with `-race`: lifecycle, current
  policy, own-only export, updates, decline/accept, cancellation, tampering,
  disabled user, departed membership, workspace/billing suspension and enforced
  SSO. The capability is rejected as an account bearer token. Public SSO denials
  do not ask the renderer to start sign-in again.
- Shared-calendar serializer test: one VCALENDAR, deduplicated timezone covering
  different series years, all-day dates across DST, escaped user text. Existing
  workday EXDATE/RDATE tests pass.
- `pnpm@10.17.0 -r test`: passed. Desktop: 5410 tests, 18 existing skips;
  mobile: 232 tests plus plugin tests; other workspace packages passed.
- Desktop and mobile typechecks passed. The new UI test starts its mock in a
  subprocess so its imports do not expand the production node TS project.
- `make gen`: no generated drift; bot-route documentation regenerated and
  `tsx tools/gen-bot-routes.ts --check` passed. Landing tests: 16 passed.
- Go vet (normal and integration tags) and golangci-lint v2.14.0 with the root
  config and integration tags: passed. ESLint on all changed desktop files and
  the mobile package: passed.
- Production web and Electron application builds passed, including third-party
  notices and bundle boundaries. Installer/signing/distribution not attempted.
- Functional UI test: download with .ics filename and body, no activation on
  dialog open, explicit activation, correct link, QR visibility, rotation and
  revocation. Three viewport/theme cases in Chromium and three in WebKit passed.
  The mock intercepts API requests; it is not evidence of live backend behavior.
  Service workers are blocked in this test to keep interceptions deterministic.
- Light/dark desktop and phone screenshots inspected. Local QR decoded with
  macOS Vision to the exact synthetic HTTPS connection URL. No external QR API.

## Remaining release gates

- Full workspace lint is blocked by seven existing errors in unchanged
  `apps/desktop/e2e-marketing/copy4.ts`, `landing-v6.spec.ts` and `v6-kit.ts`.
  They concern an unused type, floating promises and a meaningless void operator.
  New-file errors found in the first run were fixed; the final changed-file lint
  passed. No marketing fixture changes are included here.
- Two independent security/protocol reviews required by AGENTS.md have not run.
  The current owner instruction prohibits spawning agents without a new request.
  Author review and automated checks are not independent reviews.
- Full merge CI/integration matrix, fresh migration-number conflict check and
  shipping approval remain necessary. No push, PR, merge or deployment occurred.
- Physical iPhone acceptance: QR scan, Apple subscription confirmation, HTTPS transport of the resulting subscription,
  update and cancellation after Apple's refresh, revoked/rotated URL refusal. WebKit
  is engine-level UI evidence, not an iPhone/system-calendar result.
- Inside the iOS app, connecting requires a host build with the new `webcal`
  allowlist. Desktop requires the updated Electron shell. Web Safari only needs
  the server/web deployment. Required-SSO spaces cannot use URL subscriptions.
