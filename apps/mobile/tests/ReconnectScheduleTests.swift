import Foundation

// LiveKit Swift 2.17.0 reconnect, as Room+Engine.swift:400-425 and AsyncRetry.swift:31-54 run it:
// `attempts` tries, quick ones and a full last one, with a curve delay after each failed try but the last.
typealias Schedule = CalabRoomReconnectSchedule

@main
struct ReconnectScheduleTests {
  static func main() {
    curve()
    print("PASS: the delay curve mirrors computeReconnectDelay")
    fits()
    print("PASS: worst-case delays and socket/transport timeouts end inside VOICE_LOST_GRACE")
    rides()
    print("PASS: a short outage is ridden out and the first retry comes fast")
    print(String(format: "worst case %.2f s (SDK default %.2f s), deadline %.0f s, ride %.2f s",
                 Schedule.worstCase(), Schedule.worstCase(Schedule.sdkDefault), Schedule.deadline, Schedule.delays()))
  }

  static func curve() {
    let knobs = Schedule.Knobs(attempts: 10, baseDelay: 0.3, maxDelay: 7, socket: 0, primary: 0, publisher: 0)
    // easeOutCirc from base: attempt 0 starts at the base, the last one is exactly the maximum.
    precondition(abs(Schedule.delay(0, knobs) - 0.3) < 1e-9)
    precondition(abs(Schedule.delay(1, knobs) - (0.3 + (1 - pow(1.0 / 9 - 1, 2)).squareRoot() * 6.7)) < 1e-9)
    precondition(Schedule.delay(9, knobs) == 7)
    precondition((0..<9).allSatisfy { Schedule.delay($0, knobs) <= Schedule.delay($0 + 1, knobs) }, "curve not monotonic")
    // Ours: 1 s, then 5.33 s; the 6 s maximum belongs to the last attempt, after which nothing sleeps.
    precondition(abs(Schedule.delay(0) - 1) < 1e-9 && abs(Schedule.delay(1) - (1 + 0.75.squareRoot() * 5)) < 1e-9)
    precondition(abs(Schedule.delays() - (2 + 0.75.squareRoot() * 5)) < 1e-9)
  }

  static func fits() {
    let worst = Schedule.worstCase()
    // 2 quick (3.5 + 7 + 4 + 4) + 1 full (3.5 + 7 + 4) + 6.33 s of delays with 10 % jitter.
    precondition(abs(worst - (2 * 18.5 + 14.5 + Schedule.delays() * 1.1)) < 1e-9)
    precondition(worst < Schedule.grace, "the SDK may still reconnect after the seat ended: \(worst) s")
    // The driver's own deadline ends the attempt earlier still, with room for detection on both sides.
    precondition(Schedule.deadline < worst && Schedule.grace - Schedule.deadline >= 15)
    // The SDK default does not fit (ADR-0149 §7): about 50 s of delays alone.
    precondition(Schedule.delays(Schedule.sdkDefault) * 1.1 > 45 && Schedule.worstCase(Schedule.sdkDefault) > Schedule.grace)
    precondition(Schedule.responseTimeout == 7, "SignalClient's join response wait changed: re-read 2.17.0 sources")
  }

  static func rides() {
    // Every attempt failing at once still spans a Wi-Fi to LTE switch.
    precondition(Schedule.delays() >= 5)
    // A failed quick try retries within a second, so audio is back within G6's 5 s when the network is.
    precondition(Schedule.delay(0) <= 1)
    precondition(Schedule.attempts >= 2, "no quick attempt before the full one")
  }
}
