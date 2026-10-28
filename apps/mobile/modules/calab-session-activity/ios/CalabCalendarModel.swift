import Foundation

enum CalabCalendarError: Error { case invalid, unavailable }

struct CalabCalendarEvent: Codable, Identifiable {
  let key: String
  let eventId: String
  let externalUid: String
  let workspaceId: String
  let title: String
  let startsAt: Date
  let endsAt: Date
  let allDay: Bool
  let startDate: String
  let endDate: String
  let color: String
  let source: String
  var occurrenceAt: Date? = nil
  var id: String { key }

  func link(scheme: String, day: String) -> URL? {
    var args = [URLQueryItem(name: "kind", value: source == "calab" ? "event" : "external"), URLQueryItem(name: "day", value: day)]
    args.append(URLQueryItem(name: "start", value: ISO8601DateFormatter().string(from: occurrenceAt ?? startsAt)))
    if source == "calab" {
      args.append(URLQueryItem(name: "event", value: eventId))
      args.append(URLQueryItem(name: "workspace", value: workspaceId))
    } else { args.append(URLQueryItem(name: "uid", value: externalUid)) }
    return CalabCalendarAgenda.link(scheme: scheme, items: args)
  }
}

struct CalabCalendarAgenda: Codable {
  let version: Int
  let generatedAt: Date
  let validUntil: Date
  let from: Date
  let to: Date
  let timezone: String
  let events: [CalabCalendarEvent]
  let completeUntil: Date

  var calendar: Calendar {
    var result = Calendar(identifier: .gregorian)
    result.timeZone = TimeZone(identifier: timezone) ?? .gmt
    return result
  }

  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { value in
      let raw = try value.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: raw) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      guard let date = formatter.date(from: raw) else { throw CalabCalendarError.invalid }
      return date
    }
    return decoder
  }

  static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]; return encoder
  }

  static func decode(_ data: Data, now: Date = Date()) throws -> Self {
    guard data.count <= 262_144 else { throw CalabCalendarError.invalid }
    let value = try decoder().decode(Self.self, from: data)
    guard value.version == 1, TimeZone(identifier: value.timezone) != nil, value.events.count <= 100,
      value.from < value.to, value.to.timeIntervalSince(value.from) <= 8 * 86400,
      value.generatedAt <= now.addingTimeInterval(300), value.validUntil > value.generatedAt,
      value.validUntil <= value.to, value.completeUntil <= value.to,
      Set(value.events.map(\.key)).count == value.events.count else { throw CalabCalendarError.invalid }
    for event in value.events {
      guard event.endsAt > event.startsAt, event.title.count <= 200, event.key.utf8.count <= 256,
        event.color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
        (event.source == "calab" && UUID(uuidString: event.eventId) != nil && UUID(uuidString: event.workspaceId) != nil) ||
        (event.source == "external" && event.externalUid.range(of: "^[0-9a-f]{16,64}$", options: .regularExpression) != nil)
      else { throw CalabCalendarError.invalid }
      if event.allDay {
        guard value.date(event.startDate) != nil, let end = value.date(event.endDate),
          let start = value.date(event.startDate), end > start else { throw CalabCalendarError.invalid }
      }
    }
    return value
  }

  func date(_ day: String) -> Date? {
    guard day.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { return nil }
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
    f.timeZone = calendar.timeZone; f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
    guard let d = f.date(from: day), f.string(from: d) == day else { return nil }; return d
  }

  func dayKey(_ date: Date) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = calendar
    f.timeZone = calendar.timeZone; f.dateFormat = "yyyy-MM-dd"; return f.string(from: date)
  }

  func isUsable(at now: Date, timezone: String) -> Bool {
    self.timezone == timezone && now >= from && now < validUntil
  }

  func events(on day: Date, after now: Date) -> [CalabCalendarEvent] {
    let start = calendar.startOfDay(for: day)
    let end = calendar.date(byAdding: .day, value: 1, to: start)!
    return events.filter { $0.startsAt < end && $0.endsAt > start && $0.endsAt > now }
      .sorted { a, b in a.startsAt == b.startsAt ? a.key < b.key : a.startsAt < b.startsAt }
  }

  func transitionDates(after now: Date) -> [Date] {
    var dates = [now, validUntil, generatedAt.addingTimeInterval(2 * 3600)]
    for event in events { dates += [event.startsAt, event.endsAt] }
    var day = calendar.startOfDay(for: now)
    for _ in 0..<7 { day = calendar.date(byAdding: .day, value: 1, to: day)!; dates.append(day) }
    return Array(Set(dates.filter { $0 >= now && $0 <= validUntil })).sorted()
  }

  static func link(scheme: String, items: [URLQueryItem]) -> URL? {
    var c = URLComponents(); c.scheme = scheme; c.host = "calendar"; c.queryItems = items; return c.url
  }
}
