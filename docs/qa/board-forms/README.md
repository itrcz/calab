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

## Local follow-up acceptance — data types and editor QA

Contract revision 4 adds PHONE/URL/MULTISELECT and a separate optional task-title source.
- Go 1.26.8 `go test -race ./internal/boards`: passed; malformed phone/URL/choices, optional/required, scalar/array separation, title fallback/Unicode truncation/full description.
- PG17 `go test -race -tags integration ./internal/app -run '^TestBoardForms' -count=1`: passed (8.599 s), including public/bot extended-type flow and nonce independent of choice order.
- Root `make lint`, workspace typecheck, web production build and SDK build: passed.
- Built SDK against local API: create, preview, submit, reordered-values retry; owner verified phone formatting, URL, ordered choices and title fallback in task. Passed. A first fixture artifact export failed on protobuf BigInt timestamps after assertions; JSON export was fixed and the SDK scenario rerun successfully.
- Real browser: required multiple-choice error; invalid phone error; valid public submission → success and second task on Typed requests board. Editor shows enabled first-field type and separate title source. Shared Modal header/footer retain spacing when body is scrolled.
- Earlier QA fixes: forms actions in both board menus with icon/separators; shared Select controls; save returns to list; shared public footer; dedicated success checkmark; view label Board/Доска. No visual regression suites run.
- These follow-ups need CI and independent security/protocol review on the updated commit before release. The earlier CI link validates the earlier implementation only.

## Release 2.3.1 review correction

Two independent Codex reviews of `f266ae66` found the same major: generic protojson decoding discarded unknown properties, violating ADR-0064 and allowing a misspelled privacy setting to become a public form. Form create/update/preview/submit now use strict decoding; legacy endpoints retain their previous decoder.
- `TestBoardFormsRejectUnknownJSON` covers unknown request/definition/field/answer properties, privacy typos, no writes on rejection, unchanged revision and an unconsumed submission nonce.
- PG17 `go test -race -tags integration ./internal/app -run '^TestBoardForms' -count=1`: passed (16.562 s).
- `go test -race ./internal/boards ./internal/httpx ./internal/plans`: passed.
- Minor findings are recorded in docs/09 and docs/12. Final delta reviews and CI must pass before merge/tag; their exact SHA is recorded in PR #105.
