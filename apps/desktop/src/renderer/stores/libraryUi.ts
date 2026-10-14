import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isLibrarySegment, type LibrarySegment } from '../features/workspace/library';

/**
 * The last segment of «Настройки пространства → Библиотека» per workspace (features/workspace/
 * library), kept in localStorage: a per-viewer convenience — without storage it starts on the
 * first visible segment.
 */
interface LibraryUi {
  segment: Record<string, LibrarySegment>;
  setSegment: (workspaceId: string, s: LibrarySegment) => void;
}

export const useLibraryUi = create<LibraryUi>()(
  persist(
    (set) => ({
      segment: {},
      setSegment: (workspaceId, s) => set((st) => (st.segment[workspaceId] === s ? st : { segment: { ...st.segment, [workspaceId]: s } })),
    }),
    {
      name: 'calaba-library-segment',
      version: 1,
      partialize: (s) => ({ segment: s.segment }),
      merge: (persisted, current) => {
        const raw = (persisted as { segment?: Record<string, unknown> } | null)?.segment ?? {};
        const segment: Record<string, LibrarySegment> = {};
        for (const [k, v] of Object.entries(raw)) if (isLibrarySegment(v)) segment[k] = v;
        return { ...current, segment };
      },
    },
  ),
);
