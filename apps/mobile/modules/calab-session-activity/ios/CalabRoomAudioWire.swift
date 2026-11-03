import Foundation

// The room audio bridge (ADR-0149), mirror of apps/desktop/src/shared/hostRoomAudio.ts. JS validates
// first; native validates again because it holds the credentials. Both run the fixtures in
// hostRoomAudio.fixtures.ts (src/roomAudioWire.test.ts). A rule changed here changes there.

// A defensive ceiling above the limit, not the limit: TS enforces the exact 8192 bytes of the whole
// message. This sees the operation without its envelope, and re-serialized JSON grows on floats.
private let calabRoomAudioMaxBytes = 16384
private let calabRoomAudioMaxURL = 1024
private let calabRoomAudioMaxToken = 4096
private let calabRoomAudioMaxUsers = 64
private let calabRoomAudioMaxWatched = 4
private let calabRoomAudioMaxLevel = 20
private let calabRoomAudioMinThresholdDb = -80.0

private let calabRoomAudioCues: Set<String> = [
  "join", "leave", "mute", "unmute", "deafen", "undeafen", "pttOn", "pttOff", "mention", "message",
  "streamStart", "streamEnd", "watchStart", "watchStop", "moved", "disconnect", "reconnect", "recStart", "recStop",
  "builtin:air_horn", "builtin:ba_dum_tss", "builtin:cricket", "builtin:golf_clap", "builtin:quack", "builtin:sad_horn",
]

struct CalabRoomAudioGate: Equatable {
  enum Mode: String { case voice, ptt, open }
  let mode: Mode
  let thresholdDb: Double
  let pttOpen: Bool
}

struct CalabRoomAudioControls: Equatable {
  let muted: Bool
  let deafened: Bool
  let volume: Double
  let userVolumes: [String: Double]
  let bitrate: Int
  let gate: CalabRoomAudioGate
  let watched: [String: Double]
  let levels: Bool
}

struct CalabRoomAudioConnect: Equatable {
  let connectionId: String
  let roomId: String
  let url: String
  let token: String
  let relayOnly: Bool
  let red: Bool
  let canSpeak: Bool
  let controls: CalabRoomAudioControls
}

// The URL and the token never reach a log line, however this value is printed.
extension CalabRoomAudioConnect: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  var description: String { "CalabRoomAudioConnect(connectionId: \(connectionId), roomId: \(roomId), url: <redacted>, token: <redacted>)" }
  var debugDescription: String { description }
  var customMirror: Mirror { Mirror(self, children: ["connectionId": connectionId, "roomId": roomId]) }
}

enum CalabRoomAudioOperation: Equatable {
  case status
  case connect(CalabRoomAudioConnect)
  case control(connectionId: String, controls: CalabRoomAudioControls)
  case cue(connectionId: String, name: String, volume: Double)
  case disconnect(connectionId: String)
}

/** One latest snapshot for the page. Carries no URL, token, SDP or device name. */
struct CalabRoomAudioState {
  enum Phase: String, CaseIterable { case connecting, connected, reconnecting, lost, interrupted, ended, failed }
  enum MuteOrigin: String, CaseIterable { case web, system, server, native }
  enum Route: String, CaseIterable { case speaker, receiver, wired, bluetooth, other }
  enum Failure: String, CaseIterable { case permission, connection, audio, superseded, removed, duplicate, closed, network }
  var connectionId: String
  var phase = Phase.connecting
  var microphoneReady = false
  var muteOrigin: MuteOrigin? // muted exactly while set
  var canSpeak = false
  var speaking = false
  var speakers: [String] = []
  var route = Route.other
  var phoneCall = false
  var error: Failure?
  var level: Int?

  var wire: [String: Any] {
    var value: [String: Any] = [
      "connectionId": connectionId, "phase": phase.rawValue, "microphoneReady": microphoneReady,
      "muted": muteOrigin != nil, "canSpeak": canSpeak, "speaking": speaking,
      "speakers": Array(speakers.filter(calabRoomAudioUUID).prefix(calabRoomAudioMaxUsers)),
      "route": route.rawValue, "phoneCall": phoneCall,
    ]
    if let muteOrigin { value["muteOrigin"] = muteOrigin.rawValue }
    if let error { value["error"] = error.rawValue }
    if let level { value["level"] = min(max(level, 0), calabRoomAudioMaxLevel) }
    return value
  }
}

// Expo hydrates JS booleans and numbers as Swift Bool and Double, and a dynamic cast would turn
// NSNumber 1 into true: the exact type decides, as it does for the shared parser.
private func calabRoomBool(_ value: Any?) -> Bool? {
  guard let value else { return nil }
  if let flag = value as? Bool, type(of: value) == Bool.self { return flag }
  #if canImport(Darwin)
  if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
  #endif
  return nil
}

private func calabRoomNumber(_ value: Any?) -> Double? {
  guard let value else { return nil }
  var number: Double?
  if type(of: value) == Double.self { number = value as? Double }
  else if type(of: value) == Int.self { number = (value as? Int).map(Double.init) }
  #if canImport(Darwin)
  if number == nil, let bridged = value as? NSNumber, CFGetTypeID(bridged) != CFBooleanGetTypeID() { number = bridged.doubleValue }
  #endif
  return number.flatMap { $0.isFinite ? $0 : nil }
}

private func calabRoomMatch(_ pattern: NSRegularExpression, _ text: String) -> NSTextCheckingResult? {
  // The whole range, not ^$: ICU's $ also matches before a final newline, JavaScript's does not.
  let range = NSRange(text.startIndex..., in: text)
  guard let match = pattern.firstMatch(in: text, options: [], range: range), match.range == range else { return nil }
  return match
}

