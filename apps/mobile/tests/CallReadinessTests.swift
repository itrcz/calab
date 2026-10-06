import Foundation

@main
struct CallReadinessTests {
  static func main() {
    let id = UUID(), other = UUID()
    for order in [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]] {
      var state = CalabCallReadiness()
      for (index, event) in order.enumerated() {
        if event == 0 { state.accepted.insert(id) }
        if event == 1 { state.connected.insert(id) }
        if event == 2 { state.audioActive = true }
        precondition(state.ready.contains(id) == (index == 2), "lost or premature readiness: \(order)")
      }
      state.connected.insert(other)
      precondition(!state.ready.contains(other), "media alone cannot accept a call")
      state.remove(id)
      precondition(state.ready.isEmpty, "ended call retained readiness")
      state.accepted.insert(id)
      precondition(state.ready.isEmpty, "new answer inherited old media")
    }
    precondition(calabCallerName(nil) == "Calab")
    precondition(calabCallerName(123) == "Calab")
    precondition(calabCallerName("  Илья  ") == "Илья")
    precondition(calabCallerName("\u{202e}Илья") == "Илья")
    precondition(calabCallerName(String(repeating: "я", count: 100)).count == 80)
    print("Call readiness: six event orders, teardown isolation and caller presentation passed")
  }
}
