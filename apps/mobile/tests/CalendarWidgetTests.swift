import Foundation

@main
struct CalendarWidgetTests {
  static func main() throws {
    let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")
    let files = CommandLine.arguments.count > 1 ? Array(CommandLine.arguments.dropFirst()) : ["calendar-empty.json", "calendar-populated.json"].map { fixtures.appendingPathComponent($0).path }
    for file in files {
      let data = try Data(contentsOf: URL(fileURLWithPath: file))
      _ = try CalabCalendarAgenda.decode(data, now: .distantFuture)
    }
    let raw = """
    {"version":1,"generatedAt":"2026-10-31T12:00:00Z","validUntil":"2026-11-06T05:00:00Z","from":"2026-10-31T04:00:00Z","to":"2026-11-07T05:00:00Z","timezone":"America/New_York","completeUntil":"2026-11-07T05:00:00Z","events":[
      {"key":"one","eventId":"00000000-0000-0000-0000-000000000001","externalUid":"","workspaceId":"00000000-0000-0000-0000-000000000002","title":"Midnight end","startsAt":"2026-11-01T03:00:00Z","endsAt":"2026-11-01T04:00:00Z","allDay":false,"startDate":"","endDate":"","source":"calab","color":"#8B7CF8"},
      {"key":"two","eventId":"","externalUid":"0123456789abcdef","workspaceId":"","title":"Day off","startsAt":"2026-11-01T04:00:00Z","endsAt":"2026-11-02T05:00:00Z","allDay":true,"startDate":"2026-11-01","endDate":"2026-11-02","source":"external","color":"#5C9AFF"}
    ]}
    """
    let now = ISO8601DateFormatter().date(from: "2026-10-31T12:00:00Z")!
    let agenda = try CalabCalendarAgenda.decode(Data(raw.utf8), now: now)
    let day = ISO8601DateFormatter().date(from: "2026-11-01T04:00:00Z")!
    precondition(agenda.events(on: day, after: day).map(\.title) == ["Day off"], "exclusive end leaked into the following day")
    precondition(agenda.calendar.date(byAdding: .day, value: 1, to: day)!.timeIntervalSince(day) == 25 * 3600, "DST day treated as 24 hours")
    precondition(agenda.transitionDates(after: now).contains(agenda.validUntil), "cache expiry has no timeline entry")
    precondition(agenda.isUsable(at: now, timezone: "America/New_York"))
    precondition(!agenda.isUsable(at: now, timezone: "Europe/Belgrade"), "old timezone cache reused")
    precondition(!agenda.isUsable(at: agenda.validUntil, timezone: "America/New_York"), "expired cache reused")
    for bad in [raw.replacingOccurrences(of: "\"version\":1", with: "\"version\":9"), raw.replacingOccurrences(of: "2026-11-02T05:00:00Z", with: "invalid"), String(repeating: "x", count: 262145)] {
      do { _ = try CalabCalendarAgenda.decode(Data(bad.utf8), now: now); preconditionFailure("invalid agenda accepted") } catch {}
    }
    let link = agenda.events[0].link(scheme: "calab-test", day: "2026-10-31")
    precondition(link?.host == "calendar" && link?.scheme == "calab-test")
    print("Calendar widget: DATE/DST, exclusive boundaries, expiry, timezone and decoder passed")
  }
}
