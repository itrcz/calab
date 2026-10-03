import { create } from 'zustand';
import type { GrantLine } from '../lib/achievements';

/**
 * The achievement layers (ADR-0061 §5): the viewer and the grant dialog open above whatever is
 * open (the profile sheet, the superadmin window, the chat), so they live outside `useUi.dialog`
 * (one slot) and are rendered by features/people/AchievementLayers.
 */
export interface ViewRequest {
  achievementId: string;
  /** The workspace of the grants (names, «Открыть в чате»); none from the superadmin catalog. */
  workspaceId?: string;
  /** The recipient (the grants' owner). */
  userId?: string;
  /** Newest first; empty = the catalog view (title, description). */
  grants?: GrantLine[];
  /** Opened from the chat card itself: no «Открыть в чате». */
  fromChat?: boolean;
}

export interface GrantRequest {
  workspaceId: string;
  userId: string;
  /** Pre-selected («Вручить ещё» on a profile tile). */
  achievementId?: string;
}

interface AchievementUi {
  view: ViewRequest | null;
  grant: GrantRequest | null;
  openView: (v: ViewRequest | null) => void;
  openGrant: (g: GrantRequest | null) => void;
}

export const useAchievementUi = create<AchievementUi>()((set) => ({
  view: null,
  grant: null,
  openView: (view) => set({ view }),
  openGrant: (grant) => set({ grant }),
}));
