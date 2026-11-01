import Foundation
import Darwin

/// A process-independent lock: the app and WidgetKit cannot resurrect each other's old account.
final class CalabCalendarDisk {
  struct State: Codable {
    var generation = UUID().uuidString
    var binding: String?
    var dirty: Bool?
    var fingerprint: String?
    var agenda: CalabCalendarAgenda?
    var attemptedAt: Date?
    mutating func forgetCredential() {
      // Reading an unsigned snapshot must not erase an in-progress authenticated binding.
      if fingerprint != nil || agenda != nil || attemptedAt != nil {
        generation = UUID().uuidString; fingerprint = nil; agenda = nil; attemptedAt = nil; dirty = nil
      }
    }
  }
  let directory: URL
  init(directory: URL) { self.directory = directory }

  func locked<T>(_ operation: (inout State?) throws -> T) throws -> T {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = directory.appendingPathComponent("calendar.lock")
    let fd = open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw CalabCalendarError.unavailable }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw CalabCalendarError.unavailable }
    defer { flock(fd, LOCK_UN) }
    var file = directory.appendingPathComponent("calendar-state.json")
    var state: State?
    if FileManager.default.fileExists(atPath: file.path) {
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      if size <= 524_288 {
        let data = try Data(contentsOf: file)
        state = try? CalabCalendarAgenda.decoder().decode(State.self, from: data)
      }
    }
    let before = state.flatMap { try? CalabCalendarAgenda.encoder().encode($0) }
    let result = try operation(&state)
    if let state {
      let data = try CalabCalendarAgenda.encoder().encode(state)
      if data != before {
      #if os(iOS)
      try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      #else
      try data.write(to: file, options: .atomic)
      #endif
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try file.setResourceValues(values)
      }
    }
    return result
  }

  @discardableResult
  func commit(_ agenda: CalabCalendarAgenda, generation: String, fingerprint: String) throws -> Bool {
    try locked { state in
      guard state?.generation == generation, state?.fingerprint == fingerprint else { return false }
      state?.agenda = agenda
      return true
    }
  }
}
