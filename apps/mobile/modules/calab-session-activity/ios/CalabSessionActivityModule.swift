import ActivityKit
import ExpoModulesCore

public class CalabSessionActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabSessionActivity")
    Function("isSupported") {
      Bundle.main.object(forInfoDictionaryKey: "CalabSessionActivityEnabled") as? Bool == true &&
        ActivityAuthorizationInfo().areActivitiesEnabled
    }
    OnCreate { Task { @MainActor in CalabVoiceActivityController.shared.install() } }
    AsyncFunction("publish") { (document: String, generation: Int, status: String, muted: Bool, language: String) in
      try await CalabVoiceActivityController.shared.publish(document: document, generation: generation,
        status: status, muted: muted, language: language)
    }
    AsyncFunction("end") { await CalabVoiceActivityController.shared.end() }
  }
}

@MainActor
private final class CalabVoiceActivityController {
  static let shared = CalabVoiceActivityController()
  private var document: String?
  private weak var owner: AnyObject?
  private var revision = 0
  private var dismissedGeneration: Int?
  private var activity: Activity<CalabVoiceAttributes>?
  private var expiry: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []

  func install() {
    guard observers.isEmpty else { return }
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentGranted"),
      object: nil, queue: .main) { notification in
      MainActor.assumeIsolated {
        self.owner = notification.object as AnyObject?
        self.document = notification.userInfo?["document"] as? String
        self.dismissedGeneration = nil
        self.revision += 1
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentInvalidated"),
      object: nil, queue: .main) { notification in
      MainActor.assumeIsolated {
        guard let view = notification.object as AnyObject?, self.owner === view else { return }
        self.owner = nil
        self.document = nil
        self.revision += 1
        let old = self.takeActivity()
        Task { await old?.end(nil, dismissalPolicy: .immediate) }
      }
    })
    // A restarted host must never adopt an activity of a dead web session.
    let leftovers = Activity<CalabVoiceAttributes>.activities
    Task { for old in leftovers { await old.end(nil, dismissalPolicy: .immediate) } }
  }

  private func takeActivity() -> Activity<CalabVoiceAttributes>? {
    expiry?.cancel()
    expiry = nil
    let old = activity
    activity = nil
    return old
  }

  func end() async {
    dismissedGeneration = nil
    let old = takeActivity()
    await old?.end(nil, dismissalPolicy: .immediate)
  }

  func publish(document: String, generation: Int, status: String, muted: Bool, language: String) async throws {
    guard self.document == document, generation >= 0, ["connected", "reconnecting", "ended"].contains(status),
      ["ru", "en"].contains(language) else { return }
    if status == "ended" { await end(); return }
    guard dismissedGeneration != generation else { return }
    let expectedRevision = revision
    if activity?.attributes.generation != generation { await end() }
    guard self.document == document, revision == expectedRevision else { return }
    let content = ActivityContent(state: CalabVoiceAttributes.ContentState(status: status, muted: muted, language: language),
      staleDate: Date().addingTimeInterval(90))
    if let current = activity {
      // A manually dismissed/ended activity is not silently resurrected on a heartbeat.
      guard current.activityState == .active || current.activityState == .stale else {
        dismissedGeneration = generation
        _ = takeActivity()
        return
      }
      await current.update(content)
    } else {
      activity = try Activity.request(attributes: CalabVoiceAttributes(generation: generation), content: content, pushType: nil)
    }
    guard revision == expectedRevision, self.document == document, let current = activity else { return }
    expiry?.cancel()
    // A single deadline only during a voice session; staleDate remains effective if the process dies/suspends.
    expiry = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(90)) } catch { return }
      guard let self, self.activity?.id == current.id else { return }
      if current.activityState == .dismissed || current.activityState == .ended {
        self.dismissedGeneration = current.attributes.generation
        _ = self.takeActivity()
        return
      }
      await self.end()
    }
  }
}
