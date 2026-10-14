# iOS locked answer: media findings and next scope

Status: device failure reproduced, 2026-10-08. Not release acceptance.

## What the device proved

The foreground and warm locked comparisons used the same installed build. The
foreground caller's tone was audible after setting the host WebView's
`mediaPlaybackRequiresUserAction=false`; previously `play()` rejected with
`NotAllowedError`. Audio RTP also reached the test caller, but intelligible
two-way speech and echo cancellation were not established by that test.

During the subsequent locked answer, REST accept/join succeeded, CallKit activated
the audio session and RTC connected. The remote `play()` promise fulfilled, yet
the listener heard nothing. `getUserMedia` stayed pending throughout the call;
the test caller received no microphone RTP. The caller ended at its 90-second
test boundary, not the host's 15-second deadline. After Calab became visible,
the pending capture completed without another reported permission prompt.

Therefore neither a connected RTC state nor a fulfilled playback promise proves
a working conversation. The cause of inaudible background output is not separately
isolated; the capture visibility dependency is directly observed.

## Platform evidence

WebKit's [`processUserMediaPermissionValidRequest`][permission] queues an already
granted request while the page is not visible. `viewIsBecomingVisible` releases
that queue. This matches the device ordering; upstream source is not a stack trace
of the installed iOS binary. The behavior is also described in [WebKit bug 164643][bug].

The public [`setMicrophoneCaptureState` implementation][capture] changes mute state
or stops existing capture. It does not start a pending request. Changing the
WebView permission delegate would not fix the earlier cached-grant visibility
branch. Keeping an idle microphone alive or falsifying visibility is excluded.

## Bounded next implementation

ADR-0067 permits a native media driver after device evidence. Preserve its single
web UI, navigation, cookie session and shared call/voice services. Replace only
the phone call's media transport and audio I/O, with one owner per call.

1. Write the driver ADR and bridge contract before changing the runtime. The
   renderer remains responsible for REST accept/join/leave, permissions, plans,
   session changes and call ownership. Native receives only that join's ephemeral
   media credentials through the existing native-verified main-frame, exact-origin
   and current-document boundary; no native login, persistent tokens or new API.
2. Prove the native path in a local opt-in build first. Candidate: LiveKit Swift
   **2.17.0**, whose [documented CallKit integration][livekit] lets CallKit control
   audio engine availability. Use the SDK's voice processing and audio output;
   no custom WebRTC build, remote WebAudio mix or simultaneous web/native room.
   Do not copy the abandoned RN client or its UI.
3. Bind connect, mute, end and late callbacks to the current call/document. End,
   logout, reload, permission denial and superseding calls release media; pending
   work cannot resurrect it. Readiness includes actual capture/publication and
   CallKit activation. Preserve the existing bounded failure path.
4. Keep ordinary web/desktop media unchanged. Unsupported native hosts retain the
   existing capability path. Do not silently remove video, room or media settings
   from the shared UI: expand the driver contract before exposing those features
   through it. The incoming-audio proof alone is not complete feature parity.
5. Before enabling the driver, check locked warm/cold answers, at least 60 seconds
   of intelligible two-way audio, speakerphone echo control, mute/end from both
   UIs, denied permission and desktop voice takeover on a real iPhone. Review the
   credential-bearing bridge independently before publication.

No SDK or native media runtime has been added by this findings checkpoint. Shared
web integration would need its normal web release; no new server endpoint or
server deployment is established as necessary. Push, PR and deployment remain
separate authorizations.

[permission]: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/UserMediaPermissionRequestManagerProxy.cpp
[capture]: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm
[bug]: https://bugs.webkit.org/show_bug.cgi?id=164643
[livekit]: https://github.com/livekit/client-sdk-swift/tree/2.17.0#integration-with-callkit