private let calabRoomUUID = try! NSRegularExpression(pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
private let calabRoomURL = try! NSRegularExpression(pattern: "^wss://[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::([0-9]{1,5}))?(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._~-]*)*$")
private let calabRoomJWT = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")

func calabRoomAudioUUID(_ value: String) -> Bool {
  calabRoomMatch(calabRoomUUID, value) != nil && value != "00000000-0000-0000-0000-000000000000"
}

private func calabRoomId(_ value: Any?) -> String? {
  guard let id = value as? String, calabRoomAudioUUID(id) else { return nil }
  return id
}

private func calabRoomWebSocket(_ value: Any?) -> String? {
  guard let url = value as? String, url.utf8.count <= calabRoomAudioMaxURL, let match = calabRoomMatch(calabRoomURL, url) else { return nil }
  guard let range = Range(match.range(at: 1), in: url) else { return url } // no port
  guard let port = Int(url[range]), (1...65535).contains(port) else { return nil }
  return url
}

private func calabRoomToken(_ value: Any?) -> String? {
  guard let token = value as? String, token.utf8.count <= calabRoomAudioMaxToken, calabRoomMatch(calabRoomJWT, token) != nil else { return nil }
  return token
}

private func calabRoomVolume(_ value: Any?) -> Double? {
  guard let volume = calabRoomNumber(value), (0...1).contains(volume) else { return nil }
  return volume
}

private func calabRoomVolumes(_ value: Any?, limit: Int) -> [String: Double]? {
  guard let input = value as? [String: Any], input.count <= limit else { return nil }
  var volumes: [String: Double] = [:]
  for (id, level) in input {
    guard calabRoomAudioUUID(id), let level = calabRoomVolume(level) else { return nil }
    volumes[id] = level
  }
  return volumes
}

private func calabRoomGate(_ value: Any?) -> CalabRoomAudioGate? {
  guard let input = value as? [String: Any], Set(input.keys) == ["mode", "thresholdDb", "pttOpen"],
        let mode = (input["mode"] as? String).flatMap(CalabRoomAudioGate.Mode.init(rawValue:)),
        let thresholdDb = calabRoomNumber(input["thresholdDb"]), (calabRoomAudioMinThresholdDb...0).contains(thresholdDb),
        let pttOpen = calabRoomBool(input["pttOpen"]) else { return nil }
  return CalabRoomAudioGate(mode: mode, thresholdDb: thresholdDb, pttOpen: pttOpen)
}

private func calabRoomControls(_ value: Any?) -> CalabRoomAudioControls? {
  guard let input = value as? [String: Any],
        Set(input.keys) == ["muted", "deafened", "volume", "userVolumes", "bitrate", "gate", "watched", "levels"],
        let muted = calabRoomBool(input["muted"]), let deafened = calabRoomBool(input["deafened"]),
        let volume = calabRoomVolume(input["volume"]), let levels = calabRoomBool(input["levels"]),
        let bitrate = calabRoomNumber(input["bitrate"]).flatMap(Int.init(exactly:)), (8000...64000).contains(bitrate),
        let gate = calabRoomGate(input["gate"]),
        let userVolumes = calabRoomVolumes(input["userVolumes"], limit: calabRoomAudioMaxUsers),
        let watched = calabRoomVolumes(input["watched"], limit: calabRoomAudioMaxWatched) else { return nil }
  return CalabRoomAudioControls(muted: muted, deafened: deafened, volume: volume, userVolumes: userVolumes,
                                bitrate: bitrate, gate: gate, watched: watched, levels: levels)
}

/** Takes the hydrated Expo dictionary: the operation alone, the JS side has dropped the envelope. */
func calabRoomAudioOperation(_ input: [String: Any]) -> CalabRoomAudioOperation? {
  guard JSONSerialization.isValidJSONObject(input),
        let bytes = try? JSONSerialization.data(withJSONObject: input, options: .withoutEscapingSlashes),
        bytes.count <= calabRoomAudioMaxBytes, let operation = input["operation"] as? String else { return nil }
  let fields = Set(input.keys)
  if operation == "status" { return fields == ["operation"] ? .status : nil }
  guard let connectionId = calabRoomId(input["connectionId"]) else { return nil }
  switch operation {
  case "disconnect":
    return fields == ["operation", "connectionId"] ? .disconnect(connectionId: connectionId) : nil
  case "cue":
    guard fields == ["operation", "connectionId", "cue", "volume"], let name = input["cue"] as? String, calabRoomAudioCues.contains(name),
          let volume = calabRoomVolume(input["volume"]) else { return nil }
    return .cue(connectionId: connectionId, name: name, volume: volume)
  case "control":
    guard fields == ["operation", "connectionId", "controls"], let controls = calabRoomControls(input["controls"]) else { return nil }
    return .control(connectionId: connectionId, controls: controls)
  case "connect":
    guard fields == ["operation", "connectionId", "roomId", "url", "token", "relayOnly", "red", "canSpeak", "controls"],
          let roomId = calabRoomId(input["roomId"]), let url = calabRoomWebSocket(input["url"]),
          let token = calabRoomToken(input["token"]), let relayOnly = calabRoomBool(input["relayOnly"]),
          let red = calabRoomBool(input["red"]), let canSpeak = calabRoomBool(input["canSpeak"]),
          let controls = calabRoomControls(input["controls"]) else { return nil }
    return .connect(CalabRoomAudioConnect(connectionId: connectionId, roomId: roomId, url: url, token: token, relayOnly: relayOnly,
                                          red: red, canSpeak: canSpeak, controls: controls))
  default:
    return nil
  }
}
