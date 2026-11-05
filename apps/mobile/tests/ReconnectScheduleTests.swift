import Foundation

// LiveKit Swift 2.17.0 reconnect, as Room+Engine.swift:400-425 and AsyncRetry.swift:31-54 run it:
// `attempts` tries, quick ones and a full last one, with a curve delay after each failed try but the last.
typealias Schedule = CalabRoomReconnectSchedule

@main
struct ReconnectScheduleTests {
  static func main() {
    curve()
    print("PASS: the delay curve mirrors computeReconnectDelay")
    bounded()
    print("PASS: the driver's deadline and teardown end inside VOICE_LOST_GRACE")
    rides()
    print("PASS: a fast-failing outage is retried for 30 s and the first retry comes fast")
    print(String(format: "deadline %.0f s + teardown %.0f s, fast-fail retries %.2f-%.2f s, SDK alone %.2f s (default %.2f s)",
                 Schedule.deadline, Schedule.teardown, Schedule.delays(), Schedule.delays() * (1 + Schedule.jitter),
                 Schedule.worstCase(), Schedule.worstCase(Schedule.sdkDefault)))
  }

  static func curve() {
    let knobs = Schedule.Knobs(attempts: 10, baseDelay: 0.3, maxDelay: 7, socket: 0, primary: 0, publisher: 0)
    // easeOutCirc from base: attempt 0 starts at the base, the last one is exactly the maximum.
    precondition(abs(Schedule.delay(0, knobs) - 0.3) < 1e-9)
    precondition(abs(Schedule.delay(1, knobs) - (0.3 + (1 - pow(1.0 / 9 - 1, 2)).squareRoot() * 6.7)) < 1e-9)
    precondition(Schedule.delay(9, knobs) == 7)
    precondition((0..<9).allSatisfy { Schedule.delay($0, knobs) <= Schedule.delay($0 + 1, knobs) }, "curve not monotonic")
  }

  static func bounded() {
    // (a) The invariant is the driver's: it stops the room, and disconnect cancels the SDK's retries.
    precondition(Schedule.deadline + Schedule.teardown < Schedule.grace, "a reconnect may outlive the seat")
    // Neither the SDK default nor our knobs bound themselves: without the deadline both would run past it.
    precondition(Schedule.worstCase(Schedule.sdkDefault) + Schedule.teardown >= Schedule.grace, "(c) the SDK default fits")
    precondition(Schedule.worstCase() > Schedule.deadline, "the deadline never applies: knobs could be longer")
    precondition(Schedule.responseTimeout == 7, "SignalClient's join response wait changed: re-read 2.17.0 sources")
    precondition(Schedule.socketTimeout <= 4 && Schedule.primaryTimeout <= 4 && Schedule.publisherTimeout <= 4, "timeouts grew")
  }

  static func rides() {
    // (b) Every attempt failing at once (no route, airplane mode, a lift) still retries for 30 s and more,
    // with no single wait above 5 s, and the whole run, jitter included, fits before the deadline.
    precondition(Schedule.delays() >= 30, "fast failures give up after \(Schedule.delays()) s")
    precondition((0..<Schedule.attempts - 1).allSatisfy { Schedule.delay($0) * (1 + Schedule.jitter) <= 5.5 })
    precondition(Schedule.delays() * (1 + Schedule.jitter) < Schedule.deadline, "the deadline cuts planned retries")
    precondition(Schedule.delay(0) * (1 + Schedule.jitter) <= 1.5, "the first retry is slow")
  }
}
