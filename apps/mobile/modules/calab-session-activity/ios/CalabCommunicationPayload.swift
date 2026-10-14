import Foundation

/** Presentation only. No URL, credential, navigation or call authority can come from here. */
struct CalabCommunicationPayload {
  let personID: String
  let conversationID: String?
  let avatar: Data?

  init?(_ raw: [AnyHashable: Any]) {
    guard raw["v"] as? Int == 1, let person = raw["personId"] as? String,
      Self.identifier(person), ["message", "call"].contains(raw["kind"] as? String ?? "") else { return nil }
    personID = person
    let conversation = raw["conversationId"] as? String
    conversationID = conversation.flatMap { Self.identifier($0) ? $0 : nil }
    if raw["kind"] as? String == "message", conversationID == nil { return nil }
    if let value = raw["avatarJpeg"] as? String, value.utf8.count <= 2048,
      let bytes = Data(base64Encoded: value), bytes.count <= 1536 { avatar = bytes }
    else { avatar = nil }
  }
  private static func identifier(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
}
