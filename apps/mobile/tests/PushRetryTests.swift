import Foundation

@main
struct PushRetryTests {
  static func main() {
    var state = CalabPushRetry()
    let now = Date(timeIntervalSince1970: 1000)
    precondition(state.canAttempt)
    state.failed(at: now)
    precondition(!state.canAttempt)
    state.retry(at: now.addingTimeInterval(14))
    precondition(!state.canAttempt, "foreground storm bypassed cooldown")
    state.retry(at: now.addingTimeInterval(15))
    precondition(state.canAttempt, "transient failure remained sticky")
    state.failed(at: now.addingTimeInterval(16))
    state.retry(at: now.addingTimeInterval(17))
    precondition(!state.canAttempt)
    state.succeeded()
    precondition(state.canAttempt)
    print("APNs retry: lifecycle recovery, cooldown and successful reset passed")
  }
}
