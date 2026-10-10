import ActivityKit
import AVFoundation
import ExpoModulesCore
import UIKit

public class CalabSessionActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabSessionActivity")
    Events("onPermissionsChanged")
    Function("isSupported") {
      Bundle.main.object(forInfoDictionaryKey: "CalabSessionActivityEnabled") as? Bool == true &&
        ActivityAuthorizationInfo().areActivitiesEnabled
    }
    OnCreate { Task { @MainActor in
      CalabVoiceActivityController.shared.install()
      CalabMediaPermissions.shared.install()
      CalabMediaPermissions.shared.emit = { [weak self] document, state in
        self?.sendEvent("onPermissionsChanged", ["document": document, "state": state])
      }
    } }
    AsyncFunction("mediaPermissions") { (document: String) -> [String: String] in
      await CalabMediaPermissions.shared.state(document)
    }
    AsyncFunction("requestMediaPermission") { (document: String, kind: String) -> [String: String] in
      await CalabMediaPermissions.shared.request(document, kind: kind)
    }
    AsyncFunction("openAppSettings") { (document: String) -> Bool in
      await CalabMediaPermissions.shared.openSettings(document)
    }
    AsyncFunction("publish") { (document: String, generation: Int, status: String, muted: Bool, language: String) in
      try await CalabVoiceActivityController.shared.publish(document: document, generation: generation,
        status: status, muted: muted, language: language)
    }
    AsyncFunction("end") { await CalabVoiceActivityController.shared.end() }
  }
}

/** Authorization only, independent of ActivityKit and AVAudioSession configuration/capture. */
@MainActor
private final class CalabMediaPermissions {
  static let shared = CalabMediaPermissions()
  var emit: ((String, [String: String]) -> Void)?
  private weak var owner: AnyObject?
  private var document: String?
  private var asking = false
  private var observers: [NSObjectProtocol] = []
  private var unavailable: [String: String] { ["microphone": "n/a", "camera": "n/a"] }
  private func current(_ document: String) -> Bool { owner != nil && self.document == document }

  func install() {
    guard observers.isEmpty else { return }
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentGranted"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        self.owner = notice.object as AnyObject?
        self.document = notice.userInfo?["document"] as? String
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentInvalidated"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        if let view = notice.object as AnyObject?, self.owner === view { self.owner = nil; self.document = nil }
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated {
        if let document = self.document, self.current(document) { self.emit?(document, self.state(document)) }
      }
    })
  }

  private func status(_ type: AVMediaType) -> String {
    let usageKey = type == .audio ? "NSMicrophoneUsageDescription" : "NSCameraUsageDescription"
    guard let usage = Bundle.main.object(forInfoDictionaryKey: usageKey) as? String, !usage.isEmpty else { return "n/a" }
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "n/a"
    }
  }
  func state(_ document: String) -> [String: String] {
    guard current(document) else { return unavailable }
    return ["microphone": status(.audio), "camera": status(.video)]
  }
  func request(_ document: String, kind: String) async -> [String: String] {
    guard current(document), kind == "microphone" || kind == "camera" else { return unavailable }
    let type: AVMediaType = kind == "microphone" ? .audio : .video
    guard !asking, UIApplication.shared.applicationState == .active, status(type) == "not-determined" else { return state(document) }
    asking = true
    defer { asking = false }
    _ = await AVCaptureDevice.requestAccess(for: type)
    // A settings request never starts recording, even after permission is granted.
    return state(document)
  }
  func openSettings(_ document: String) async -> Bool {
    guard current(document), UIApplication.shared.applicationState == .active,
      let url = URL(string: UIApplication.openSettingsURLString) else { return false }
    let opened = await UIApplication.shared.open(url)
    return current(document) && opened
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
