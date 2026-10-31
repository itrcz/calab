# ADR-0149. iOS: native audio for voice rooms in the phone shell

Status: accepted, 2026-10-28 (GitHub #255); background and lock ship first (Delivery order). Extends ADR-0067/0079; amends ADR-0004 (native
output exception), ADR-0014 (gate implementation) and ADR-0069 (lock-screen mute). Aligned with
ADR-0150 (60 s seat grace). Plan: [ios-native-room-audio](../plans/ios-native-room-audio.md).

## Context

Reported on an iPhone, 28.10: in a room, music, Instagram and other apps are inaudible or their volume
"pumps"; starting music interrupts the room; lock/background leads to reconnects and sometimes no
audio either way afterwards. The shell runs LiveKit JS inside one WKWebView (ADR-0067), so WebKit
owns the app's AVAudioSession: non-mixable play-and-record, and the mic stays captured while muted
(ADR-0014 gates with `track.enabled`). Its voice-processing I/O ducks other audio and neither the
page nor the host can configure that. Nobody handles interruptions, and in background the page
freezes once the app has no active media, so LiveKit JS drops.

ADR-0079 already links LiveKit Swift 2.17.0 for CallKit calls (opt-in proof, not release ready).
Its 2.17.0 sources expose what WebKit hides: manual session configuration, `duckingLevel` (iOS 17,
SDK default `.min`), `isAdvancedDuckingEnabled` (default off), microphone mute modes, engine
availability, a capture post-processing delegate, `SoundPlayer`, token refresh and SFU room moves.

## Decision

**1. Split.** On a capable iOS shell, room audio moves to native; the rest stays in the shared web.
- Native `CalabRoomAudio`: the LiveKit Room of the device identity `<user>:<session>`; capture,
  publish, remote playout, AVAudioSession, interruptions, routes, resets, gate, cues, reconnect.
- Web: UI, REST join/leave, `PATCH /api/voice/self`, permissions, seat and voice state (gateway),
  chat, settings, Live Activity snapshots, video (§3).
- One media owner per join: a join (`connectionId`) is native-audio or web-media for its whole
  life; never WebKit capture or `<audio>` beside it. A native failure before capture may fall back
  to the web path once, in foreground, after native reports a drained `ended`; never mid-session.
- v1 scope: workspace voice rooms. 1:1 calls (ADR-0034), SIP answers (ADR-0133) and CallKit calls
  (ADR-0079) keep their engines. Safari, Android, Electron and old shells keep the web path.

**2. Bridge.** ADR-0079's boundary unchanged: main frame, exact origin, current document, sequence,
8192-byte envelopes, unknown fields rejected, credentials in memory only, no URL/token/SDP/device
names in events or logs. Capability `roomAudioVersion: 1` only from a flagged build on iOS 17+. New
message type `roomAudio` (no CallKit event binds a room); parsers in `shared/hostRoomAudio.ts`,
mirrored in Swift with shared fixtures:
- `connect`: connectionId (fresh per attempt), roomId, `wss` URL (≤1024, no credentials/fragment),
  JWT (≤4096), relayOnly, bitrate 8–64 kbps, red, canSpeak, controls. `disconnect`: connectionId.
- `control`: complete controls: muted, deafened, volume, userVolumes (≤64), gate {mode voice|ptt|
  open, thresholdDb, pttOpen}, watched stream publishers (≤4), levels on/off. `cue`: a fixed name.
- State: phase (connecting, connected, reconnecting, lost, interrupted, ended, failed),
  microphoneReady, muted + origin (web, system, server), canSpeak, speaking (own gate), speakers
  (≤64 user UUIDs), route kind, phoneCall, error code, levels (0–20) only when asked. Native keeps
  one latest snapshot, emits it ≥100 ms apart and queues nothing for a frozen page.

**3. Video: a companion connection.** The WebView keeps a second, subscribe-only LiveKit connection,
identity `<user>:<session>:web`: camera and screen-share *video* plus the existing data topics (stream
watch, annotations), never an audio kind; native subscribes screen-share audio while it is watched.
- `POST /api/rooms/{id}/voice/companion` → url, token, identity; needs this session's seat in the
  room (pending, connected or held) and the identity check, never creates or changes a seat. Grant:
  subscribe (VIEW_ROOM & CONNECT), data, no sources in v1, TTL 10 min; not `hidden` (data needs it).
