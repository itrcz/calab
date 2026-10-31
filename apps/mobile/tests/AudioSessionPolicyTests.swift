import Foundation

private let elsewhere = CalabAudioSessionConfig(category: .playAndRecord, mode: .other, options: [.allowBluetoothHFP])

@main
struct AudioSessionPolicyTests {
  private static func joined(canSpeak: Bool) -> CalabAudioSessionMachine {
    var machine = CalabAudioSessionMachine()
    _ = machine.handle(.join(canSpeak: canSpeak, callHolds: false))
    return machine
  }

  static func main() {
    policyTable()
    print("PASS: category, mode, options and ducking per state")
    lifecycle()
    print("PASS: activation precedes the engine and leave notifies other apps")
    interruptions()
    print("PASS: interruptions reactivate, and the microphone follows the phone call rule")
    routes()
    print("PASS: only real drift re-applies the configuration")
    resets()
    print("PASS: media reset rebuilds now or after the interruption, else fails")
    foreground()
    print("PASS: foreground verifies the session and retries a lost interruption end")
    grants()
    print("PASS: capture starts only in foreground and a revoked grant stops it")
    callYield()
    print("PASS: the room yields to a call and leaves its session alone")
  }

  private static func policyTable() {
    let speaking = CalabAudioPolicy.of(.speaking)
    precondition(speaking.session?.category == .playAndRecord && speaking.session?.mode == .voiceChat)
    precondition(speaking.session?.options == [.mixWithOthers, .allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker])
    precondition(speaking.ducking == CalabAudioDucking(level: .min, advanced: false), "pumping can return")
    precondition(speaking.engine && speaking.capture)
    let listening = CalabAudioPolicy.of(.listening)
    precondition(listening.session?.category == .playback && listening.session?.options == [.mixWithOthers], "listener must stay on A2DP")
    precondition(listening.engine && !listening.capture, "a listener never captures")
    for state in [CalabAudioState.idle, .interrupted, .call] {
      let policy = CalabAudioPolicy.of(state)
      precondition(policy.session == nil && policy.ducking == nil && !policy.engine && !policy.capture, "touched a session that is not ours")
    }
    for state in [CalabAudioState.speaking, .listening] {
      precondition(CalabAudioPolicy.of(state).session?.options.contains(.mixWithOthers) == true, "product decision 4")
    }
    let live = CalabAudioSessionConfig.speaking
    precondition(live.holds(live))
    let extra = CalabAudioSessionConfig(category: live.category, mode: live.mode, options: live.options.union(CalabAudioOptions(rawValue: 1 << 8)))
    precondition(live.holds(extra), "an option iOS added counted as drift")
    let ducked = CalabAudioSessionConfig(category: live.category, mode: live.mode, options: live.options.union(.duckOthers))
    precondition(!live.holds(ducked), "ducking went unnoticed")
    var fewer = live.options; fewer.remove(.mixWithOthers)
    precondition(!live.holds(CalabAudioSessionConfig(category: live.category, mode: live.mode, options: fewer)), "lost mixing went unnoticed")
    precondition(!live.holds(.listening) && !live.holds(elsewhere))
  }

  private static func lifecycle() {
    var machine = CalabAudioSessionMachine()
    precondition(machine.handle(.join(canSpeak: true, callHolds: false)) == [.configure(.speaking), .activate, .engine(true), .startCapture])
    precondition(machine.state == .speaking)
    precondition(machine.handle(.join(canSpeak: false, callHolds: false)) == [], "second join replaced the first")
    precondition(machine.handle(.leave) == [.stopCapture, .engine(false), .deactivate], "session deactivated under a running engine")
    precondition(machine.state == .idle)
    precondition(machine.handle(.leave) == [], "double leave")
    precondition(machine.handle(.join(canSpeak: false, callHolds: false)) == [.configure(.listening), .activate, .engine(true)])
    precondition(machine.state == .listening)
    precondition(machine.handle(.leave) == [.engine(false), .deactivate])
    for event in [CalabAudioEvent.interruptionBegan(phoneCall: false), .interruptionEnded, .mediaServicesReset, .yieldToCall,
                  .resumeFromCall(foreground: true), .routeChanged(.categoryChange, seen: elsewhere), .activationFailed, .audioFailed,
                  .foreground(seen: elsewhere, engineRunning: false, phoneCall: false)] {
      precondition(machine.handle(event) == [], "idle reacted to \(event)")
      precondition(machine.state == .idle)
    }
  }

