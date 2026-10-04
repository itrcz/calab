# Board forms acceptance — 2026-10-04

Implementation: `dc9679180a9b99ca90106a1357ad4c423c94a475`, based on main `3eeb3ca3` (2.3.0).
Contract: [ADR-0064](../../adr/0064-board-forms.md). PR: https://github.com/itrcz/calab/pull/105.
Implementation CI [37221942861](https://github.com/itrcz/calab/actions/runs/37221942861) passed all required jobs, including all five PG17 integration shards.
Release is pending the required two independent security/protocol reviews; no production deployment or announcement has been made.

## Observed checks

- Local Go 1.26.8, PostgreSQL 17, isolated Valkey and databases. `make gen` with repository-pinned plugins; `pnpm -r typecheck`; root `make lint`: passed.
- `go test -race -tags integration ./internal/app -run '^Test(BoardForms|BotRouteTable|IdentityRoute|Camera)' -count=1`: passed (43.242 s).
- `go test -race ./internal/boards ./internal/plans ./internal/httpx`, web production build and SDK build: passed.
- Forms coverage: public/private ACL, revoked member/bot, SSO, archive/delete, quota 5/20/unlimited/Free, nonce/revision/concurrency, signed webhook, no-write preview, automation runs exactly once for a real submission and never for preview.
- Real Chromium (mute audio), desktop 960×600 and mobile 390: UI create/edit, preview, anonymous submit → task appears in selected column/high priority, private deny/allow, deletion invalidates open link: passed on this implementation.
- Built `@calaba/bot-sdk` against the running local API: denied management before permission grant; create/list/update/private get/preview/submit/idempotency/delete passed. Owner read the resulting task and verified bot author, status and priority. Credentials were local fixtures and are not included.
- Local static Caddy handler for `/f/*`: HTTP 200, no-store, no-referrer, noindex/nofollow. Only localhost hosts were used.
- Earlier full integration on `4d1a4120`: rest and app F–P / non-A–P passed; A–E failed three real-camera checks under parallel load. Those three checks passed in the focused run above. That earlier run is not acceptance of the merged code. Full merged-code acceptance passed in the linked PR CI (all five PG17 shards).
- Visual regression suites were not run, per owner instruction. Screenshots below are manual scenario QA, not updated visual baselines.

## Screenshots

[Preview](preview.png) · [Public form, mobile](public-mobile.png) · [Success](success-mobile.png) · [Task on board](task-board.png) · [Private form, anonymous](private-anonymous.png) · [Deleted form](deleted-mobile.png).
