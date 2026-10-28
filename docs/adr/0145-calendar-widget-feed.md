# ADR-0145: Session-bound read-only calendar feed

Status: proposed, 2026-10-28. Depends on [ADR-0144](0144-caldav-date-preservation.md). Requires security review before merge.

## Why a separate capability

An iOS widget runs outside the host WebView and may refresh while the host is suspended. Passing the full web access/refresh session would grant unnecessary authority. Issue a narrowly scoped read capability instead. The main app remains the shared web client from ADR-0067; this change adds no general native API client or separate recurrence engine. The native system-surface exception is documented with the extension change.

## Issuance and token boundary

`POST /api/me/calendar-widget` uses the existing authenticated middleware. Only a human with a live local-account or workspace-SSO session can issue a grant. It is bound to that exact persisted user/session pair, not just the user. Bots, guests, machine identities, recovery authority and disabled/revoked/expired sessions are denied.

The HS256 key is HMAC-derived from `JWT_SECRET` using `calab/calendar-widget/v1`. A distinct type, issuer and audience separate it from normal API JWTs and RSVP links. Lifetime is at most 30 days, capped by the persisted session expiry; reopening the app can renew it. There is no new credential table or independent permanent token.

`GET /api/calendar-widget?tz=<IANA zone>` accepts only this grant in the Authorization bearer header. Normal access JWTs, bot tokens, cookies and URL tokens do not authorize this route. The bot/identity route inventory marks it as self-authenticating: `public` there means it bypasses the general bearer middleware, not that calendar data is anonymous.

## Read authority and disclosure

Every fetch resolves the persisted session again and applies existing identity, membership, workspace policy, permission and plan gates. Workspace SSO is restricted to its workspace. Personal CalDAV additionally requires global read authority and the existing paid-plan gate. Dependency failures fail closed.

The feed contains only the caller's organized/attended Calab meetings and permitted personal CalDAV imports, excluding declined/cancelled occurrences. It reuses the existing recurrence/exception logic. It covers seven local calendar days and at most 100 occurrences. Candidate queries cap at 1001 rows and reject over 1000 with 503; truncation reports `completeUntil` explicitly. An invalid timezone returns 422.

Returned fields are occurrence/event identifiers, applicable workspace ID, title, times, all-day DATE interval, source and color. No descriptions, attendee addresses, provider hrefs/passwords, conference credentials or recording links are exposed. Issuance and reads are rate-limited; both use `Cache-Control: no-store`.

## Revocation and client cache

Logout or revocation of the bound session makes subsequent feed reads fail, even if the JWT has not expired. Disabling the user or removing authority also takes effect on the next read. The native client separately clears its grant/cache and requests timeline reloads on explicit logout/account change. A grant does not extend the original session lifetime.

Already rendered widgets cannot be erased synchronously by the server. Remote revocation is observed at the next permitted fetch or expiry, and offline data is bounded by the grant expiry and feed window. This is a documented cache boundary, not an instant remote-wipe guarantee.

## Compatibility and verification

Deploy the additive migration and server before clients request the capability. Existing clients do not call the endpoints and are unchanged. Tests cover token confusion, anonymous/bot denial, exact-session revocation and expiry, SSO/workspace isolation, disabled/removed authority, own-only events, recurrence cancellations, all-day dates after timezone change, output bounds and minimized data. Two independent security/protocol reviews are required on the integrated implementation.