  private static func interruptions() {
    var machine = joined(canSpeak: true)
    precondition(machine.handle(.interruptionBegan(phoneCall: false)) == [.muteTrack, .engine(false)], "others would see a frozen track")
    precondition(machine.state == .interrupted)
    precondition(machine.handle(.interruptionBegan(phoneCall: false)) == [])
    precondition(machine.handle(.interruptionEnded) == [.configure(.speaking), .activate, .engine(true), .restoreMicrophone], "intent did not return")
    precondition(machine.state == .speaking)
    precondition(machine.handle(.interruptionEnded) == [], "late ended replayed activation")

    _ = machine.handle(.interruptionBegan(phoneCall: true))
    precondition(machine.handle(.interruptionEnded) == [.configure(.speaking), .activate, .engine(true), .holdMicrophoneMuted], "mic reopened after a call")

    // The observer reports the call only after the interruption has begun.
    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.phoneCallStarted) == [])
    precondition(machine.handle(.interruptionEnded).last == .holdMicrophoneMuted, "late observer lost the call")
    precondition(machine.handle(.phoneCallStarted) == [])
    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.interruptionEnded).last == .restoreMicrophone, "a past call leaked into the next interruption")

    var listener = joined(canSpeak: false)
    precondition(listener.handle(.interruptionBegan(phoneCall: true)) == [.engine(false)], "a listener has no track")
    precondition(listener.handle(.interruptionEnded) == [.configure(.listening), .activate, .engine(true)])

    // A refused reactivation stays interrupted and keeps what the resume consumed.
    _ = machine.handle(.interruptionBegan(phoneCall: true))
    precondition(machine.handle(.interruptionEnded).last == .holdMicrophoneMuted)
    precondition(machine.handle(.activationFailed) == [.muteTrack, .engine(false)])
    precondition(machine.state == .interrupted)
    precondition(machine.handle(.foreground(seen: .speaking, engineRunning: false, phoneCall: false)).last == .holdMicrophoneMuted, "retry reopened the mic after a call")
    precondition(machine.state == .speaking)

    // A failure later on is not that resume: its flags must not come back.
    _ = machine.handle(.foreground(seen: .speaking, engineRunning: true, phoneCall: false))
    precondition(machine.handle(.activationFailed) == [.muteTrack, .engine(false)])
    precondition(machine.handle(.interruptionEnded).last == .restoreMicrophone, "an old hold came back")

    // Capture that was refused before it started is started by the retry.
    var refused = CalabAudioSessionMachine()
    _ = refused.handle(.join(canSpeak: true, callHolds: false))
    precondition(refused.handle(.activationFailed) == [.engine(false)], "no track to mute yet")
    precondition(refused.handle(.foreground(seen: .speaking, engineRunning: false, phoneCall: false)).contains(.startCapture), "microphone stayed silent after a refused join")
    precondition(refused.state == .speaking)

    var granted = joined(canSpeak: false)
    precondition(granted.handle(.grant(canSpeak: true, foreground: true)).contains(.startCapture))
    _ = granted.handle(.activationFailed)
    precondition(granted.handle(.foreground(seen: .listening, engineRunning: false, phoneCall: false)).contains(.startCapture), "microphone stayed silent after a refused grant")

    var resumed = joined(canSpeak: false)
    _ = resumed.handle(.interruptionBegan(phoneCall: false))
    _ = resumed.handle(.grant(canSpeak: true, foreground: false))
    precondition(resumed.handle(.foreground(seen: .listening, engineRunning: false, phoneCall: false)).contains(.startCapture))
    _ = resumed.handle(.activationFailed)
    precondition(resumed.handle(.foreground(seen: .listening, engineRunning: false, phoneCall: false)).contains(.startCapture), "microphone stayed silent after a refused resume")
  }

  private static func routes() {
    var machine = joined(canSpeak: true)
    precondition(machine.handle(.routeChanged(.other, seen: .speaking)) == [.refreshRoute])
    precondition(machine.handle(.routeChanged(.categoryChange, seen: .speaking)) == [.refreshRoute], "our own setCategory re-applied itself")
    precondition(machine.reassertions == 0)
    precondition(machine.handle(.routeChanged(.categoryChange, seen: elsewhere)) == [.configure(.speaking), .refreshRoute])
    precondition(machine.reassertions == 1, "G5 reads this count")
    precondition(machine.handle(.routeChanged(.categoryChange, seen: .speaking)) == [.refreshRoute], "the re-apply looped")
    precondition(machine.reassertions == 1)
    precondition(machine.handle(.routeChanged(.other, seen: elsewhere)) == [.refreshRoute], "only categoryChange reasserts; foreground covers the rest")

    var listener = joined(canSpeak: false)
    precondition(listener.handle(.routeChanged(.categoryChange, seen: .speaking)) == [.configure(.listening), .refreshRoute], "listener left in play-and-record")

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.routeChanged(.categoryChange, seen: elsewhere)) == [.refreshRoute], "re-applied during an interruption")
    _ = machine.handle(.interruptionEnded)
    _ = machine.handle(.yieldToCall)
    precondition(machine.handle(.routeChanged(.categoryChange, seen: elsewhere)) == [], "re-applied over CallKit")
    precondition(machine.reassertions == 1)
  }

  private static func resets() {
    var machine = joined(canSpeak: true)
    precondition(machine.handle(.mediaServicesReset) == [.engine(false), .configure(.speaking), .activate, .engine(true), .republish, .restoreMicrophone])
    var listener = joined(canSpeak: false)
    precondition(listener.handle(.mediaServicesReset) == [.engine(false), .configure(.listening), .activate, .engine(true)], "nothing to republish")

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.mediaServicesReset) == [], "rebuilt while interrupted")
    precondition(machine.handle(.interruptionEnded) == [.configure(.speaking), .activate, .engine(true), .republish, .restoreMicrophone], "deferred rebuild lost")
    precondition(machine.handle(.interruptionBegan(phoneCall: false)) == [.muteTrack, .engine(false)])
    precondition(!machine.handle(.interruptionEnded).contains(.republish), "rebuild ran twice")

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    _ = machine.handle(.mediaServicesReset)
    precondition(machine.handle(.interruptionEnded).contains(.republish))
    _ = machine.handle(.activationFailed)
    precondition(machine.handle(.interruptionEnded).contains(.republish), "refused resume lost the rebuild")

    precondition(machine.handle(.audioFailed) == [.stopCapture, .engine(false), .deactivate, .fail], "web would not rejoin")
    precondition(machine.state == .idle)
    _ = machine.handle(.join(canSpeak: true, callHolds: false))
    _ = machine.handle(.yieldToCall)
    precondition(machine.handle(.audioFailed) == [.stopCapture, .fail], "deactivated CallKit's session")
  }

  private static func foreground() {
    var machine = joined(canSpeak: true)
    precondition(machine.handle(.foreground(seen: .speaking, engineRunning: true, phoneCall: false)) == [.activate], "healthy foreground did work")
    precondition(machine.handle(.foreground(seen: .speaking, engineRunning: false, phoneCall: false)) == [.activate, .engine(true)])
    precondition(machine.handle(.foreground(seen: elsewhere, engineRunning: false, phoneCall: false)) == [.configure(.speaking), .activate, .engine(true)], "activation before configuration")
    precondition(machine.reassertions == 1)
    _ = machine.handle(.interruptionBegan(phoneCall: true))
    precondition(machine.handle(.foreground(seen: elsewhere, engineRunning: false, phoneCall: true)) == [], "activated over a live phone call")
    precondition(machine.state == .interrupted)
    precondition(machine.handle(.foreground(seen: elsewhere, engineRunning: false, phoneCall: false)) == [.configure(.speaking), .activate, .engine(true), .holdMicrophoneMuted], "room stuck after a lost ended")
    precondition(machine.state == .speaking)
  }

  private static func grants() {
    var machine = joined(canSpeak: false)
    precondition(machine.handle(.grant(canSpeak: true, foreground: false)) == [], "started capture in background")
    precondition(machine.state == .listening)
    precondition(machine.handle(.foreground(seen: .listening, engineRunning: true, phoneCall: false)) == [.engine(false), .configure(.speaking), .activate, .engine(true), .startCapture, .restoreMicrophone])
    precondition(machine.state == .speaking)
    precondition(machine.handle(.grant(canSpeak: true, foreground: true)) == [], "granted twice")
    precondition(machine.handle(.grant(canSpeak: false, foreground: false)) == [.stopCapture, .engine(false), .configure(.listening), .activate, .engine(true)])
    precondition(machine.state == .listening)
    precondition(machine.handle(.grant(canSpeak: false, foreground: true)) == [])
    precondition(machine.handle(.grant(canSpeak: true, foreground: true)) == [.engine(false), .configure(.speaking), .activate, .engine(true), .startCapture, .restoreMicrophone])

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.grant(canSpeak: false, foreground: false)) == [.stopCapture], "capture outlived the grant")
    precondition(machine.handle(.interruptionEnded) == [.configure(.listening), .activate, .engine(true)], "resumed with the old category")

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    _ = machine.handle(.grant(canSpeak: true, foreground: true))
    precondition(machine.handle(.interruptionEnded) == [.configure(.listening), .activate, .engine(true)], "an end of interruption may arrive in background")
    precondition(machine.handle(.foreground(seen: .listening, engineRunning: true, phoneCall: false)).contains(.startCapture))
  }

  private static func callYield() {
    var machine = joined(canSpeak: true)
    precondition(machine.handle(.yieldToCall) == [.muteTrack, .engine(false)], "no deactivate: CallKit is about to activate")
    precondition(machine.state == .call)
    precondition(machine.handle(.interruptionBegan(phoneCall: true)) == [], "the call's own activation interrupted the room")
    precondition(machine.handle(.mediaServicesReset) == [])
    precondition(machine.handle(.resumeFromCall(foreground: false)) == [.configure(.speaking), .activate, .engine(true), .republish, .restoreMicrophone], "declined call lost the mic")
    precondition(machine.state == .speaking)
    _ = machine.handle(.yieldToCall)
    precondition(machine.handle(.leave) == [.stopCapture], "web left after an answer and we took CallKit's session down")
    precondition(machine.state == .idle)

    _ = machine.handle(.join(canSpeak: true, callHolds: true))
    precondition(machine.state == .call, "joined under a call")
    precondition(machine.handle(.resumeFromCall(foreground: false)) == [.configure(.listening), .activate, .engine(true)], "started capture in background")
    precondition(machine.handle(.leave) == [.engine(false), .deactivate])
    precondition(machine.handle(.join(canSpeak: true, callHolds: true)) == [])
    precondition(machine.handle(.resumeFromCall(foreground: true)) == [.configure(.speaking), .activate, .engine(true), .startCapture, .restoreMicrophone])

    _ = machine.handle(.interruptionBegan(phoneCall: false))
    precondition(machine.handle(.yieldToCall) == [], "engine is already off")
    precondition(machine.state == .call)
  }
}
