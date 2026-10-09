import type { GetBillingResponse } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * The owner's billing summary per workspace (GET /api/workspaces/{id}/billing, ADR-0080 §13).
 * Loaded when the cabinet / paywall needs it; BILLING_UPDATE (owner only) and a changed
 * Workspace.billing mark it stale and services/billing reloads it. The data object is replaced only
 * on a load, so `useBilling((s) => s.byWs[id]?.data)` re-renders on a reload, never on a tick.
 */

export type BillingLoad =
  /** First load running (no data yet). */
  | 'loading'
  | 'ready'
  /** 501: billing is off on this server or not built yet — the owner UI renders nothing. */
  | 'unavailable'
  /** 404: no billing account for this workspace. */
  | 'none'
  | 'error';

export interface BillingEntry {
  load: BillingLoad;
  data: GetBillingResponse | null;
  /** Revision shown (BillingSummary.revision; 0 for a member's status-only answer). */
  revision: bigint;
  /** A BILLING_UPDATE with a newer revision arrived: a reload is due. */
  stale: boolean;
  error: string | null;
}

export const EMPTY_ENTRY: BillingEntry = { load: 'loading', data: null, revision: 0n, stale: false, error: null };

// ---------------------------------------------------------------- pure reducers (unit-tested)

export function beginLoad(e: BillingEntry | undefined): BillingEntry {
  if (!e) return EMPTY_ENTRY;
  // A reload keeps what is shown (no spinner flash); only the first load shows «loading».
  return e.data ? e : { ...e, load: 'loading', error: null };
}

/** A GET answered. An answer older than the revision shown (a racing reload) is dropped. */
export function applyLoaded(e: BillingEntry | undefined, data: GetBillingResponse): BillingEntry {
  const revision = data.summary?.revision ?? 0n;
  if (e?.data && e.revision > revision && revision > 0n) return { ...e, stale: false };
  return { load: 'ready', data, revision, stale: false, error: null };
}

export function applyFailed(e: BillingEntry | undefined, load: Exclude<BillingLoad, 'loading' | 'ready'>, error: string | null): BillingEntry {
  // A failed reload of a shown summary keeps it (the next update retries); a first load fails.
  if (e?.data && load === 'error') return { ...e, stale: false, error };
  return { load, data: load === 'error' ? (e?.data ?? null) : null, revision: 0n, stale: false, error };
}

/** BILLING_UPDATE{revision}: stale when newer than shown (≤ shown is ignored, proto contract). */
export function applyUpdate(e: BillingEntry | undefined, revision: bigint): BillingEntry | undefined {
  if (!e) return e;
  if (revision > 0n && revision <= e.revision) return e;
  return e.stale ? e : { ...e, stale: true };
}

// ---------------------------------------------------------------- store

interface BillingStore {
  byWs: Record<string, BillingEntry>;
  begin: (ws: string) => void;
  loaded: (ws: string, data: GetBillingResponse) => void;
  failed: (ws: string, load: Exclude<BillingLoad, 'loading' | 'ready'>, error: string | null) => void;
  /** Returns whether the entry is now stale (a reload is due). */
  update: (ws: string, revision: bigint) => boolean;
  drop: (ws: string) => void;
  reset: () => void;
}

export const useBilling = create<BillingStore>()((set, get) => ({
  byWs: {},
  begin: (ws) => set((s) => ({ byWs: { ...s.byWs, [ws]: beginLoad(s.byWs[ws]) } })),
  loaded: (ws, data) => set((s) => ({ byWs: { ...s.byWs, [ws]: applyLoaded(s.byWs[ws], data) } })),
  failed: (ws, load, error) => set((s) => ({ byWs: { ...s.byWs, [ws]: applyFailed(s.byWs[ws], load, error) } })),
  update: (ws, revision) => {
    const prev = get().byWs[ws];
    const next = applyUpdate(prev, revision);
    if (next && next !== prev) set((s) => ({ byWs: { ...s.byWs, [ws]: next } }));
    return !!next?.stale;
  },
  drop: (ws) =>
    set((s) => {
      if (!(ws in s.byWs)) return s;
      const { [ws]: _, ...rest } = s.byWs;
      return { byWs: rest };
    }),
  reset: () => set({ byWs: {} }),
}));
