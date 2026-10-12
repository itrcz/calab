import { create } from 'zustand';
import type { MailAddress, MailDraft } from '../../shared/mail';
import { useBoardsUi } from './boardsUi';
import { useWebApps } from './webApps';

/**
 * The «Почта» section's shell state (ADR-0088 §8): whether the mail mode covers the column and the
 * centre, the add-account form (with a deep-link prefill, §12) and the composer request. Not
 * persisted: the app starts on the section it left by the other stores (mail is not remembered per
 * workspace, like «Личные»). The mail data itself lives in stores/mail.ts.
 *
 * Exclusive with the other modes: a room / DM / day / board / web app opened from anywhere turns
 * mail off — the boards and web apps through the subscriptions below, rooms and days in stores/ui.ts.
 */

/** What the composer opens with. `seq` makes a repeated request (the same reply twice) a new one. */
export type ComposeRequest =
  | { kind: 'new'; accountId?: string; to?: MailAddress[]; cc?: MailAddress[]; subject?: string; text?: string; seq: number }
  | { kind: 'reply' | 'replyAll' | 'forward'; messageId: string; seq: number }
  | { kind: 'draft'; draft: MailDraft; seq: number };

/** Prefill of the add-account form from `calab://mail/<payload>` (§12). Lives in memory only; never logged. */
export interface AddPrefill {
  email: string;
  password: string;
  seq: number;
}

interface MailUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  /** The add-account card is shown in the centre (also the empty state without accounts). */
  adding: boolean;
  prefill: AddPrefill | null;
  openAdd: (prefill?: { email: string; password: string }) => void;
  closeAdd: () => void;
  compose: ComposeRequest | null;
  openCompose: (req: DistributiveOmit<ComposeRequest, 'seq'>) => void;
  closeCompose: () => void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let seq = 0;

export const useMailUi = create<MailUiState>()((set) => ({
  active: false,
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
  adding: false,
  prefill: null,
  openAdd: (prefill) => set({ adding: true, prefill: prefill ? { ...prefill, seq: ++seq } : null }),
  closeAdd: () => set({ adding: false, prefill: null }),
  compose: null,
  openCompose: (req) => set({ compose: { ...req, seq: ++seq } }),
  closeCompose: () => set({ compose: null }),
}));

/** Turns the mail mode off (a room, a day, a workspace opened from anywhere). */
export function leaveMail(): void {
  if (useMailUi.getState().active) useMailUi.getState().setActive(false);
}

useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveMail();
});
useWebApps.subscribe((s, prev) => {
  if (s.open && s.open !== prev.open) leaveMail();
});
