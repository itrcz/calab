# ADR-0146: Native iOS calendar widgets

Status: accepted for local implementation after Opus 5.5 plan review, 2026-10-26. Owner requested all four widgets, Opus 5.5 plan and implementation reviews, physical iPhone acceptance, and no autonomous merge.

## Why this is a native exception to ADR-0067

ADR-0067 keeps application screens and editing in the shared web client. Home Screen and Lock Screen widgets are system surfaces rendered by WidgetKit in a separate extension process; a WebView cannot supply them. This exception adds only a bounded, read-only calendar projection and links back into the existing shared-web event/day/create screens. It introduces no second calendar editor, recurrence engine, or general native API client. All four families share one provider/cache.

The server capability is specified separately in [ADR-0145](0145-calendar-widget-feed.md). It is needed for permitted extension refreshes while the host WebView is suspended. Sharing the full web access/refresh session would give the extension unnecessary authority. iOS still controls refresh scheduling, so this does not promise instant background sync.

## Product contract

Four WidgetKit configurations in the existing extension: Today & Tomorrow (medium, primary), Up Next (small), Agenda (large, seven-day strip and chronological list), Up Next on the Lock Screen (accessory rectangular). The primary layout follows the supplied Yandex Calendar reference: date and remaining today on the left, tomorrow on the right, colored event markers, overflow count and an add action. Calab typography/colors, native light/dark/tinted rendering, English/Russian localization and VoiceOver labels. Sample events appear only in the gallery preview.

The personal agenda combines Calab meetings the person organizes or attends (excluding declined/cancelled occurrences) and their imported CalDAV calendar. No colleagues' private schedules. Current workspace identity, membership and billing gates still apply. CalDAV retains its existing paid-plan gate and import cadence. Taps open the relevant event/day in Calab; add opens the existing creation UI and never creates an event without confirmation.

## Data and authority

[ADR-0145](0145-calendar-widget-feed.md) defines issuance, session binding, policy checks, the minimized seven-day feed and revocation. The extension receives only that read-only grant; it cannot read the WebView session or obtain general API/CalDAV credentials. [ADR-0144](0144-caldav-date-preservation.md) preserves original CalDAV DATE values before timezone conversion.

## Native storage, bridge and lifecycle

Explicit `CALAB_IOS_APP_GROUP` enables the feature. App and existing WidgetKit extension receive the same App Group and a dedicated shared Keychain access group. The exact HTTPS origin is compiled into both from EXPO_PUBLIC_CALAB_URL, never supplied by a message or server redirect. Keychain uses AfterFirstUnlockThisDeviceOnly for the narrow grant; the shared container contains only the minimized agenda snapshot and generation state, protected until first unlock. No grant appears in preferences, URLs, telemetry or logs. No networking before first unlock. URLSession refuses redirects and limits time/response bytes.

An additive `calendarWidgetVersion: 1` capability extends the existing main-frame/exact-origin/document/sequence handshake. Operations: bind(user/session binding), configure(grant, expiresAt), refresh, clear, and opened(tap acknowledgement). Binding invalidates cached authority when the authenticated account/session changes. Small bounded messages, strict shape validation, no general native fetch API. Web session changes invalidate in-flight grant requests before clearing native state. Native mutations use a cross-process flock on the App Group lock file, with a persisted generation and grant fingerprint checked under that lock before committing fetched data. An installation marker in the container is required before using Keychain: its absence deletes surviving credentials. Serialized mutations and persisted generation fencing prevent a late fetch from restoring an old account after logout/change. Navigation document revocation cancels queued bridge authority; it does not erase a valid background grant merely because the WebView reloads. Explicit logout/identity loss clears the Keychain/cache and reloads all four timelines.

The timeline provider fetches independently while the app is closed, shares its cache across sizes, coalesces refreshes and schedules local entries for start/end/midnight transitions. Request refresh after approximately 30 minutes with jitter; iOS owns actual scheduling. Cache validity is bounded by the seven-day window and grant expiry; after two hours show its last-update time. Expired content becomes an explicit refresh/sign-in state, not an empty day. Cache timezone must match device timezone; timezone changes refetch. 401/403 erase data; transient failure retains only unexpired cache with an update-needed indication. Titles, times and counts use .privacySensitive(); OS redaction depends on the user's lock-screen privacy setting. Cached renders already held by WidgetKit cannot be synchronously revoked remotely; local clearing requests a reload, while remote revocation is observed at the next permitted fetch/expiry entry.

## Navigation and compatibility

