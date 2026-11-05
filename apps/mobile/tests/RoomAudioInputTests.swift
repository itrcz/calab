import Foundation

let doc = "11111111-1111-4111-8111-111111111111"
let first = "22222222-2222-4222-8222-222222222222"
let second = "33333333-3333-4333-8333-333333333333"
let alice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
let session = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

func controls(muted: Bool = false, deafened: Bool = false, volume: Double = 0.8, users: [String: Double] = [:], watched: [String: Double] = [:]) -> CalabRoomAudioControls {
  CalabRoomAudioControls(muted: muted, deafened: deafened, volume: volume, userVolumes: users, bitrate: 32000,
                         gate: CalabRoomAudioGate(mode: .voice, thresholdDb: -50, pttOpen: false), watched: watched, levels: false)
}

@main
struct RoomAudioInputTests {
  static func main() {
    hosts()
    print("PASS: connect reaches only the build's rtc hosts")
    identities()
    print("PASS: microphones and watched screen-share audio only, never the web companion")
    convergence()
    print("PASS: complete controls converge, deafen unsubscribes, the system mute holds")
    generations()
    print("PASS: stale documents and connections change nothing")
    pacing()
    print("PASS: operations are rate-limited and state is paced to one latest snapshot")
    watchdog()
    print("PASS: the capture watchdog restarts once per silence, never on a dead meter path")
    precondition(calabRoomAudioCueResource("builtin:quack") == "calab-room-builtin-quack")
    precondition(calabRoomAudioCueResource("pttOn") == "calab-room-pttOn" && calabRoomAudioCueResource("../x") == nil)
    print("PASS: cues resolve to bundled files by name only")
  }

  static func hosts() {
    let allowed = calabRoomAudioHosts(["rtc.calab.ru", "RTC2.calab.ru", "10.0.0.1", "rtc", "*.calab.ru", 7, "rtc.calab.ru:443"])
    precondition(allowed == ["rtc.calab.ru"], "malformed hosts admitted: \(allowed)")
    precondition(calabRoomAudioHosts(nil).isEmpty && calabRoomAudioHosts("rtc.calab.ru").isEmpty && calabRoomAudioHosts([String]()).isEmpty)
    precondition(calabRoomAudioEndpoint("wss://rtc.calab.ru", hosts: allowed)?.absoluteString == "wss://rtc.calab.ru")
    precondition(calabRoomAudioEndpoint("wss://RTC.calab.ru:7880/rtc", hosts: allowed) != nil, "case or port refused")
    for url in ["wss://rtc.calab.ru.evil.test", "wss://evil.test", "wss://10.0.0.1", "wss://rtc", "ws://rtc.calab.ru",
                "https://rtc.calab.ru", "wss://user@rtc.calab.ru", "wss://rtc.calab.ru/?x=1", "wss://rtc.calab.ru/#x", "rtc.calab.ru", ""] {
      precondition(calabRoomAudioEndpoint(url, hosts: allowed) == nil, "\(url) admitted")
    }
    // A missing or empty list admits nothing: it never means "any host".
    precondition(calabRoomAudioEndpoint("wss://rtc.calab.ru", hosts: []) == nil)
    // What the shared parser accepts is still pinned here: a single label or an IP passes the parser only.
    var input: [String: Any] = ["operation": "connect", "connectionId": first, "roomId": second, "url": "wss://10.0.0.1",
      "token": "a.b.c", "relayOnly": false, "red": true, "canSpeak": true,
      "controls": ["muted": false, "deafened": false, "volume": 1.0, "userVolumes": [String: Any](), "bitrate": 32000.0,
                   "gate": ["mode": "voice", "thresholdDb": -50.0, "pttOpen": false] as [String: Any],
                   "watched": [String: Any](), "levels": false] as [String: Any]]
    guard case .connect(let ip)? = calabRoomAudioOperation(input) else { fatalError("fixture rejected") }
    precondition(calabRoomAudioEndpoint(ip.url, hosts: allowed) == nil)
    input["url"] = "wss://rtc.calab.ru"
    guard case .connect(let listed)? = calabRoomAudioOperation(input) else { fatalError("fixture rejected") }
    precondition(calabRoomAudioEndpoint(listed.url, hosts: allowed) != nil)
  }

