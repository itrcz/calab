import Foundation
import Security
import WidgetKit
import CryptoKit

func calabCalendarBinding(_ raw: String) -> String? {
  let parts = raw.split(separator: ":")
  guard parts.count == 2, UUID(uuidString: String(parts[0])) != nil, UUID(uuidString: String(parts[1])) != nil else { return nil }
  return SHA256.hash(data: Data(raw.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
}

struct CalabCalendarCredential: Codable {
  let token: String
  let expiresAt: Date
  var binding: String? {
    let parts = token.split(separator: ".")
    guard parts.count == 3 else { return nil }
    var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
    guard let data = Data(base64Encoded: encoded), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let user = value["sub"] as? String, let session = value["sid"] as? String else { return nil }
    return calabCalendarBinding(user + ":" + session)
  }
  var fingerprint: String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined() }
}

struct CalabCalendarSnapshot {
  let agenda: CalabCalendarAgenda?
  let signedIn: Bool
}

/// Only the narrow calendar grant is in Keychain. The App Group stores display data and a generation.
final class CalabCalendarStore {
  let disk: CalabCalendarDisk
  let origin: URL
  let accessGroup: String
  let scheme: String

  static func configured() -> CalabCalendarStore? {
    let b = Bundle.main
    guard let group = b.object(forInfoDictionaryKey: "CalabCalendarAppGroup") as? String,
      let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
      let access = b.object(forInfoDictionaryKey: "CalabCalendarKeychainGroup") as? String,
      access.range(of: "^[A-Z0-9]{10}\\.", options: .regularExpression) != nil,
      let raw = b.object(forInfoDictionaryKey: "CalabCalendarOrigin") as? String,
      let origin = URL(string: raw), origin.scheme == "https", origin.host != nil,
      origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
      origin.path.isEmpty || origin.path == "/",
      let scheme = b.object(forInfoDictionaryKey: "CalabCalendarScheme") as? String
    else { return nil }
    return CalabCalendarStore(directory: dir, origin: origin, accessGroup: access, scheme: scheme)
  }

  init(directory: URL, origin: URL, accessGroup: String, scheme: String) {
    disk = CalabCalendarDisk(directory: directory); self.origin = origin; self.accessGroup = accessGroup; self.scheme = scheme
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "CalabCalendarWidget.v1",
      kSecAttrAccount as String: "grant", kSecAttrAccessGroup as String: accessGroup,
      kSecAttrSynchronizable as String: false]
  }

  private func removeCredential() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw CalabCalendarError.unavailable }
  }

  private func credential() throws -> CalabCalendarCredential? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data, data.count <= 8192 else { throw CalabCalendarError.unavailable }
    return try CalabCalendarAgenda.decoder().decode(CalabCalendarCredential.self, from: data)
  }

  private func ensureInstallation(_ state: inout CalabCalendarDisk.State?) throws {
    if state == nil {
      // Keychain survives uninstall. A new installation must never inherit an old agenda.
      try removeCredential()
      state = CalabCalendarDisk.State()
    }
  }

  func bind(_ raw: String) throws -> Bool {
    guard let binding = calabCalendarBinding(raw) else { throw CalabCalendarError.invalid }
    return try disk.locked { state in
      try ensureInstallation(&state)
      guard let c = try credential(), c.binding == binding, state?.binding == binding, c.expiresAt > Date() else {
        try removeCredential(); state = CalabCalendarDisk.State(binding: binding); return false
      }
      return c.expiresAt > Date().addingTimeInterval(3600)
    }
  }

  func configure(token: String, expiresAt: Date) throws {
    guard !token.isEmpty, token.utf8.count <= 2048, expiresAt > Date(), expiresAt <= Date().addingTimeInterval(31 * 86400) else { throw CalabCalendarError.invalid }
    let value = CalabCalendarCredential(token: token, expiresAt: expiresAt)
    try disk.locked { state in
      try ensureInstallation(&state)
      guard let binding = value.binding, state?.binding == binding else { throw CalabCalendarError.invalid }
      if state?.fingerprint == value.fingerprint { return }
      // Publish a new generation before accepting any result for the previous credential.
      try removeCredential()
      var q = query
      q[kSecValueData as String] = try CalabCalendarAgenda.encoder().encode(value)
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw CalabCalendarError.unavailable }
      state = CalabCalendarDisk.State(binding: binding, fingerprint: value.fingerprint, agenda: state?.agenda)
    }
  }

  func clear(generation: String? = nil) throws {
    try disk.locked { state in
      try ensureInstallation(&state)
      if let generation, state?.generation != generation { return }
      try removeCredential(); state = CalabCalendarDisk.State()
    }
  }

  func snapshot(now: Date = Date()) throws -> CalabCalendarSnapshot {
    try disk.locked { state in
      try ensureInstallation(&state)
      guard let c = try credential(), c.expiresAt > now, c.fingerprint == state?.fingerprint else {
        try removeCredential(); state?.forgetCredential(); return CalabCalendarSnapshot(agenda: nil, signedIn: false)
      }
      let agenda = state?.agenda
      return CalabCalendarSnapshot(agenda: agenda?.isUsable(at: now, timezone: TimeZone.current.identifier) == true ? agenda : nil, signedIn: true)
    }
  }

  struct Fetch {
    let credential: CalabCalendarCredential
    let generation: String
    let timezone: String
  }

  func markDirty() throws { try disk.locked { state in state?.dirty = true } }
  func retryDelay(now: Date = Date()) throws -> TimeInterval? {
    try disk.locked { state in
      guard state?.dirty == true, state?.fingerprint != nil else { return nil }
      return max(1, 30 - now.timeIntervalSince(state?.attemptedAt ?? .distantPast))
    }
  }

  func claimFetch(force: Bool, now: Date = Date()) throws -> Fetch? {
    try disk.locked { state in
      try ensureInstallation(&state)
      guard let c = try credential(), c.expiresAt > now, let current = state, current.fingerprint == c.fingerprint else { return nil }
      let zone = TimeZone.current.identifier
      if !force, current.dirty != true, let agenda = current.agenda, agenda.isUsable(at: now, timezone: zone), now.timeIntervalSince(agenda.generatedAt) < 15 * 60 { return nil }
      // Coalesce processes/families; a crash leaves only a short retry delay.
      if let last = current.attemptedAt, now.timeIntervalSince(last) < 30 { return nil }
      state?.attemptedAt = now
      state?.dirty = false
      return Fetch(credential: c, generation: current.generation, timezone: zone)
    }
  }

  func request(_ fetch: Fetch) -> URLRequest? {
    var c = URLComponents(url: origin.appendingPathComponent("api/calendar-widget"), resolvingAgainstBaseURL: false)
    c?.queryItems = [URLQueryItem(name: "tz", value: fetch.timezone)]
    guard let url = c?.url else { return nil }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.setValue("Bearer " + fetch.credential.token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }
}

