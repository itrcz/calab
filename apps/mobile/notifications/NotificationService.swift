import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var pending: NotificationCompletion?
  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let delivery = NotificationCompletion(request.content, contentHandler)
    pending = delivery
    CalabCommunication.message(request.content) { delivery.finish($0) }
  }
  override func serviceExtensionTimeWillExpire() { pending?.finish() }
}

/** Timeout and asynchronous donation can race; each APNs request completes exactly once. */
private final class NotificationCompletion {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private let fallback: UNNotificationContent
  init(_ content: UNNotificationContent, _ handler: @escaping (UNNotificationContent) -> Void) {
    fallback = content; self.handler = handler
  }
  func finish(_ content: UNNotificationContent? = nil) {
    lock.lock(); let callback = handler; handler = nil; lock.unlock()
    callback?(content ?? fallback)
  }
}
