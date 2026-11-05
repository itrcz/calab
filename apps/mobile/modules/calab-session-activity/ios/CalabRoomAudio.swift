import Foundation

// ADR-0149 native room driver. Everything above `#if canImport(LiveKit)` is pure and runs in the swiftc
// harness (tests/RoomAudioInputTests.swift, tests/ReconnectScheduleTests.swift); the SDK part stays thin.

// §7: LiveKit Swift 2.17.0 reconnects in quick attempts, the last one full (Room+Engine.swift:400-425,
// AsyncRetry.swift:31-54). A reconnect after VOICE_LOST_GRACE recreates a seat others saw end, so the bound
// is the driver's own deadline: it disconnects the Room, and Room.disconnect() drops the retry task before
// any await (Room.swift:536, 551-555; the dropped AnyTaskCancellable cancels it, AsyncSequence+Subscribe.swift:
// 147-149). The SDK knobs only shape the retries inside it: an outage that fails fast (no route, airplane
// mode, a lift) is retried for 30 s and more.
enum CalabRoomReconnectSchedule {
  static let attempts = 10
  static let baseDelay = 1.0
  static let maxDelay = 5.0
  static let socketTimeout = 3.5
  static let primaryTimeout = 4.0
  static let publisherTimeout = 4.0
  // Not a ConnectOptions knob: SignalClient.swift:97 waits for the join or reconnect response this long.
  static let responseTimeout = 7.0
  // computeReconnectDelay adds up to 10 % (TimeInterval.swift:89-92).
  static let jitter = 0.1
  // ADR-0150 seat grace on the server.
  static let grace = 60.0
  // Reconnecting this long, the driver stops the room and reports `lost`.
  static let deadline = 45.0
  // From the deadline to a cancelled retry loop: the drain disconnects before awaiting anything else, and
  // disconnect drops the retry task before its leave message. A margin for the main actor, not a wait.
  static let teardown = 2.0

  struct Knobs {
    let attempts: Int, baseDelay: Double, maxDelay: Double, socket: Double, primary: Double, publisher: Double
  }
  static let ours = Knobs(attempts: attempts, baseDelay: baseDelay, maxDelay: maxDelay, socket: socketTimeout,
                          primary: primaryTimeout, publisher: publisherTimeout)
  // ConnectOptions() and TimeInterval.swift:22-33 of 2.17.0.
  static let sdkDefault = Knobs(attempts: 10, baseDelay: 0.3, maxDelay: 7, socket: 10, primary: 10, publisher: 10)

  // TimeInterval.computeReconnectDelay without its jitter (TimeInterval.swift:64-93).
  static func delay(_ attempt: Int, _ knobs: Knobs = ours) -> Double {
    if attempt >= knobs.attempts - 1 { return knobs.maxDelay }
    let x = Double(attempt) / Double(max(2, knobs.attempts) - 1) - 1
    return knobs.baseDelay + (1 - x * x).squareRoot() * (max(knobs.maxDelay, knobs.baseDelay) - knobs.baseDelay)
  }
  // Task.retrying sleeps after each failed attempt but the last, with delays 0...attempts-2.
  static func delays(_ knobs: Knobs = ours) -> Double { (0..<max(0, knobs.attempts - 1)).reduce(0) { $0 + delay($1, knobs) } }
  // The SDK alone, without the driver's deadline: a quick attempt waits for the socket, the response, the
  // subscriber and, once published, the publisher; the full one (the last) for the primary transport only.
  static func worstCase(_ knobs: Knobs = ours) -> Double {
    let quick = knobs.socket + responseTimeout + knobs.primary + knobs.publisher
    let full = knobs.socket + responseTimeout + knobs.primary
    return Double(max(0, knobs.attempts - 1)) * quick + full + delays(knobs) * (1 + jitter)
  }
}

/** §6: after a phone call the microphone stays muted until the page has taken the mute over. */
struct CalabRoomMuteHold {
  private(set) var held = false
  mutating func hold() { held = true }
  // A late unmuted control from the page cannot reopen it; a muted one hands the mute back to the page.
  mutating func acknowledge(webMuted: Bool) { if webMuted { held = false } }
  mutating func reset() { held = false }
}

/** One room session per document: a later connect, a disconnect or a new document retires it. */
struct CalabRoomAudioTicket {
  private(set) var document: String?
  private(set) var connection: String?
  private(set) var revision = 0
  func owns(document: String, connection: String) -> Bool { self.document == document && self.connection == connection }
  func current(_ revision: Int, document: String?) -> Bool { revision == self.revision && document != nil && document == self.document }
  @discardableResult mutating func begin(document: String, connection: String) -> Int {
    revision += 1; self.document = document; self.connection = connection
    return revision
  }
  // The connection id stays for the final snapshot; nothing it started may act any more.
  mutating func end() { revision += 1 }
  mutating func forget() { revision += 1; document = nil; connection = nil }
}

/** A frozen or hostile page cannot spin connect/disconnect or flood the audio thread with controls. */
struct CalabRoomAudioRate {
  static let capacity = 20.0
  static let perSecond = 10.0
  static let connectCost = 5.0
  private var tokens = capacity
  private var last: Double?
  mutating func allow(now: Double, cost: Double = 1) -> Bool {
    if let last { tokens = min(Self.capacity, tokens + max(0, now - last) * Self.perSecond) }
    last = now
    guard tokens >= cost else { return false }
    tokens -= cost
    return true
  }
}

/** State reaches the page at most every 100 ms and only as the latest snapshot (ADR-0149 §2). */
struct CalabRoomAudioPacer {
  enum Pace: Equatable { case now, after(Double), pending }
  static let interval = 0.1
  private var last = -Double.infinity
  private var scheduled = false
  mutating func offer(now: Double) -> Pace {
    if scheduled { return .pending }
    let wait = last + Self.interval - now
    if wait <= 0 { last = now; return .now }
    scheduled = true
    return .after(wait)
  }
  mutating func fired(now: Double) { scheduled = false; last = now }
}

