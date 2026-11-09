import Foundation

@main struct BadgeWriterTest {
  @MainActor static func main() async {
    var writes: [Int] = []
    var suspended: CheckedContinuation<Void, Never>?
    let writer = CalabBadgeWriter { count in
      writes.append(count)
      if writes.count == 1 { await withCheckedContinuation { suspended = $0 } }
    }
    writer.set(7)
    while suspended == nil { await Task.yield() }
    writer.set(9)
    writer.set(0) // logout must be last, even if an older OS operation is in flight
    writer.set(-1)
    writer.set(100000)
    suspended?.resume()
    for _ in 0..<100 { await Task.yield() }
    precondition(writes == [7, 0], "stale count overtook logout or an invalid count was accepted")
    writer.set(3)
    for _ in 0..<100 { await Task.yield() }
    precondition(writes == [7, 0, 3])
    print("badge writer: serialized, coalesced, zero clears, invalid rejected")
  }
}