- `voice.ParseIdentity` keeps rejecting the suffix (pin with a test); new `ParseCompanion`.
  Companion join/leave never touches voice state, ADR-0150 grace, cues or SIP `PersonLeft`; one
  without its session's seat is removed. Every path that removes a device (leave, kick, revoke,
  other device, grace expiry, sweep, reconcile) removes its companion; resync updates its grant.
- DUPLICATE_IDENTITY: the distinct identity never displaces the native connection; a newer
  companion of the same session replaces the old one as "superseded", not as a takeover.
- Capacity: counts against `LIVEKIT_MAX_PARTICIPANTS` (50), not user_limit, plan limits or billing
  seats; failure only disables video. Lazy: foreground with a camera, screen or data feature in
  the room; closed 30 s after none and on background. My native identity is "me", not a tile.
- Out of v1: own camera publish (first prove WebKit camera capture leaves the session alone), musician
  mode, workspace soundboard clips. Rejected: same identity (DUPLICATE_IDENTITY evicts native); native
  video over the WebView (second UI, ADR-0067); hidden companion (data features break); audio-only
  (cameras and screens vanish; acceptable only as the internal first stage).

**4. Mute keeps capture running.** Mute = `LocalAudioTrack.mute()` (server voice state, ADR-0014)
plus engine mute in `.inputMixer` mode: no system chime, no session reconfiguration, instant unmute.
Because capture started in foreground and continues, unmute works from the lock screen and the Live
Activity; iOS lets a background app continue capture, not start it. Accepted costs: orange mic
indicator, voice processing and Bluetooth HFP stay on in the room. Listeners without SPEAK never
capture: `.playback` + `.mixWithOthers` (A2DP, no ducking); a later grant captures on the next
foreground. Rejected for v1: release capture after N s muted (lock-screen unmute fails, each toggle
flips HFP↔A2DP audibly, `.restart` re-activates the session); revisit as explicit "listen only".

**5. Gate, rings, levels (ADR-0014 parity).**
- Gate in the capture post-processing delegate: closed → zeros (Opus DTX), track published and
  unmuted. RMS threshold from the web slider, open after 2 frames, 400 ms hangover; `ptt` follows
  `pttOpen`; `open` never gates. Allocation-free on the audio thread.
- Own ring = gate. Remote rings and active speaker = LiveKit server speakers (as Safari today).
  Per-user volume = `RemoteAudioTrack.volume`. Deafen = unsubscribe all remote audio + mute.
- Bridge rate: state on change only, ≥100 ms apart; levels only while web asks (mic test or a
  visible meter, foreground) at 10 Hz in 21 steps, auto-off after 30 s. Idle room: zero messages.
- UI cues and built-in soundboard clips play natively by name via `SoundPlayer`, inside the AEC
  reference. The WebView stays silent: no `getUserMedia` audio, no `<audio>`/WebAudio output.
  Not in v1: musician mode (VPIO bypass + 128 kbps republish), background auto-mute.

**6. Audio session policy.** Calab owns the session (`isAutomaticConfigurationEnabled = false`):
activate before enabling the engine, deactivate with `.notifyOthersOnDeactivation` on leave.
- Speaking: `.playAndRecord`, mode `.voiceChat`, options `.mixWithOthers`, `.allowBluetoothHFP`,
  `.allowBluetoothA2DP`, `.defaultToSpeaker`. A headset with both profiles routes HFP (Apple): its
  mic works, other apps play through HFP too. Speaker by default; the system route picker overrides.
- Ducking: `duckingLevel = .min`, `isAdvancedDuckingEnabled = false`, set explicitly so an SDK
  default change cannot reintroduce pumping. Both need iOS 17, hence the capability floor.
- Interruption began: `interrupted`, track muted (others see muted, not frozen), engine off; with a
  phone call (`CXCallObserver`) web sets `on_phone` (ADR-0133). Ended: reactivate even without
  `.shouldResume` (we are mixable); the mic stays muted after a call, else the intent returns.
- Route change: re-read the route kind; `.categoryChange` that left the session different from our
  configuration re-applies it and is counted (WebKit or the SDK changed it). Our own `setCategory`
  posts the same event, so a matching session is left alone. Media-services reset: rebuild
  session, engine and publication, else `failed(audio)` and web rejoins. Foreground: verify
  category, activation and engine. Unmuted capture without frames for 3 s restarts the engine once.
