# Native iOS calendar widgets

Contract: [ADR-0146](../adr/0146-ios-calendar-widgets.md). These are native WidgetKit views; their actions open the existing shared-web calendar.

| Variant | iOS family | Content |
| --- | --- | --- |
| Today & Tomorrow | Medium Home Screen | Remaining events today and tomorrow in two columns; day, event and create links |
| Up Next | Small Home Screen | Next timed meeting, or an all-day event if no timed meeting remains |
| Agenda | Large Home Screen | Seven-day strip, upcoming events grouped by day, overflow link |
| Up Next | Rectangular Lock Screen | Next event and time; tap opens its occurrence |

## Data and privacy

The app provisions a separate, read-only, exact-session-bound calendar grant after sign-in. The extension fetches the minimized agenda directly, including imported CalDAV events already available to that account. It never receives the login JWT, refresh token, provider credentials, descriptions, attendees or meeting URLs. Existing workspace identity policies, membership, SSO scope and CalDAV entitlement are checked on the server for every read.

The grant lives in a dedicated shared Keychain group. Display data lives in a protected, backup-excluded App Group file. File locking and generation checks fence writes from old sessions and extension processes. Logout clears the grant and agenda before the web document is revoked. A missing installation marker removes surviving Keychain credentials after reinstall. A remote session revocation takes effect when the extension next contacts the server; cached displays cannot be remotely erased instantly.

The feed contains up to 100 events across seven local calendar days. An explicit completeness boundary avoids presenting truncated data as an empty calendar. Imported all-day dates retain their source DATE values across timezone changes. Expired or incompatible-timezone data is hidden; offline data remains usable within its validity and is labelled stale after two hours.

## Build and rollout

1. Merge the CalDAV DATE preservation change first (ADR-0144, migration `00133`), then the feed/grant (ADR-0145), then the native/shared-web integration (ADR-0146). Each dependent PR is based on its prerequisite branch and must be retargeted to main after that prerequisite merges. Deploy the compatible server and shared-web bridge. Existing clients continue to work; a new client with an older server has no widget feed.
2. Register one App Group for the iOS app and its existing `.voiceactivity` extension. Set `CALAB_IOS_APP_GROUP` and an explicit `CALAB_IOS_URL_SCHEME`, alongside the existing HTTPS `EXPO_PUBLIC_CALAB_URL` and bundle ID. Production builds must use `CALAB_IOS_URL_SCHEME=calab` to retain both production custom-link aliases; a different scheme is for an isolated QA bundle only. Verify this value before signing.
3. Run Expo prebuild and install pods. When disabling calendar support on a previously generated target, use a clean prebuild to remove its old source references. The config plugin copies the canonical Swift sources, adds the four configurations to the existing WidgetKit bundle, and generates App Group and dedicated Keychain entitlements for both targets. Keep the app's private Keychain group first.
4. Refresh both provisioning profiles. Inspect the signed app and extension entitlements and resolved `CalabCalendarKeychainGroup`; an unresolved or incorrect AppIdentifierPrefix must block distribution.
5. Build and distribute a new native binary. A web deployment alone cannot add WidgetKit extensions or signing capabilities. TestFlight and production configuration must use the production origin and identifiers.

For physical acceptance, use a separate bundle ID, App Group, URL scheme and app name, a trusted HTTPS test origin, and isolated synthetic server data. Keep the working TestFlight app installed. Do not commit credentials, temporary tunnel URLs, device identifiers or user screenshots.

## Refresh behavior

The app refreshes after sign-in, relevant calendar changes and foreground transitions. The extension schedules local start/end/midnight/expiry transitions in advance and requests network timelines about every 30 minutes, with jitter. Empty/error states request a retry after five minutes. Network requests are coalesced across processes and respect a minimum cooldown.

WidgetKit decides when requests run. Low Power Mode, device usage and system budgets can delay them; this is not an instant-sync guarantee. A manual gallery refresh or developer refresh is not evidence of normal background update latency.

## Acceptance evidence and remaining gates

The implementation was reviewed by two fresh Claude Opus 5.5 sessions after the plan review. Important findings were fixed and reviewed again: cold-start cache retention, binding during grant issuance, Keychain group order, lost refresh requests, deep-link acknowledgement and duplicate imported event keys. The final integration and route/test-delta reviews identify code commit `88d62cbdfe662cd9e2db54f19588217387c62a4b` and report no unresolved blocker/major. The actual model identifier in the CLI results is `claude-opus-5-5`; acceptance-document edits do not change the reviewed code.

Focused checks include PG17 HTTP integration with race detection, token-purpose confusion, exact-session/SSO revocation, membership exclusions, bounded feeds, CalDAV DATE and duplicate imports; bridge/document/renewal/deep-link regressions; Swift date/DST/expiry and cross-process cache fencing; plugin idempotence; mobile and desktop typechecks; generation drift; and a signed arm64 Release build.

The root `make lint` server, mobile, landing and SDK checks pass. Desktop lint still reports the seven pre-existing errors in `e2e-marketing/copy4.ts`, `landing-v6.spec.ts` and `v6-kit.ts`; those files are unchanged by this feature. Final server acceptance and CI results are recorded in the linked acceptance report; CI is a pre-merge gate.

Physical acceptance is recorded separately from source tests. See [physical acceptance](calendar-widgets-acceptance.md) for completed scenarios and device-only gaps. Production rollout, TestFlight upload and merge require separate authorization.
