import Foundation

// Decodes the shared fixtures into the plain Swift types Expo hydrates, on every platform:
// JSONSerialization's NSNumber differs between Darwin and Linux Foundation.
enum WireValue: Decodable {
  case null, bool(Bool), number(Double), string(String), array([WireValue]), object([String: WireValue])
  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() { self = .null }
    else if let flag = try? value.decode(Bool.self) { self = .bool(flag) }
    else if let number = try? value.decode(Double.self) { self = .number(number) }
    else if let text = try? value.decode(String.self) { self = .string(text) }
    else if let list = try? value.decode([WireValue].self) { self = .array(list) }
    else { self = .object(try value.decode([String: WireValue].self)) }
  }
  var hydrated: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let flag): return flag
    case .number(let number): return number
    case .string(let text): return text
    case .array(let list): return list.map(\.hydrated)
    case .object(let fields): return fields.mapValues(\.hydrated)
    }
  }
}

func controls(_ value: CalabRoomAudioControls) -> [String: Any] {
  ["muted": value.muted, "deafened": value.deafened, "volume": value.volume, "userVolumes": value.userVolumes,
   "bitrate": value.bitrate, "gate": ["mode": value.gate.mode.rawValue, "thresholdDb": value.gate.thresholdDb, "pttOpen": value.gate.pttOpen],
   "watched": value.watched, "levels": value.levels]
}

// The fields each case parsed into, so the test sees more than an accept/reject bit.
func echo(_ operation: CalabRoomAudioOperation) -> [String: Any] {
  switch operation {
  case .status: return ["operation": "status"]
  case .disconnect(let id): return ["operation": "disconnect", "connectionId": id]
  case .cue(let id, let name, let volume): return ["operation": "cue", "connectionId": id, "cue": name, "volume": volume]
  case .control(let id, let value): return ["operation": "control", "connectionId": id, "controls": controls(value)]
  case .connect(let value):
    return ["operation": "connect", "connectionId": value.connectionId, "roomId": value.roomId, "url": value.url,
            "token": value.token, "relayOnly": value.relayOnly, "red": value.red,
            "canSpeak": value.canSpeak, "controls": controls(value.controls)]
  }
}

func nativeTypes() {
  let id = "11111111-1111-4111-8111-111111111111"
  let gate: [String: Any] = ["mode": "voice", "thresholdDb": -50.0, "pttOpen": false]
  func input(_ volume: Any = 1.0, muted: Any = false) -> [String: Any] {
    ["operation": "control", "connectionId": id,
     "controls": ["muted": muted, "deafened": false, "volume": volume, "userVolumes": [String: Any](), "bitrate": 32000.0,
                  "gate": gate, "watched": [String: Any](), "levels": false] as [String: Any]]
  }
  precondition(calabRoomAudioOperation(input()) != nil, "hydrated Bool and Double rejected")
  precondition(calabRoomAudioOperation(input(1)) != nil, "Int volume rejected")
  for volume: Any in [Double.nan, Double.infinity, -Double.infinity, true, "1"] {
    precondition(calabRoomAudioOperation(input(volume)) == nil, "invalid volume accepted")
  }
  for muted: Any in [0, 1, 1.0, "false"] {
    precondition(calabRoomAudioOperation(input(muted: muted)) == nil, "non-boolean mute accepted")
  }
  #if canImport(Darwin)
  precondition(calabRoomAudioOperation(input(NSNumber(value: 0.5), muted: NSNumber(value: true))) != nil, "bridged values rejected")
  precondition(calabRoomAudioOperation(input(NSNumber(value: true))) == nil, "bridged boolean volume accepted")
  precondition(calabRoomAudioOperation(input(muted: NSNumber(value: 1))) == nil, "bridged number mute accepted")
  #endif
}

func redaction() {
  let token = "secret-header.secret-payload.secret-signature", url = "wss://secret.example.test/rtc"
  var input = connectInput(token: token, url: url)
  input["operation"] = "connect"
  guard let operation = calabRoomAudioOperation(input), case .connect(let connect) = operation else {
    fatalError("connect rejected")
  }
  precondition(connect.token == token && connect.url == url, "parsed credentials changed")
  var dumped = ""
  dump(operation, to: &dumped)
  var mirrored = ""
  dump(connect, to: &mirrored)
  for text in ["\(connect)", "\(operation)", String(describing: connect), String(reflecting: connect),
               String(describing: operation), String(reflecting: operation), dumped, mirrored] {
    precondition(!text.contains("secret"), "connect printed a credential")
    precondition(text.contains("11111111-1111-4111-8111-111111111111"), "connect printed nothing useful")
  }
}

func connectInput(token: String, url: String) -> [String: Any] {
  let id = "11111111-1111-4111-8111-111111111111"
  let controls: [String: Any] = ["muted": false, "deafened": false, "volume": 1.0, "userVolumes": [String: Any](), "bitrate": 32000.0,
                                 "gate": ["mode": "open", "thresholdDb": -50.0, "pttOpen": false] as [String: Any],
                                 "watched": [String: Any](), "levels": false]
  return ["connectionId": id, "roomId": id, "url": url, "token": token, "relayOnly": false, "red": true, "canSpeak": true, "controls": controls]
}

let stateConnection = "11111111-1111-4111-8111-111111111111"

func samples() -> [[String: Any]] {
  let speaker = "22222222-2222-4222-8222-222222222222"
  var full = CalabRoomAudioState(connectionId: stateConnection)
  full.phase = .connected; full.microphoneReady = true; full.canSpeak = true; full.speaking = true
  full.speakers = [speaker]; full.route = .bluetooth; full.level = 20
  var muted = CalabRoomAudioState(connectionId: stateConnection)
  muted.phase = .interrupted; muted.muteOrigin = .system; muted.phoneCall = true
  var failed = CalabRoomAudioState(connectionId: stateConnection)
  failed.phase = .failed; failed.error = .audio; failed.level = 99
  var crowded = CalabRoomAudioState(connectionId: stateConnection)
  crowded.speakers = ["invalid"] + Array(repeating: speaker, count: 65)
  return [full, muted, failed, crowded].map(\.wire)
}

func state(_ change: (inout CalabRoomAudioState) -> Void) -> [String: Any] {
  var value = CalabRoomAudioState(connectionId: stateConnection)
  change(&value)
  return value.wire
}

@main
struct RoomAudioWireFixture {
  static func main() throws {
    nativeTypes()
    redaction()
    let fixtures = try JSONDecoder().decode([WireValue].self, from: FileHandle.standardInput.readDataToEndOfFile())
    let operations: [Any] = fixtures.map { fixture in
      guard let input = fixture.hydrated as? [String: Any], let operation = calabRoomAudioOperation(input) else { return NSNull() }
      return echo(operation)
    }
    let output = try JSONSerialization.data(withJSONObject: [
      "operations": operations, "samples": samples(),
      "phases": CalabRoomAudioState.Phase.allCases.map { value in state { $0.phase = value } },
      "routes": CalabRoomAudioState.Route.allCases.map { value in state { $0.route = value } },
      "origins": CalabRoomAudioState.MuteOrigin.allCases.map { value in state { $0.muteOrigin = value } },
      "errors": CalabRoomAudioState.Failure.allCases.map { value in state { $0.error = value } },
    ])
    print(String(decoding: output, as: UTF8.self))
  }
}
