# iOS native room audio — implementation plan

ADR: [0149](../adr/0149-ios-native-room-audio.md). Issue: GitHub #255. Status: accepted
28.10. Order: stage 1 (background and lock) first, stage 2 (the rest) after it.

Goal: on an iPhone shell built with `CALAB_IOS_NATIVE_ROOM_AUDIO=1`, workspace voice rooms use native
LiveKit Swift audio that mixes with other apps, handles interruptions and survives lock, while the
shared web keeps UI, REST, permissions, seat state and video. Everything else keeps working as today.

## Rules for every step

- One goal per PR, worktree from fresh `origin/main` (after the previous step merged), `git commit -s`,
  English messages, no co-author trailers. Checks as CI: `make gen` + `git diff --exit-code`,
  `make lint`, `go test -race` of touched packages + the package's integration test,
  `pnpm -s typecheck && pnpm -s lint && pnpm -s test` (desktop and mobile workspaces).
- Native code that holds logic (parsers, policy, gate, owner) stays outside `#if canImport(LiveKit)`
  so the existing `swiftc` harness (`apps/mobile/src/*Wire.test.ts` compiling `apps/mobile/tests/*.swift`)
  can test it without the SDK. The LiveKit-bound part stays thin.
- Native compile proof per native step: unsigned arm64 Release with and without the flag, no drift
  in generated native inputs (docs/mobile/shared-web-status.md). Compiling is not device evidence.
- "iPhone:" marks what only a real device can prove; such results go into
  `docs/mobile/room-audio-testing.md` with build, iOS version and date.
- Reviews: one per PR; two independent reviews for R2 (credential bridge) and R5 (tokens, grants).

## Alignment with parallel work