/// Bounded streaming response, no cookies/cache/redirects. Never log the request or grant.
private final class CalabCalendarRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  var data = Data()
  var response: HTTPURLResponse?
  var continuation: CheckedContinuation<(Int, Data), Error>?
  static func run(_ request: URLRequest) async throws -> (Int, Data) {
    let delegate = CalabCalendarRequest()
    return try await withCheckedThrowingContinuation { continuation in
      delegate.continuation = continuation
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
      config.timeoutIntervalForResource = 20
      let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
      session.dataTask(with: request).resume()
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    self.response = response as? HTTPURLResponse
    completionHandler(response.expectedContentLength > 262_144 ? .cancel : .allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if self.data.count + data.count > 262_144 { dataTask.cancel(); return }
    self.data.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    defer { continuation = nil; session.finishTasksAndInvalidate() }
    if let error { continuation?.resume(throwing: error) }
    else if let response { continuation?.resume(returning: (response.statusCode, data)) }
    else { continuation?.resume(throwing: CalabCalendarError.unavailable) }
  }
}

actor CalabCalendarLoader {
  static let shared = CalabCalendarLoader()
  private var pending: Task<CalabCalendarSnapshot, Never>?
  private var retry: Task<Void, Never>?

  func load(force: Bool = false) async -> CalabCalendarSnapshot {
    if force { try? CalabCalendarStore.configured()?.markDirty() }
    if let pending {
      _ = await pending.value
      // A new account can configure while the old fetch is suspended. The disk claim
      // coalesces normal callers but lets the new generation fetch immediately.
      return await fetch(force: false)
    }
    let task = Task { await self.fetch(force: force) }
    pending = task
    let result = await task.value
    pending = nil
    return result
  }

  private func fetch(force: Bool) async -> CalabCalendarSnapshot {
    guard let store = CalabCalendarStore.configured() else { return CalabCalendarSnapshot(agenda: nil, signedIn: false) }
    do {
      if let fetch = try store.claimFetch(force: force), let request = store.request(fetch) {
        let (status, data) = try await CalabCalendarRequest.run(request)
        if status == 401 || status == 403 { try store.clear(generation: fetch.generation) }
        else if status == 200 {
          let agenda = try CalabCalendarAgenda.decode(data)
          guard agenda.timezone == fetch.timezone, agenda.validUntil <= fetch.credential.expiresAt else { throw CalabCalendarError.invalid }
          try store.disk.commit(agenda, generation: fetch.generation, fingerprint: fetch.credential.fingerprint)
        }
      }
    } catch { /* Optional surface: keep only the still-valid cache after a transient failure. */ }
    if retry == nil, let delay = try? store.retryDelay() {
      retry = Task {
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        self.retry = nil
        _ = await self.load()
        for kind in ["CalabCalendarTodayTomorrow", "CalabCalendarNext", "CalabCalendarAgenda", "CalabCalendarLock"] { WidgetCenter.shared.reloadTimelines(ofKind: kind) }
      }
    }
    return (try? store.snapshot()) ?? CalabCalendarSnapshot(agenda: nil, signedIn: false)
  }
}