/**
 * §6: unmuted capture that delivered frames and then none for 3 s restarts the engine once, again only after
 * frames return. One per connection. A delegate that never delivered proves nothing about capture (the probe's
 * open frames=0 finding), so it arms nothing: the gate stays open and the engine is left alone.
 */
struct CalabCaptureWatchdog {
  static let silence = 3.0
  // The processor's counter runs across connections: the first reading is a baseline, not a delivery.
  private var frames: Int?
  private var delivered = false
  private var since: Double?
  private var restarted = false
  mutating func tick(now: Double, frames: Int, expecting: Bool) -> Bool {
    defer { self.frames = frames }
    if let last = self.frames, frames != last { delivered = true; since = now; restarted = false; return false }
    guard expecting, delivered else { since = nil; return false }
    guard let since else { self.since = now; return false }
    guard !restarted, now - since >= Self.silence else { return false }
    restarted = true
    return true
  }
}

/**
 * §7: the reconnect budget counts from the last moment the link was known healthy, not from when the SDK
 * notices the drop: after a suspension it may notice late and still finish a full reconnect past the
 * server's grace. Times come from a clock that keeps running while the device sleeps.
 */
struct CalabRoomHealth {
  // Background ticks come every second; a longer gap means the process did not run.
  static let maxTickGap = 3.0
  // After such a gap, the link counts as healthy again only once it stayed up this long, longer than the
  // SDK needs to notice a dead signal connection (ping timeout from the server, not confirmed on device).
  static let probation = 20.0
  private(set) var lastHealthy: Double?
  private var lastTick: Double?
  private var trustedFrom: Double?
  mutating func start(now: Double) { lastHealthy = now; lastTick = now; trustedFrom = nil }
  mutating func tick(now: Double, connected: Bool) {
    defer { lastTick = now }
    if let lastTick, now - lastTick > Self.maxTickGap { trustedFrom = now + Self.probation }
    guard connected else { return }
    if let trustedFrom, now < trustedFrom { return }
    trustedFrom = nil; lastHealthy = now
  }
  // What is left of the deadline when reconnecting starts now; zero means stop at once.
  func remaining(now: Double) -> Double {
    max(0, CalabRoomReconnectSchedule.deadline - (now - (lastHealthy ?? now)))
  }
}

enum CalabRoomTrackSource: Equatable { case microphone, screenShareAudio, other }

// `<user>:<session>` (server voice.Identity). The companion `<user>:<session>:web` and anything else is no user.
func calabRoomUser(_ identity: String) -> String? {
  let parts = identity.split(separator: ":", omittingEmptySubsequences: false)
  guard parts.count == 2, calabRoomAudioUUID(String(parts[0])), calabRoomAudioUUID(String(parts[1])) else { return nil }
  return parts[0].lowercased()
}

// The web's own video connection (ADR-0149 §3): never a voice, never subscribed here.
func calabRoomCompanion(_ identity: String) -> Bool { identity.hasSuffix(":web") }

// The volume to subscribe at, or nil to stay unsubscribed. Web sends final per-user and stream volumes.
func calabRoomTrackVolume(identity: String, source: CalabRoomTrackSource, controls: CalabRoomAudioControls) -> Double? {
  guard !calabRoomCompanion(identity), !controls.deafened else { return nil }
  let user = calabRoomUser(identity)
  switch source {
  case .microphone: return min(1, max(0, user.flatMap { controls.userVolumes[$0] ?? controls.userVolumes[$0.uppercased()] } ?? controls.volume))
  case .screenShareAudio: return user.flatMap { id in controls.watched.first { $0.key.lowercased() == id }?.value }.map { min(1, max(0, $0)) }
  case .other: return nil
  }
}

// The system wins (interruption, phone call hold), then the server's grant, then the page's own mute.
func calabRoomMuteOrigin(webMuted: Bool, deafened: Bool, canSpeak: Bool, system: Bool) -> CalabRoomAudioState.MuteOrigin? {
  if system { return .system }
  if !canSpeak { return .server }
  return webMuted || deafened ? .web : nil
}

// LiveKit's active speakers as user ids: once each, without my own device, at most 64.
func calabRoomSpeakers(_ identities: [String], local: String?) -> [String] {
  var seen = Set<String>(), speakers: [String] = []
  for identity in identities where identity != local {
    guard let user = calabRoomUser(identity), seen.insert(user).inserted else { continue }
    speakers.append(user)
    if speakers.count == 64 { break }
  }
  return speakers
}

