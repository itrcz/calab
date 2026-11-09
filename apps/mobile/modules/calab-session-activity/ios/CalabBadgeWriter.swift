import Foundation

/** Serial, latest-value-wins writes. In-flight values cannot finish after a queued logout clear. */
@MainActor
final class CalabBadgeWriter {
  private let write: @MainActor (Int) async -> Void
  private var pending: Int?
  private var running = false

  init(write: @escaping @MainActor (Int) async -> Void) { self.write = write }

  func set(_ count: Int) {
    guard (0...99999).contains(count) else { return }
    pending = count
    guard !running else { return }
    running = true
    Task { @MainActor in
      while let count = pending {
        pending = nil
        await write(count)
      }
      running = false
    }
  }
}
