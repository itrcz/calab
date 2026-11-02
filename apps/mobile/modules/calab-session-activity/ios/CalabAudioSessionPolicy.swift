import Foundation

// ADR-0149 §6. Decisions only: the driver executes the returned actions in order and
// stops at the first failure. No SDK types here, so the swiftc harness runs this as is.

enum CalabAudioCategory: Equatable { case playAndRecord, playback, other }
enum CalabAudioMode: Equatable { case voiceChat, standard, other }

struct CalabAudioOptions: OptionSet {
  let rawValue: Int
  static let mixWithOthers = CalabAudioOptions(rawValue: 1 << 0)
  static let allowBluetoothHFP = CalabAudioOptions(rawValue: 1 << 1)
  static let allowBluetoothA2DP = CalabAudioOptions(rawValue: 1 << 2)
  static let defaultToSpeaker = CalabAudioOptions(rawValue: 1 << 3)
  // Never requested. Seen on the session, it means another component turned on ducking.
  static let duckOthers = CalabAudioOptions(rawValue: 1 << 4)
}

struct CalabAudioSessionConfig: Equatable {
  let category: CalabAudioCategory
  let mode: CalabAudioMode
  let options: CalabAudioOptions
  static let speaking = CalabAudioSessionConfig(category: .playAndRecord, mode: .voiceChat,
    options: [.mixWithOthers, .allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker])
  static let listening = CalabAudioSessionConfig(category: .playback, mode: .standard, options: [.mixWithOthers])
  // iOS adds options to a live session on its own when voice processing starts, so
  // extra bits are not drift. Losing ours or gaining ducking is.
  func holds(_ seen: CalabAudioSessionConfig) -> Bool {
    seen.category == category && seen.mode == mode && seen.options.isSuperset(of: options) && !seen.options.contains(.duckOthers)
  }
}

enum CalabAudioDuckingLevel: Equatable { case min }

struct CalabAudioDucking: Equatable {
  let level: CalabAudioDuckingLevel
  let advanced: Bool
  // Explicit, so a changed SDK default cannot bring the pumping back.
  static let minimal = CalabAudioDucking(level: .min, advanced: false)
}

enum CalabAudioState: Equatable { case idle, speaking, listening, interrupted, call }

struct CalabAudioPolicy: Equatable {
  // nil: the system or CallKit holds the session and we leave it alone.
  let session: CalabAudioSessionConfig?
  let ducking: CalabAudioDucking?
  let engine: Bool
  let capture: Bool
  static func of(_ state: CalabAudioState) -> CalabAudioPolicy {
    switch state {
    case .speaking: return CalabAudioPolicy(session: .speaking, ducking: .minimal, engine: true, capture: true)
    case .listening: return CalabAudioPolicy(session: .listening, ducking: .minimal, engine: true, capture: false)
    case .idle, .interrupted, .call: return CalabAudioPolicy(session: nil, ducking: nil, engine: false, capture: false)
    }
  }
}

enum CalabAudioRouteChange: Equatable { case categoryChange, other }

enum CalabAudioEvent: Equatable {
  case join(canSpeak: Bool, callHolds: Bool)
  case leave
  case interruptionBegan(phoneCall: Bool)
  // CXCallObserver can report the call after the interruption has begun.
  case phoneCallStarted
  // `.shouldResume` is deliberately not an input: we are mixable, so we always reactivate.
  case interruptionEnded
  case routeChanged(CalabAudioRouteChange, seen: CalabAudioSessionConfig)
  case mediaServicesReset
  case foreground(seen: CalabAudioSessionConfig, engineRunning: Bool, phoneCall: Bool)
  case grant(canSpeak: Bool, foreground: Bool)
  case yieldToCall
  case resumeFromCall(foreground: Bool)
  // Activation or the engine refused: retried on the next end of interruption or foreground.
  case activationFailed
  // Join or rebuild cannot continue: the room reports failed(audio) and web rejoins.
  case audioFailed
}

