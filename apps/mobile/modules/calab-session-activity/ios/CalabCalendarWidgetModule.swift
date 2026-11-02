import ExpoModulesCore
import Foundation
import UIKit
import WidgetKit

public class CalabCalendarWidgetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabCalendarWidget")
    Function("scheme") { CalabCalendarStore.configured()?.scheme ?? "" }
    Function("isSupported") { CalabCalendarStore.configured() != nil }
    OnCreate { Task { @MainActor in CalabCalendarController.shared.install() } }
    AsyncFunction("bind") { (document: String, binding: String) -> Bool in
      MainActor.assumeIsolated { CalabCalendarController.shared.bind(document: document, binding: binding) }
    }.runOnQueue(.main)
    AsyncFunction("configure") { (document: String, token: String, expiresAt: String) -> Bool in
      MainActor.assumeIsolated { CalabCalendarController.shared.configure(document: document, token: token, expiresAt: expiresAt) }
    }.runOnQueue(.main)
    AsyncFunction("refresh") { (document: String, promise: Promise) in
      MainActor.assumeIsolated { CalabCalendarController.shared.refresh(document: document, promise: promise) }
    }.runOnQueue(.main)
    AsyncFunction("clear") { (document: String) -> Bool in
      MainActor.assumeIsolated { CalabCalendarController.shared.clear(document: document) }
    }.runOnQueue(.main)
  }
}

@MainActor
private final class CalabCalendarController {
  static let shared = CalabCalendarController()
  private weak var owner: AnyObject?
  private var document: String?
  private var observers: [NSObjectProtocol] = []
  private func current(_ value: String) -> Bool { owner != nil && document == value }

  func install() {
    guard observers.isEmpty else { return }
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentGranted"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated { self.owner = notice.object as AnyObject?; self.document = notice.userInfo?["document"] as? String }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentInvalidated"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated { if let view = notice.object as AnyObject?, self.owner === view { self.owner = nil; self.document = nil } }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostSessionCleared"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        if let view = notice.object as AnyObject?, self.owner === view {
          // Synchronous native logout precedes RN messages/document revocation in the WebView patch.
          try? CalabCalendarStore.configured()?.clear()
          self.reload()
        }
      }
    })
    for name in [UIApplication.didBecomeActiveNotification, NSNotification.Name.NSSystemTimeZoneDidChange] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
        Task { @MainActor in
          _ = await CalabCalendarLoader.shared.load()
          self.reload()
        }
      })
    }
  }

  func bind(document: String, binding: String) -> Bool {
    guard current(document), let store = CalabCalendarStore.configured() else { return false }
    do { let valid = try store.bind(binding); if !valid { reload() }; return valid } catch { return false }
  }
  func configure(document: String, token: String, expiresAt: String) -> Bool {
    guard current(document), let store = CalabCalendarStore.configured(),
      let encoded = try? JSONEncoder().encode(expiresAt),
      let date = try? CalabCalendarAgenda.decoder().decode(Date.self, from: encoded) else { return false }
    do { try store.configure(token: token, expiresAt: date) } catch { return false }
    Task { _ = await CalabCalendarLoader.shared.load(force: true); reload() }
    return true
  }
  func refresh(document: String, promise: Promise) {
    guard current(document) else { promise.resolve(false); return }
    Task {
      let result = await CalabCalendarLoader.shared.load(force: true)
      reload()
      promise.resolve(current(document) && result.signedIn)
    }
  }
  func clear(document: String) -> Bool {
    guard current(document) else { return false }
    do { try CalabCalendarStore.configured()?.clear(); reload(); return true } catch { return false }
  }
  private func reload() {
    for kind in ["CalabCalendarTodayTomorrow", "CalabCalendarNext", "CalabCalendarAgenda", "CalabCalendarLock"] {
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
  }
}
