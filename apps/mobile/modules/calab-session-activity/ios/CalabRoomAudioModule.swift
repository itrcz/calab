import ExpoModulesCore

// ADR-0149 §2: the `roomAudio` bridge. JS validated the operation; it is parsed again here because
// native holds the credentials, and it acts only for the document the host granted.
public class CalabRoomAudioModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CalabRoomAudio")
    Events("onRoomAudioChanged")
    Constants(["roomAudioEnabled": calabRoomAudioEnabled])
    OnCreate {
      #if canImport(LiveKitClient) || canImport(LiveKit)
      Task { @MainActor in
        guard calabRoomAudioEnabled else { return }
        CalabRoomAudio.shared.install()
        // Paced in the driver: one latest snapshot, at least 100 ms apart, nothing queued.
        CalabRoomAudio.shared.emit = { [weak self] document, state in
          self?.sendEvent("onRoomAudioChanged", ["document": document, "state": ["supported": true, "media": state.wire]])
        }
      }
      #endif
    }
    AsyncFunction("operation") { (document: String, input: [String: Any]) in
      guard calabRoomAudioEnabled else { throw CalabRoomAudioUnavailable() }
      guard let operation = calabRoomAudioOperation(input) else { throw CalabRoomAudioInvalid() }
      #if canImport(LiveKitClient) || canImport(LiveKit)
      try await CalabRoomAudio.shared.operation(document, operation)
      #endif
    }
    AsyncFunction("state") { (document: String) -> [String: Any] in
      guard calabRoomAudioEnabled else { return ["supported": false] }
      #if canImport(LiveKitClient) || canImport(LiveKit)
      if let state = await CalabRoomAudio.shared.snapshot(for: document) { return ["supported": true, "media": state.wire] }
      #endif
      return ["supported": true]
    }
  }
}

private struct CalabRoomAudioUnavailable: Error {}
private struct CalabRoomAudioInvalid: Error {}

private var calabRoomAudioEnabled: Bool {
  #if canImport(LiveKitClient) || canImport(LiveKit)
  return CalabRoomAudio.enabled
  #else
  return false
  #endif
}
