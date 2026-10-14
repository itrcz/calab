import Foundation

/** Routing dictionaries may survive reload; a report/media claim never does. */
final class CalabCallReports {
 struct Ticket: Equatable { let id: UUID; let scope: String; let runtime: UInt; let attempt: UUID }
 private var reports: [UUID: (Ticket, Bool)] = [:]
 func begin(_ id: UUID, _ scope: String, _ runtime: UInt) throws -> Ticket? {
  if let (ticket, settled) = reports[id], ticket.runtime == runtime {
   guard ticket.scope == scope else { throw NSError(domain:"CalabCalls",code:2) }
   guard settled else { throw NSError(domain:"CalabCalls",code:7) }
   return nil
  }
  let ticket = Ticket(id:id,scope:scope,runtime:runtime,attempt:UUID())
  reports[id] = (ticket,false);return ticket
 }
 @discardableResult func complete(_ ticket: Ticket, _ success: Bool) -> Bool {
  guard reports[ticket.id]?.0 == ticket else { return false }
  if success { reports[ticket.id]=(ticket,true) } else { reports.removeValue(forKey:ticket.id) }
  return true
 }
 func settled(_ id: UUID, _ scope: String, _ runtime: UInt) -> Bool {
  guard let (ticket, settled)=reports[id] else {return false}
  return settled && ticket.scope==scope && ticket.runtime==runtime
 }
 func adoptRouting(_ id:UUID,_ scope:String,_ runtime:UInt)->Bool {
  guard runtime>0,let (ticket,settled)=reports[id],settled,ticket.runtime==0,ticket.scope==scope else{return false}
  reports[id]=(Ticket(id:id,scope:scope,runtime:runtime,attempt:UUID()),true);return true
 }
 func retire(_ runtime: UInt) { reports=reports.filter {$0.value.0.runtime != runtime} }
 func remove(_ id: UUID) { reports.removeValue(forKey:id) }
 func contains(_ id:UUID)->Bool {reports[id] != nil}
}
