# Calendar subscriptions: local acceptance

2026-10-29. Base: `2f574cf9e`. Scope and API: [ADR-0147](../adr/0147-calendar-export-subscription.md).
Pre-release evidence for [PR #274](https://github.com/itrcz/calab/pull/274).
Deployment and physical-device acceptance are separate from these checks.

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

- Seven pre-existing workspace lint errors in marketing fixtures were corrected:
  remove unused declarations and retain the synchronous seed functions' actual
  return types. Targeted ESLint and node TypeScript passed; full `make lint` must
  also pass before release.
- Two independent security/protocol reviews ran at `092bd7e535d6`. They identified
  three release blockers, fixed in `58824184926c`: fixed-offset recurring dates,
  workspace guest demotion retaining a public feed, and unbounded timezone work
  for unsupported export years. Regression tests reproduced the failures first.
  The final targeted PG17/Redis race tests passed, including demotion, date bounds,
  cancellation/deadline and Moscow/Tokyo local recurrence tests. Both independent
  reviewers rechecked `58824184926c`: no remaining blocker/major. The protocol
  reviewer independently expanded the exported Moscow monthly and Tokyo weekday
  recurrence and confirmed that their local dates stay correct.
- The full PR CI/integration matrix passed on `092bd7e535d6`, including all
  PostgreSQL 17 integration shards. The corrected release candidate must pass CI
  again. The owner authorized release after independent reviews and green checks.
  Main was refreshed: no divergence or migration/ADR collision. Recheck before
  merge if main advances. Production and device acceptance are not implied by CI.
- Physical iPhone acceptance: QR scan, Apple subscription confirmation, HTTPS transport of the resulting subscription,
  update and cancellation after Apple's refresh, revoked/rotated URL refusal. WebKit
  is engine-level UI evidence, not an iPhone/system-calendar result.
- Inside the iOS app, connecting requires a host build with the new `webcal`
  allowlist. Desktop requires the updated Electron shell. Web Safari only needs
  the server/web deployment. Required-SSO spaces cannot use URL subscriptions.
