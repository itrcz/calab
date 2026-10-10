# ADR-0081. Native phone media permissions in shared settings

Status: accepted for local implementation (2026-10-09). Extends ADR-0067/0069/0070.

## Contract

- Keep the existing shared settings and onboarding. Add the optional iOS
  `mediaPermissionsVersion: 1` capability over the verified main-frame, exact-origin,
  current-document/sequence bridge. Older binaries, browsers and Electron retain
  their current behavior. No server/proto/auth, billing or capture-pipeline changes.
- Operations are exactly `status`, `request(kind: microphone | camera)` and
  `settings`. There is no caller-provided URL, OS permission name or credential.
  Responses contain only microphone/camera states (`granted`, `denied`,
  `not-determined`, `restricted`, `n/a`) and an optional settings-opened boolean.
- Native checks document authority before and after asynchronous work. Requests
  require the app to be active and the selected OS permission to be undetermined.
  They call AVFoundation authorization without opening a recording/capture session,
  changing AVAudioSession, or altering an active call. Denial is never re-prompted.
  One permission prompt at a time; invalidation discards stale responses.
- Shared settings show the native state, a Request access button while undetermined,
  and an Open system settings button after denial. The latter opens only Apple's
  fixed settings URL for this app and also serves denied notifications. Restricted
  access remains explicit. Returning from Settings refreshes the displayed state.
- Existing microphone onboarding uses the native request when supported, then runs
  its existing mic test. Settings requests themselves do not capture audio/video.
- WebKit can skip its extra site prompt only when the OS already granted the requested
  media and native WKFrameInfo proves the configured HTTPS origin, main frame and
  current WebView. Other frames/origins and undetermined/denied access retain WebKit's
  existing permission handling. Never use a blanket `grant` or host-only match.

## Acceptance and release

Test exact operation/state schemas, old-host fallback, stale-document/revoke/timeout,
request isolation and foreground refresh. Compile the native iOS code and patched
WebView. Check the existing settings screen at 390 px. Real-device gates remain:
first-time mic/camera prompts, denial -> Settings -> return, no duplicate site prompt
after an OS grant, and an existing call surviving a status/settings visit.
The complete behavior needs shared-web deployment and a new iOS build. No production
deploy, TestFlight replacement or publication is part of this local implementation.
