// Debug-only device probe for ADR-0149 gates G1-G5. Nothing here exists in Release.
#if DEBUG
import Foundation

enum CalabAudioProbeMode: Equatable { case speaking, listening }

// Launch with `-CalabAudioProbe`, or `-CalabAudioProbe listening` for the no-capture policy.
func calabAudioProbeMode(_ arguments: [String]) -> CalabAudioProbeMode? {
  guard let flag = arguments.firstIndex(of: "-CalabAudioProbe") else { return nil }
  return arguments.dropFirst(flag + 1).first == "listening" ? .listening : .speaking
}

#if canImport(LiveKitClient)
import LiveKitClient
#elseif canImport(LiveKit)
import LiveKit
#endif
#if canImport(LiveKitClient) || canImport(LiveKit)
import AVFAudio
import CallKit
import OSLog
import UIKit

private final class CalabAudioProbeMeter: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var frames = 0
  private var energy = 0.0
  func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {}
  func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
    let samples = audioBuffer.rawBuffer(forChannel: 0)
    var sum = 0.0
    for index in 0..<audioBuffer.frames { sum += Double(samples[index] * samples[index]) }
    lock.lock(); frames += audioBuffer.frames; energy += sum; lock.unlock()
  }
  func audioProcessingRelease() {}
  func drain() -> (frames: Int, rms: Double) {
    lock.lock(); defer { frames = 0; energy = 0; lock.unlock() }
    return (frames, frames > 0 ? (energy / Double(frames)).squareRoot() : 0)
  }
}

/** The room policy with a looped local cue and no Room: one line per second reads every gate. */
@MainActor
final class CalabAudioProbe: NSObject, CXCallObserverDelegate {
  private static var running: CalabAudioProbe?
  private let logger = Logger(subsystem: "Calab", category: "audio-probe")
  private let session = AVAudioSession.sharedInstance()
  private let calls = CXCallObserver()
  private let meter = CalabAudioProbeMeter()
  private let engine = CalabLiveKitAudioEngine()
  private let owner: CalabAudioOwner
  private let mode: CalabAudioProbeMode
  private var machine = CalabAudioSessionMachine()
  private var lease: CalabAudioLease?
  private var observers: [NSObjectProtocol] = []
  private var sampler: Task<Void, Never>?
  private var cue: SoundHandle?
  private var intentMuted = false
  private var muteClock = true

  static func startIfRequested(arguments: [String] = ProcessInfo.processInfo.arguments) {
    guard running == nil, let mode = calabAudioProbeMode(arguments) else { return }
    let probe = CalabAudioProbe(mode)
    running = probe
    Task { @MainActor in await probe.start() }
  }

  private init(_ mode: CalabAudioProbeMode) {
    self.mode = mode
    engine.captureProcessing = meter
    owner = CalabAudioOwner(engine: engine)
    super.init()
  }

  private func start() async {
    LiveKitSDK.disableLogging()
    if mode == .speaking && session.recordPermission != .granted {
      let granted = await withCheckedContinuation { continuation in
        session.requestRecordPermission { continuation.resume(returning: $0) }
      }
      guard granted else { logger.error("microphone denied"); return }
    }
    do { lease = try owner.acquire(.room) }
    catch { logger.error("engine profile refused: \(String(describing: error), privacy: .public)"); return }
    logger.notice("mute mode inputMixer=\(AudioManager.shared.microphoneMuteMode == .inputMixer, privacy: .public)")
    calls.setDelegate(self, queue: .main)
    observe(AVAudioSession.interruptionNotification) { probe, notice in
      if let event = notice.calabInterruption(phoneCall: probe.phoneCall) { probe.send(event) }
    }
    observe(AVAudioSession.routeChangeNotification) { probe, notice in
      probe.send(.routeChanged(notice.calabRouteChange, seen: probe.session.calabSeen))
    }
    observe(AVAudioSession.mediaServicesWereResetNotification) { probe, _ in probe.send(.mediaServicesReset) }
    observe(UIApplication.willEnterForegroundNotification) { probe, _ in
      probe.send(.foreground(seen: probe.session.calabSeen, engineRunning: AudioManager.shared.isEngineRunning, phoneCall: probe.phoneCall))
    }
    send(.join(canSpeak: mode == .speaking, callHolds: false))
    await startCue()
    sampler = Task { @MainActor [weak self] in
      var second = 0
      while !Task.isCancelled, let self {
        second += 1
        self.sample(second)
        do { try await Task.sleep(for: .seconds(1)) } catch { return }
      }
    }
  }

