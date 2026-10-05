import ActivityKit

// Compiled into the module and extension from this one source, no App Group or shared files.
public struct CalabVoiceAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var status: String
    public var muted: Bool
    public var language: String
  }
  public var generation: Int
}