An app-specific calendar URL scheme opens only a validated calendar action; it cannot forward arbitrary URLs. Native dispatches only validated action parameters to the existing authenticated document, without reloading the WebView. A fenced acknowledgement prevents losing a tap during document rotation. Cold and warm launches use the same path. Shared web consumes calendar navigation after authentication/readiness and rechecks current access through existing APIs. Invalid/missing/deleted targets fall back to calendar, never open an arbitrary provider URL. Existing binaries and old servers remain usable: capability absence does nothing; 404 issuance leaves a clear unavailable state without retry loops. Server+web deployment and a new signed binary are required for production activation, independently of this local branch.

## Verification and release boundary

Focused server tests cover token separation, expiry/revocation/disabled user, account/workspace policy, own-only events, declined/cancelled/recurring/DST/all-day, CalDAV plan gate and truncation. Bridge tests cover malformed/stale documents, logout races and old hosts. Native tests cover timeline boundaries, stale cache, URL parsing, decoder limits and generation fences; prebuild twice verifies target/entitlement idempotence. Build/typecheck/lint and two independent Opus security/protocol reviews precede final readiness.

Physical iPhone acceptance must add all four widgets, inspect light/dark and populated/empty states, tap event/day/add, receive a changed schedule with the app closed, and clear on logout. Use a separate dev bundle ID, display name, URL scheme, App Group and Keychain group so the working TestFlight install and credentials remain intact. Use PG17 on isolated local ports, the branch API and built web behind a trusted public HTTPS tunnel; synthetic test account/events only. A local fake CalDAV provider exercises import where available. Prove closed-app refresh with server access evidence and a visible changed title; developer refresh mode is reported separately from normal scheduling. Label synthetic data and distinguish physical rendering from integrated backend proof. No merge, production deploy, TestFlight upload or announcement is part of this task. Any unavailable physical gate remains explicitly unverified.

## Plan review resolutions

Opus 5.5 reviewed the initial plan on 2026-10-26. All nine significant findings were accepted: isolated device install and trusted HTTPS full-stack test; reinstall marker; cross-process cache lock; explicit privacySensitive; useful offline cache; workspace-SSO support; policy versus dependency error handling; calendar-date/DST/timezone handling. Unknown request zones return the existing API validation status 422, not silent UTC. External UIDs already hash provider identifiers in the existing importer; keep that opaque key to open the precise imported occurrence. Calab events use Calab purple (#8B7CF8), external events use the selected CalDAV calendar color or blue (#5C9AFF). Add APIs are Links compatible with iOS 16.4; newer layout APIs are availability-guarded. Feature-disabled builds omit the calendar widget configurations.

## Implementation finding: imported DATE preservation

A real PG17/CalDAV test reproduced all-day dates shifting after a profile timezone change. Migration 00133 adds start_date/end_date to external_busy and import preserves the original exclusive DATE interval. Old writers remain compatible through empty defaults; old rows use the existing profile-zone interpretation until the next normal import fills the dates. This is required calendar correctness, not a new credential store.


## Implementation review resolutions

Opus 5.5 identified cache loss on cold starts/renewal, native operation ordering, default Keychain scope, corrupt cache recovery and dropped throttled refreshes. Binding now hashes the authenticated user/session pair; a grant must name that same pair. A same-session web reload or grant renewal preserves display data, while a changed binding clears it. Native mutations run FIFO on the main queue. A missing native grant requests immediate reissuance. A dirty bit schedules an update after the cross-process cooldown. The host keeps its own default Keychain group before the dedicated shared group, and excludes display cache from backup. Corrupt JSON fails closed and permits recovery.

The proposed protojson mismatch was checked against actual Go HTTP responses: httpx already emits scalar defaults and empty arrays; Swift successfully decoded both empty and populated responses including fractional seconds. CalDAV import already limits titles to 200 Unicode scalars and the widget feed normalizes colors. Candidate queries cap at 1001 rows and refuse the entire feed with 503 beyond 1000; output caps at 100 and marks the first omitted instant in completeUntil. Past non-recurring rows are excluded even when a legacy until_at is null.

## Integration with phone links (ADR-0142)

The host reads the initial URL once and shares one live URL listener between regular task/invite/room links and widget actions. A live link supersedes a delayed initial URL, and a regular link cancels any undelivered widget tap. READY advertises both independent capabilities; document revocation fences both. Production retains `calab` and legacy `calaba` schemes. An explicitly configured custom widget scheme is used alone for isolated QA, so that development install cannot claim the production custom schemes.