- One engine owner (`CalabAudioOwner`): `AudioManager.shared` (engine, mute mode, ducking, delegate)
  is process-wide; room and CallKit drivers never hold it together. A CallKit answer makes the room
  yield synchronously (mute, engine off) before `didActivate` reaches the call driver; ADR-0034 then
  has web leave the room; decline, cancel or failed accept resume it. ADR-0133 parking excludes
  native audio: a SIP answer leaves the room and native releases the session before WebKit capture.

**7. Background and reconnect.**
- Alive: UIBackgroundModes `audio` (present) + active session + engine running while connected,
  muted or deafened included. Native never waits for the frozen page.
- LiveKit Swift reconnects (quick/full, refreshed tokens) and follows SFU moves. Attempts, delays
  and timeouts are set so the worst case ends inside VOICE_LOST_GRACE (tested); the SDK default
  (10 attempts, about 50 s of delays alone) does not fit, and a late reconnect would recreate a seat
  others saw end. Then `lost`: foreground web rejoins via REST and a new `connect`; in background
  the Live Activity shows no connection and the seat ends with the grace. No native login or REST.
- Removal, duplicate identity, room deletion: native stops by itself (desktop takeover works with a
  frozen page); web reconciles on resume. Server mute arrives as a grant change.
- Live Activity (ADR-0069): native updates phase and mute between web snapshots; a lock-screen mute
  button (`LiveActivityIntent`) toggles native mute, the server learns it from the track.

## Delivery order

Background and lock come first, the rest follows (28.10).
- Stage 1, background and lock: session policy and engine owner, bridge, native room driver, web
  selection. A room keeps two-way audio in background, locked, while music starts, while a Telegram
  video note is recorded and across a network change. The §6 session policy ships as is, mixing
  included. Built with the room flag only, without the CallKit flag. A native-audio join shows no
  cameras or screens yet (the audio-only internal stage of §3), so the build goes to internal
  testers only.
- Stage 2, the rest: companion video (§3), Live Activity updates and lock-screen mute (§7), CallKit
  coexistence (§6), loudness and Bluetooth checks on device, then a build for everyone.

## Rollout and gates

- Build flag `CALAB_IOS_NATIVE_ROOM_AUDIO=1`, independent from incoming calls; the plugin links the
  same pinned LiveKit pod. Default builds are unchanged. Web selects native only with the
  capability; kill switch = a web release that stops selecting it. No server flag.
- Safari and old shells stay on the web path: WebKit gives pages no mixing, ducking or interruption
  control (its Audio Session API offers coarse types only; not tried on device). Documented in docs/02.
- Tests: envelope boundaries (TS + Swift fixtures), stale document/connection, one owner per join,
  controls convergence, policy/owner/gate state machines, plugin output, server companion rules.
  Two independent reviews for the credential bridge and the companion token path.
- iPhone-only gates (signed Release, full list in the plan): Apple Music/Spotify loudness, Instagram,
  Telegram video note, music start keeps the room, lock 10 min, Wi-Fi↔LTE, Bluetooth, speaker echo
  and music leak, WebView media vs the category, CallKit and cellular calls, lock-screen mute,
  desktop takeover, denied permission, energy vs the WebKit baseline.
- One engine and one driver for calls and rooms only after: ADR-0079 gates pass; room→call→room on
  a device with both flags; switching CallKit-owned and app-owned activation leaves no stale engine
  availability, mute mode or category. Then merge, also for in-app 1:1 calls.

## Consequences

Rooms on iPhone mix with other apps and survive lock; the ADR-0004 native exception covers rooms
(remote audio, cues and AEC in one engine). An iPhone with video holds two connections; the server
learns a companion identity. v1 native gaps: own camera, musician mode, workspace clips, iOS 16.

## Product decisions (28.10)

1. After a phone call the mic comes back muted.
2. Bluetooth defaults to HFP: the headset mic works; music from other apps sounds like a phone call.
3. v1 ships without own camera, musician mode and workspace sound clips on iPhone.
4. `.mixWithOthers` stays on every route, the speaker included; revisit only if device tests show
   music leaking into the room past the echo canceller.

## Settled in stage 2

Companion details (identity format, endpoint, webhook rules, `LIVEKIT_MAX_PARTICIPANTS` headroom) are
reviewed with the R5 pull request.