enum CalabAudioAction: Equatable {
  case configure(CalabAudioSessionConfig)
  case activate
  case deactivate
  case engine(Bool)
  case startCapture
  case stopCapture
  case republish
  case muteTrack
  case restoreMicrophone
  case holdMicrophoneMuted
  case refreshRoute
  case fail
}

struct CalabAudioSessionMachine {
  private(set) var state = CalabAudioState.idle
  // How often someone else changed our configuration. G5 reads this number.
  private(set) var reassertions = 0
  private var canSpeak = false
  private var capturing = false
  private var afterPhoneCall = false
  private var needsRebuild = false
  // What the previous event consumed or began, undone if its activation is refused.
  private var consumed = (afterPhoneCall: false, needsRebuild: false, capture: false)
  private var settled: CalabAudioState { capturing ? .speaking : .listening }
  private var session: CalabAudioSessionConfig { capturing ? .speaking : .listening }
  private var ours: Bool { state == .speaking || state == .listening }
  private var quiesce: [CalabAudioAction] { capturing ? [.muteTrack, .engine(false)] : [.engine(false)] }

  mutating func handle(_ event: CalabAudioEvent) -> [CalabAudioAction] {
    let refused = consumed
    consumed = (false, false, false)
    switch event {
    case let .join(speak, callHolds):
      guard state == .idle else { return [] }
      canSpeak = speak
      if callHolds { state = .call; return [] }
      capturing = speak; state = settled
      consumed.capture = speak
      return [.configure(session), .activate, .engine(true)] + (capturing ? [.startCapture] : [])
    case .leave:
      return teardown()
    case .audioFailed:
      return state == .idle ? [] : teardown() + [.fail]
    case let .interruptionBegan(phoneCall):
      if state == .interrupted { afterPhoneCall = afterPhoneCall || phoneCall; return [] }
      guard ours else { return [] }
      let actions = quiesce
      state = .interrupted; afterPhoneCall = phoneCall
      return actions
    case .phoneCallStarted:
      if state == .interrupted { afterPhoneCall = true }
      return []
    case .interruptionEnded:
      return state == .interrupted ? resume(foreground: false) : []
    case let .routeChanged(reason, seen):
      if state == .interrupted { return [.refreshRoute] }
      guard ours else { return [] }
      // Our own setCategory posts `.categoryChange` too: only real drift re-applies, or we loop.
      if reason == .categoryChange && !session.holds(seen) { reassertions += 1; return [.configure(session), .refreshRoute] }
      return [.refreshRoute]
    case .mediaServicesReset:
      if state == .interrupted || state == .call { needsRebuild = true; return [] }
      guard ours else { return [] }
      return [.engine(false), .configure(session), .activate, .engine(true)] + (capturing ? [.republish, .restoreMicrophone] : [])
    case let .foreground(seen, engineRunning, phoneCall):
      // Not every began gets an ended, so foreground is the retry while no call is up.
      if state == .interrupted { return phoneCall ? [] : resume(foreground: true) }
      guard ours else { return [] }
      if canSpeak && !capturing { return startCapture() }
      var actions: [CalabAudioAction] = []
      if !session.holds(seen) { reassertions += 1; actions.append(.configure(session)) }
      // AVAudioSession has no activation getter and setActive(true) is idempotent.
      actions.append(.activate)
      if !engineRunning { actions.append(.engine(true)) }
      return actions
    case let .grant(speak, foreground):
      canSpeak = speak
      if speak { return foreground && state == .listening ? startCapture() : [] }
      guard capturing else { return [] }
      capturing = false
      guard state == .speaking else { return [.stopCapture] }
      state = .listening
      return [.stopCapture, .engine(false), .configure(.listening), .activate, .engine(true)]
    case .yieldToCall:
      if state == .interrupted { state = .call; return [] }
      guard ours else { return [] }
      let actions = quiesce
      state = .call
      return actions
    case let .resumeFromCall(foreground):
      return state == .call ? resume(foreground: foreground) : []
    case .activationFailed:
      guard ours else { return [] }
      afterPhoneCall = refused.afterPhoneCall; needsRebuild = refused.needsRebuild
      // Capture that never started must start on the retry, not pass for running.
      if refused.capture { capturing = false }
      let actions = quiesce
      state = .interrupted
      return actions
    }
  }

