import Foundation

private final class FakeEngine: CalabAudioEngine {
  var log: [String] = []
  var available = false
  var profile: CalabAudioEngineProfile?
  var refuseApply = false
  func muteMicrophone() { log.append("mute") }
  func setAvailable(_ value: Bool) throws { available = value; log.append(value ? "on" : "off") }
  func apply(_ value: CalabAudioEngineProfile) throws {
    if refuseApply { throw CocoaError(.featureUnsupported) }
    profile = value; log.append(value == .room ? "room" : "standard")
  }
  func take() -> [String] { defer { log = [] }; return log }
}

@main
struct AudioOwnerTests {
  @MainActor
  static func main() throws {
    try profiles()
    print("PASS: mute mode, ducking and processing are set per owner")
    try precedence()
    print("PASS: the call takes the engine synchronously and the room resumes after it")
    try lateCallbacks()
    print("PASS: late callbacks of a yielded or superseded lease change nothing")
    try failures()
    print("PASS: a stuck profile fails the room and never the call")
    #if DEBUG
    probeTrigger()
    print("PASS: probe starts only from its launch argument")
    #endif
  }

  @MainActor
  private static func profiles() throws {
    let engine = FakeEngine(), owner = CalabAudioOwner(engine: engine)
    let room = try owner.acquire(.room)
    precondition(owner.holder == .room && owner.holds(room))
    precondition(engine.take() == ["mute", "off", "room"], "profile changed under a running engine")
    precondition(engine.profile?.muteMode == .inputMixer, "mute would chime or reconfigure the session")
    precondition(engine.profile?.ducking == .minimal && engine.profile?.captureProcessing == true)
    let started = try owner.setEngine(true, lease: room)
    precondition(started && engine.available)
    owner.release(room)
    precondition(owner.holder == .none && !engine.available, "released room left the engine on")
    precondition(engine.profile == .standard, "room settings leaked to the next driver")
    precondition(engine.profile?.muteMode == .voiceProcessing && engine.profile?.captureProcessing == false)
  }

  @MainActor
  private static func precedence() throws {
    let engine = FakeEngine(), owner = CalabAudioOwner(engine: engine)
    var events: [String] = []
    owner.roomYield = { events.append("yield:\(engine.available)") }
    owner.roomResume = { events.append("resume:\(owner.holder == .room)") }
    let room = try owner.acquire(.room)
    try owner.setEngine(true, lease: room)
    _ = engine.take()
    precondition(events.isEmpty)

    let call = try owner.acquire(.call)
    precondition(events == ["yield:true"], "room must quiet itself before the engine stops")
    precondition(engine.take() == ["mute", "off", "standard"], "yield is not synchronous")
    precondition(owner.holder == .call && owner.holds(call) && !owner.holds(room), "room and call held the engine together")
    let taken = try owner.setEngine(true, lease: call)
    precondition(taken && engine.available)

    events = []
    owner.release(call)
    precondition(engine.take() == ["on", "mute", "off", "room"], "resume replayed room settings out of order")
    precondition(events == ["resume:true"], "declined call did not resume the room")
    precondition(owner.holds(room), "resumed room lost its lease")
    let resumed = try owner.setEngine(true, lease: room)
    precondition(resumed)

    // A join under a call waits, and a voluntary leave is not a yield.
    events = []
    owner.release(room)
    precondition(events.isEmpty, "a room that left yielded")
    let held = try owner.acquire(.call)
    let waiting = try owner.acquire(.room)
    precondition(owner.holder == .call && !owner.holds(waiting), "room joined over a call")
    _ = engine.take()
    let early = try owner.setEngine(true, lease: waiting)
    precondition(!early)
    precondition(!engine.available && engine.take().isEmpty)
    owner.release(held)
    precondition(events == ["resume:true"] && owner.holds(waiting))

    // Web leaves the room after an answer: the end of the call has nothing to resume.
    let answered = try owner.acquire(.call)
    events = []
    owner.release(waiting)
    owner.release(answered)
    precondition(events.isEmpty && owner.holder == .none, "resumed a room that had left")
    precondition(engine.profile == .standard)
  }

  @MainActor
  private static func lateCallbacks() throws {
    let engine = FakeEngine(), owner = CalabAudioOwner(engine: engine)
    let old = try owner.acquire(.room)
    let fresh = try owner.acquire(.room)
    _ = engine.take()
    precondition(!owner.holds(old) && owner.holds(fresh), "two joins own one engine")
    owner.release(old)
    precondition(owner.holder == .room && engine.take().isEmpty, "old drain released the new join")
    let stale = try owner.setEngine(true, lease: old)
    precondition(!stale)

    let call = try owner.acquire(.call)
    let yielded = try owner.setEngine(true, lease: fresh)
    precondition(!yielded, "yielded room restarted the engine under a call")
    precondition(!engine.available)
    owner.release(call)
    owner.release(call)
    precondition(owner.holder == .room, "double release")
    let second = try owner.acquire(.call)
    owner.release(call)
    precondition(owner.holder == .call && owner.holds(second), "old call ended the new one")
    owner.release(second)
    owner.release(fresh)
    precondition(owner.holder == .none)
  }

  @MainActor
  private static func failures() throws {
    let engine = FakeEngine(), owner = CalabAudioOwner(engine: engine)
    var failed = 0
    owner.roomFailed = { failed += 1 }
    engine.refuseApply = true
    do { _ = try owner.acquire(.room); preconditionFailure("room ran on a stale profile") } catch {}
    precondition(owner.holder == .none, "failed join kept the engine")
    let call = try owner.acquire(.call)
    precondition(owner.holder == .call && owner.holds(call), "a call was refused because of the room")
    engine.refuseApply = false
    let room = try owner.acquire(.room)
    engine.refuseApply = true
    owner.release(call)
    precondition(failed == 1, "room resumed on a stale profile")
    engine.refuseApply = false
    owner.release(room)
    precondition(failed == 1 && owner.holder == .none)
  }

  #if DEBUG
  private static func probeTrigger() {
    precondition(calabAudioProbeMode(["Calab"]) == nil, "probe ran without its argument")
    precondition(calabAudioProbeMode(["Calab", "-CalabAudioProbeX"]) == nil)
    precondition(calabAudioProbeMode(["Calab", "-CalabAudioProbe"]) == .speaking)
    precondition(calabAudioProbeMode(["Calab", "-CalabAudioProbe", "listening"]) == .listening)
    precondition(calabAudioProbeMode(["Calab", "-CalabAudioProbe", "other"]) == .speaking)
  }
  #endif
}
