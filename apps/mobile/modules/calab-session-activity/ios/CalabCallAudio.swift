import Foundation

// A system mute must take effect even before the shared document is responsive.
// Its late unmuted controls cannot undo that intent. Once web acknowledges mute,
// its ordinary controls own the state again; an explicit unmute also converges.
struct CalabCallMuteSafety {
  private var held = Set<UUID>()
  private var confirmed = Set<UUID>()
  func blocks(_ id: UUID) -> Bool { held.contains(id) }
  mutating func mute(_ id: UUID) { held.insert(id); confirmed.remove(id) }
  mutating func confirm(_ id: UUID, webMuted: Bool) {
    guard held.contains(id) else { return }
    confirmed.insert(id)
    acknowledge(id, muted: webMuted)
  }
  @discardableResult mutating func acknowledge(_ id: UUID, muted: Bool) -> Bool {
    guard muted, confirmed.contains(id), held.contains(id) else { return false }
    release(id); return true
  }
  mutating func release(_ id: UUID) { held.remove(id); confirmed.remove(id) }
}

// Once remote audio arrived, later controls/activation cannot replay startup audio.
struct CalabCallProgressState {
  private var waiting = false
  mutating func begin() { waiting = true }
  mutating func receivedAudio() { waiting = false }
  mutating func end() { waiting = false }
  func shouldPlay(active: Bool, deafened: Bool) -> Bool { waiting && active && !deafened }
}

func calabCallProgressWave() -> Data {
  // Quiet 160 ms pulse followed by silence. PCM WAV, no file/network dependency.
  let rate = 16000, frames = 32000, pulse = 2560
  var data = Data()
  func integer<T: FixedWidthInteger>(_ value: T) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }
  data.append(contentsOf: "RIFF".utf8); integer(UInt32(36 + frames * 2))
  data.append(contentsOf: "WAVEfmt ".utf8); integer(UInt32(16))
  integer(UInt16(1)); integer(UInt16(1)); integer(UInt32(rate))
  integer(UInt32(rate * 2)); integer(UInt16(2)); integer(UInt16(16))
  data.append(contentsOf: "data".utf8); integer(UInt32(frames * 2))
  for frame in 0..<frames {
    let envelope = frame < pulse ? min(1, Double(min(frame, pulse - 1 - frame)) / 160) : 0
    integer(Int16(1800 * envelope * sin(2 * .pi * 440 * Double(frame) / Double(rate))))
  }
  return data
}

func calabCallAudioBitrate(_ value: Any?) -> Int? {
  // Expo's JSI dictionaries contain Double for JS numbers. Do not truncate a
  // fractional input or relax the shared protocol's integer/range validation.
  let bitrate = (value as? Int) ?? (value as? Double).flatMap(Int.init(exactly:))
  guard let bitrate, (8000...64000).contains(bitrate) else { return nil }
  return bitrate
}

#if canImport(LiveKitClient)
import LiveKitClient
#elseif canImport(LiveKit)
import LiveKit
#endif
#if canImport(LiveKitClient) || canImport(LiveKit)
import AVFAudio
import UIKit