  static func identities() {
    precondition(calabRoomUser("\(alice):\(session)") == alice)
    precondition(calabRoomUser("\(alice.uppercased()):\(session)") == alice, "user ids not normalized")
    for identity in ["\(alice):\(session):web", "sip_79990001122", alice, "\(alice):x", ""] {
      precondition(calabRoomUser(identity) == nil, "\(identity) taken for a user")
    }
    precondition(calabRoomCompanion("\(alice):\(session):web") && !calabRoomCompanion("\(alice):\(session)"))
    let value = controls(users: [alice: 0.3], watched: [bob: 0.6])
    precondition(calabRoomTrackVolume(identity: "\(alice):\(session)", source: .microphone, controls: value) == 0.3)
    precondition(calabRoomTrackVolume(identity: "\(bob):\(session)", source: .microphone, controls: value) == 0.8, "master volume not the default")
    // A SIP line or another non-user voice is still heard at the master volume.
    precondition(calabRoomTrackVolume(identity: "sip_79990001122", source: .microphone, controls: value) == 0.8)
    precondition(calabRoomTrackVolume(identity: "\(alice):\(session):web", source: .microphone, controls: value) == nil, "companion subscribed")
    precondition(calabRoomTrackVolume(identity: "\(bob):\(session)", source: .screenShareAudio, controls: value) == 0.6)
    precondition(calabRoomTrackVolume(identity: "\(alice):\(session)", source: .screenShareAudio, controls: value) == nil, "unwatched stream subscribed")
    precondition(calabRoomTrackVolume(identity: "\(bob):\(session)", source: .other, controls: value) == nil)
    precondition(calabRoomTrackVolume(identity: "\(bob):\(session)", source: .microphone, controls: controls(volume: 3)) == 1, "volume above 1")
    let speakers = calabRoomSpeakers(["\(alice):\(session)", "\(alice):\(second)", "\(bob):\(session):web", "sip_1", "\(bob):\(session)", "\(bob):\(first)"],
                                     local: "\(bob):\(session)")
    precondition(speakers == [alice, bob], "speakers \(speakers)")
    let crowd = (0..<80).map { String(format: "%08x-0000-4000-8000-000000000000:\(session)", $0 + 1) }
    precondition(calabRoomSpeakers(crowd, local: nil).count == 64)
  }

  static func convergence() {
    // Each control is complete: nothing from an earlier one survives.
    let identity = "\(alice):\(session)"
    var applied = controls(users: [alice: 0.2], watched: [alice: 0.5])
    applied = controls()
    precondition(calabRoomTrackVolume(identity: identity, source: .microphone, controls: applied) == 0.8)
    precondition(calabRoomTrackVolume(identity: identity, source: .screenShareAudio, controls: applied) == nil)
    let deaf = controls(deafened: true, users: [alice: 1], watched: [alice: 1])
    precondition(calabRoomTrackVolume(identity: identity, source: .microphone, controls: deaf) == nil, "deafened still subscribed")
    precondition(calabRoomTrackVolume(identity: identity, source: .screenShareAudio, controls: deaf) == nil)
    precondition(calabRoomMuteOrigin(webMuted: false, deafened: false, canSpeak: true, system: false) == nil)
    precondition(calabRoomMuteOrigin(webMuted: false, deafened: true, canSpeak: true, system: false) == .web, "deafen left the microphone open")
    precondition(calabRoomMuteOrigin(webMuted: false, deafened: false, canSpeak: false, system: false) == .server)
    precondition(calabRoomMuteOrigin(webMuted: true, deafened: false, canSpeak: false, system: true) == .system)
    // After a phone call: late unmuted controls keep it muted, a muted one hands it back, then unmute works.
    var hold = CalabRoomMuteHold()
    hold.hold()
    for _ in 0..<3 { hold.acknowledge(webMuted: false); precondition(hold.held, "late page state reopened the microphone") }
    hold.acknowledge(webMuted: true)
    precondition(!hold.held)
    hold.acknowledge(webMuted: false)
    precondition(!hold.held)
  }

