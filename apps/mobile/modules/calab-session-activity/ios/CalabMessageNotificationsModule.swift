import ExpoModulesCore
import UserNotifications

public class CalabMessageNotificationsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabMessageNotifications")
    Events("onPushChanged")
    OnCreate {
      Task { @MainActor in
        CalabMessagePush.shared.install()
        CalabMessagePush.shared.emit = { [weak self] document, state in
          self?.sendEvent("onPushChanged", ["document": document, "state": state])
        }
      }
    }
    AsyncFunction("acknowledgePush") { (document: String, eventId: String) in
      await CalabMessagePush.shared.acknowledge(document: document, eventId: eventId)
    }
    AsyncFunction("pushState") { (document: String, requestPermission: Bool) -> [String: Any] in
      await CalabMessagePush.shared.state(document: document, requestPermission: requestPermission)
    }
    AsyncFunction("testNotification") { (document: String, body: String) -> String in
      await CalabMessagePush.shared.test(document: document, body: body)
    }
  }
}

/** Expo forwards APNs callbacks; no replacement of UIApplicationDelegate or auth/session storage. */
public class CalabMessagePushSubscriber: ExpoAppDelegateSubscriber {
  public func subscriberDidRegister() { CalabMessagePush.shared.install() }
  public func applicationDidBecomeActive(_ application: UIApplication) { CalabMessagePush.shared.refresh() }
  public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    CalabMessagePush.shared.registered(deviceToken)
  }
  public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    CalabMessagePush.shared.registrationFailed()
  }
}

