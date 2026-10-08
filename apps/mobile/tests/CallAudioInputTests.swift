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
                       -Double.infinity, Double.greatestFiniteMagnitude, true, "32000", NSNull()] {
      guard calabCallAudioBitrate(value) == nil else {
        print("FAIL: invalid bitrate accepted"); exit(1)
      }
    }
    guard calabCallAudioBitrate(nil) == nil else { exit(1) }
    print("PASS: native bridged bitrate validation")
  }
}
