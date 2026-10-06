import ExpoModulesCore
import PushKit
import CallKit
import AVFAudio

public class CalabIncomingCallsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabIncomingCalls")
    Events("onCallsChanged")
    OnCreate {
      Task { @MainActor in
        CalabIncomingCalls.shared.install()
        CalabIncomingCalls.shared.emit = { [weak self] document, state in
          self?.sendEvent("onCallsChanged", ["document": document, "state": state])
        }
      }
    }
    AsyncFunction("callsState") { (document: String) -> [String: Any] in await CalabIncomingCalls.shared.state(document) }
    AsyncFunction("bindCalls") { (document: String, binding: String, version: String, token: String) -> Bool in
      await CalabIncomingCalls.shared.bind(document, binding, version, token)
    }
    AsyncFunction("settleCall") { (document: String, action: String, result: String) in await CalabIncomingCalls.shared.settle(document, action, result) }
    AsyncFunction("syncCall") { (document: String, event: String, phase: String) in await CalabIncomingCalls.shared.sync(document, event, phase) }
  }
}

/** Register before a React scene exists; cold Host startup stays Expo's responsibility. */
public class CalabIncomingCallsSubscriber: ExpoAppDelegateSubscriber {
  public func subscriberDidRegister() { CalabIncomingCalls.shared.install() }
}

private final class CallCompletion {
  private let lock = NSLock()
  private var completed = false
  private let callback: () -> Void
  init(_ callback: @escaping () -> Void) { self.callback = callback }
  func finish() { lock.lock(); let first = !completed; completed = true; lock.unlock(); if first { callback() } }
}