  // iOS lets a background app continue capture, not start it: callers pass the foreground.
  private mutating func resume(foreground: Bool) -> [CalabAudioAction] {
    let starts = foreground && canSpeak && !capturing
    if starts { capturing = true }
    state = settled
    consumed = (afterPhoneCall, needsRebuild, starts)
    var actions: [CalabAudioAction] = [.configure(session), .activate, .engine(true)]
    if starts { actions.append(.startCapture) } else if capturing && needsRebuild { actions.append(.republish) }
    if capturing { actions.append(afterPhoneCall ? .holdMicrophoneMuted : .restoreMicrophone) }
    afterPhoneCall = false; needsRebuild = false
    return actions
  }

  private mutating func startCapture() -> [CalabAudioAction] {
    capturing = true; state = .speaking
    consumed.capture = true
    return [.engine(false), .configure(.speaking), .activate, .engine(true), .startCapture, .restoreMicrophone]
  }

  private mutating func teardown() -> [CalabAudioAction] {
    var actions: [CalabAudioAction] = capturing ? [.stopCapture] : []
    if ours { actions += [.engine(false), .deactivate] } else if state == .interrupted { actions.append(.deactivate) }
    self = CalabAudioSessionMachine()
    return actions
  }
}

#if os(iOS)
import AVFAudio

extension CalabAudioCategory {
  init(_ category: AVAudioSession.Category) {
    self = category == .playAndRecord ? .playAndRecord : category == .playback ? .playback : .other
  }
}

extension CalabAudioMode {
  init(_ mode: AVAudioSession.Mode) {
    self = mode == .voiceChat ? .voiceChat : mode == .default ? .standard : .other
  }
}

private extension AVAudioSession.CategoryOptions {
  // The new name arrived with Swift 6.2 toolchains. compiler(), not swift(): this pod is language mode 5.
  static var calabBluetoothHFP: AVAudioSession.CategoryOptions {
    #if compiler(>=6.2)
    return .allowBluetoothHFP
    #else
    return .allowBluetooth
    #endif
  }
}

extension AVAudioSession {
  var calabSeen: CalabAudioSessionConfig {
    var options: CalabAudioOptions = []
    if categoryOptions.contains(.mixWithOthers) { options.insert(.mixWithOthers) }
    if categoryOptions.contains(.calabBluetoothHFP) { options.insert(.allowBluetoothHFP) }
    if categoryOptions.contains(.allowBluetoothA2DP) { options.insert(.allowBluetoothA2DP) }
    if categoryOptions.contains(.defaultToSpeaker) { options.insert(.defaultToSpeaker) }
    if categoryOptions.contains(.duckOthers) { options.insert(.duckOthers) }
    return CalabAudioSessionConfig(category: CalabAudioCategory(category), mode: CalabAudioMode(mode), options: options)
  }

  func calabApply(_ config: CalabAudioSessionConfig) throws {
    var options: AVAudioSession.CategoryOptions = []
    if config.options.contains(.mixWithOthers) { options.insert(.mixWithOthers) }
    if config.options.contains(.allowBluetoothHFP) { options.insert(.calabBluetoothHFP) }
    if config.options.contains(.allowBluetoothA2DP) { options.insert(.allowBluetoothA2DP) }
    if config.options.contains(.defaultToSpeaker) { options.insert(.defaultToSpeaker) }
    try setCategory(config.category == .playAndRecord ? .playAndRecord : .playback,
      mode: config.mode == .voiceChat ? .voiceChat : .default, options: options)
  }
}

extension Notification {
  // nil: nothing the policy reacts to.
  func calabInterruption(phoneCall: Bool) -> CalabAudioEvent? {
    guard let raw = userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return nil }
    switch type {
    case .began: return .interruptionBegan(phoneCall: phoneCall)
    case .ended: return .interruptionEnded
    @unknown default: return nil
    }
  }

  var calabRouteChange: CalabAudioRouteChange {
    let raw = userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
    return raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .categoryChange ? .categoryChange : .other
  }
}
#endif
