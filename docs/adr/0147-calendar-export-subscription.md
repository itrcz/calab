# ADR-0147: Personal calendar downloads and subscriptions

Date: 2026-10-29. Base: 2f574cf9e. Status: locally implemented, not released.

## Requested outcome

Download .ics in web and desktop, subscribe on iPhone with a button, and connect
from a computer using a QR code. This is a personal, read-only calendar of Calab
meetings in the selected workspace. It does not export colleagues' calendars,
imported CalDAV events, attendee addresses, comments or recordings.

## Contract

- GET /api/workspaces/{id}/calendar.ics?from&to downloads the caller's meetings.
  RFC3339 half-open window, at most 400 days within supported years 2000–2200;
  UI dates include the final day.
  Include series that have an occurrence in the window, preserving the complete
  recurrence and exceptions. The UI explains that recurring series are included
  in full. GET /api/events/{id}/calendar.ics downloads one visible live series.
- GET /api/workspaces/{id}/calendar-subscription returns an empty grant if off.
  POST activates idempotently, PUT rotates, DELETE revokes idempotently.
  Generated protobuf response contains feed_url, connect_url and webcal_url.
- GET /api/calendar-feed.ics?t= is a purpose-specific bearer capability, never
  an account credential. It returns the owner's meetings in that workspace,
  rolling 30 days back / 365 days forward, with complete recurring series.
- GET /api/calendar-connect?t= is the QR destination: a small first-party page
  with an explicit Apple subscription link and a selectable HTTPS feed URL for
  other clients. No auto-redirect, analytics, remote QR service or third-party
  resources. Invalid/revoked links return 404 without event information.
- Subscription identity is a random UUID, signed with a domain-separated HMAC
  key derived from the server secret. Only the ID is stored, never the bearer
  URL. One subscription per (workspace, user), foreign-keyed to membership.
  Changing the ID revokes every earlier URL. Signature checked before DB access.
  No automatic expiry: explicit disconnect, membership removal or secret rotation
  ends the subscription. Signing key rotation requires reconnecting.
- Every content request checks the current identity delivery policy, including
  disabled/banned/suspended users, current workspace guest role, directory freshness,
  workspace suspension and enforced billing suspension.
  Required-SSO workspaces cannot issue or use a public subscription, even with
  an active SSO session; authenticated .ics export still follows request policy.
  Subscription policy refusals use FORBIDDEN/CALENDAR_SUBSCRIPTION_SSO, not
  SSO_REQUIRED, so the renderer does not start an endless sign-in flow. Authenticated routes additionally use the normal request
  policy and viewer resolution. Machines and guests cannot manage subscriptions
  or export calendars. Declined/cancelled/removed meetings disappear from feeds.
- Fail closed on database/policy failures. Cap candidates at 1000 and output at
  8 MiB, with a 10 second request deadline honored during timezone serialization.
  Never return a successful partial feed.
  Verified public capabilities are rate-limited per ID before database access
  (30 burst / 30 per minute, independently of RSVP links). No-store, no-referrer and
  noindex on all capability responses. Secrets live in query parameters, which
  the application's access logs omit; deployment proxies must redact `t` too.
- A feed has one VCALENDAR, deduplicated VTIMEZONE definitions and stable event
  UIDs/sequence numbers. No METHOD/ORGANIZER/ATTENDEE fields, to avoid sending
  invitations when a calendar application imports it. Preserve DST, all-day
  dates, workday rules and EXDATE/RDATE via the existing ICS serializer. Repeating
  meetings outside UTC retain TZID even without DST, using a fixed-offset VTIMEZONE
  so monthly dates and weekdays do not shift when converted to UTC.

## Interface and platforms

One calendar actions menu in the desktop and phone headers opens a download
dialog or a subscription dialog. Download also appears in a meeting card.
Subscription is opt-in: the first screen explains the scope and link access;
activation reveals the Apple button, local QR code, copy link, rotate and revoke under expandable subscription settings.
QR generation is local and lazy. Errors and pending states are visible; revoked
or rotated links are removed from the dialog immediately after server success.
The QR landing page has no meeting content.

Only well-formed webcal links to the configured server's exact feed endpoint may
leave the Electron/phone host. No broad custom-protocol allowlist. Browser opens
the link synchronously from the click. Phone host requires its updated native
bundle to allow this protocol; Safari works with the web deployment.

Apple subscription is read-only and refresh timing is controlled by Apple.
Google URL subscriptions require its computer web UI; no claim of one-tap
Android setup or immediate sync. Downloaded files do not update automatically.
Copies already imported/cached by another app cannot be remotely erased.

## Verification and delivery

Real PG17/Redis integration: export content and ranges, series and exceptions,
own-only scope, bot/guest/stranger denials, grant lifecycle, tampering, capability
confusion, membership removal, policy/disabled/suspended denials and empty feeds.
Client tests cover date conversion, downloads, external link validation and
phone routing. Typecheck/lint, generated-code drift, relevant server race tests,
web/desktop builds and screenshots of desktop/mobile dialogs (dark/light).
QR decoding must recover the exact synthetic connect URL. Native Apple system
confirmation is not claimed tested without a real device.

All tiers; no billing changes. Local branch and commits for review; no push,
merge or production deployment without the owner's later ship approval.
