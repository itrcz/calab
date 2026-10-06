import Foundation
import Intents
import UserNotifications
import ImageIO

/** Shared native OS presentation adapter, also compiled into the notification extension. */
enum CalabCommunication {
  private static func person(_ payload: CalabCommunicationPayload, name: String) -> INPerson {
    var avatar: INImage?
    if let data = payload.avatar, let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetType(source) as String? == "public.jpeg",
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 64, height <= 64 {
      avatar = INImage(imageData: data)
    }
    return INPerson(personHandle: INPersonHandle(value: payload.personID, type: .unknown),
      nameComponents: nil, displayName: name, image: avatar, contactIdentifier: nil,
      customIdentifier: payload.personID)
  }

  static func message(_ content: UNNotificationContent, completion: @escaping (UNNotificationContent) -> Void) {
    guard content.userInfo["kind"] as? String == "message",
      let payload = CalabCommunicationPayload(content.userInfo), let conversation = payload.conversationID else {
      completion(content); return
    }
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
      content: content.body, speakableGroupName: nil, conversationIdentifier: conversation,
      serviceName: nil, sender: person(payload, name: content.title), attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { error in
      guard error == nil, let updated = try? content.updating(from: intent),
        let result = updated.mutableCopy() as? UNMutableNotificationContent else { completion(content); return }
      // Intents may decorate presentation, but must not replace our opaque tap/sound contract.
      result.userInfo = content.userInfo; result.categoryIdentifier = content.categoryIdentifier
      result.threadIdentifier = conversation; result.sound = content.sound
      result.subtitle = content.subtitle
      completion(result)
    }
  }

  static func call(_ raw: [AnyHashable: Any], name: String) {
    guard raw["kind"] as? String == "call", let payload = CalabCommunicationPayload(raw) else { return }
    let intent = INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil,
      audioRoute: .unknown, destinationType: .normal,
      contacts: [person(payload, name: name)], callCapability: .audioCall)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate(completion: nil)
  }
  static func clear() { INInteraction.deleteAll(completion: nil) }
}
