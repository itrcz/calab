import Foundation

private func feed(_ gate: inout CalabVoiceGate, _ db: Double, frames: Int, ms: Double = 10) -> [Bool] {
  (0..<frames).map { _ in gate.push(db: db, frameMs: ms) }
}

@main
struct VoiceGateTests {
  static func main() {
    voice()
    print("PASS: voice opens after two frames above the threshold")
    hangover()
    print("PASS: 400 ms hangover keeps word endings and closes after it")
    ptt()
    print("PASS: push-to-talk follows the key and rings only with speech")
    open()
    print("PASS: open never gates and still rings on speech")
    meter()
    print("PASS: RMS, dB and 21 level steps match the web meter")
    // No references inside: copying or mutating the gate on the audio thread never allocates.
    precondition(_isPOD(CalabVoiceGate.self), "gate holds a reference")
    print("PASS: the gate is plain data")
  }

  static func voice() {
    var gate = CalabVoiceGate()
    gate.configure(mode: .voice, thresholdDb: -50, pttOpen: false)
    precondition(feed(&gate, -60, frames: 5) == Array(repeating: false, count: 5), "noise opened the gate")
    precondition(gate.push(db: -40, frameMs: 10) == false, "one frame opened the gate")
    precondition(gate.push(db: -40, frameMs: 10) == true && gate.speaking, "two frames kept it closed")
    // A single loud click between quiet frames never opens it.
    gate.reset()
    for _ in 0..<10 { _ = gate.push(db: -40, frameMs: 10); precondition(!gate.push(db: -70, frameMs: 10)) }
    // Exactly the threshold is not speech, as in vad.ts.
    gate.reset()
    precondition(feed(&gate, -50, frames: 4).allSatisfy { !$0 }, "the threshold itself counted as speech")
  }

  static func hangover() {
    var gate = CalabVoiceGate()
    gate.configure(mode: .voice, thresholdDb: -50, pttOpen: false)
    _ = feed(&gate, -30, frames: 2)
    let tail = feed(&gate, -70, frames: 40)
    precondition(tail.prefix(39).allSatisfy { $0 }, "closed before 400 ms")
    precondition(tail.last == false && !gate.speaking, "still open after 400 ms")
    // Speech inside the hangover restarts it.
    _ = feed(&gate, -30, frames: 2)
    _ = feed(&gate, -70, frames: 30)
    precondition(gate.push(db: -30, frameMs: 10))
    precondition(feed(&gate, -70, frames: 39).allSatisfy { $0 }, "a resumed word was cut")
    // 20 ms frames reach 400 ms in 20 of them.
    var web = CalabVoiceGate()
    web.configure(mode: .voice, thresholdDb: -50, pttOpen: false)
    _ = feed(&web, -30, frames: 2, ms: 20)
    precondition(feed(&web, -70, frames: 20, ms: 20).last == false, "hangover is not in milliseconds")
  }

  static func ptt() {
    var gate = CalabVoiceGate()
    gate.configure(mode: .ptt, thresholdDb: -50, pttOpen: false)
    precondition(feed(&gate, -20, frames: 5).allSatisfy { !$0 } && !gate.speaking, "released key sent speech")
    _ = feed(&gate, -70, frames: 40)
    gate.configure(mode: .ptt, thresholdDb: -50, pttOpen: true)
    precondition(gate.push(db: -70, frameMs: 10), "held key gated silence")
    precondition(!gate.speaking, "held key rang without speech")
    _ = feed(&gate, -20, frames: 2)
    precondition(gate.speaking)
    gate.configure(mode: .ptt, thresholdDb: -50, pttOpen: false)
    precondition(!gate.push(db: -20, frameMs: 10) && !gate.speaking, "release waited for a hangover")
    // Switching modes starts closed.
    gate.configure(mode: .voice, thresholdDb: -50, pttOpen: false)
    precondition(!gate.voiced && !gate.push(db: -20, frameMs: 10))
  }

  static func open() {
    var gate = CalabVoiceGate()
    gate.configure(mode: .open, thresholdDb: -50, pttOpen: false)
    precondition(feed(&gate, -80, frames: 5).allSatisfy { $0 }, "open mode gated")
    precondition(!gate.speaking, "silence rang")
    _ = feed(&gate, -20, frames: 2)
    precondition(gate.speaking, "speech did not ring")
  }

  static func meter() {
    var silent = [Float](repeating: 0, count: 480)
    precondition(CalabVoiceGate.rms(&silent, count: silent.count) == 0)
    precondition(CalabVoiceGate.db(rms: 0) == -80 && CalabVoiceGate.level(db: -80) == 0)
    var full = [Float](repeating: 32767, count: 480)
    let loud = CalabVoiceGate.db(rms: CalabVoiceGate.rms(&full, count: full.count))
    precondition(abs(loud) < 0.01 && CalabVoiceGate.level(db: loud) == 20, "full scale is not 0 dB")
    // A sine at half scale: RMS 0.354, -9 dB.
    var sine = (0..<480).map { Float(16384 * sin(2 * Double.pi * 440 * Double($0) / 48000)) }
    let db = CalabVoiceGate.db(rms: CalabVoiceGate.rms(&sine, count: sine.count))
    precondition(abs(db + 9.03) < 0.1, "sine level \(db)")
    precondition(CalabVoiceGate.level(db: -40) == 10 && CalabVoiceGate.level(db: 6) == 20 && CalabVoiceGate.level(db: -120) == 0)
    precondition(Set((0...80).map { CalabVoiceGate.level(db: -Double($0)) }).count == 21, "not 21 steps")
    CalabVoiceGate.silence(&sine, count: sine.count)
    precondition(sine.allSatisfy { $0 == 0 }, "closed gate left samples")
  }
}