/** One audio transport; the shared web call service retains auth and REST ownership. */
@MainActor
final class CalabCallAudio: NSObject, RoomDelegate {
  var changed: (() -> Void)?
  var failed: ((UUID) -> Void)?
  var authorized: ((String, UUID) -> Bool)?
  var active: (() -> Bool)?
  var systemMuted: ((UUID) -> Bool)?
  var acknowledgeMute: ((UUID, Bool) -> Void)?
  private var progress = CalabCallProgressState()
  private var progressPlayer: AVAudioPlayer?
  private var progressDeadline: Task<Void, Never>?
  private static let progressWave = calabCallProgressWave()
  private var room: Room?
  private var document: String?
  private var event: UUID?
  private var connection: String?
  private var revision = 0
  private var controls: [String: Any] = [:]
  private var mic: LocalAudioTrack?
  private var controlTask: Task<Void, Never>?
  private var connectTask: Task<Void, Never>?
  private var publicationTask: Task<Void, Error>?
  private var drainTask: Task<Void, Never>?
  private var failureDeadline: Task<Void, Never>?
  private var phase = "ended"
  private var microphoneReady = false
  private var canSpeak = false
  private var speakers: [String] = []
  private var error: String?
  var eventID: UUID? { event }
  var webMuted: Bool { controls["muted"] as? Bool == true }
  var ready: Bool { phase == "connected" && (!canSpeak || microphoneReady) }
  func snapshot(for doc: String) -> [String: Any]? {
    // Reload/logout must not expose a previous document's media state to a new
    // page, including an older web client which does not understand this field.
    guard document == doc, let event, let connection else { return nil }
    var state: [String: Any] = ["eventId": event.uuidString.lowercased(), "connectionId": connection,
      "phase": phase, "microphoneReady": microphoneReady, "muted": effectiveMute,
      "canSpeak": canSpeak, "speakers": speakers]
    if let error { state["error"] = error }
    return state
  }
  private var effectiveMute: Bool { event.map { systemMuted?($0) == true } == true || !canSpeak || controls["muted"] as? Bool == true || controls["deafened"] as? Bool == true }
  func refreshControls() { applyControls() }
  private func current(_ rev: Int, _ expected: Room) -> Bool {
    revision == rev && room === expected && document.map { doc in event.map { authorized?(doc, $0) == true } ?? false } == true
  }
  func prepare() throws {
    // SDK diagnostics can contain the signaling URL/JWT or SDP; expose only our
    // fixed error codes through the host's existing bounded call diagnostics.
    LiveKitSDK.disableLogging()
    AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
    try AudioManager.shared.setEngineAvailability(.none)
  }
  func activate(_ on: Bool) {
    do { try AudioManager.shared.setEngineAvailability(on && room != nil && controls["deafened"] as? Bool != true ? .default : .none) }
    catch { if let event { fail(event, "audio") } }
    updateProgress(active: on && room != nil)
  }
  private func updateProgress(active: Bool) {
    guard progress.shouldPlay(active: active, deafened: controls["deafened"] as? Bool == true) else {
      progressPlayer?.stop(); progressPlayer = nil; return
    }
    let volume = Float(max(0, min(1, controls["volume"] as? Double ?? 1)))
    if let progressPlayer { progressPlayer.volume = volume; return }
    // CallKit already owns this audio session. This player never activates it
    // or captures/publishes audio; failure of an optional cue cannot fail a call.
    guard let player = try? AVAudioPlayer(data: Self.progressWave) else { return }
    player.volume = volume; player.numberOfLoops = -1
    if player.play() { progressPlayer = player }
  }
  private func finishProgress() {
    progress.end(); progressPlayer?.stop(); progressPlayer = nil
    progressDeadline?.cancel(); progressDeadline = nil
  }
  func connect(document doc: String, input: [String: Any]) async {
    guard let raw = input["eventId"] as? String, let id = UUID(uuidString: raw), authorized?(doc,id) == true,
      let next = input["connectionId"] as? String, UUID(uuidString: next) != nil,
      let roomID = input["roomId"] as? String, UUID(uuidString: roomID) != nil,
      let url = input["url"] as? String, url.count <= 1024, let endpoint = URLComponents(string: url),
      endpoint.scheme == "wss", endpoint.host?.isEmpty == false, endpoint.user == nil, endpoint.password == nil, endpoint.fragment == nil,
      let token = input["token"] as? String, !token.isEmpty, token.count <= 4096,
      let bitrate = calabCallAudioBitrate(input["bitrate"]),
      let initial = input["controls"] as? [String: Any] else { return }
    if event == id && connection == next { return }
    stop()
    document = doc; event = id; connection = next; controls = initial; error = nil
    canSpeak = input["canSpeak"] as? Bool == true; microphoneReady = false; phase = "connecting"
    progress.begin()
    let rev = revision
    progressDeadline = Task { @MainActor in
      do { try await Task.sleep(for: .seconds(10)) } catch { return }
      if self.revision == rev { self.finishProgress() }
    }
    let previous = drainTask
    failureDeadline = Task { @MainActor in
      do { try await Task.sleep(for: .seconds(15)) } catch { return }
      if self.revision == rev { self.fail(id,"connection") }
    }
    changed?()
    let task = Task { @MainActor in
      // Never enable the global engine while an old publication is still unwinding.
      await previous?.value
      guard self.revision == rev, self.authorized?(doc,id) == true, !Task.isCancelled else { return }
      let expected = Room(delegate: self, roomOptions: RoomOptions(
        defaultAudioCaptureOptions: AudioCaptureOptions(echoCancellation: true, autoGainControl: true, noiseSuppression: true),
        defaultAudioPublishOptions: AudioPublishOptions(encoding: AudioEncoding(maxBitrate: bitrate), dtx: true, red: true)))
      self.room = expected
      await self.runConnect(expected, rev: rev, id: id, url: url, token: token, relayOnly: input["relayOnly"] as? Bool == true)
    }
    connectTask = task
    await task.value
    if revision == rev { connectTask = nil }
  }
  private func runConnect(_ expected: Room, rev: Int, id: UUID, url: String, token: String, relayOnly: Bool) async {
    do {
      // A permission request cannot be presented on the lock screen. Never retry a denial.
      if canSpeak && AVAudioSession.sharedInstance().recordPermission != .granted {
        guard AVAudioSession.sharedInstance().recordPermission == .undetermined,
          UIApplication.shared.applicationState == .active else { fail(id,"permission"); return }
        let granted = await withCheckedContinuation { continuation in
          AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard current(rev,expected) else { return }
        guard granted else { fail(id,"permission"); return }
      }
      // CallKit acceptance and didActivate may arrive in either order. This wait is bounded
      // by the existing native answer deadline; it never acquires/activates an audio session.
      for _ in 0..<200 {
        guard current(rev,expected) else { return }
        if active?() == true { break }
        try await Task.sleep(for: .milliseconds(50))
      }
      guard current(rev,expected) else { return }
      guard active?() == true else { fail(id,"audio"); return }
      try AudioManager.shared.setEngineAvailability(controls["deafened"] as? Bool == true ? .none : .default)
      AudioManager.shared.isMicrophoneMuted = effectiveMute
      updateProgress(active: true)
      try await expected.connect(url: url, token: token, connectOptions: ConnectOptions(
        autoSubscribe: false, reconnectAttempts: 3, iceTransportPolicy: relayOnly ? .relay : .all))
      guard current(rev,expected) else { await expected.disconnect(); return }
      canSpeak = canSpeak && microphoneAllowed(expected.localParticipant.permissions)
      // Receiving and publishing use independent RTC transports. Do not hold
      // the caller's already-published audio behind our microphone publication.
      for participant in expected.remoteParticipants.values {
        for publication in participant.trackPublications.values {
          if let publication = publication as? RemoteTrackPublication { subscribe(publication, in: expected, revision: rev) }
        }
      }
      if canSpeak {
        try await publishMicrophone(expected, revision: rev)
      }
      guard current(rev,expected) else { return }
      phase = "connected"
      failureDeadline?.cancel(); failureDeadline = nil
      applyControls()
      changed?()
    } catch {
      if current(rev,expected) { fail(id,"connection") }
      else { await expected.disconnect() }
    }
  }
  private func publishMicrophone(_ expected: Room, revision rev: Int) async throws {
    if let publicationTask { return try await publicationTask.value }
    if microphoneReady { return }
    // A later server grant must not cause a background permission prompt.
    guard AVAudioSession.sharedInstance().recordPermission == .granted else {
      if current(rev,expected), let event { fail(event,"permission") }
      throw CancellationError()
    }
    // A local progress cue must never feed back through a newly opened mic.
    // Stop before creating/starting capture, even if remote audio is still pending.
    finishProgress()
    let task = Task { @MainActor in
      let track = await LocalAudioTrack.createTrack(options: AudioCaptureOptions(
        echoCancellation: true, autoGainControl: true, noiseSuppression: true))
      guard self.current(rev,expected) else { try? await track.stop(); return }
      self.mic = track
      // Apply mute before publication, not after the first outgoing packet.
      if self.effectiveMute { try await track.mute() }
      guard self.current(rev,expected) else { try? await track.stop(); return }
      _ = try await expected.localParticipant.publish(audioTrack: track)
      guard self.current(rev,expected) else { try? await track.stop(); await expected.disconnect(); return }
      self.microphoneReady = true
    }
    publicationTask = task
    defer { if revision == rev { publicationTask = nil } }
    try await task.value
  }
  func control(_ doc: String, _ input: [String: Any]) {
    guard document == doc, input["connectionId"] as? String == connection,
      input["eventId"] as? String == event?.uuidString.lowercased(),
      let value = input["controls"] as? [String: Any] else { return }
    controls = value
    if let event { acknowledgeMute?(event, value["muted"] as? Bool == true) }
    applyControls()
  }
  func disconnect(_ doc: String, _ input: [String: Any]) {
    guard document == doc, input["connectionId"] as? String == connection,
      input["eventId"] as? String == event?.uuidString.lowercased() else { return }
    stop(); changed?()
  }
  func stop() {
    finishProgress()
    revision += 1
    failureDeadline?.cancel(); failureDeadline = nil
    let oldControl = controlTask; oldControl?.cancel(); controlTask = nil
    let oldConnect = connectTask; oldConnect?.cancel(); connectTask = nil
    let oldPublication = publicationTask; oldPublication?.cancel(); publicationTask = nil
    let previous = drainTask
    let old = room; let oldMic = mic
    room = nil; mic = nil
    phase = "ended"; microphoneReady = false; speakers = []
    // Synchronous capture/playout boundary, including while an SDK await is pending.
    AudioManager.shared.isMicrophoneMuted = true
    try? AudioManager.shared.setEngineAvailability(.none)
    drainTask = Task { @MainActor in
      await previous?.value
      await oldControl?.value
      await oldConnect?.value
      _ = try? await oldPublication?.value
      try? await oldMic?.stop()
      await old?.disconnect()
    }
  }
  private func fail(_ id: UUID, _ reason: String) {
    stop(); phase = "failed"; error = reason; changed?(); failed?(id)
  }
  private func subscribe(_ publication: RemoteTrackPublication, in expected: Room, revision rev: Int) {
    guard publication.kind == .audio else { return }
    Task { @MainActor in
      guard self.current(rev,expected) else { return }
      try? await publication.set(subscribed: true)
      guard self.current(rev,expected) else { return }
      self.applyOutput()
    }
  }
  private func microphoneAllowed(_ permissions: ParticipantPermissions) -> Bool {
    permissions.canPublish && (permissions.canPublishSources.isEmpty || permissions.canPublishSources.contains(Track.Source.microphone.rawValue))
  }
  private func applyOutput() {
    let volume = max(0,min(1,controls["volume"] as? Double ?? 1))
    let levels = controls["userVolumes"] as? [String: Double] ?? [:]
    for participant in room?.remoteParticipants.values ?? Dictionary<Participant.Identity,RemoteParticipant>().values {
      let uid = participant.identity?.stringValue.split(separator: ":").first.map(String.init) ?? ""
      for publication in participant.trackPublications.values {
        if let track = publication.track as? RemoteAudioTrack {
          track.volume = controls["deafened"] as? Bool == true ? 0 : max(0,min(1,levels[uid] ?? volume))
        }
      }
    }
  }
  private func applyControls() {
    applyOutput()
    AudioManager.shared.isMicrophoneMuted = effectiveMute
    activate(active?() == true)
    guard controlTask == nil, let mic, let expected = room else { changed?(); return }
    let rev = revision
    controlTask = Task { @MainActor in
      defer { if self.revision == rev { self.controlTask = nil } }
      do {
        while self.current(rev,expected) && mic.isMuted != self.effectiveMute {
          if self.effectiveMute { try await mic.mute() } else { try await mic.unmute() }
        }
        if self.current(rev,expected) { AudioManager.shared.isMicrophoneMuted = self.effectiveMute; self.changed?() }
      } catch { if self.current(rev,expected), let id = self.event { self.fail(id,"audio") } }
    }
  }
  nonisolated func room(_ room: Room, didUpdateConnectionState state: ConnectionState, from oldState: ConnectionState) {
    Task { @MainActor in
      guard self.room === room else { return }
      if state == .reconnecting { self.phase = "reconnecting"; self.changed?() }
      if state == .connected && self.phase == "reconnecting" { self.phase = "connected"; self.applyControls(); self.changed?() }

    }
  }
  nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
    Task { @MainActor in
      guard self.room === room, let id = self.event else { return }
      let reason: String
      switch error?.type {
      case .participantRemoved: reason = "removed"
      case .duplicateIdentity: reason = "duplicate"
      case .roomDeleted: reason = "closed"
      default: reason = "network"
      }
      self.stop()
      self.phase = "failed"; self.error = reason; self.changed?()
      // The shared service decides takeover/rejoin with the same rules as web calls.
      // A stalled WebView cannot leave the system call UI up indefinitely.
      let rev = self.revision
      self.failureDeadline = Task { @MainActor in
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
        if self.revision == rev { self.failed?(id) }
      }
    }
  }
  nonisolated func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
    Task { @MainActor in guard self.room === room else { return }; self.subscribe(publication,in:room,revision:self.revision) }
  }
  nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
    Task { @MainActor in
      guard self.room === room else { return }
      if publication.kind == .audio {
        self.progress.receivedAudio(); self.finishProgress()
      }
      self.applyOutput()
    }
  }
  nonisolated func room(_ room: Room, participant: Participant, didUpdatePermissions permissions: ParticipantPermissions) {
    Task { @MainActor in
      guard self.room === room, participant === room.localParticipant else { return }
      self.canSpeak = self.microphoneAllowed(permissions)
      self.applyControls()
      if self.canSpeak && !self.microphoneReady && self.phase == "connected" {
        let rev = self.revision
        do {
          try await self.publishMicrophone(room, revision: rev)
          if self.current(rev,room) { self.applyControls() }
        } catch { if self.current(rev,room), let id = self.event { self.fail(id,"audio") } }
      }
    }
  }
  nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
    let ids = participants.compactMap { $0.identity?.stringValue.split(separator: ":").first.map(String.init) }.filter { UUID(uuidString:$0) != nil }
    Task { @MainActor in guard self.room === room else { return }; if self.speakers != ids { self.speakers = Array(ids.prefix(64)); self.changed?() } }
  }
}
#endif