private let calabRoomHostname = try! NSRegularExpression(pattern: "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

// CalabRoomAudioHosts from Info.plist (plugins/withCallAudio.js, CALAB_IOS_RTC_HOSTS). Malformed entries drop out.
func calabRoomAudioHosts(_ value: Any?) -> Set<String> {
  guard let names = value as? [Any] else { return [] }
  return Set(names.compactMap { name in
    guard let name = name as? String else { return nil }
    let range = NSRange(name.startIndex..., in: name)
    return calabRoomHostname.firstMatch(in: name, options: [], range: range)?.range == range ? name : nil
  })
}

// The parser already shaped the URL; this pins its host to the build's list. An empty list admits nothing.
func calabRoomAudioEndpoint(_ url: String, hosts: Set<String>) -> URL? {
  guard let parts = URLComponents(string: url), parts.scheme == "wss", let host = parts.host?.lowercased(), hosts.contains(host),
        parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { return nil }
  return parts.url
}

// Generated by plugins/withCallAudio.js into the pod's resources: `builtin:quack` is calab-room-builtin-quack.
func calabRoomAudioCueResource(_ name: String) -> String? {
  calabRoomAudioCues.contains(name) ? "calab-room-" + name.replacingOccurrences(of: ":", with: "-") : nil
}

#if os(iOS)
import AVFAudio

extension CalabRoomAudioState.Route {
  init(_ route: AVAudioSessionRouteDescription) {
    switch route.outputs.first?.portType {
    case .builtInSpeaker?: self = .speaker
    case .builtInReceiver?: self = .receiver
    case .headphones?, .usbAudio?, .lineOut?: self = .wired
    case .bluetoothA2DP?, .bluetoothHFP?, .bluetoothLE?: self = .bluetooth
    default: self = .other
    }
  }
}
#endif

#if canImport(LiveKitClient)
import LiveKitClient
#elseif canImport(LiveKit)
import LiveKit
#endif
#if canImport(LiveKitClient) || canImport(LiveKit)
import CallKit
import OSLog
import UIKit
import os

/** The gate, own ring, meter and watchdog counter in the capture post-processing delegate (ADR-0149 §5). */
final class CalabRoomCaptureProcessor: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
  private let lock: UnsafeMutablePointer<os_unfair_lock>
  private var gate = CalabVoiceGate()
  private var sampleRate = 48000.0
  private var frames = 0
  private var db = CalabVoiceGate.floorDb
  override init() {
    lock = .allocate(capacity: 1)
    lock.initialize(to: os_unfair_lock())
    super.init()
  }
  deinit { lock.deinitialize(count: 1); lock.deallocate() }
  func configure(_ value: CalabRoomAudioGate) {
    let mode: CalabVoiceGate.Mode = value.mode == .ptt ? .ptt : value.mode == .open ? .open : .voice
    os_unfair_lock_lock(lock); gate.configure(mode: mode, thresholdDb: value.thresholdDb, pttOpen: value.pttOpen); os_unfair_lock_unlock(lock)
  }
  func reset() { os_unfair_lock_lock(lock); gate.reset(); db = CalabVoiceGate.floorDb; os_unfair_lock_unlock(lock) }
  func read() -> (frames: Int, speaking: Bool, level: Int) {
    os_unfair_lock_lock(lock); defer { os_unfair_lock_unlock(lock) }
    return (frames, gate.speaking, CalabVoiceGate.level(db: db))
  }
  func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
    os_unfair_lock_lock(lock); sampleRate = Double(max(8000, sampleRateHz)); os_unfair_lock_unlock(lock)
  }
  // Called only while the published track is unmuted: a muted sender marks the APM output unused, and
  // the post-processor runs inside `capture_output_used` (WebRTC audio_processing_impl.cc:1395-1429).
  func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
    let count = audioBuffer.frames, channels = audioBuffer.channels
    guard count > 0, channels > 0 else { return }
    let db = CalabVoiceGate.db(rms: CalabVoiceGate.rms(audioBuffer.rawBuffer(forChannel: 0), count: count))
    os_unfair_lock_lock(lock)
    let passes = gate.push(db: db, frameMs: Double(count) * 1000 / sampleRate)
    frames &+= count; self.db = db
    os_unfair_lock_unlock(lock)
    if !passes { for channel in 0..<channels { CalabVoiceGate.silence(audioBuffer.rawBuffer(forChannel: channel), count: count) } }
  }
  func audioProcessingRelease() {}
}

enum CalabRoomAudioRefusal: Error { case rate, host, connection }

extension CalabRoomReconnectSchedule {
  static func options(relayOnly: Bool) -> ConnectOptions {
    ConnectOptions(autoSubscribe: false, reconnectAttempts: attempts, reconnectAttemptDelay: baseDelay, reconnectMaxDelay: maxDelay,
                   socketConnectTimeoutInterval: socketTimeout, primaryTransportConnectTimeout: primaryTimeout,
                   publisherTransportConnectTimeout: publisherTimeout, iceTransportPolicy: relayOnly ? .relay : .all)
  }
}

/** The room's audio transport. The shared web keeps REST, seats, UI and video (ADR-0149 §1). */
@MainActor
final class CalabRoomAudio: NSObject, RoomDelegate, CXCallObserverDelegate {
  static let shared = CalabRoomAudio()
  // The flag of this build, a host list and iOS 17 for the ducking controls (ADR-0149 §6).
  nonisolated static var enabled: Bool {
    guard #available(iOS 17, *), Bundle.main.object(forInfoDictionaryKey: "CalabRoomAudioEnabled") as? Bool == true else { return false }
    return !calabRoomAudioHosts(Bundle.main.object(forInfoDictionaryKey: "CalabRoomAudioHosts")).isEmpty
  }
  var emit: ((String, CalabRoomAudioState) -> Void)?
  private let logger = Logger(subsystem: "Calab", category: "room-audio")
  private let hosts = calabRoomAudioHosts(Bundle.main.object(forInfoDictionaryKey: "CalabRoomAudioHosts"))
  private let session = AVAudioSession.sharedInstance()
  private let calls = CXCallObserver()
  private let processor = CalabRoomCaptureProcessor()
  private let engine = CalabLiveKitAudioEngine()
  private lazy var owner = CalabAudioOwner(engine: engine)
  private weak var view: AnyObject?
  private var granted: String?
  private var ticket = CalabRoomAudioTicket()
  private var machine = CalabAudioSessionMachine()
  private var rate = CalabRoomAudioRate()
  private var pacer = CalabRoomAudioPacer()
  private var watchdog = CalabCaptureWatchdog()
  private var health = CalabRoomHealth()
  private var lease: CalabAudioLease?
  private var room: Room?
  private var red = true
  private var controls: CalabRoomAudioControls?
  private var state: CalabRoomAudioState?
  private var sent: CalabRoomAudioState?
  private var link = CalabRoomAudioState.Phase.connecting
  private var canSpeak = false
  private var hold = CalabRoomMuteHold()
  private var foreground = true
  private var route = CalabRoomAudioState.Route.other
  private var phoneCall = false
  private var levelsUntil: Date?
  private var mic: LocalAudioTrack?
  private var publication: LocalTrackPublication?
  private var publishedBitrate: Int?
  private var wanted: [Track.Sid: Bool] = [:]
  private var players: [AVAudioPlayer] = []
  private var observers: [NSObjectProtocol] = []
  private var connectTask: Task<Void, Never>?
  private var publishTask: Task<Void, Error>?
  private var controlTask: Task<Void, Never>?
  private var drainTask: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var ticker: Task<Void, Never>?
  private var paced: Task<Void, Never>?

