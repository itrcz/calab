# iOS app icon unread badge

Base: 14a0f48821c1f54a207fc9300a7475c718bda48a. Owner requested implementation,
verification, a new App Store Connect build and a pull request on 2026-11-09.

- Match the existing desktop badge: unread DMs plus mentions in visible workspace
  rooms, including @everyone. Reuse the existing read queries and permission resolver;
  no second unread ledger. Clamp the native representation to 99,999.
- APNs message alerts carry an absolute, freshly computed `aps.badge`. A read marker
  update on any client sends a badge-only APNs update (including zero), with no banner
  or sound. Delivery is best effort; foreground READY always reconciles the count.
- Count only workspaces allowed by the exact endpoint session's current identity policy.
  Reuse session/device locks and reject revoked, disabled, expired or foreign bindings.
  No credentials, message content or new product identifiers cross the badge bridge.
- Add an optional versioned iOS notification badge capability to the existing origin,
  main-frame, document and sequence checked bridge. Old hosts and Android remain compatible.
  Publish after READY, on changes and foreground return; zero clears. Explicit logout
  clears the native badge. Reload does not clear a still-valid background count.
- Serialize native OS updates so an old count cannot overtake logout or a newer value.
  Preserve notification extension badge content and foreground badge presentation.
- Tests: real serialized APNs payload (zero/nonzero/VoIP unchanged); PG17 permission,
  unread/read and exact-session cases; host handshake/replay/invalid count/logout tests;
  Swift state tests, native build and simulator icon checks. Report real APNs/physical
  device observations separately from synthetic tests.
- No schema/proto change, media behavior change, new user setting or store submission
  for public release. PR and App Store Connect upload are authorized; production web/API
  rollout follows the normal maintainer merge/release workflow.

Review follow-up (PR #320, base efc7fb9aafb69140d902c657c77f74b1b8882dc1):
- Keep cross-device reads, but coalesce events for one second before any DB work;
  allow at most four active badge workers and 128 pending users per process.
- Bound each endpoint transaction/provider call to 750 ms, within the existing
  three-second user pass. Keep fresh authorization and endpoint locking unchanged.
- Skip an unchanged count for the same endpoint version using the shared five-minute
  Valkey cache described below; ordinary APNs alerts update that cache too.
  This is a best-effort optimization, not an unread ledger.
- Scope: push service, targeted PG17 race tests, ADR/backlog. No mobile changes,
  schema/proto changes or deployment. Verify bursts, unchanged/failed sends,
  alert-to-read-to-zero, concurrency and provider deadlines; then update PR and notify reviewer.

Replica-cache correction (2026-11-10, base 0fe1bd6f6):
- Replace the local accepted-count map with one Valkey key per endpoint/version,
  TTL five minutes. Both alert and badge-only paths use it under the existing DB lock.
- Invalidate the old value before sending; only an accepted send writes a new value.
  A rejected/timed-out attempt therefore cannot leave an old count to suppress a refresh.
- Use a unique pending token and atomic compare-on-completion so a late cache write
  cannot overwrite a newer attempt. A pending token never suppresses delivery.
- Cache operations are bounded by the endpoint budget. If invalidation is unavailable,
  ordinary alerts still deliver without a badge; badge-only updates defer to the next
  read/alert/foreground. No stale cache is allowed to suppress a later correct update.
- Verify A:3 → B:4 → A:3 with real PG17/Valkey, including provider timeout/failure and
  cache failure. Keep worker/debounce limits; no mobile, schema or permission changes.
