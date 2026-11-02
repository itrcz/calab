import SwiftUI
import WidgetKit

enum CalendarWords {
  static var ru: Bool { Locale.preferredLanguages.first?.hasPrefix("ru") == true }
  static func text(_ en: String, _ ru: String) -> String { self.ru ? ru : en }
  static var tomorrow: String { text("TOMORROW", "ЗАВТРА") }
  static var today: String { text("TODAY", "СЕГОДНЯ") }
  static var empty: String { text("No more events today", "На сегодня событий больше нет") }
  static var free: String { text("No events", "Нет событий") }
}

struct CalabCalendarEntry: TimelineEntry {
  let date: Date
  let snapshot: CalabCalendarSnapshot
  var agenda: CalabCalendarAgenda? {
    guard let agenda = snapshot.agenda, agenda.isUsable(at: date, timezone: TimeZone.current.identifier) else { return nil }
    return agenda
  }
}

struct CalabCalendarProvider: TimelineProvider {
  func placeholder(in context: Context) -> CalabCalendarEntry { preview() }
  func getSnapshot(in context: Context, completion: @escaping (CalabCalendarEntry) -> Void) {
    if context.isPreview { completion(preview()); return }
    let snapshot = (try? CalabCalendarStore.configured()?.snapshot()) ?? CalabCalendarSnapshot(agenda: nil, signedIn: false)
    completion(CalabCalendarEntry(date: Date(), snapshot: snapshot))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<CalabCalendarEntry>) -> Void) {
    Task {
      let snapshot = await CalabCalendarLoader.shared.load()
      let now = Date()
      let dates = snapshot.agenda?.transitionDates(after: now) ?? [now]
      let entries = dates.map { CalabCalendarEntry(date: $0, snapshot: snapshot) }
      let delay = snapshot.agenda == nil ? 300.0 : 1800 + Double.random(in: 0...180)
      completion(Timeline(entries: entries.isEmpty ? [CalabCalendarEntry(date: now, snapshot: snapshot)] : entries, policy: .after(now.addingTimeInterval(delay))))
    }
  }
  private func preview() -> CalabCalendarEntry {
    let now = Date(); let calendar = Calendar.current; let day = calendar.startOfDay(for: now)
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: day)!
    let to = calendar.date(byAdding: .day, value: 7, to: day)!
    let events = [("Planning", now.addingTimeInterval(1800)), ("Design review", tomorrow.addingTimeInterval(10 * 3600)), ("Team sync", tomorrow.addingTimeInterval(14 * 3600))].enumerated().map { i, item in
      CalabCalendarEvent(key: "sample-\(i)", eventId: "00000000-0000-0000-0000-000000000001", externalUid: "", workspaceId: "00000000-0000-0000-0000-000000000002", title: item.0, startsAt: item.1, endsAt: item.1.addingTimeInterval(1800), allDay: false, startDate: "", endDate: "", color: i == 2 ? "#5C9AFF" : "#8B7CF8", source: "calab")
    }
    return CalabCalendarEntry(date: now, snapshot: CalabCalendarSnapshot(agenda: CalabCalendarAgenda(version: 1, generatedAt: now, validUntil: to, from: day, to: to, timezone: TimeZone.current.identifier, events: events, completeUntil: to), signedIn: true))
  }
}

enum CalabCalendarKind: String, CaseIterable {
  case todayTomorrow = "CalabCalendarTodayTomorrow"
  case next = "CalabCalendarNext"
  case agenda = "CalabCalendarAgenda"
  case lock = "CalabCalendarLock"
}