  private override init() {
    super.init()
    engine.captureProcessing = processor
  }

  private var now: Double { ProcessInfo.processInfo.systemUptime }
  // systemUptime stops while the device sleeps; the server's grace does not. CLOCK_MONOTONIC keeps counting.
  private var awake: Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000 }
  // Device diagnostics at notice level, kept in Release for TestFlight. Only our own enums, codes and the first
  // 8 characters of the connection id are public; never a URL, host, token, SDP, identity or device name.
  private func note(_ text: String) { logger.notice("\(text, privacy: .public)") }
  private func tag(_ connection: String?) -> String { String((connection ?? "-").prefix(8)) }
  private var lastSummary = -Double.infinity
  private var summaryFrames = 0

  private func current(_ revision: Int, _ expected: Room? = nil) -> Bool {
    ticket.current(revision, document: granted) && (expected == nil || room === expected)
  }
  private var effectiveMute: Bool { calabRoomMuteOrigin(webMuted: controls?.muted ?? true, deafened: controls?.deafened ?? false, canSpeak: canSpeak, system: hold.held || machine.state == .interrupted || machine.state == .call) != nil }

  func install() {
    guard observers.isEmpty else { return }
    LiveKitSDK.disableLogging()
    calls.setDelegate(self, queue: .main)
    phoneCall = calls.calls.contains { !$0.hasEnded }
    owner.roomYield = { [weak self] in self?.send(.yieldToCall) }
    owner.roomResume = { [weak self] in guard let self else { return }; self.send(.resumeFromCall(foreground: self.foreground)) }
    owner.roomFailed = { [weak self] in self?.send(.audioFailed) }
    observe(NSNotification.Name("CalabHostDocumentGranted")) { audio, notice in
      audio.view = notice.object as AnyObject?; audio.granted = notice.userInfo?["document"] as? String
    }
    // A reload or logout ends the room with the document that owned it.
    for name in ["CalabHostDocumentInvalidated", "CalabHostSessionCleared"] {
      observe(NSNotification.Name(name)) { audio, notice in
        guard let view = notice.object as AnyObject?, audio.view === view else { return }
        audio.stop(.ended); audio.ticket.forget(); audio.view = nil; audio.granted = nil; audio.state = nil; audio.sent = nil
      }
    }
    observe(AVAudioSession.interruptionNotification) { audio, notice in
      if let event = notice.calabInterruption(phoneCall: audio.phoneCall) { audio.send(event) }
    }
    observe(AVAudioSession.routeChangeNotification) { audio, notice in
      audio.send(.routeChanged(notice.calabRouteChange, seen: audio.session.calabSeen))
    }
    observe(AVAudioSession.mediaServicesWereResetNotification) { audio, _ in audio.send(.mediaServicesReset) }
    observe(UIApplication.willEnterForegroundNotification) { audio, _ in
      audio.foreground = true; audio.note("foreground")
      audio.send(.foreground(seen: audio.session.calabSeen, engineRunning: AudioManager.shared.isEngineRunning, phoneCall: audio.phoneCall))
      audio.changed()
    }
    observe(UIApplication.didEnterBackgroundNotification) { audio, _ in audio.foreground = false; audio.note("background") }
  }

  private func observe(_ name: Notification.Name, _ handle: @escaping @MainActor (CalabRoomAudio, Notification) -> Void) {
    observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notice in
      MainActor.assumeIsolated { if let self { handle(self, notice) } }
    })
  }

  func currentDocument(_ document: String) -> Bool { view != nil && granted == document }

  func snapshot(for document: String) -> CalabRoomAudioState? {
    guard currentDocument(document), ticket.document == document else { return nil }
    return state
  }

  // MARK: Operations

  func operation(_ document: String, _ operation: CalabRoomAudioOperation) async throws {
    if case .status = operation { return }
    let kind: String, connection: String
    switch operation {
    case .status: return
    case let .connect(request): kind = "connect"; connection = request.connectionId
    case let .control(id, _): kind = "control"; connection = id
    case let .cue(id, _, _): kind = "cue"; connection = id
    case let .disconnect(id): kind = "disconnect"; connection = id
    }
    // Controls follow every page change: only the rest is worth a line.
    if kind != "control" { note("operation \(kind) \(tag(connection))") }
    guard currentDocument(document) else { note("refused \(kind) \(tag(connection)): stale-document"); return }
    var cost = 1.0
    if case .connect = operation { cost = CalabRoomAudioRate.connectCost }
    guard rate.allow(now: now, cost: cost) else { note("refused \(kind) \(tag(connection)): rate-limit"); throw CalabRoomAudioRefusal.rate }
    if kind != "connect", !ticket.owns(document: document, connection: connection) {
      note("refused \(kind) \(tag(connection)): stale-connection (current \(tag(ticket.connection)))"); return
    }
    switch operation {
    case .status: return
    case let .connect(request): try await connect(document, request)
    case let .control(connection, value): control(document, connection, value)
    case let .cue(connection, name, volume): cue(document, connection, name, volume)
    case .disconnect: stop(.ended)
    }
  }

  private func connect(_ document: String, _ request: CalabRoomAudioConnect) async throws {
    // Never a force-unwrapped URL: a host outside this build's list fails the operation and holds nothing.
    guard let endpoint = calabRoomAudioEndpoint(request.url, hosts: hosts) else {
      // The host itself stays out of the log; the count tells an empty list from a missing entry.
      note("refused connect \(tag(request.connectionId)): host-not-allowed (\(hosts.count) hosts in this build)")
      throw CalabRoomAudioRefusal.host
    }
    if ticket.owns(document: document, connection: request.connectionId), state?.phase != .ended, state?.phase != .failed, state?.phase != .lost { return }
    stop(.ended)
    let previous = drainTask
    let rev = ticket.begin(document: document, connection: request.connectionId)
    var fresh = CalabRoomAudioState(connectionId: request.connectionId)
    fresh.canSpeak = request.canSpeak
    state = fresh; link = .connecting; canSpeak = request.canSpeak; hold.reset(); red = request.red
    controls = request.controls; wanted = [:]; levelsUntil = request.controls.levels ? Date().addingTimeInterval(30) : nil
    processor.configure(request.controls.gate); processor.reset(); watchdog = CalabCaptureWatchdog()
    refresh()
    deadline = Task { @MainActor in
      do { try await Task.sleep(for: .seconds(15)) } catch { return }
      if self.current(rev), self.link == .connecting { self.stop(.failed, .connection) }
    }
    let token = request.token, relayOnly = request.relayOnly, bitrate = request.controls.bitrate
    let task = Task { @MainActor in
      // Never take the engine while the previous room still unwinds.
      await previous?.value
      guard self.current(rev), !Task.isCancelled else { return }
      await self.run(rev, endpoint: endpoint, token: token, relayOnly: relayOnly, bitrate: bitrate)
    }
    connectTask = task
    await task.value
    if ticket.revision == rev { connectTask = nil }
  }

  private func run(_ rev: Int, endpoint: URL, token: String, relayOnly: Bool, bitrate: Int) async {
    // A permission prompt cannot appear on the lock screen; a denial is final (gate G14).
    if canSpeak && session.recordPermission != .granted {
      guard session.recordPermission == .undetermined, UIApplication.shared.applicationState == .active else { stop(.failed, .permission); return }
      let granted = await withCheckedContinuation { continuation in session.requestRecordPermission { continuation.resume(returning: $0) } }
      guard current(rev) else { return }
      guard granted else { stop(.failed, .permission); return }
    }
    do { lease = try owner.acquire(.room) } catch { stop(.failed, .audio); return }
    route = CalabRoomAudioState.Route(session.currentRoute)
    send(.join(canSpeak: canSpeak, callHolds: lease.map { !owner.holds($0) } ?? false))
    guard current(rev), state?.phase != .failed else { return }
    let expected = Room(delegate: self, roomOptions: RoomOptions(
      defaultAudioCaptureOptions: Self.capture, defaultAudioPublishOptions: publishOptions(bitrate),
      adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: true, suspendLocalVideoTracksInBackground: true))
    room = expected
    do {
      try await expected.connect(url: endpoint.absoluteString, token: token, connectOptions: CalabRoomReconnectSchedule.options(relayOnly: relayOnly))
      guard current(rev, expected) else { await expected.disconnect(); return }
      canSpeak = canSpeak && Self.microphoneAllowed(expected.localParticipant.permissions)
      if !canSpeak { send(.grant(canSpeak: false, foreground: foreground)) }
      link = .connected; health.start(now: awake)
      note("room connected \(tag(ticket.connection)) canSpeak=\(canSpeak)")
      deadline?.cancel(); deadline = nil
      applyOutput()
      if machine.state == .speaking { try await publishMicrophone(expected, rev) }
      guard current(rev, expected) else { return }
      applyControls(); startTicker(rev)
    } catch {
      note("room connect failed \(tag(ticket.connection)): \((error as? LiveKitError)?.type.rawValue ?? -1)")
      if current(rev, expected) { stop(.failed, .connection) } else { await expected.disconnect() }
    }
  }

  private static let capture = AudioCaptureOptions(echoCancellation: true, autoGainControl: true, noiseSuppression: true)
  private func publishOptions(_ bitrate: Int) -> AudioPublishOptions {
    AudioPublishOptions(encoding: AudioEncoding(maxBitrate: bitrate), dtx: true, red: red)
  }
  private static func microphoneAllowed(_ permissions: ParticipantPermissions) -> Bool {
    permissions.canPublish && (permissions.canPublishSources.isEmpty || permissions.canPublishSources.contains(Track.Source.microphone.rawValue))
  }

  private func publishMicrophone(_ expected: Room, _ rev: Int) async throws {
    if let publishTask { return try await publishTask.value }
    guard publication == nil, machine.state == .speaking else { return }
    // A later grant never prompts from the background.
    guard session.recordPermission == .granted else { stop(.failed, .permission); throw CancellationError() }
    let bitrate = controls?.bitrate ?? 32000
    let task = Task { @MainActor in
      let track = await LocalAudioTrack.createTrack(options: Self.capture)
      guard self.current(rev, expected) else { try? await track.stop(); return }
      self.mic = track
      // Published with the track unmuted: 2.17.0 waits up to 5 s for a first frame (LocalParticipant.swift:775-781,
      // LocalAudioTrack.swift:187-216) on the capture post-processing path, which a muted sender silences. The
      // engine's input mixer sends zeros meanwhile, and the track mute follows right after publish.
      if self.effectiveMute, self.lease.map(self.owner.holds) == true { AudioManager.shared.isMicrophoneMuted = true }
      let published = try await expected.localParticipant.publish(audioTrack: track, options: self.publishOptions(bitrate))
      guard self.current(rev, expected) else { try? await track.stop(); return }
      self.publication = published; self.publishedBitrate = bitrate
      self.note("microphone published \(bitrate / 1000) kbps muted=\(self.effectiveMute)")
      self.applyControls()
    }
    publishTask = task
    defer { if ticket.revision == rev { publishTask = nil } }
    try await task.value
  }

  private func unpublishMicrophone() {
    guard let room, let publication else { mic = nil; return }
    let track = mic
    self.publication = nil; mic = nil; publishedBitrate = nil
    Task { @MainActor in
      try? await room.localParticipant.unpublish(publication: publication)
      try? await track?.stop()
    }
    refresh()
  }

  // (Re)publishes once the link is up; reconnected() calls it again for a deferred one. A failure is retried
  // once, then the room fails with `audio` instead of leaving the microphone silently gone.
  private func ensureMicrophone(after delay: Double = 0) {
    guard let room, link == .connected, publication == nil, publishTask == nil, machine.state == .speaking else { return }
    let rev = ticket.revision
    Task { @MainActor in
      if delay > 0 { do { try await Task.sleep(for: .seconds(delay)) } catch { return } }
      for attempt in 0..<2 {
        guard self.current(rev, room), self.link == .connected, self.publication == nil, self.machine.state == .speaking else { return }
        do { try await self.publishMicrophone(room, rev); if self.current(rev, room) { self.applyControls() }; return }
        catch {
          self.note("microphone publish attempt \(attempt + 1) failed: \((error as? LiveKitError)?.type.rawValue ?? -1)")
          if attempt == 0 { do { try await Task.sleep(for: .seconds(1)) } catch { return } }
        }
      }
      guard self.current(rev, room), self.link == .connected, self.publication == nil else { return }
      self.note("microphone publish failed twice")
      self.stop(.failed, .audio)
    }
  }

  private func control(_ document: String, _ connection: String, _ value: CalabRoomAudioControls) {
    guard ticket.owns(document: document, connection: connection), state != nil else { return }
    // The page saw the system mute and took it over: from now its controls own the microphone again.
    hold.acknowledge(webMuted: value.muted)
    // Levels run 30 s per request: a page that froze with its meter open stops them by itself.
    if !value.levels { levelsUntil = nil } else if controls?.levels != true { levelsUntil = Date().addingTimeInterval(30) }
    controls = value
    processor.configure(value.gate)
    applyControls()
  }

  private func applyControls() {
    applyOutput()
    // The engine mute (inputMixer) is instant and silent; the track mute tells the server (ADR-0149 §4).
    if lease.map(owner.holds) == true { AudioManager.shared.isMicrophoneMuted = effectiveMute }
    // No live bitrate in 2.17.0: a new voice tier republishes the microphone once, never mid-reconnect;
    // reconnected() comes back here.
    if room != nil, link == .connected, let bitrate = controls?.bitrate, publication != nil, publishedBitrate != bitrate, publishTask == nil {
      unpublishMicrophone()
      ensureMicrophone()
    }
    refresh()
    guard controlTask == nil, let mic, let expected = room else { return }
    let rev = ticket.revision
    controlTask = Task { @MainActor in
      defer { if self.ticket.revision == rev { self.controlTask = nil } }
      do {
        while self.current(rev, expected) && mic.isMuted != self.effectiveMute {
          if self.effectiveMute { try await mic.mute() } else { try await mic.unmute() }
        }
        self.refresh()
      } catch { if self.current(rev, expected) { self.stop(.failed, .audio) } }
    }
  }

  // Subscribes microphones and watched screen-share audio, nothing else, never the web companion.
  private func applyOutput() {
    guard let room, let controls else { return }
    let rev = ticket.revision
    for participant in room.remoteParticipants.values {
      guard let identity = participant.identity?.stringValue else { continue }
      for case let publication as RemoteTrackPublication in participant.trackPublications.values where publication.kind == .audio {
        let source: CalabRoomTrackSource = publication.source == .microphone ? .microphone : publication.source == .screenShareAudio ? .screenShareAudio : .other
        let volume = calabRoomTrackVolume(identity: identity, source: source, controls: controls)
        if let track = publication.track as? RemoteAudioTrack, let volume { track.volume = volume }
        let subscribe = volume != nil
        guard wanted[publication.sid] != subscribe else { continue }
        wanted[publication.sid] = subscribe
        Task { @MainActor in
          guard self.current(rev, room) else { return }
          try? await publication.set(subscribed: subscribe)
        }
      }
    }
  }

  private func cue(_ document: String, _ connection: String, _ name: String, _ volume: Double) {
    guard ticket.owns(document: document, connection: connection), lease != nil,
          machine.state == .speaking || machine.state == .listening,
          let resource = calabRoomAudioCueResource(name),
          let url = Bundle.main.url(forResource: resource, withExtension: "mp3") ?? Bundle.main.url(forResource: resource, withExtension: "m4a"),
          let player = try? AVAudioPlayer(contentsOf: url) else { return }
    players.removeAll { !$0.isPlaying }
    if players.count >= 4 { players.removeFirst().stop() }
    player.volume = Float(min(1, max(0, volume)))
    if player.play() { players.append(player) }
  }

  // MARK: Session policy

  private func send(_ event: CalabAudioEvent) {
    let actions = machine.handle(event)
    note("event \(String(describing: event)) -> \(String(describing: actions))")
    for action in actions {
      do { try perform(action) }
      catch {
        note("action refused \(String(describing: action)): \((error as NSError).domain) \((error as NSError).code)")
        // A teardown never stops halfway: whatever refused, the room fails and the page is told.
        if actions.contains(.fail) { stop(.failed, .audio, sessionHeld: action == .deactivate); return }
        if event != .activationFailed { send(.activationFailed) }
        break
      }
    }
    applyControls()
  }

  private func perform(_ action: CalabAudioAction) throws {
    switch action {
    case let .configure(config): try session.calabApply(config)
    case .activate: try session.setActive(true)
    // Headset controls go back to the music app only once the session is gone with a notice.
    case .deactivate: try session.setActive(false, options: .notifyOthersOnDeactivation)
    case let .engine(on):
      if let lease { let held = try owner.setEngine(on, lease: lease); note("engine \(on ? "on" : "off")\(held ? "" : " skipped: call holds it")") }
    // Capture starts now, in foreground; the track publishes once the room is connected.
    case .startCapture: try AudioManager.shared.startLocalRecording()
    case .stopCapture:
      unpublishMicrophone()
      try AudioManager.shared.stopLocalRecording()
    case .republish:
      try AudioManager.shared.stopLocalRecording()
      try AudioManager.shared.startLocalRecording()
      unpublishMicrophone()
      ensureMicrophone()
    case .muteTrack:
      AudioManager.shared.isMicrophoneMuted = true
      if let mic { Task { try? await mic.mute() } }
    case .holdMicrophoneMuted: hold.hold()
    case .restoreMicrophone: ensureMicrophone()
    case .refreshRoute: route = CalabRoomAudioState.Route(session.currentRoute)
    case .fail: stop(.failed, .audio)
    }
  }

  // MARK: Teardown

  /** Quiet now, drained later: the terminal phase reaches the page only once nothing holds audio. */
  private func stop(_ phase: CalabRoomAudioState.Phase, _ error: CalabRoomAudioState.Failure? = nil, sessionHeld: Bool = false) {
    guard state != nil, lease != nil || room != nil || connectTask != nil || state?.phase != phase else { return }
    ticket.end()
    let rev = ticket.revision
    for task in [deadline, ticker, paced] { task?.cancel() }
    deadline = nil; ticker = nil
    let oldControl = controlTask, oldConnect = connectTask, oldPublish = publishTask
    oldControl?.cancel(); oldConnect?.cancel(); oldPublish?.cancel()
    controlTask = nil; connectTask = nil; publishTask = nil
    let previous = drainTask, old = room, oldMic = mic
    room = nil; mic = nil; publication = nil; publishedBitrate = nil; wanted = [:]; levelsUntil = nil
    for player in players { player.stop() }
    players = []
    // Synchronous boundary: microphone and engine off, session released, before any SDK await.
    AudioManager.shared.isMicrophoneMuted = true
    var released = !sessionHeld
    for action in machine.handle(.leave) {
      do { try perform(action) } catch { if action == .deactivate { released = false } }
    }
    if let lease { owner.release(lease) }
    lease = nil
    hold.reset(); processor.reset()
    drainTask = Task { @MainActor in
      // Disconnect first: it drops a running SDK reconnect before its first await (Room.swift:536, 551-555), and
      // unpublishes and stops the local track (Room.swift:691-707, Participant.swift:219-220).
      await old?.disconnect()
      await previous?.value
      await oldControl?.value
      await oldConnect?.value
      _ = try? await oldPublish?.value
      try? await oldMic?.stop()
      guard self.ticket.revision == rev else { return }
      if !released { try? self.session.setActive(false, options: .notifyOthersOnDeactivation) }
      self.note("phase -> \(phase.rawValue)\(error.map { " error=\($0.rawValue)" } ?? "") drained \(self.tag(self.ticket.connection))")
      self.state?.phase = phase; self.state?.error = error
      self.refresh()
    }
  }

  // MARK: State

  private func startTicker(_ rev: Int) {
    ticker?.cancel()
    ticker = Task { @MainActor in
      while !Task.isCancelled && self.current(rev) {
        self.tick()
        // The watchdog needs only seconds; the ring and meter need 100 ms, and only for a visible page.
        do { try await Task.sleep(for: .milliseconds(self.foreground ? 100 : 1000)) } catch { return }
      }
    }
  }

  private func tick() {
    health.tick(now: awake, connected: link == .connected)
    let read = processor.read()
    let expecting = machine.state == .speaking && publication != nil && !effectiveMute && link == .connected && AudioManager.shared.isEngineRunning
    if watchdog.tick(now: now, frames: read.frames, expecting: expecting), let lease {
      note("watchdog: capture silent 3 s, engine restarted")
      do { try owner.setEngine(false, lease: lease); try owner.setEngine(true, lease: lease) } catch { send(.audioFailed) }
    }
    if let until = levelsUntil, until < Date() { levelsUntil = nil }
    state?.speaking = expecting && read.speaking
    state?.level = levelsUntil != nil && foreground && !effectiveMute ? read.level : nil
    // One line per 10 s while connected; the frame count says whether the capture delegate runs at all.
    if link == .connected, now - lastSummary >= 10 {
      note("summary \(tag(ticket.connection)) machine=\(machine.state) frames+\(read.frames &- summaryFrames) published=\(publication != nil) muted=\(effectiveMute) engine=\(AudioManager.shared.isEngineRunning) route=\(route.rawValue) fg=\(foreground)")
      lastSummary = now; summaryFrames = read.frames
    }
    refresh()
  }

  private func refresh() {
    guard var next = state else { return }
    let before = next
    defer {
      if before.phase != next.phase || before.error != next.error || (before.muteOrigin == nil) != (next.muteOrigin == nil) {
        note("phase \(before.phase.rawValue) -> \(next.phase.rawValue)\(next.error.map { " error=\($0.rawValue)" } ?? "") muted=\(next.muteOrigin?.rawValue ?? "no") \(tag(next.connectionId))")
      }
    }
    if next.phase != .ended && next.phase != .failed && next.phase != .lost {
      next.phase = machine.state == .interrupted || machine.state == .call ? .interrupted : link
    }
    next.canSpeak = canSpeak
    next.microphoneReady = publication != nil
    next.muteOrigin = calabRoomMuteOrigin(webMuted: controls?.muted ?? true, deafened: controls?.deafened ?? false, canSpeak: canSpeak,
                                          system: hold.held || machine.state == .interrupted || machine.state == .call)
    if next.muteOrigin != nil { next.speaking = false; next.level = nil }
    next.route = route
    next.phoneCall = phoneCall
    state = next
    changed()
  }

  private func changed() {
    guard let state, let document = ticket.document, currentDocument(document), state != sent else { return }
    // A frozen page gets nothing it would have to replay: in background only phase and mute changes go out.
    if !foreground, var quiet = sent { quiet.speaking = state.speaking; quiet.speakers = state.speakers; quiet.level = state.level; if quiet == state { return } }
    switch pacer.offer(now: now) {
    case .now: sent = state; emit?(document, state)
    case let .after(wait):
      paced = Task { @MainActor in
        do { try await Task.sleep(for: .milliseconds(Int(wait * 1000) + 1)) } catch { self.pacer.fired(now: self.now); return }
        self.pacer.fired(now: self.now)
        self.changed()
      }
    case .pending: return
    }
  }

  // MARK: Delegates

  nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    MainActor.assumeIsolated {
      phoneCall = calls.calls.contains { !$0.hasEnded }
      if !call.hasEnded { send(.phoneCallStarted) } else { refresh() }
    }
  }

  // A quick reconnect never leaves `.connected`, so the start and completion callbacks drive the phase.
  nonisolated func room(_ room: Room, didStartReconnectWithMode reconnectMode: ReconnectMode) {
    Task { @MainActor in self.reconnecting(room) }
  }

  nonisolated func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) {
    Task { @MainActor in self.reconnected(room) }
  }

  nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
    Task { @MainActor in
      if connectionState == .reconnecting { self.reconnecting(room) }
      if connectionState == .connected && oldConnectionState == .reconnecting { self.reconnected(room) }
    }
  }

  private func reconnecting(_ room: Room) {
    guard self.room === room, link == .connected else { return }
    link = .reconnecting; refresh()
    let rev = ticket.revision
    deadline?.cancel()
    let budget = health.remaining(now: awake)
    note("reconnect started, budget \(Int(budget)) s")
    guard budget > 0 else { note("reconnect budget spent: lost"); stop(.lost, .network); return }
    deadline = Task { @MainActor in
      do { try await Task.sleep(for: .seconds(budget)) } catch { return }
      if self.current(rev, room), self.link == .reconnecting { self.note("reconnect deadline: lost"); self.stop(.lost, .network) }
    }
  }

  // A full reconnect brings new publications: the subscriptions are planned again.
  private func reconnected(_ room: Room) {
    guard self.room === room, link == .reconnecting else { return }
    deadline?.cancel(); deadline = nil
    link = .connected; wanted = [:]; health.start(now: awake)
    note("reconnect completed")
    applyControls()
    ensureMicrophone()
  }

  nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
    Task { @MainActor in
      guard self.room === room else { return }
      self.note("room disconnected: \(error.map { String($0.type.rawValue) } ?? "no error") link=\(self.link.rawValue)")
      // Removal, takeover by another device and a deleted room end it here, even with the page frozen.
      switch error?.type {
      case .participantRemoved?: self.stop(.ended, .removed)
      case .duplicateIdentity?: self.stop(.ended, .duplicate)
      case .roomDeleted?: self.stop(.ended, .closed)
      case nil where self.link == .connected: self.stop(.ended)
      default: self.stop(.lost, .network)
      }
    }
  }

  nonisolated func room(_ room: Room, didMoveToRoomNamed roomName: String) {
    Task { @MainActor in guard self.room === room else { return }; self.wanted = [:]; self.applyOutput(); self.refresh() }
  }

  nonisolated func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
    Task { @MainActor in guard self.room === room else { return }; self.applyOutput() }
  }

  nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
    Task { @MainActor in guard self.room === room else { return }; self.applyOutput() }
  }

  nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) {
    Task { @MainActor in guard self.room === room else { return }; self.wanted[publication.sid] = nil }
  }

  nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
    Task { @MainActor in self.localUnpublished(room, publication) }
  }

  nonisolated func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
    Task { @MainActor in self.localPublished(room, publication) }
  }

  // A full reconnect or an SFU move unpublishes every local track and republishes only unmuted ones
  // (LocalParticipant.swift:344-376, called from Room+EngineDelegate.swift:68-80). Our own unpublish clears
  // `publication` first, so only the SDK's arrives here.
  private func localUnpublished(_ room: Room, _ unpublished: LocalTrackPublication) {
    guard self.room === room, let publication, unpublished === publication else { return }
    let muted = mic?.isMuted ?? true
    self.publication = nil
    note("microphone unpublished by the SDK, muted=\(muted)")
    refresh()
    if muted { mic = nil; ensureMicrophone(after: 0.5); return }
    // The unmuted one comes back by itself and is adopted below; if it does not, publish a fresh one.
    let rev = ticket.revision
    Task { @MainActor in
      do { try await Task.sleep(for: .seconds(10)) } catch { return }
      guard self.current(rev, room), self.publication == nil else { return }
      self.mic = nil
      self.ensureMicrophone()
    }
  }

  private func localPublished(_ room: Room, _ published: LocalTrackPublication) {
    guard self.room === room, published.source == .microphone, publication == nil, publishTask == nil,
          let track = published.track as? LocalAudioTrack, track === mic else { return }
    publication = published
    note("microphone republished by the SDK, adopted")
    applyControls()
  }

  nonisolated func room(_ room: Room, participant: Participant, didUpdatePermissions permissions: ParticipantPermissions) {
    Task { @MainActor in
      guard self.room === room, participant === room.localParticipant else { return }
      let allowed = Self.microphoneAllowed(permissions)
      guard allowed != self.canSpeak else { return }
      self.canSpeak = allowed
      // A new grant captures on the next foreground at the latest (ADR-0149 §4).
      self.send(.grant(canSpeak: allowed, foreground: self.foreground && UIApplication.shared.applicationState == .active))
    }
  }

  nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
    let identities = participants.compactMap { $0.identity?.stringValue }
    Task { @MainActor in
      guard self.room === room else { return }
      let speakers = calabRoomSpeakers(identities, local: room.localParticipant.identity?.stringValue)
      guard self.state?.speakers != speakers else { return }
      self.state?.speakers = speakers; self.refresh()
    }
  }
}
#endif