  static func generations() {
    var ticket = CalabRoomAudioTicket()
    let one = ticket.begin(document: doc, connection: first)
    precondition(ticket.owns(document: doc, connection: first) && ticket.current(one, document: doc))
    precondition(!ticket.owns(document: doc, connection: second) && !ticket.owns(document: second, connection: first))
    precondition(!ticket.current(one, document: second) && !ticket.current(one, document: nil), "another document passed")
    // A newer connect supersedes: the first connection's late callbacks are stale.
    let two = ticket.begin(document: doc, connection: second)
    precondition(!ticket.current(one, document: doc) && ticket.current(two, document: doc))
    precondition(!ticket.owns(document: doc, connection: first), "old connection still controls")
    // Disconnect keeps the id for the last snapshot but retires everything in flight.
    ticket.end()
    precondition(!ticket.current(two, document: doc) && ticket.owns(document: doc, connection: second))
    // A reload or logout forgets the document.
    ticket.forget()
    precondition(ticket.document == nil && !ticket.owns(document: doc, connection: second))
  }

  static func pacing() {
    var rate = CalabRoomAudioRate()
    precondition((0..<20).allSatisfy { _ in rate.allow(now: 0) } && !rate.allow(now: 0), "burst above 20")
    precondition(rate.allow(now: 0.1) && !rate.allow(now: 0.1), "refill not 10 per second")
    var connects = CalabRoomAudioRate()
    precondition((0..<4).allSatisfy { _ in connects.allow(now: 0, cost: CalabRoomAudioRate.connectCost) })
    precondition(!connects.allow(now: 0, cost: CalabRoomAudioRate.connectCost), "connect storm passed")
    precondition(connects.allow(now: 0.5, cost: CalabRoomAudioRate.connectCost))
    var pacer = CalabRoomAudioPacer()
    precondition(pacer.offer(now: 10) == .now)
    guard case let .after(wait) = pacer.offer(now: 10.03) else { fatalError("second state not delayed") }
    precondition(abs(wait - 0.07) < 1e-9)
    precondition(pacer.offer(now: 10.05) == .pending && pacer.offer(now: 10.06) == .pending, "states queued")
    pacer.fired(now: 10.1)
    if case .now = pacer.offer(now: 10.15) { fatalError("sent within 100 ms of the paced one") }
    var idle = CalabRoomAudioPacer()
    precondition(idle.offer(now: 1) == .now && idle.offer(now: 1.2) == .now)
  }

  static func watchdog() {
    var dog = CalabCaptureWatchdog()
    var frames = 0
    for second in stride(from: 0.0, to: 10, by: 0.1) { frames += 480; precondition(!dog.tick(now: second, frames: frames, expecting: true)) }
    var restarts = 0
    for second in stride(from: 10.0, to: 20, by: 0.1) where dog.tick(now: second, frames: frames, expecting: true) { restarts += 1; precondition(second >= 12.89, "restarted before 3 s without frames") }
    precondition(restarts == 1, "restarted \(restarts) times in one silence")
    frames += 480
    precondition(!dog.tick(now: 20, frames: frames, expecting: true))
    precondition((0..<40).contains { dog.tick(now: 20.1 + Double($0) * 0.1, frames: frames, expecting: true) }, "not re-armed after frames returned")
    // Muted, interrupted or unpublished capture expects no frames.
    var quiet = CalabCaptureWatchdog()
    precondition(!(0..<100).contains { quiet.tick(now: Double($0) * 0.1, frames: 480 * $0, expecting: false) })
    precondition(!quiet.tick(now: 10, frames: 48000, expecting: true) && !quiet.tick(now: 12, frames: 48000, expecting: true))
    precondition(quiet.tick(now: 13, frames: 48000, expecting: true), "silence after unmute not caught")
    // A delegate that never delivered (dead meter path) arms nothing: no restart on any unmuted silence,
    // also when the processor's counter starts above zero from an earlier connection.
    for baseline in [0, 96000] {
      var dead = CalabCaptureWatchdog()
      precondition(!(0..<600).contains { dead.tick(now: Double($0) * 0.1, frames: baseline, expecting: $0 % 200 > 20) }, "dead meter path restarted the engine")
    }
  }
}