struct CalabTodayTomorrowWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: CalabCalendarKind.todayTomorrow.rawValue, provider: CalabCalendarProvider()) { CalabCalendarView(entry: $0, kind: .todayTomorrow) }
      .configurationDisplayName(CalendarWords.text("Today & Tomorrow", "Сегодня и завтра"))
      .description(CalendarWords.text("Your remaining day and tomorrow at a glance.", "Оставшиеся события сегодня и планы на завтра."))
      .supportedFamilies([.systemMedium])
  }
}
struct CalabNextEventWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: CalabCalendarKind.next.rawValue, provider: CalabCalendarProvider()) { CalabCalendarView(entry: $0, kind: .next) }
      .configurationDisplayName(CalendarWords.text("Up Next", "Ближайшее событие"))
      .description(CalendarWords.text("Your next meeting, without opening Calab.", "Ближайшая встреча без открытия Calab."))
      .supportedFamilies([.systemSmall])
  }
}
struct CalabAgendaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: CalabCalendarKind.agenda.rawValue, provider: CalabCalendarProvider()) { CalabCalendarView(entry: $0, kind: .agenda) }
      .configurationDisplayName(CalendarWords.text("Agenda", "Расписание"))
      .description(CalendarWords.text("Your week and upcoming events.", "Неделя и предстоящие события."))
      .supportedFamilies([.systemLarge])
  }
}
struct CalabLockCalendarWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: CalabCalendarKind.lock.rawValue, provider: CalabCalendarProvider()) { CalabCalendarView(entry: $0, kind: .lock) }
      .configurationDisplayName(CalendarWords.text("Up Next", "Ближайшее событие"))
      .description(CalendarWords.text("Next event on your Lock Screen.", "Ближайшее событие на экране блокировки."))
      .supportedFamilies([.accessoryRectangular])
  }
}