@MainActor
private final class CalabMessagePush: NSObject, UNUserNotificationCenterDelegate {
  static let shared = CalabMessagePush()
  var emit: ((String, [String: Any]) -> Void)?
  private weak var owner: AnyObject?
  private var document: String?
  private var token: String?
  private var registrationRetry = CalabPushRetry()
  private var pendingTap: [String: Any]?
  private var observers: [NSObjectProtocol] = []
  private var waiters: [UUID: (String, CheckedContinuation<String?, Never>)] = [:]
  private var requestingToken = false
  private var testing = false
  private static let testIdentifier = "calab-notification-test"
  private let center = UNUserNotificationCenter.current()
  private var environment: String? {
    let value = Bundle.main.object(forInfoDictionaryKey: "CalabMessagePushEnvironment") as? String
    return value == "development" || value == "production" ? value : nil
  }
  private var configured: Bool { environment != nil && center.delegate === self }
  private var installation: String {
    let key = "CalabPushInstallation"
    if let stored = UserDefaults.standard.string(forKey: key), UUID(uuidString: stored) != nil { return stored }
    let value = UUID().uuidString.lowercased()
    UserDefaults.standard.set(value, forKey: key)
    return value
  }
  func install() {
    guard observers.isEmpty else { return }
    // Cooperate with other modules: a foreign delegate disables this optional capability.
    if environment != nil && center.delegate == nil { center.delegate = self }
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentGranted"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        self.owner = notice.object as AnyObject?
        self.document = notice.userInfo?["document"] as? String
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostSessionCleared"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        if let view = notice.object as AnyObject?, self.owner === view {
          self.pendingTap = nil
          // UserNotifications scopes this to Calab. Reload only invalidates the document.
          self.center.removeAllDeliveredNotifications()
          CalabCommunication.clear()
        }
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentInvalidated"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        guard let view = notice.object as AnyObject?, self.owner === view else { return }
        self.owner = nil; self.document = nil; self.token = nil
        self.finishToken(nil)
      }
    })
  }
  private func current(_ document: String) -> Bool { owner != nil && self.document == document }
  func state(document: String, requestPermission: Bool) async -> [String: Any] {
    guard current(document), configured else { return ["permission": "unsupported"] }
    if requestPermission { registrationRetry.retry(at: Date()) }
    var settings = await center.notificationSettings()
    guard current(document), configured else { return ["permission": "unsupported"] }
    if requestPermission && settings.authorizationStatus == .notDetermined && UIApplication.shared.applicationState == .active {
      _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
      guard current(document), configured else { return ["permission": "unsupported"] }
      settings = await center.notificationSettings()
    }
    guard current(document), configured else { return ["permission": "unsupported"] }
    var value: [String: Any] = ["permission": "denied"]
    switch settings.authorizationStatus {
    case .notDetermined: value["permission"] = "default"
    case .authorized, .provisional, .ephemeral:
      guard let token = await deviceToken(document), current(document), configured,
        let app = Bundle.main.bundleIdentifier, let environment else { return ["permission": "unsupported"] }
      value = ["permission": "granted", "token": token, "appId": app, "environment": environment, "installationId": installation]
    default: break
    }
    if let tap = pendingTap, let expires = tap["expiresAt"] as? Int64, Double(expires) > Date().timeIntervalSince1970 * 1000 { value["tap"] = tap }
    else { pendingTap = nil }
    return value
  }
  func test(document: String, body: String) async -> String {
    guard current(document), configured else { return "unsupported" }
    guard !testing, UIApplication.shared.applicationState == .active,
      !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, body.utf16.count <= 512 else { return "failed" }
    testing = true
    defer { testing = false }
    var settings = await center.notificationSettings()
    guard current(document), configured, UIApplication.shared.applicationState == .active else { return "failed" }
    if settings.authorizationStatus == .notDetermined {
      do { _ = try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
      catch { return "failed" }
      settings = await center.notificationSettings()
    }
    guard current(document), configured, UIApplication.shared.applicationState != .background else { return "failed" }
    guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else { return "denied" }
    // No APNs token/server round-trip: this tests local authorization and presentation only.
    let content = UNMutableNotificationContent()
    content.title = "Calab"
    content.body = body
    content.sound = .default
    do {
      try await center.add(UNNotificationRequest(identifier: Self.testIdentifier, content: content, trigger: nil))
      guard current(document), configured else {
        center.removePendingNotificationRequests(withIdentifiers: [Self.testIdentifier])
        center.removeDeliveredNotifications(withIdentifiers: [Self.testIdentifier])
        return "unsupported"
      }
      return "scheduled"
    } catch { return "failed" }
  }
  func acknowledge(document: String, eventId: String) {
    guard current(document), pendingTap?["eventId"] as? String == eventId else { return }
    pendingTap = nil
  }
  private func deviceToken(_ document: String) async -> String? {
    guard current(document), configured, registrationRetry.canAttempt else { return nil }
    if let token { return token }
    return await withCheckedContinuation { continuation in
      let id = UUID()
      waiters[id] = (document, continuation)
      if !requestingToken { requestingToken = true; UIApplication.shared.registerForRemoteNotifications() }
      // Only pending registration has a deadline; no idle polling or background keepalive.
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(10))
        if let waiter = self.waiters.removeValue(forKey: id) { waiter.1.resume(returning: nil) }
        if self.waiters.isEmpty { self.requestingToken = false }
      }
    }
  }
  private func finishToken(_ token: String?) {
    let waiting = waiters; waiters.removeAll(); requestingToken = false
    for (_, waiter) in waiting { waiter.1.resume(returning: current(waiter.0) ? token : nil) }
  }
  func registered(_ data: Data) {
    guard configured else { return }
    let value = data.map { String(format: "%02x", $0) }.joined()
    let changed = token != nil && token != value
    token = value; registrationRetry.succeeded(); finishToken(value)
    if changed, let document, current(document) {
      Task { let value = await self.state(document: document, requestPermission: false)
        if self.current(document) { self.emit?(document, value) }
      }
    }
  }
  func refresh() {
    guard let document, current(document) else { return }
    registrationRetry.retry(at: Date())
    Task { let state = await self.state(document: document, requestPermission: false)
      if self.current(document) { self.emit?(document, state) }
    }
  }
  func registrationFailed() { registrationRetry.failed(at: Date()); token = nil; finishToken(nil) }
  // The common renderer owns foreground sounds/alerts, so remote APNs never duplicates them.
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    let localTest = notification.request.identifier == "calab-notification-test" && !(notification.request.trigger is UNPushNotificationTrigger)
    completionHandler(localTest ? [.banner, .sound] : [])
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    let data = response.notification.request.content.userInfo
    Task { @MainActor in
      defer { completionHandler() }
      guard response.actionIdentifier == UNNotificationDefaultActionIdentifier, self.configured,
        data["v"] as? Int == 1, data["kind"] as? String == "message",
        let binding = data["binding"] as? String, let event = data["eventId"] as? String,
        UUID(uuidString: binding) != nil, UUID(uuidString: event) != nil,
        let expires = data["expiresAt"] as? NSNumber, expires.doubleValue > Date().timeIntervalSince1970 * 1000 else { return }
      self.pendingTap = ["binding": binding, "eventId": event, "expiresAt": expires.int64Value]
      if let document = self.document, self.current(document) {
        let state = await self.state(document: document, requestPermission: false)
        if self.current(document) { self.emit?(document, state) }
      }
    }
  }
}
