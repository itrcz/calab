import Foundation

// ADR-0149 §6. AudioManager.shared (engine, mute mode, ducking, delegate) is process-wide,
// so the room and call drivers reach it through one owner and never hold it together.

enum CalabAudioHolder: Equatable { case none, room, call }

enum CalabAudioMuteMode: Equatable { case inputMixer, voiceProcessing }

struct CalabAudioEngineProfile: Equatable {
  let muteMode: CalabAudioMuteMode
  let ducking: CalabAudioDucking
  let captureProcessing: Bool
  // Mute without a chime or a session change, instant unmute (ADR-0149 §4). The gate runs in capture.
  static let room = CalabAudioEngineProfile(muteMode: .inputMixer, ducking: .minimal, captureProcessing: true)
  // What the call driver has always run on, so a released room leaves nothing behind for it.
  static let standard = CalabAudioEngineProfile(muteMode: .voiceProcessing, ducking: .minimal, captureProcessing: false)
  static func of(_ holder: CalabAudioHolder) -> CalabAudioEngineProfile { holder == .room ? .room : .standard }
}

struct CalabAudioLease: Equatable {
  let holder: CalabAudioHolder
  fileprivate let generation: Int
}

// A newer lease of the same kind supersedes the older one, whose late release changes nothing.
struct CalabAudioOwnerState {
  private var generation = 0
  private var room: CalabAudioLease?
  private var call: CalabAudioLease?
  var holder: CalabAudioHolder { call != nil ? .call : room != nil ? .room : .none }
  var roomWaiting: Bool { room != nil && call != nil }
  func holds(_ lease: CalabAudioLease) -> Bool { lease == (lease.holder == .room ? room : call) && lease.holder == holder }

  mutating func acquire(_ kind: CalabAudioHolder) -> CalabAudioLease {
    generation += 1
    let lease = CalabAudioLease(holder: kind, generation: generation)
    if kind == .call { call = lease } else { room = lease }
    return lease
  }

  mutating func release(_ lease: CalabAudioLease) {
    if lease == room { room = nil } else if lease == call { call = nil }
  }
}

protocol CalabAudioEngine: AnyObject {
  func muteMicrophone()
  func setAvailable(_ available: Bool) throws
  func apply(_ profile: CalabAudioEngineProfile) throws
}

@MainActor
final class CalabAudioOwner {
  // Synchronous: a CallKit answer needs the room quiet before didActivate reaches the call driver.
  var roomYield: (() -> Void)?
  var roomResume: (() -> Void)?
  var roomFailed: (() -> Void)?
  private var state = CalabAudioOwnerState()
  private let engine: CalabAudioEngine
  init(engine: CalabAudioEngine) { self.engine = engine }
  var holder: CalabAudioHolder { state.holder }
  func holds(_ lease: CalabAudioLease) -> Bool { state.holds(lease) }

  // A room lease taken while a call holds the engine waits; check holds(_:) and expect roomResume.
  func acquire(_ kind: CalabAudioHolder) throws -> CalabAudioLease {
    precondition(kind != .none)
    let previous = state.holder
    let lease = state.acquire(kind)
    do { try hand(from: previous) }
    catch {
      // A call cannot be refused because the room's settings stuck. Its driver takes over the engine.
      guard kind == .room else { return lease }
      state.release(lease)
      throw error
    }
    return lease
  }

  func release(_ lease: CalabAudioLease) {
    let previous = state.holder
    state.release(lease)
    do { try hand(from: previous) } catch { if state.holder == .room { roomFailed?() } }
  }

  // The driver switches on after activating the session (ADR-0149 §6). A late callback
  // from a yielded or superseded lease is refused, so it cannot restart the engine under a call.
  @discardableResult func setEngine(_ available: Bool, lease: CalabAudioLease) throws -> Bool {
    guard state.holds(lease) else { return false }
    try engine.setAvailable(available)
    return true
  }

  private func hand(from previous: CalabAudioHolder) throws {
    let next = state.holder
    guard next != previous else { return }
    if previous == .room && next == .call { roomYield?() }
    engine.muteMicrophone()
    var failure: Error?
    do { try engine.setAvailable(false) } catch { failure = error }
    do { try engine.apply(.of(next)) } catch { failure = failure ?? error }
    if let failure { throw failure }
    if next == .room && previous == .call { roomResume?() }
  }
}

#if canImport(LiveKitClient)
import LiveKitClient
#elseif canImport(LiveKit)
import LiveKit
#endif
#if canImport(LiveKitClient) || canImport(LiveKit)
final class CalabLiveKitAudioEngine: CalabAudioEngine {
  // The room's gate or the probe's meter. Installed only while the room holds the engine.
  var captureProcessing: AudioCustomProcessingDelegate?
  func muteMicrophone() { AudioManager.shared.isMicrophoneMuted = true }
  func setAvailable(_ available: Bool) throws { try AudioManager.shared.setEngineAvailability(available ? .default : .none) }
  func apply(_ profile: CalabAudioEngineProfile) throws {
    let audio = AudioManager.shared
    audio.audioSession.isAutomaticConfigurationEnabled = false
    try audio.set(microphoneMuteMode: profile.muteMode == .inputMixer ? .inputMixer : .voiceProcessing)
    audio.isAdvancedDuckingEnabled = profile.ducking.advanced
    if #available(iOS 17, *) {
      switch profile.ducking.level {
      case .min: audio.duckingLevel = .min
      }
    }
    audio.capturePostProcessingDelegate = profile.captureProcessing ? captureProcessing : nil
  }
}
#endif
