import Foundation

@main
struct CallAudioInputTests {
  static func main() {
    // Expo's JSI dictionary hydration preserves JS numbers as Swift Double.
    for value: Any in [8000.0, 32000.0, 64000.0, 32000, NSNumber(value: 32000)] {
      guard calabCallAudioBitrate(value) != nil else {
        print("FAIL: valid bridged bitrate rejected"); exit(1)
      }
    }
    for value: Any in [7999.0, 64001.0, 32000.5, Double.nan, Double.infinity,
                       -Double.infinity, Double.greatestFiniteMagnitude, true,
                       NSNumber(value: true), NSNumber(value: 32000.5), "32000", NSNull()] {
      guard calabCallAudioBitrate(value) == nil else {
        print("FAIL: invalid bitrate accepted"); exit(1)
      }
    }
    guard calabCallAudioBitrate(nil) == nil else { exit(1) }
    let call = UUID(), other = UUID()
    var mute = CalabCallMuteSafety()
    mute.mute(call) // system mute before media exists
    precondition(mute.blocks(call) && !mute.blocks(other))
    for _ in 0..<3 { // delayed unmuted controls and failed acknowledgements
      precondition(!mute.acknowledge(call, muted: false))
      precondition(mute.blocks(call), "late web state reopened the microphone")
    }
    precondition(!mute.acknowledge(other, muted: true))
    precondition(mute.blocks(call), "another call acknowledged this mute")
    precondition(!mute.acknowledge(call, muted: true), "old muted controls acknowledged a newer action")
    precondition(mute.blocks(call))
    mute.confirm(call, webMuted: false) // matching action settles before its controls
    precondition(mute.blocks(call))
    precondition(mute.acknowledge(call, muted: true))
    precondition(!mute.blocks(call), "confirmed web mute did not restore ordinary controls")
    mute.mute(call)
    mute.confirm(call, webMuted: false)
    mute.mute(call) // a new user intent invalidates the previous confirmation
    precondition(!mute.acknowledge(call, muted: true))
    precondition(mute.blocks(call))
    mute.confirm(call, webMuted: true) // controls may also precede the matching result
    precondition(!mute.blocks(call))
    mute.mute(call)
    mute.release(other)
    precondition(mute.blocks(call))
    mute.release(call) // confirmed explicit unmute or end
    precondition(!mute.blocks(call), "ended call retained its microphone latch")
    var progress = CalabCallProgressState()
    precondition(!progress.shouldPlay(active: true, deafened: false))
    progress.begin()
    precondition(!progress.shouldPlay(active: false, deafened: false), "cue bypassed CallKit")
    precondition(progress.shouldPlay(active: true, deafened: false))
    precondition(!progress.shouldPlay(active: true, deafened: true), "cue bypassed deafen")
    progress.receivedAudio()
    precondition(!progress.shouldPlay(active: true, deafened: false), "cue overlapped remote audio")
    precondition(!progress.shouldPlay(active: false, deafened: true))
    precondition(!progress.shouldPlay(active: true, deafened: false), "late control restarted cue")
    progress.begin()
    precondition(progress.shouldPlay(active: true, deafened: false), "new call lost cue")
    progress.end()
    precondition(!progress.shouldPlay(active: true, deafened: false), "late activation revived ended cue")
    let cue = calabCallProgressWave()
    precondition(String(data: cue.prefix(4), encoding: .ascii) == "RIFF")
    precondition(String(data: cue[8..<12], encoding: .ascii) == "WAVE")
    precondition(cue.count == 44 + 16000 * 2 * 2)
    let samples: [Int16] = stride(from: 44, to: cue.count, by: 2).map {
      Int16(bitPattern: UInt16(cue[$0]) | (UInt16(cue[$0 + 1]) << 8))
    }
    precondition(samples.prefix(3200).contains { $0 != 0 }, "cue has no pulse")
    precondition(samples.dropFirst(3200).allSatisfy { $0 == 0 }, "cue has no quiet interval")
    precondition(samples.allSatisfy { abs(Int($0)) <= 1800 }, "cue exceeded quiet amplitude")
    print("PASS: connecting cue respects activation, deafen, remote audio and termination")
    print("PASS: native bridged bitrate validation")
    print("PASS: early system mute, late controls, acknowledgement and call isolation")
  }
}
