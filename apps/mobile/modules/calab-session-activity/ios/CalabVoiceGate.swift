import Foundation

// ADR-0149 §5: the web gate (renderer/lib/media/vad.ts) without RNNoise. It runs on the audio thread,
// so nothing here allocates, locks or touches Foundation objects; the driver holds the lock around it.

struct CalabVoiceGate {
  enum Mode: Equatable { case voice, ptt, open }
  // Two capture buffers above the threshold open it: the APM hands over 10 ms, so the gate opens
  // after 20 ms of speech, no later than the web's two 20 ms frames.
  static let openFrames = 2
  static let hangoverMs = 400.0
  // vad.ts METER_MIN_DB, the slider's floor.
  static let floorDb = -80.0
  static let levelSteps = 20
  // WebRTC's float samples keep the Int16 range.
  static let fullScale: Float = 32768

  private(set) var mode = Mode.voice
  private(set) var thresholdDb = -50.0
  private(set) var pttOpen = false
  // Voice activity on the threshold, in every mode: the own ring.
  private(set) var voiced = false
  private var speechRun = 0
  private var silenceMs = 0.0

  // A new mode starts closed, so a released push-to-talk never leaks a hangover.
  mutating func configure(mode: Mode, thresholdDb: Double, pttOpen: Bool) {
    if mode != self.mode { reset() }
    self.mode = mode; self.thresholdDb = thresholdDb; self.pttOpen = pttOpen
  }

  mutating func reset() { voiced = false; speechRun = 0; silenceMs = 0 }

  // Whether the buffer may leave the device; a closed gate sends zeros, which Opus DTX drops.
  var passes: Bool {
    switch mode {
    case .open: return true
    case .ptt: return pttOpen
    case .voice: return voiced
    }
  }

  // The ring the room shows for me: speech that actually leaves the device.
  var speaking: Bool { voiced && passes }

  @discardableResult mutating func push(db: Double, frameMs: Double) -> Bool {
    if db > thresholdDb {
      speechRun += 1; silenceMs = 0
      if !voiced && speechRun >= Self.openFrames { voiced = true }
    } else {
      speechRun = 0
      if voiced {
        silenceMs += frameMs
        if silenceMs >= Self.hangoverMs { voiced = false; silenceMs = 0 }
      }
    }
    return passes
  }

  static func rms(_ samples: UnsafePointer<Float>, count: Int) -> Float {
    guard count > 0 else { return 0 }
    var sum: Float = 0
    for index in 0..<count { let value = samples[index] / fullScale; sum += value * value }
    return (sum / Float(count)).squareRoot()
  }

  static func db(rms: Float) -> Double {
    guard rms > 0 else { return floorDb }
    return max(floorDb, 20 * Double(log10f(rms)))
  }

  // 21 steps over the meter's -80...0 dB.
  static func level(db: Double) -> Int {
    let clamped = min(0, max(floorDb, db))
    return Int(((clamped - floorDb) / -floorDb * Double(levelSteps)).rounded())
  }

  static func silence(_ samples: UnsafeMutablePointer<Float>, count: Int) {
    samples.update(repeating: 0, count: count)
  }
}
