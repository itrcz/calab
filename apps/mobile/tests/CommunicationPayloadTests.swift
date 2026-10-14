import Foundation

@main
struct CommunicationPayloadTests {
  static func main() {
    let person = String(repeating: "a", count: 64), conversation = String(repeating: "b", count: 64)
    var raw: [AnyHashable: Any] = ["v": 1, "kind": "message", "personId": person, "conversationId": conversation]
    precondition(CalabCommunicationPayload(raw)?.conversationID == conversation)
    raw["avatarJpeg"] = Data([0xff,0xd8]).base64EncodedString()
    precondition(CalabCommunicationPayload(raw)?.avatar?.count == 2)
    raw["avatarJpeg"] = String(repeating: "a", count: 2049)
    precondition(CalabCommunicationPayload(raw)?.avatar == nil, "oversized avatar must preserve text")
    raw["avatarJpeg"] = "https://example.test/private.png"
    precondition(CalabCommunicationPayload(raw)?.avatar == nil, "never load a remote URL")
    raw["conversationId"] = ""
    precondition(CalabCommunicationPayload(raw) == nil, "message needs a stable conversation")
    raw["kind"] = "call"
    precondition(CalabCommunicationPayload(raw)?.personID == person)
    raw["personId"] = String(repeating: "z", count: 64)
    precondition(CalabCommunicationPayload(raw) == nil)
    raw["personId"] = person; raw["kind"] = "task"
    precondition(CalabCommunicationPayload(raw) == nil)
    precondition(CalabCommunicationPayload([:]) == nil, "old text-only push remains supported")
    print("Communication payload: bounded optional avatar, opaque identities and legacy fallback passed")
  }
}
