import Foundation

@main
struct CalendarDiskTests {
  static func main() throws {
    let directory: URL
    if CommandLine.arguments.count > 1 {
      directory = URL(fileURLWithPath: CommandLine.arguments[1])
      try CalabCalendarDisk(directory: directory).locked { state in
        if CommandLine.arguments.count > 2 { state?.forgetCredential() }
        else { state = CalabCalendarDisk.State() }
      }
      return
    }
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let disk = CalabCalendarDisk(directory: directory)
    let generation = try disk.locked { value in value = CalabCalendarDisk.State(); value?.fingerprint = "old-account"; return value!.generation }
    let process = Process(); process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); process.arguments = [directory.path]
    try process.run(); process.waitUntilExit(); precondition(process.terminationStatus == 0)
    let now = Date()
    let agenda = CalabCalendarAgenda(version: 1, generatedAt: now, validUntil: now.addingTimeInterval(3600), from: now, to: now.addingTimeInterval(86400), timezone: "UTC", events: [], completeUntil: now.addingTimeInterval(86400))
    let committed = try disk.commit(agenda, generation: generation, fingerprint: "old-account")
    precondition(!committed, "old process restored a cleared account")
    let state = try disk.locked { $0! }
    precondition(state.fingerprint == nil && state.agenda == nil)
    try Data("corrupt cache".utf8).write(to: directory.appendingPathComponent("calendar-state.json"))
    let recovered = try disk.locked { value in
      let empty = value == nil; value = CalabCalendarDisk.State(); return empty
    }
    precondition(recovered, "corruption must fail closed and permit reconfiguration")
    try disk.locked { $0 = CalabCalendarDisk.State(binding: "new-session") }
    let reader = Process(); reader.executableURL = process.executableURL; reader.arguments = [directory.path, "snapshot"]
    try reader.run(); reader.waitUntilExit(); precondition(reader.terminationStatus == 0)
    let binding = try disk.locked { $0?.binding }
    precondition(binding == "new-session", "unsigned snapshot erased a binding awaiting its grant")
    print("Calendar disk: cross-process logout fences stale cache writes")
  }
}
