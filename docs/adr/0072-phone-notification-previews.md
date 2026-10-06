# ADR-0072. Phone notification previews and CallKit answer readiness

Accepted for local implementation, 2026-10-06. Amends ADR-0070/0071.

The owner confirmed real iPhone push delivery and requested sender/message previews,
the caller's name, and one successful answer from the system call screen. The existing
web renderer remains the only UI, auth, call-state and RTC implementation.

- After the existing send-time session/access/settings checks, read the current message
  and author. Ordinary APNs alerts carry a bounded single-line sender (80 Unicode scalars)
  and message preview (240); attachment-only messages use a localized type label. Never
  include attachment URLs, auth data or internal routing IDs in presentation fields.
  iOS notification preview settings control display on the lock screen. This deliberately
  replaces the previous generic-only alert decision: Apple now receives the preview text.
- VoIP carries an optional `callerName`, resolved from the currently ringing call's author
  after the same policy checks. CallKit treats it only as presentation, with a bounded
  generic fallback. Opaque routing, authenticated resolve, expiry and revocation are unchanged.
  Old hosts ignore the additional field; new hosts accept old generic payloads.
- Keep native answer, web media connection and CallKit audio activation as independent
  readiness facts. Their ordering must not discard a completed connection or leave a
  failure timer running after all three facts arrive. Configure the system audio session
  for voice before fulfilling an answer; CallKit controls activation. No second capture,
  playback or RTC pipeline is introduced; shared web AEC/output rules remain unchanged.
- Each queued web action gets its bounded request budget when it starts, within its original
  native expiry. Waiting behind the ring action must not consume a parallel six-second timer.
- One voice device at a time remains the server policy. A workspace connection on desktop
  must yield to a phone answer without the desktop hanging up that call. Reproduce/check
  this separately; a timeout fix alone is not proof of device handover or cold locked audio.

- Both web Accept and native Answer reuse one in-flight action in the common call service.
  A delivered, unexpired receipt may resolve the current ACTIVE call under the same exact
  session/access checks. This describes state, not permission to adopt it: the phone must
  prove that this web document already owns its matching active or in-flight accept, await
  that request, and require its successful HTTP accept response as ownership proof. Gateway
  ACTIVE is deferred during that request; failure clears optimistic ownership. Joining a native
  action attaches its deadline/cancellation to a web-first request and unblocks the native
  queue on cancellation; late success follows the existing bounded cleanup without RTC.
  Other-device ACTIVE stays rejected. Push dispatch
  still requires RINGING; existing servers/hosts remain compatible without guaranteed race repair.
- Wire `@user UUID` mentions render the recipient's own display name or a generic localized
  member label. Arbitrary IDs in authored text must not trigger unrestricted profile reads.

No migrations, new permissions, tariffs, native login or new screens. Task/calendar payloads
remain unchanged. Acceptance: provider payload/authorization tests; action queue and native
readiness ordering tests; relevant call/voice takeover checks; iOS build; then actual phone
preview, one-tap answer, desktop-room handover and >30 s bidirectional locked audio. Device
gates are unverified until observed after web/API deployment and native installation.

Audio lifecycle reference: [Apple CallKit sample](https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls).

## Baseline follow-up, 2026-10-06

Owner authorized the four audit repairs and one PR, without deployment or installation.

- Call bridge v1 with optional `callsMuteVersion: 1` adds bounded `mute`/`unmute` actions and microphone-state sync. The existing
  web voice service alone changes capture, under the current document/session and locally
  owned active call. A mute action cannot accept a call, switch rooms or lift moderator mute.
  CallKit fulfils only after the shared voice state has applied the requested value; failure
  or timeout fails that action without ending a healthy call. Web microphone changes update
  CallKit through its standard transaction, without echoing another microphone mutation.
  Web remains compatible with old hosts; new hosts keep answer/end with old web and reject
  system mute until the current web document has synchronized microphone state.
- Message dispatch remains bounded to five minutes. Once sent, an opaque notification route
  may be resolved for seven additional days, still requiring the exact live session, endpoint
  version, delivered receipt and current message/access policy. Calls keep their existing
  short deadlines. Reuse `expires_at` for pending dispatch versus completed receipt retention;
  no schema migration. APNs/FCM transport expiry stays short. Retention is bounded by the
  existing 2048 ordinary receipts per endpoint; oldest completed messages may be evicted to
  admit new work, never pending jobs or the current call. Old already-delivered payloads keep
  their original expiry. Expired/deleted/foreign/revoked references remain unusable.
- Explicit logout/account change clears this application's delivered Notification Center
  entries as well as pending navigation. Reload/document replacement is not logout. This
  does not claim to recall a push already accepted by APNs but not yet delivered.
- An APNs registration error can be retried on foreground return or explicit permission
  request after a 15-second cooldown. No polling, new permission prompt or background loop.

Acceptance: mute idempotency, ownership/session/deadline/permission guards and both directions;
late message tap plus revoked/deleted/expired references, short provider TTL and receipt cap;
native logout/reload isolation and registration retry policy; required lint/typecheck/generation
and targeted race integration; native compile. Real locked/cold answer/audio remains a device
gate after the matching web/API release and phone installation.

## Communication presentation, 2026-10-06

Owner requested avatars and a bounded audit of adjacent notification/call behavior in PR123.

- Keep the existing access checks, renderer, routes and credentials. Presentation gains
  binding-scoped opaque person/conversation identifiers and an optional inline JPEG avatar.
  The server reads only the current author's avatar after dispatch authorization, from the
  existing private blob store. No public avatar URL, new endpoint, shared login/keychain,
  or notification-extension network access. Thumbnails are at most 64 px / 1536 bytes;
  bounded cache and best-effort work must not hold up delivery. Invalid/missing avatars
  fall back to the sender's name. Provider serialization stays below APNs size limits.
- APNs message alerts opt into the standard notification service extension and group by
  conversation (`thread-id`) and include the authorized room/group name as a bounded subtitle. The extension donates INSendMessageIntent and updates the
  notification with its sender image. It preserves routing, sound, expiry and category,
  completes exactly once, and returns the original alert on unsupported/malformed data.
  Native communication presentation is additive; old builds still display text alerts.
- Calls report to CallKit immediately, with a nonempty generic handle matching the donated
  INPerson identifier. INStartCallIntent carries the caller image without delaying ringing
  or changing audio/answer ownership. CXCallUpdate has no per-caller image property: donation
  does not guarantee a profile photo on every system call screen. Do not write Contacts,
  add a duplicate alert, or replace CallKit to imitate one. Actual rendering is a device gate.
- Explicit logout also deletes this app's donated interactions. No outgoing-message/call
  donations, Siri calling handler, quick reply, badge counter or Focus bypass is introduced.
  These require separate shared-state/lifecycle contracts; an incomplete counter or action
  would be misleading. The adjacent repair is stable conversation grouping and CallKit handle.
- Native configuration adds Communication Notifications and a notification service target
  to push-enabled builds. A matching development profile and new signed phone build are
  required; existing APNs credentials and server schema/config stay unchanged.

Acceptance: avatar bounds/cache/malformed input and missing blob; payload byte limit and
stable account-scoped grouping; authorization remains ahead of presentation; extension
idempotent project generation; native compile; text-only fallback and logout cleanup.
Check actual avatars/grouping and CallKit presentation on the device after rollout.
References: [Apple communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications),
[CXCallUpdate](https://developer.apple.com/documentation/callkit/cxcallupdate).