  private var phoneCall: Bool { calls.calls.contains { !$0.hasEnded } }

  private func observe(_ name: Notification.Name, _ handle: @escaping @MainActor (CalabAudioProbe, Notification) -> Void) {
    observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notice in
      MainActor.assumeIsolated { if let self { handle(self, notice) } }
    })
  }

  nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    MainActor.assumeIsolated { if !call.hasEnded { self.send(.phoneCallStarted) } }
  }

  private func send(_ event: CalabAudioEvent) {
    let actions = machine.handle(event)
    logger.notice("event \(String(describing: event), privacy: .public) -> \(String(describing: actions), privacy: .public)")
    for action in actions {
      do { try perform(action) }
      catch {
        logger.error("\(String(describing: action), privacy: .public) refused: \(String(describing: error), privacy: .public)")
        send(.activationFailed)
        return
      }
    }
  }

  private func perform(_ action: CalabAudioAction) throws {
    switch action {
    case let .configure(config): try session.calabApply(config)
    case .activate: try session.setActive(true)
    case .deactivate: try session.setActive(false, options: .notifyOthersOnDeactivation)
    case let .engine(on): if let lease { try owner.setEngine(on, lease: lease) }
    case .startCapture: try AudioManager.shared.startLocalRecording()
    case .stopCapture: try AudioManager.shared.stopLocalRecording()
    case .republish:
      try AudioManager.shared.stopLocalRecording()
      try AudioManager.shared.startLocalRecording()
    case .muteTrack: AudioManager.shared.isMicrophoneMuted = true
    case .holdMicrophoneMuted:
      // The rule under test: nothing reopens the microphone after a phone call.
      intentMuted = true; muteClock = false
      AudioManager.shared.isMicrophoneMuted = true
    case .restoreMicrophone: AudioManager.shared.isMicrophoneMuted = intentMuted
    case .refreshRoute, .fail: break
    }
  }

  private func startCue() async {
    do {
      let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("calab-audio-probe.wav")
      try calabCallProgressWave().write(to: file)
      let handle = try await SoundPlayer.shared.prepare(fileURL: file, named: "probe")
      try await handle.play(options: SoundPlaybackOptions(mode: .replace, loop: true, destination: .local))
      cue = handle
    } catch { logger.error("cue refused: \(String(describing: error), privacy: .public)") }
  }

  // Port types only: the ADR keeps device names out of logs.
  private func sample(_ second: Int) {
    // Mute and unmute on a clock so G1 needs no interface.
    if muteClock && second % 10 == 0 && machine.state == .speaking {
      intentMuted.toggle()
      AudioManager.shared.isMicrophoneMuted = intentMuted
    }
    let seen = session.calabSeen
    let route = session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: "+")
    let input = session.currentRoute.inputs.map(\.portType.rawValue).joined(separator: "+")
    let capture = meter.drain()
    let line = "state=\(machine.state) category=\(seen.category) mode=\(seen.mode) options=\(seen.options.rawValue)"
      + " holds=\(CalabAudioPolicy.of(machine.state).session?.holds(seen) ?? true) reasserted=\(machine.reassertions)"
      + " engine=\(AudioManager.shared.isEngineRunning) muted=\(AudioManager.shared.isMicrophoneMuted)"
      + " frames=\(capture.frames) rms=\(capture.rms) out=\(route) in=\(input) others=\(session.isOtherAudioPlaying)"
    logger.notice("\(line, privacy: .public)")
  }
}
#endif
#endif
