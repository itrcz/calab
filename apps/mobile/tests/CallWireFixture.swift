import Foundation

@main
struct CallWireFixture {
  static func main() throws {
    let now = calabCallMilliseconds(Date(timeIntervalSince1970: 1790000000.123456))
    let actions = ["ring", "answer", "end", "mute", "unmute"].map { action in
      ["binding": "11111111-1111-4111-8111-111111111111",
       "eventId": "22222222-2222-4222-8222-222222222222",
       "actionId": UUID().uuidString.lowercased(), "action": action,
       "expiresAt": now + 10000] as [String: Any]
    }
    let data = try JSONSerialization.data(withJSONObject: ["supported": true, "actions": actions])
    print(String(decoding: data, as: UTF8.self))
  }
}
