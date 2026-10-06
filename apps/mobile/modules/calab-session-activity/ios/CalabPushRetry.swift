import Foundation

/** Retries are triggered by foreground/user intent, never by status probes or a timer. */
struct CalabPushRetry {
  private(set) var retryAt: Date?
  var canAttempt: Bool { retryAt == nil }
  mutating func failed(at now: Date) { retryAt = now.addingTimeInterval(15) }
  mutating func succeeded() { retryAt = nil }
  mutating func retry(at now: Date) {
    if let retryAt, now >= retryAt { self.retryAt = nil }
  }
}
