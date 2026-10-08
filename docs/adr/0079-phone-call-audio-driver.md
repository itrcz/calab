# ADR-0079. Native audio for iOS system incoming calls

Status: accepted for a local opt-in device proof, 2026-10-08. Not release ready.
Extends ADR-0067/0071; [device evidence](../mobile/locked-audio-findings.md).

## Decision and scope

The shared renderer continues to own UI, authentication, REST call transitions,
voice seats and permissions. An optional `callsAudioVersion: 1` host capability
uses LiveKit Swift 2.17.0 only for audio of an incoming CallKit-owned call. Ordinary
web/desktop calls, outgoing phone calls and room sessions retain their current
engine. Native audio never runs concurrently with the web room for the same join.
There is no new server endpoint, migration, native login or credential storage.

Use the official prebuilt Swift 2.17.0 XCFramework, pinned by the SHA-256 in its
[upstream manifest](https://github.com/livekit/client-sdk-swift-xcframework/blob/2.17.0/Package.swift),
with LiveKitWebRTC 150.7871.02 and LiveKitUniFFI 0.1.9. The thin local podspec only
describes that distribution; no SDK source fork. Native license texts are bundled.

The first opt-in proof is audio-only. It must not be published as full media
parity: camera/screen/musician controls require a subsequent driver contract.
Server permissions still cap all capabilities. This local build reports no
camera/screen grant for the native audio session; it creates no second UI.

## Bridge contract

Use the existing native-verified `calls` envelope (main frame, exact origin,
WebView owner, current document, increasing sequence). Old hosts do not advertise
the new version; old web clients keep existing calls. Envelopes are bounded at
8192 UTF-8 bytes; unknown fields and invalid UUIDs are rejected.

- `audioConnect`: event UUID, fresh connection UUID, room UUID, server-issued WSS
  URL (no credentials/fragment, at most 1024 chars), ephemeral JWT (at most 4096
  chars), relay-only policy, capped audio bitrate (8..64 kbps), canSpeak, and
  effective microphone mute/output volume/per-user volume settings.
- `audioControl`: event/connection UUID and the complete current audio controls.
- `audioDisconnect`: event/connection UUID. It cannot end a different session.
- Replies reuse calls state with optional `media`: event/connection UUID, phase,
  microphone readiness, mute and active speaker user UUIDs, plus a fixed error
  code on failure. No URL, token, SDP or device identifiers in events or logs.

Only a current reported call with a pending system answer or accepted answer may
prepare a native connection. The shared REST accept still precedes this request.
Capture requires both native acceptance and CallKit `didActivate`; permission
denial fails without retrying around the OS. An undetermined microphone permission
can be requested only with the app active. Native credentials stay in memory.

## Lifecycle and audio

One native room and one capture owner. Each async callback checks its document,
event and connection generation. End, logout, reload and replacement invalidate
that generation synchronously and stop capture before asynchronous RTC teardown.
Late connect/publication cannot mark a new call connected. No automatic fallback
to hidden WebView capture after a native failure.
Replacement waits for the previous SDK operations to drain before enabling the
engine. Initial mute is applied before track publication. Settings cannot start a
parallel WebKit microphone test during this native session.

CallKit owns audio-session activation. The SDK's automatic AVAudioSession changes
are disabled; its engine is available only inside CallKit activation. Native
voice processing supplies AEC/NS/AGC and native remote output (the native exception
to ADR-0004's browser `<audio>` rule). Mute keeps the track published; deafen also
mutes output. Server publish-permission revocation cannot be lifted by UI unmute.

The existing 15-second native readiness deadline remains (after up to ~10 s of CallKit
activation wait); the web-side `audioConnect` request therefore waits 30 s, other host
call requests 10 s. Connected means RTC,
required mic publication and CallKit audio activation, not just a signaling socket.
Perceptual audio still needs a real-device test. End and mute work through the
existing shared call state; native termination always releases its own media.
Participant removal retains the existing shared takeover grace; duplicate identity
leaves locally, and network loss uses the existing rejoin policy. Native failure
cleanup has a 15-second fallback if the shared document stops responding.

## Gates and rollout

Regression tests cover envelope boundaries, stale connection/document events,
mute/deafen and one transport per call. Native tests cover readiness/cancellation;
signed device build must compile without input drift. Test warm and cold locked
answer, 60 seconds of two-way speech, speakerphone echo, Bluetooth, mute/end,
permission denial and desktop takeover. Review the credential bridge before
publication. Default host builds leave this proof disabled until those gates pass.

The updated shared web adapter needs a web release or an explicitly configured
local preview before the device can use it. Native build success alone is not a
verified call; do not silently deploy shared web to complete the test.
