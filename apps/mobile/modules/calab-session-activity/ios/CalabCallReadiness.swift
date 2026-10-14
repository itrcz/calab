import Foundation

// Web media can connect before the REST accept has settled back across the bridge.
// Keep all three facts: none of the six possible orders may lose readiness.
struct CalabCallReadiness {
  var accepted = Set<UUID>()
  var connected = Set<UUID>()
  var audioActive = false
  var ready: Set<UUID> { audioActive ? accepted.intersection(connected) : [] }
  mutating func remove(_ id: UUID) { accepted.remove(id); connected.remove(id) }
}

func calabCallerName(_ raw: Any?) -> String {
  guard let raw = raw as? String else { return "Calab" }
  let clean = raw.unicodeScalars.filter { scalar in
    let v = scalar.value
    return !CharacterSet.controlCharacters.contains(scalar) && v != 0x061c &&
      v != 0x200e && v != 0x200f && !(0x202a...0x202e).contains(v) && !(0x2066...0x2069).contains(v)
  }
  let singleLine = String(String.UnicodeScalarView(clean)).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  let bounded = String(String.UnicodeScalarView(singleLine.unicodeScalars.prefix(80)))
  return bounded.isEmpty ? "Calab" : bounded
}

// The bridge timestamp is also exercised by the Swift -> shared TypeScript contract test.
func calabCallMilliseconds(_ date: Date = Date()) -> Double { (date.timeIntervalSince1970 * 1000).rounded(.down) }
