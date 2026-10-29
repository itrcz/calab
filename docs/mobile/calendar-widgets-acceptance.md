# Calendar widget acceptance, 2026-10-26–27

Pre-split reviewed code: `88d62cbdfe662cd9e2db54f19588217387c62a4b`, integrated with `origin/main` at `5e71164edfb8bd85cc920194746eec1d1b1b29c3`. Physical build: `9757702c5e2132f68342398ebc628086db77f7df`; native widget code is unchanged by the integration apart from an ADR comment. Plan/spec: `7e26f7d1`; server contract: `d2e5aa10`. Status: implementation and source review complete, core physical scenarios passed; extended device and distribution gates remain. No production rollout or merge.

## Review split, 2026-10-28

The original implementation was rebased onto main `da3438bc8` and split for maintainer review: CalDAV DATE persistence (migration `00133`, ADR-0144), the session-bound feed/grant (ADR-0145), and native widgets/shared-web integration (ADR-0148). Swift widget/store runtime is unchanged from the device-tested implementation. The host now integrates main's phone links (ADR-0142): one initial/live URL path, both READY capabilities, and isolated custom-scheme configuration. These host integration changes require fresh checks and are not claimed as physically verified by the earlier build. The integration with the newer ONLYOFFICE migration history needs fresh checks; earlier physical observations below remain observations of the explicitly named development build.

The separate DATE change adds independent unit and PG17 import/storage tests. The server feed keeps its full HTTP permission/revocation/recurrence/date coverage. The PR descriptions carry current exact heads, check results and independent review confirmations. No production activation, new physical build or TestFlight upload is implied by this split.

On October 29 the maintainer landed #261 and #262 by rebase, including the DST-at-midnight DATE fix and the read-limiter/revocation-test follow-ups. The iOS-only #253 was then transplanted onto main `c283c7ae2`; its implementation patch is unchanged, and the landed server changes are preserved. Its base is now main. Current-head checks and reviews are recorded in the PR; this maintenance does not extend the physical-device evidence below or confirm production deployment.

## Review

The plan was reviewed by Claude Opus 5.5 before implementation. Two fresh independent implementation reviews covered the integrated auth/protocol change. Significant findings were fixed and rechecked; both original final confirmations identify the physical-build source SHA and report no remaining blocker/major. Both CLI responses report actual model usage `claude-opus-5-5`. After integrating working-day recurrence from main, two additional reviews checked the integration and the final route/test delta at the final code SHA. No blocker/major was reported. Reviewer questions about fixture isolation were checked against source: each fixture creates its own workspace, these tests are sequential, every process creates its own database, and an empty locale is accepted for restoration. Minor follow-ups are in the technical backlog.

## Automated and build evidence

- Passed: affected-file lint; mobile and desktop typechecks; focused web bridge/navigation tests (25); mobile tests and plugin regression tests (including five final extension-plugin cases).
- Passed: Swift model tests with actual Go feed fixtures, DATE/DST/expiry boundaries, cross-process storage/binding fences; native source typecheck.
- Passed: Go calendar/CalDAV/auth units; PG17 focused HTTP integration with race detection (13.217 seconds), plus duplicate-import/bounded-feed regressions. Dedicated test PostgreSQL and Redis instances were used.
- Passed: final generation check with zero generated-file drift; signed arm64 Release build and installation. App and extension have matching App Group/dedicated Keychain entitlements; the host private Keychain group remains first.
- Passed after main integration: desktop/mobile typechecks, affected web tests, production web build, `make gen` without protocol/SQL drift, bot-route generation check and server lint. The final route/test delta also passed server lint.
- Passed: combined bot-route, six widget, invitation-audience and external-reminder HTTP tests with PG17/race (35.158 seconds). The bounded-feed fixture originally polluted global reminder counts; a failing combined run reproduced it, and cleanup restricted to each fixture workspace fixed it. The workday fixture restores the shared owner locale.
- Passed: all four official app integration shards with PG17 and `-race`, matching CI filters: A–B 310.780s, C–I 284.065s, J–P 235.406s, remaining names 421.162s (475 top-level app tests inventoried). The rest of the server completed across 81 packages plus an isolated full ysync retry (27.849s); 21 packages contain no tests. LiveKit and Garage S3 were available.
- Limits and failed attempts: the first unsharded app run hit the default ten-minute timeout and a shared invitation-mail count assertion; that assertion passed in the focused reproduction and official C–I shard. An existing ysync timing test failed under concurrent load before its successful whole-package retry. Optional live AI/Keycloak/SIP, performance benchmarks, and five real-camera track tests were skipped (the latter require the optional `lk` CLI). These are not claimed as verified. Local ffmpeg is 8.1.1; CI uses 8.0.
- Not green: root `make lint` reports seven unchanged baseline errors in desktop marketing test files. Server, mobile, landing and SDK lint pass. CI remains a pre-merge gate.

## Physical device evidence

A separately named development app was installed alongside the existing TestFlight app on an iPhone 14 Pro Max running iOS 27.0.1. The branch API and shared web client used a temporary trusted HTTPS origin, isolated PG17/Redis, and synthetic account/events. No production account or calendar was used. WidgetKit developer mode was not enabled.

| Scenario | Observed result |
| --- | --- |
| First sign-in provisions widget | Passed: grant POST 200 followed by native agenda GET 200 |
| Medium Today & Tomorrow | Passed: actual synthetic today/tomorrow meetings and times visible, distinct from gallery placeholders |
| Large Agenda | Passed: seven-day strip, date markers, grouped meetings and overflow visible |
| Warm create action | Passed: medium plus button opened New meeting on the expected date; cancelled without creating an event |
| Small Up Next | Passed: added through the gallery page-control dots; real next meeting rendered |
| Rectangular Lock Screen | Passed: saved on a separate test Lock Screen, real next meeting rendered, tap opened the correct details |
| Closed-app update | Passed for independent fetch: after app termination, adding Small triggered extension-only GET 200. This was a manual gallery trigger, not evidence of normal background latency |
| Cold event link | Passed: Small opened the correct meeting details from a terminated app |
| Warm day link | Passed: Agenda day strip opened October 28 and its Weekly review event |
| Explicit logout | Passed: app returned to sign-in; Small and Agenda cleared meetings and showed Sign in to Calab |
| Account switch and empty state | Passed: second synthetic account showed No events in Small and Agenda, without previous meetings or date markers |
| Remote exact-session revocation | Passed for app foreground: isolated API revoked the phone session; relaunch showed Your session was ended on another device. On October 27 all three Home Screen families were observed showing Sign in to Calab with meetings cleared. This proves cleanup, not its latency; post-revoke Lock Screen cleanup was not observed |
| Light mode, locale/timezone change, first unlock | Not yet observed on the physical phone |

Device Hub screenshots and private logs remain local and ignored. They are not committed to the public repository. The existing TestFlight binary was preserved. The original combined PR used migration `00126` / ADR `0138`; the review split now uses migration `00133` and ADRs `0144`–`0146` because main occupied those old numbers. Recreate isolated development databases that used the unreleased widget migration `00124`, `00126`, `00131` or `00132`; never treat that schema as compatible with the refreshed migration history. An old widget `00131` would incorrectly mark the new office migration as applied and collide with `00133`. This instruction applies only to disposable widget QA databases, never production databases. Recheck number availability before merge. Release requires completing the remaining device scenarios, normal review/CI gates, server migration and web deployment, production signing configuration, and a new native build.
