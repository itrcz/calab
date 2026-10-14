import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BoardFeature, EstimateScale, type BoardStatus } from '@calaba/protocol';
import { featureOn } from '../../lib/boards/features';
import type { MatchCtx } from '../../lib/boards/filter';
import { useBoards } from '../../stores/boards';
import { useWorkspaces } from '../../stores/workspaces';
import { useSession } from '../../stores/session';
import { useToday } from '../calendar/MiniCalendar';
import { useMobile } from '../../lib/mobile';
import { useBoardsUi, type ViewKind } from '../../stores/boardsUi';

const NONE: BoardStatus[] = [];

/**
 * The filter context of a board (me, its statuses, today): memoized, so the column selectors get
 * a stable object and a task event does not rebuild it.
 */
export function useMatchCtx(boardId: string): MatchCtx {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const statuses = useBoards(useShallow((s) => s.boards[boardId]?.statuses ?? NONE));
  const today = useToday();
  // Who is a member: the members map changes on joins / leaves / profile edits only, not on presence.
  const members = useWorkspaces((s) => {
    const ws = useBoards.getState().boards[boardId]?.workspaceId;
    return ws ? s.byId[ws]?.members : undefined;
  });
  return useMemo(() => {
    const map: Record<string, Pick<BoardStatus, 'type'>> = {};
    for (const s of statuses) map[s.id] = { type: s.type };
    return { me, statuses: map, today, ...(members ? { gone: (id: string) => !members[id] } : {}) };
  }, [me, statuses, today, members]);
}

/**
 * The board's view: the viewer's choice, else kanban (a phone: the list, ADR-0042 §5). The
 * timeline with the TIMELINE feature off opens as the list (ADR-0058 §3); the choice is kept.
 */
export function useViewKind(boardId: string): ViewKind {
  const mobile = useMobile();
  const kind = useBoardsUi((s) => s.prefs[boardId]?.kind);
  const timeline = useFeatureOn(boardId, BoardFeature.TIMELINE);
  const k = kind ?? (mobile ? 'list' : 'kanban');
  return k === 'timeline' && !timeline ? 'list' : k;
}

const NO_FEATURES: readonly BoardFeature[] = [];

/**
 * The board's disabled features (ADR-0058 §3): the board's own array, a stable reference until a
 * BOARD_UPDATE — a task event does not re-render through it.
 */
export function useDisabledFeatures(boardId: string): readonly BoardFeature[] {
  return useBoards((s) => s.boards[boardId]?.disabledFeatures ?? NO_FEATURES);
}

/** One feature of the board is on (a primitive selector). */
export function useFeatureOn(boardId: string, f: BoardFeature): boolean {
  return useBoards((s) => featureOn(s.boards[boardId]?.disabledFeatures, f));
}

/** The board's estimate scale (UNSPECIFIED from an older server reads as Fibonacci). */
export function useEstimateScale(boardId: string): EstimateScale {
  return useBoards((s) => s.boards[boardId]?.estimateScale ?? EstimateScale.FIBONACCI);
}
