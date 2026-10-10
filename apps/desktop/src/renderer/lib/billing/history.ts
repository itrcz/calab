import { LedgerEntryKind, Plan, type LedgerEntry } from '@calaba/protocol';

/**
 * The owner history groups the entries of one operation (owner, 10.10: a plan change looked like
 * «charge + refund»): the seat charge of an activation / plan change / paid resume and the
 * compensation of the previous plan share LedgerEntry.operation_id, and show as one row with their
 * sum, expandable to the entries. The ledger itself stays append-only and unchanged.
 */

export type LedgerItem =
  | { kind: 'entry'; entry: LedgerEntry }
  | { kind: 'op'; id: string; op: 'change' | 'activate' | 'resume'; from: Plan; to: Plan; total: bigint; currency: string; entries: readonly LedgerEntry[] };

const skuPlan = (sku: string): Plan => (sku.includes('enterprise') ? Plan.ENTERPRISE : sku.includes('team') ? Plan.TEAM : Plan.UNSPECIFIED);

/** Entries (newest first, as the API pages them) → rows; an operation's entries are consecutive. */
export function groupLedger(entries: readonly LedgerEntry[]): LedgerItem[] {
  const out: LedgerItem[] = [];
  for (let i = 0; i < entries.length; ) {
    const e = entries[i];
    if (!e) break;
    const id = e.operationId;
    let j = i + 1;
    while (id && j < entries.length && entries[j]?.operationId === id) j++;
    if (!id || j - i < 2) {
      out.push({ kind: 'entry', entry: e });
      i++;
      continue;
    }
    const group = entries.slice(i, j);
    const charge = group.find((x) => x.kind === LedgerEntryKind.SEAT_CHARGE);
    const comp = group.find((x) => x.kind === LedgerEntryKind.COMPENSATION);
    const reason = charge?.reason ?? '';
    out.push({
      kind: 'op',
      id,
      op: reason === 'change_plan' ? 'change' : reason === 'resume' ? 'resume' : 'activate',
      from: comp ? skuPlan(comp.sku) : Plan.UNSPECIFIED,
      to: charge ? skuPlan(charge.sku) : Plan.UNSPECIFIED,
      total: group.reduce((s, x) => s + (x.amount?.minor ?? 0n), 0n),
      currency: group[0]?.amount?.currency ?? '',
      entries: group,
    });
    i = j;
  }
  return out;
}