private struct CalabCalendarView: View {
  @Environment(\.showsWidgetContainerBackground) private var showsBackground
  let entry: CalabCalendarEntry
  let kind: CalabCalendarKind
  private var scheme: String { Bundle.main.object(forInfoDictionaryKey: "CalabCalendarScheme") as? String ?? "calab" }
  private var calendar: Calendar { entry.agenda?.calendar ?? Calendar.current }
  private var day: Date { calendar.startOfDay(for: entry.date) }
  private var tomorrow: Date { calendar.date(byAdding: .day, value: 1, to: day)! }
  private var emptyText: String {
    if let a = entry.agenda, a.completeUntil < a.to { return CalendarWords.text("Open Calab for all events", "Все события в Calab") }
    return CalendarWords.free
  }
  private var next: CalabCalendarEvent? {
    let events = entry.agenda?.events.filter { $0.endsAt > entry.date }.sorted { $0.startsAt < $1.startsAt } ?? []
    return events.first(where: { !$0.allDay }) ?? events.first
  }
  private func title(_ event: CalabCalendarEvent) -> String {
    // Lock Screen and background-free contexts (including StandBy) never render
    // the real title, even when the user's OS privacy setting allows it.
    if kind == .lock || !showsBackground { return CalendarWords.text("Meeting", "Встреча") }
    return event.title.isEmpty ? CalendarWords.text("Event", "Событие") : event.title
  }
  private func link(_ day: Date, kind: String = "day") -> URL {
    let key = entry.agenda?.dayKey(day) ?? dateString(day, "yyyy-MM-dd")
    return CalabCalendarAgenda.link(scheme: scheme, items: [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "day", value: key)])!
  }
  private func eventLink(_ event: CalabCalendarEvent) -> URL {
    event.link(scheme: scheme, day: entry.agenda?.dayKey(max(event.startsAt, day)) ?? dateString(max(event.startsAt, day), "yyyy-MM-dd")) ?? link(day)
  }
  private func dateString(_ date: Date, _ template: String) -> String {
    let f = DateFormatter(); f.calendar = calendar; f.timeZone = calendar.timeZone
    if template == "yyyy-MM-dd" { f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = template }
    else { f.setLocalizedDateFormatFromTemplate(template) }
    return f.string(from: date)
  }

  var body: some View {
    Group {
      if #available(iOS 17.0, *) { content.containerBackground(Color(uiColor: .secondarySystemBackground), for: .widget) }
      else { content.padding(kind == .lock ? 0 : 14).background(kind == .lock ? Color.clear : Color(uiColor: .secondarySystemBackground)) }
    }
    .widgetURL((kind == .next || kind == .lock) ? next.map(eventLink) ?? link(day) : link(day))
  }

  @ViewBuilder private var content: some View {
    if entry.agenda == nil {
      VStack(alignment: .leading, spacing: 6) {
        Label("Calab", systemImage: "calendar").font(.headline)
        Text(entry.snapshot.signedIn ? CalendarWords.text("Open Calab to update your calendar", "Откройте Calab, чтобы обновить календарь") : CalendarWords.text("Sign in to Calab", "Войдите в Calab"))
          .font(kind == .lock ? .caption : .subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    } else {
      switch kind {
      case .todayTomorrow: medium
      case .next: small
      case .agenda: large
      case .lock: lock
      }
    }
  }

  private var dateHeading: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(dateString(day, "EEEE").uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Color.red)
      Text(dateString(day, "d")).font(.system(size: 27, weight: .semibold, design: .rounded))
    }.accessibilityElement(children: .combine)
  }
  private var add: some View {
    Link(destination: link(day, kind: "create")) {
      Image(systemName: "plus").font(.system(size: 17, weight: .medium))
        .frame(width: 29, height: 29).background(.primary.opacity(0.09), in: Circle())
    }.buttonStyle(.plain).accessibilityLabel(CalendarWords.text("Create event", "Создать событие"))
  }
  private var medium: some View {
    HStack(alignment: .top, spacing: 18) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top) { dateHeading; Spacer(minLength: 4); add }
        dayEvents(day, limit: 1, empty: CalendarWords.empty)
        stale
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      VStack(alignment: .leading, spacing: 9) {
        Link(destination: link(tomorrow)) { Text(CalendarWords.tomorrow).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }.buttonStyle(.plain)
        dayEvents(tomorrow, limit: 2, empty: CalendarWords.free)
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private var small: some View {
    VStack(alignment: .leading, spacing: 8) {
      dateHeading
      Spacer(minLength: 0)
      if let next {
        eventRow(next, compact: false)
        if !calendar.isDate(next.startsAt, inSameDayAs: day) { Text(dateString(next.startsAt, "EEEdMMM")).font(.caption2).foregroundStyle(.secondary).privacySensitive() }
      } else { Text(emptyText).font(.subheadline).foregroundStyle(.secondary) }
      stale
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }

  private var large: some View {
    let upcoming = entry.agenda?.events.filter { $0.endsAt > entry.date } ?? []
    return VStack(alignment: .leading, spacing: 10) {
      HStack { Text(dateString(day, "MMMM").capitalized).font(.title3.weight(.semibold)); Spacer(); add }
      HStack(spacing: 0) {
        ForEach(0..<7, id: \.self) { index in
          let date = calendar.date(byAdding: .day, value: index, to: day)!
          Link(destination: link(date)) {
            VStack(spacing: 3) {
              Text(dateString(date, "EEEEE")).font(.caption2).foregroundStyle(.secondary)
              Text(dateString(date, "d")).font(.subheadline.weight(index == 0 ? .bold : .regular))
                .frame(width: 26, height: 26).background(index == 0 ? Color.accentColor.opacity(0.2) : .clear, in: Circle())
              Circle().fill((entry.agenda?.events(on: date, after: entry.date).isEmpty == false) ? Color.accentColor : .clear).frame(width: 3, height: 3).privacySensitive()
            }.frame(maxWidth: .infinity)
          }.buttonStyle(.plain)
        }
      }
      Divider()
      if upcoming.isEmpty { Text(emptyText).font(.subheadline).foregroundStyle(.secondary) }
      ForEach(Array(upcoming.prefix(3).enumerated()), id: \.element.key) { index, event in
        VStack(alignment: .leading, spacing: 4) {
          if index == 0 || !calendar.isDate(event.startsAt, inSameDayAs: upcoming[index-1].startsAt) {
            Text(event.startsAt < tomorrow ? CalendarWords.today : calendar.isDate(event.startsAt, inSameDayAs: tomorrow) ? CalendarWords.tomorrow : dateString(event.startsAt, "EEEdMMM").uppercased())
              .font(.caption2.weight(.semibold)).foregroundStyle(.secondary).privacySensitive()
          }
          Link(destination: eventLink(event)) { eventRow(event, compact: true) }.buttonStyle(.plain)
        }
      }
      if upcoming.count > 3 || (entry.agenda?.completeUntil ?? .distantFuture) < (entry.agenda?.to ?? .distantPast) {
        Link(destination: link(day)) { Text(CalendarWords.text("More events in Calab", "Все события в Calab")).font(.caption).foregroundStyle(.secondary).privacySensitive() }.buttonStyle(.plain)
      }
      Spacer(minLength: 0)
      stale
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var lock: some View {
    HStack(alignment: .center, spacing: 8) {
      RoundedRectangle(cornerRadius: 2).frame(width: 3)
      VStack(alignment: .leading, spacing: 2) {
        if let next {
          Text(title(next)).font(.headline).lineLimit(1)
          timeLabel(next).font(.caption)
          if !calendar.isDate(next.startsAt, inSameDayAs: day) { Text(dateString(next.startsAt, "EEEdMMM")).font(.caption2).lineLimit(1) }
        } else { Text("Calab").font(.headline); Text(emptyText).font(.caption) }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.privacySensitive()
  }

  @ViewBuilder private func dayEvents(_ date: Date, limit: Int, empty: String) -> some View {
    let events = entry.agenda?.events(on: date, after: entry.date) ?? []
    let incomplete = (entry.agenda?.completeUntil ?? .distantFuture) < calendar.date(byAdding: .day, value: 1, to: date)!
    if events.isEmpty {
      Text(incomplete ? CalendarWords.text("Open Calab for all events", "Все события в Calab") : empty)
        .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        .frame(maxHeight: .infinity, alignment: .bottomLeading)
    } else {
      VStack(alignment: .leading, spacing: kind == .agenda ? 9 : 7) {
        ForEach(Array(events.prefix(limit))) { event in
          Link(destination: eventLink(event)) { eventRow(event, compact: true) }.buttonStyle(.plain)
        }
        if events.count > limit || incomplete {
          Link(destination: link(date)) {
            Text(incomplete ? CalendarWords.text("More events", "Ещё события") : CalendarWords.text("\(events.count-limit) more", "Ещё \(events.count-limit)"))
              .font(.caption).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
          }.buttonStyle(.plain)
        }
      }
    }
  }

  private func eventRow(_ event: CalabCalendarEvent, compact: Bool) -> some View {
    HStack(alignment: .top, spacing: 7) {
      RoundedRectangle(cornerRadius: 2).fill(color(event.color)).frame(width: 3).widgetAccentable()
      VStack(alignment: .leading, spacing: 2) {
        Text(title(event))
          .font(compact && kind != .agenda ? .system(size: 13, weight: .semibold) : .subheadline.weight(.semibold)).lineLimit(1)
        timeLabel(event).font(compact ? .system(size: 12) : .caption).foregroundStyle(.secondary).lineLimit(1)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.fixedSize(horizontal: false, vertical: true).privacySensitive().accessibilityElement(children: .combine)
  }
  private func timeLabel(_ event: CalabCalendarEvent) -> Text {
    if event.allDay { return Text(CalendarWords.text("All day", "Весь день")) }
    return Text("\(dateString(event.startsAt, "jmm")) – \(dateString(event.endsAt, "jmm"))")
  }
  @ViewBuilder private var stale: some View {
    if let agenda = entry.agenda, entry.date.timeIntervalSince(agenda.generatedAt) >= 7200 {
      Text(CalendarWords.text("Updated ", "Обновлено ") + dateString(agenda.generatedAt, "jmm")).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
    }
  }
  private func color(_ hex: String) -> Color {
    let n = UInt32(hex.dropFirst(), radix: 16) ?? 0x8B7CF8
    return Color(red: Double((n >> 16) & 255)/255, green: Double((n >> 8) & 255)/255, blue: Double(n & 255)/255)
  }
}