@MainActor
private final class CalabIncomingCalls: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = CalabIncomingCalls()
  var emit: ((String, [String: Any]) -> Void)?
  private weak var owner: AnyObject?
  private var document: String?
  private var registry: PKPushRegistry?
  private var provider: CXProvider?
  private var token: String?
  private var observers: [NSObjectProtocol] = []
  private let reports = CalabCallReports()
  private var actions: [String: [String: Any]] = [:]
  private var calls: [UUID: [String: Any]] = [:]
  private var answers: [UUID: CXAnswerCallAction] = [:]
  private var ends: [UUID: CXEndCallAction] = [:]
  private var deadlines: [UUID: Task<Void, Never>] = [:]
  private var readiness = CalabCallReadiness()
  private let callController = CXCallController()
  private var muteActions: [UUID: CXSetMutedCallAction] = [:]
  private var muteDeadlines: [UUID: Task<Void, Never>] = [:]
  private var muteTransactions: [UUID: UUID] = [:]
  private var nativeMuted: [UUID: Bool] = [:]
  private var desiredMuted: [UUID: Bool] = [:]
  private let storage = UserDefaults.standard
  private let bindingKey = "CalabVoIPBinding"
  private var environment: String? {
    let value = Bundle.main.object(forInfoDictionaryKey: "CalabMessagePushEnvironment") as? String
    return value == "development" || value == "production" ? value : nil
  }
  private var configured: Bool { Bundle.main.object(forInfoDictionaryKey: "CalabIncomingCallsEnabled") as? Bool == true && environment != nil }
  private var installation: String {
    if let id = storage.string(forKey: "CalabPushInstallation"), UUID(uuidString: id) != nil { return id }
    let id = UUID().uuidString.lowercased(); storage.set(id, forKey: "CalabPushInstallation"); return id
  }
  private var now: Double { Date().timeIntervalSince1970 * 1000 }
  private var binding: [String: Any]? {
    guard let b = storage.dictionary(forKey: bindingKey), (b["expires"] as? Double ?? 0) > now else { storage.removeObject(forKey: bindingKey); return nil }
    return b
  }
  func install() {
    guard observers.isEmpty else { return }
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentGranted"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated { self.owner = notice.object as AnyObject?; self.document = notice.userInfo?["document"] as? String; self.changed() }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostSessionCleared"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        guard let view = notice.object as AnyObject?, self.owner === view else { return }
        // Synchronous logout boundary, before the WebView grants another document.
        self.storage.removeObject(forKey: self.bindingKey); self.endAll()
      }
    })
    observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("CalabHostDocumentInvalidated"), object: nil, queue: .main) { notice in
      MainActor.assumeIsolated {
        guard let view = notice.object as AnyObject?, self.owner === view else { return }
        self.owner = nil; self.document = nil
        // Reload preserves an incoming receipt; accepted media cannot survive a dead document.
        for id in Array(self.readiness.accepted) { self.end(id, .failed) }
      }
    })
    guard configured else { return }
    let config = CXProviderConfiguration()
    config.supportsVideo = false; config.maximumCallsPerCallGroup = 1; config.maximumCallGroups = 1
    config.supportedHandleTypes = [.generic]; config.includesCallsInRecents = false
    let p = CXProvider(configuration: config); p.setDelegate(self, queue: .main); provider = p
    let r = PKPushRegistry(queue: .main); r.delegate = self; registry = r; r.desiredPushTypes = [.voIP]
  }
  private func current(_ doc: String) -> Bool { owner != nil && document == doc }
  func state(_ doc: String) -> [String: Any] {
    guard current(doc), configured, registry != nil, provider != nil else { return ["supported": false] }
    var value: [String: Any] = ["supported": true, "audioActive": readiness.audioActive, "actions": Array(actions.values).filter { ($0["expiresAt"] as? Double ?? 0) > now }]
    if let token, let app = Bundle.main.bundleIdentifier, let environment {
      value["token"] = token; value["appId"] = app; value["environment"] = environment; value["installationId"] = installation
    }
    return value
  }
  func bind(_ doc: String, _ id: String, _ version: String, _ value: String) -> Bool {
    guard current(doc), configured, UUID(uuidString: id) != nil, (UInt64(version) ?? 0) > 0, value == token else { return false }
    if binding?["id"] as? String != id || binding?["version"] as? String != version { endAll() }
    storage.set(["id": id, "version": version, "token": value, "expires": now + 28 * 86400000], forKey: bindingKey)
    return true
  }
  private func changed() { if let document, current(document) { emit?(document, state(document)) } }
  private func enqueue(_ id: UUID, _ action: String, expires: Double) {
    guard let call = calls[id], actions.count < 8 else { end(id, .failed); return }
    let actionID = UUID().uuidString.lowercased()
    actions[actionID] = ["binding": call["binding"]!, "eventId": id.uuidString.lowercased(), "expiresAt": expires, "actionId": actionID, "action": action]
    changed()
  }
  private func deadline(_ id: UUID, milliseconds: Double) {
    deadlines[id]?.cancel()
    deadlines[id] = Task { @MainActor in
      do { try await Task.sleep(for: .milliseconds(max(1, milliseconds))) } catch { return }
      self.end(id, .failed, notifyWeb: true); self.changed()
    }
  }
  private func end(_ id: UUID, _ reason: CXCallEndedReason, notifyWeb: Bool = false) {
    let call = calls[id]
    deadlines.removeValue(forKey: id)?.cancel()
    answers.removeValue(forKey: id)?.fail(); ends.removeValue(forKey: id)?.fail()
    readiness.remove(id)
    for (actionID, action) in Array(muteActions) where action.callUUID == id { finishMute(actionID, success: false) }
    muteTransactions = muteTransactions.filter { $0.value != id }
    nativeMuted.removeValue(forKey: id); desiredMuted.removeValue(forKey: id)
    actions = actions.filter { $0.value["eventId"] as? String != id.uuidString.lowercased() }
    if calls.removeValue(forKey: id) != nil { provider?.reportCall(with: id, endedAt: Date(), reason: reason) }
    reports.remove(id)
    if notifyWeb, let call, actions.count < 8 {
      let actionID = UUID().uuidString.lowercased()
      actions[actionID] = ["binding": call["binding"]!, "eventId": id.uuidString.lowercased(), "expiresAt": now + 10000, "actionId": actionID, "action": "end"]
    }
  }
  private func endAll(notifyWeb: Bool = false) { actions.removeAll(); for id in Array(calls.keys) { end(id, .failed, notifyWeb: notifyWeb) } }
  private func generic(_ completion: CallCompletion) {
    guard let provider else { completion.finish(); return }
    let id = UUID(); let update = CXCallUpdate(); update.localizedCallerName = "Calab"
    provider.reportNewIncomingCall(with: id, update: update) { _ in
      provider.reportCall(with: id, endedAt: Date(), reason: .failed); completion.finish()
    }
  }
  private func receive(_ raw: [AnyHashable: Any], completion: CallCompletion) {
    guard let provider else { completion.finish(); return }
    // Every must-report event reaches CallKit before JS, network or session restoration.
    guard raw["v"] as? Int == 1, raw["kind"] as? String == "call",
      let bindingID = raw["binding"] as? String, UUID(uuidString: bindingID) != nil,
      let event = raw["eventId"] as? String, let id = UUID(uuidString: event), id != UUID(uuidString: "00000000-0000-0000-0000-000000000000"),
      let expiry = raw["expiresAt"] as? NSNumber, expiry.doubleValue > now, expiry.doubleValue <= now + 60000,
      let binding, binding["id"] as? String == bindingID,
      token == nil || binding["token"] as? String == token else { generic(completion); return }
    if let existing = calls[id], existing["binding"] as? String == bindingID {
      // Still invoke the required OS report for this receipt using its existing UUID.
      // CallKit rejects the duplicate; it cannot create/end a second phantom call.
      let update = CXCallUpdate(); update.localizedCallerName = calabCallerName(raw["callerName"])
      provider.reportNewIncomingCall(with: id, update: update) { _ in completion.finish() }
      return
    }
    guard calls.isEmpty, let ticket = try? reports.begin(id, bindingID, 0) else { generic(completion); return }
    calls[id] = ["binding": bindingID, "expiresAt": expiry.doubleValue]
    let update = CXCallUpdate(); update.localizedCallerName = calabCallerName(raw["callerName"]); update.hasVideo = false
    update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false; update.supportsDTMF = false
    // DND is enforced by the OS and current web/server policy; no custom ringtone override.
    provider.reportNewIncomingCall(with: id, update: update) { error in
      Task { @MainActor in
        defer { completion.finish() }
        guard self.reports.complete(ticket, error == nil) else {
          if error == nil { provider.reportCall(with: id, endedAt: Date(), reason: .failed) }; return
        }
        guard error == nil, self.calls[id] != nil, self.binding?["id"] as? String == bindingID, expiry.doubleValue > self.now else { self.end(id, .failed); return }
        self.deadline(id, milliseconds: expiry.doubleValue - self.now)
        self.enqueue(id, "ring", expires: expiry.doubleValue)
      }
    }
  }
  func settle(_ doc: String, _ actionID: String, _ result: String) {
    if current(doc), let id = UUID(uuidString: actionID), let action = muteActions[id] {
      let expected = action.isMuted ? "muted" : "unmuted"
      finishMute(id, success: result == expected && (actions[actionID]?["expiresAt"] as? Double ?? 0) > now)
      return
    }
    guard current(doc), let action = actions.removeValue(forKey: actionID), let raw = action["eventId"] as? String, let id = UUID(uuidString: raw), calls[id] != nil,
      (action["expiresAt"] as? Double ?? 0) > now else { return }
    switch (action["action"] as? String, result) {
    case ("ring", "ringing"): break
    case ("answer", "accepted"):
      guard let answer = answers.removeValue(forKey: id) else { end(id, .failed); return }
      // Configure, but let CallKit activate. WebKit still owns capture and playback.
      do { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP]) }
      catch { answer.fail(); end(id, .failed, notifyWeb: true); changed(); return }
      readiness.accepted.insert(id)
      deadline(id, milliseconds: 15000)
      answer.fulfill()
      cancelReadyDeadlines()
    case ("end", "ended"):
      ends.removeValue(forKey: id)?.fulfill(); end(id, .remoteEnded)
    default: end(id, .failed)
    }
  }
  func sync(_ doc: String, _ event: String, _ phase: String) {
    guard current(doc), let id = UUID(uuidString: event), calls[id] != nil else { return }
    if phase == "muted" || phase == "unmuted" {
      desiredMuted[id] = phase == "muted"; syncMute(id); return
    }
    if phase == "ended" { end(id, .remoteEnded) }
    if phase == "connected" {
      readiness.connected.insert(id); cancelReadyDeadlines()
    }
  }
  private func cancelReadyDeadlines() {
    for id in readiness.ready { deadlines.removeValue(forKey: id)?.cancel() }
  }
  private func finishMute(_ actionID: UUID, success: Bool) {
    muteDeadlines.removeValue(forKey: actionID)?.cancel()
    actions.removeValue(forKey: actionID.uuidString.lowercased())
    guard let action = muteActions.removeValue(forKey: actionID) else { return }
    if success { nativeMuted[action.callUUID] = action.isMuted; action.fulfill() }
    else { action.fail() }
    syncMute(action.callUUID)
  }
  /** App-originated transactions acknowledge already-applied media, without a feedback loop. */
  private func syncMute(_ id: UUID) {
    guard calls[id] != nil, readiness.accepted.contains(id), let muted = desiredMuted[id],
      nativeMuted[id, default: false] != muted,
      !muteActions.values.contains(where: { $0.callUUID == id }),
      !muteTransactions.values.contains(id) else { return }
    let action = CXSetMutedCallAction(call: id, muted: muted)
    muteTransactions[action.uuid] = id
    callController.request(CXTransaction(action: action)) { error in
      if error != nil { Task { @MainActor in self.muteTransactions.removeValue(forKey: action.uuid) } }
    }
  }
  nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    MainActor.assumeIsolated {
      let id = action.callUUID
      if self.muteTransactions.removeValue(forKey: action.uuid) != nil {
        if self.calls[id] != nil && self.readiness.accepted.contains(id) && self.desiredMuted[id] == action.isMuted {
          self.nativeMuted[id] = action.isMuted; action.fulfill()
        } else { action.fail() }
        self.syncMute(id); return
      }
      guard self.calls[id] != nil, self.readiness.accepted.contains(id), self.desiredMuted[id] != nil,
        !self.muteActions.values.contains(where: { $0.callUUID == id }), !self.muteTransactions.values.contains(id), self.actions.count < 8,
        let call = self.calls[id] else { action.fail(); return }
      self.muteActions[action.uuid] = action
      self.actions[action.uuid.uuidString.lowercased()] = ["binding": call["binding"]!, "eventId": id.uuidString.lowercased(),
        "expiresAt": self.now + 10000, "actionId": action.uuid.uuidString.lowercased(), "action": action.isMuted ? "mute" : "unmute"]
      self.muteDeadlines[action.uuid] = Task { @MainActor in
        do { try await Task.sleep(for: .seconds(10)) } catch { return }
        self.finishMute(action.uuid, success: false)
      }
      self.changed()
    }
  }
  nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    MainActor.assumeIsolated {
      guard registry === self.registry, type == .voIP else { return }
      let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
      if let old = self.binding?["token"] as? String, old != token { self.storage.removeObject(forKey: self.bindingKey); self.endAll() }
      self.token = token; self.changed()
    }
  }
  nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    MainActor.assumeIsolated { guard registry === self.registry, type == .voIP else { return }; self.token = nil; self.storage.removeObject(forKey: self.bindingKey); self.endAll(); self.changed() }
  }
  nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let once = CallCompletion(completion)
    MainActor.assumeIsolated {
      guard registry === self.registry, type == .voIP else { once.finish(); return }
      self.receive(payload.dictionaryPayload, completion: once)
    }
  }
  nonisolated func providerDidReset(_ provider: CXProvider) { MainActor.assumeIsolated { self.endAll(notifyWeb: true); self.readiness.audioActive = false; self.changed() } }
  nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    MainActor.assumeIsolated {
      guard self.calls[action.callUUID] != nil, self.answers[action.callUUID] == nil else { action.fail(); return }
      self.answers[action.callUUID] = action; self.deadline(action.callUUID, milliseconds: 10000)
      self.enqueue(action.callUUID, "answer", expires: self.now + 10000)
    }
  }
  nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    MainActor.assumeIsolated {
      guard self.calls[action.callUUID] != nil else { action.fulfill(); return }
      self.ends[action.callUUID] = action; self.deadline(action.callUUID, milliseconds: 10000)
      self.enqueue(action.callUUID, "end", expires: self.now + 10000)
    }
  }
  nonisolated func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    MainActor.assumeIsolated {
      if let action = action as? CXSetMutedCallAction {
        self.muteTransactions.removeValue(forKey: action.uuid)
        self.finishMute(action.uuid, success: false)
      } else if let action = action as? CXCallAction { self.end(action.callUUID, .failed, notifyWeb: true); self.changed() }
    }
  }
  nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    MainActor.assumeIsolated {
      self.readiness.audioActive = true; self.cancelReadyDeadlines(); self.changed()
    }
  }
  nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    MainActor.assumeIsolated { self.readiness.audioActive = false; self.changed() }
  }
}
