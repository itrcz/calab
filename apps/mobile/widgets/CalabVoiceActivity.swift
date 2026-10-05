import ActivityKit
import SwiftUI
import WidgetKit

struct CalabVoiceActivity: Widget {
  private func status(_ context: ActivityViewContext<CalabVoiceAttributes>) -> String {
    let ru = context.state.language == "ru"
    if context.isStale { return ru ? "Откройте Calab, чтобы проверить связь" : "Open Calab to check connection" }
    if context.state.status == "reconnecting" { return ru ? "Восстановление связи" : "Reconnecting" }
    return ru ? "В голосовой комнате" : "In a voice room"
  }
  private func icon(_ context: ActivityViewContext<CalabVoiceAttributes>) -> String {
    if context.isStale { return "questionmark.circle" }
    if context.state.status == "reconnecting" { return "arrow.triangle.2.circlepath" }
    return context.state.muted ? "mic.slash" : "waveform"
  }
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: CalabVoiceAttributes.self) { context in
      HStack(spacing: 12) {
        Image(systemName: icon(context)).font(.title2)
        VStack(alignment: .leading, spacing: 4) {
          Text("Calab").font(.headline)
          Text(status(context)).font(.subheadline)
          if !context.isStale && context.state.muted {
            Text(context.state.language == "ru" ? "Микрофон выключен" : "Microphone muted").font(.caption)
          }
        }
        Spacer()
      }.padding()
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Text("Calab").font(.headline) }
        DynamicIslandExpandedRegion(.trailing) { Image(systemName: icon(context)) }
        DynamicIslandExpandedRegion(.bottom) { Text(status(context)).font(.subheadline) }
      } compactLeading: { Text("Calab").font(.caption) }
        compactTrailing: { Image(systemName: icon(context)) }
        minimal: { Image(systemName: icon(context)) }
    }
  }
}

@main
struct CalabVoiceActivityBundle: WidgetBundle {
  var body: some Widget { CalabVoiceActivity() }
}