- ADR-0150 seat grace (PR #257, VOICE_LOST_GRACE 60 s, `connection_lost`):
  R5 starts after it merges; companion rules sit next to `seatAfterDrop`/`explicitRelease` and never
  feed them. R3's reconnect schedule is tested to end inside the grace: a LiveKit reconnect after
  the grace would recreate the seat through `participant_joined`.
- Web audio recovery (PR #260: startAudio, resubscribe, mic health,
  rejoin backoff): R4 rebases on it; every recovery path returns early for a native-owned join.
- Autoplay fix (PR #256): keeps the web path healthy; independent.
- PRs #253 (calendar widgets) and #254 (phone links) touch `apps/mobile/src/App.tsx` and the
  hostActivity bridge: R2 is additive (new message type and capability) and rebases after them.

## Steps

### Stage 1: background and lock

| # | Goal (one PR) | Layers | Depends | Days | iPhone |
|---|---|---|---|---|---|
| R0 | ADR-0149 + this plan | docs | — | 0.5 | — |
| R1 | Session policy, engine owner and a debug probe | Swift | R0 | 2 | gates G1–G5 |
| R2 | `roomAudio` bridge contract and capability | TS shared, RN, Swift parsers | R0 | 1.5 | — |
| R3 | Native room driver behind the build flag | Swift, Expo plugin | R1, R2 | 4 | G6, G8, G14 |
| R4 | Web voice service selects the native driver | web | R2, R3 | 3 | stage 1 run |

Done when an internal TestFlight build with only `CALAB_IOS_NATIVE_ROOM_AUDIO=1` passes G2, G3, G4,
G6, G8, G14, G16 and G17. In that build a native-audio join shows no cameras or screens (R4 shows
why), so it stays with internal testers.

### Stage 2: the rest

| # | Goal (one PR) | Layers | Depends | Days | iPhone |
|---|---|---|---|---|---|
| R5 | Server companion identity and endpoint | proto, Go | R0, ADR-0150 | 3 | — |
| R6 | Web companion connection for video and data | web | R4, R5 | 2.5 | G10 |
| R7 | Live Activity updates and lock-screen mute | Swift, widget | R3 | 2 | G12, G13 |
| R8 | CallKit coexistence through the engine owner | Swift | R1, R3 | 1.5 | G11, G15 |
| R9 | Device acceptance run, docs, status | docs | R3–R8 | 1 + 2 device | all |

Stage 1 ≈ 11 developer days + 1 device session, stage 2 ≈ 10 days + 2 device sessions, with the
owner's iPhone and a desktop peer.

### R1. Session policy, engine owner, probe (critical: decides go/no-go early)

- Files: `modules/calab-session-activity/ios/CalabAudioSessionPolicy.swift` (pure: category, mode,
  options, ducking for speaking/listening/interrupted/call states; interruption, route and reset
  transitions), `CalabAudioOwner.swift` (one owner of `AudioManager.shared`: room, call or none;
  call precedence; mute mode, ducking and processing delegate set per owner), a debug-only probe
  compiled out of Release: LiveKit local recording + `SoundPlayer` tone with the exact policy, no
  room, no web, started by a launch argument.
- Tests: `tests/AudioSessionPolicyTests.swift`, `tests/AudioOwnerTests.swift`, wrapper
  `src/audioPolicy.test.ts` (swiftc harness).
- iPhone: G1–G5 with the probe. If G5 (WebView media vs our category) fails, stop and decide
  before R3: block web media playback with sound during a native room, or reassert and accept gaps.

### R2. Bridge contract

- Files: `apps/desktop/src/shared/hostRoomAudio.ts` (types, parsers, bounds: 8192 bytes, UUIDs,
  `wss` URL ≤1024, JWT ≤4096, ≤64 user volumes, ≤4 watched publishers, fixed cue names),
  `shared/hostActivity.ts` (message type `roomAudio`), `apps/mobile/src/activityProtocol.ts`
  (`roomAudioVersion: 1` when native reports support), `apps/mobile/src/roomAudio.ts` (RN glue as in
  `incomingCalls.ts`), `App.tsx` wiring (document/generation checks as for `calls`),
  `apps/mobile/tests/RoomAudioWireFixture.swift` + Swift parser.
- Tests: `shared/hostRoomAudio.test.ts` (every bound, unknown fields, wrong document/sequence),
  `activityProtocol.test.ts`, `src/roomAudioWire.test.ts` (TS and Swift accept/reject the same fixtures).

### R3. Native room driver

- Files: `ios/CalabRoomAudio.swift` (LiveKit Room, connect/control/cue/disconnect, generation and
  document checks as in `CalabCallAudio.swift`, `autoSubscribe: false`, subscribe microphones and
  watched screen-share audio, ignore `:web` identities, permissions, removal/duplicate/moved,
  reconnect schedule constant, speakers coalescing, interruption/route/reset handlers wired to
  R1, capture watchdog), `ios/CalabVoiceGate.swift` (pure gate + RMS, allocation-free),
  `ios/CalabRoomAudioModule.swift` (Expo module), bundled cue and built-in soundboard assets
  (converted from `apps/desktop/src/renderer/assets/sounds` at build time to a format `AVAudioFile`
  reads), `plugins/withCallAudio.js` (also links the pod for the new flag, writes
  `CalabRoomAudioEnabled`), `app.config.ts` (flag, independent from incoming calls).
- Tests: `tests/RoomAudioInputTests.swift` (inputs, stale generation, controls convergence),
  `tests/VoiceGateTests.swift` (2-frame open, 400 ms hangover, ptt, open), `tests/ReconnectScheduleTests.swift`
  (worst-case delays + socket/transport timeouts < VOICE_LOST_GRACE 60 s; the SDK default does not
  fit), `plugins/withCallAudio.test.js` (flag on/off, no stale pod line).
- Bridge: gate on the document natively as `CalabIncomingCallsModule.swift` `audioOperation` does,
  serialize connect and disconnect, rate-limit operations, never force-unwrap the URL.
- iPhone: G6, G8, G14 with a local web preview of R4 (no silent web deploy); G7 and G9 in stage 2.

### R4. Web voice service

- Files: `renderer/lib/media/hostRoomAudio.ts` (`HostRoomAudioSession`, like `HostCallAudioSession`),
  `renderer/services/voice.ts` (room joins choose native when the capability exists: no
  `getUserMedia` audio, no `<audio>`, controls from the store, cues and mic-test levels through
  native, musician mode and workspace clips hidden with a reason, cameras and screens replaced by
  a reason until R6, one foreground fallback to the web path before capture), `renderer/platform/*` (capability exposure),
  `renderer/lib/voiceLogic.ts` only if gate mapping needs it.
- Tests: `lib/media/hostRoomAudio.test.ts`, `services/voice.test.ts` (one owner per join, no web
  capture, recovery paths skipped, fallback only before capture, state mapping, rejoin on `lost`).
- Controls: clamp `userVolumes` to 1 as `nativeControls()` does for calls; one value above 1 drops the whole control.
- Visual: one QA pass of the voice island and settings on iPhone width (hidden controls, reasons).

### R5. Server companion identity

- Files: `apps/server/internal/voice/voice.go` (`CompanionIdentity`, `ParseCompanion`),
  `internal/rtc/companion.go` (`POST /api/rooms/{id}/voice/companion`), `rtc/webhook.go`,
  `rtc/sync.go`, `rtc/identity.go`, `rtc/rtc.go` (`removeIdentities` callers, `pushGrant`),
  `rtc/devices.go`, `rtc/leave.go`, `proto/calaba/v1/*.proto` + `make gen`, docs/05 and docs/04 rows.
- Tests: `voice_test.go` (`ParseIdentity` rejects `:web`), `rtc/companion_test.go` (grant has no
  sources, needs a seat), `rtc/companion_integration_test.go` (join/leave of a companion leaves
  voice state, grace and cues untouched; leave/kick/revoke/other device/grace expiry/sweep remove
  it; duplicate companion supersedes only the companion).
- Note: `LIVEKIT_MAX_PARTICIPANTS` stays 50 until R9 measures rooms with several iPhones.

### R6. Web companion connection

- Files: `renderer/services/voiceCompanion.ts` (video-only Room; subscribe camera and screen video
  only; data topics `WATCH_TOPIC`, `ANNOT_TOPIC`; lazy connect/disconnect; my native identity treated
  as me), `services/voice.ts` (wiring, watched stream → native control), `services/annot.ts`.
- Tests: `voiceCompanion.test.ts` (never subscribes an audio kind, lazy timers, superseded handling,
  no seat assumptions), `voice.test.ts` (no duplicate self tile, cameras/screens visible).
- iPhone: G10 (muted video tiles do not change the session category).

### R7. Live Activity and lock-screen mute

- Files: `ios/CalabSessionActivityModule.swift`, `ios/CalabVoiceAttributes.swift`, widget extension
  intent under `widgets/`, `plugins/withSessionActivity.js`; ADR-0069 status line points to 0149.
- A thawed page's stale `muted:false` must not undo a native mute; if that needs a revision in the
  contract, it comes with a capability bump here.
- Tests: Swift merge rule (native phase/mute vs newer web snapshot), plugin test for the intent.
- iPhone: G12, G13.

### R8. CallKit coexistence

- Files: `ios/CalabIncomingCallsModule.swift` (answer → `CalabAudioOwner` makes the room yield before
  `didActivate`; decline/cancel/failure → resume), `ios/CalabCallAudio.swift` (acquire/release through
  the owner, its own mute mode and ducking), `CXCallObserver` → `phoneCall` in room state.
- Tests: `tests/AudioOwnerTests.swift` (yield/resume orders, late callbacks, failed accept).
- iPhone: G11, G15 on a build with both flags.

### R9. Acceptance and docs

- `docs/mobile/room-audio-testing.md` (scenario and results), `docs/02-media.md` (native exception
  covers rooms; Safari limitation), `docs/mobile/shared-web-status.md`, `TESTING.md` (≤15 lines),
  ADR-0149 status line records the device results; a finding that contradicts it goes to a new ADR.

## Critical path

Stage 1: R0 → R1 (probe) → R2 → R3 → R4 ≈ 11 days, then the stage 1 device run. Stage 2 starts
after it: R5 → R6 → R9, with R7 and R8 beside R5–R6. The probe's G5 result is the first go/no-go; G8/G9 confirm product decision 4 (mixing on the speaker).

## Device gates (iPhone, signed Release, desktop peer in the same room)

| # | Scenario | Pass |
|---|---|---|
| G1 | Apple Music playing, join room, talk, mute, unmute | music never stops; level steady, no pumping when either side speaks |
| G2 | Spotify; start music while already in the room | room audio and mic continue, no interruption event |
| G3 | Instagram feed with sound; Telegram video note recorded and played | room resumes ≤ 2 s after the note; mic state per rule |
| G4 | Lock 10 min in a room (muted and unmuted, with music) | no reconnect; two-way audio right after unlock |
| G5 | Chat voice message and inline video with sound in the WebView | category unchanged (or reasserted ≤ 1 s), room continues |
| G6 | Wi-Fi ↔ LTE during speech | audio back ≤ 5 s; seat never ends |
| G7 | AirPods and an HFP headset; connect/disconnect mid-room | headset mic used; falls back to speaker |
| G8 | 60 s two-way on speaker | peer hears no echo (ADR-0004 manual echo test) |
| G9 | Music on speaker while unmuted | record whether the peer hears it |
| G10 | Cameras and a screen share via the companion | video visible, category unchanged, no duplicate self |
| G11 | Incoming CallKit call during a room: answer, decline, caller cancel | answer leaves room (ADR-0034); others resume room ≤ 2 s |
| G12 | Mute/unmute from the lock screen after 10 min locked | server voice state follows ≤ 1 s |
| G13 | Desktop takeover while the phone is locked | phone audio stops ≤ 2 s, activity ends |
| G14 | Denied microphone permission; listener without SPEAK | fixed error, no background prompt; listener mixes via A2DP |
| G15 | Cellular or FaceTime call during a room | others see muted; room resumes after; mic stays muted |
| G16 | 30 min locked muted room | battery and CPU not above the WebKit baseline on the same phone |
| G17 | Safari and an old shell with the new web | unchanged web path |

## Rollback

Web release that stops selecting `roomAudioVersion` (no binary needed); build without the flag;
the server companion endpoint is unused without R6 and harmless (no seat effects).

## Risks

1. WebKit may still change the shared session when the page plays media (G5, G10). Mitigation decided
   after R1; until then web media with sound is the top unknown.
2. `.mixWithOthers` with voice processing: LiveKit notes an echo risk and an engine-init race it retries
   (G8, G9). Fallback: no mixing on the built-in speaker route.
3. A frozen page cannot rejoin after LiveKit gives up in background; the seat ends after 60 s. Accepted.
4. A companion missed by one removal path would outlive its seat: integration tests and two reviews.
5. Two drivers on one process-wide `AudioManager` until unification: `CalabAudioOwner`, G11, G15.
6. Ducking control needs iOS 17; iOS 16 phones keep the WebKit path.
