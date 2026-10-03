import { useQuery } from '@tanstack/react-query';
import type { Achievement, ListAchievementsResponse } from '@calaba/protocol';
import { useCallback } from 'react';
import { api } from './api/endpoints';
import { queryClient } from './queryClient';
import { CATALOG_KEY } from './achievementCache';

export { CATALOG_KEY };

/**
 * The host catalog of achievements (ADR-0061 §3) in the react-query cache: loaded on first use
 * (a card, a profile, the grant dialog), revalidated by the server's ETag (the browser's HTTP
 * cache answers 304), archived ones kept so old cards and grants still resolve. The superadmin
 * tab invalidates it after a change. Member grants are a per-profile query (`memberKey`),
 * invalidated by WORKSPACE_MEMBER_UPDATE with a changed `achievementCount` (services/dispatch).
 */
export const memberAchievementsKey = (workspaceId: string, userId: string) => ['member-achievements', workspaceId, userId] as const;

const CATALOG_STALE_MS = 10 * 60_000;

const catalogQuery = {
  queryKey: CATALOG_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.achievements.catalog(signal),
  staleTime: CATALOG_STALE_MS,
};

/** The whole catalog (archived included), by position. */
export function useAchievementCatalog(enabled = true): readonly Achievement[] | undefined {
  return useQuery({ ...catalogQuery, enabled, select: selectList }).data;
}

const selectList = (d: ListAchievementsResponse): readonly Achievement[] => d.achievements;

/** One achievement by id (undefined while loading or when unknown). */
export function useAchievement(id: string): Achievement | undefined {
  const select = useCallback((d: ListAchievementsResponse) => d.achievements.find((a) => a.id === id), [id]);
  return useQuery({ ...catalogQuery, select }).data;
}

export function invalidateCatalog(): void {
  void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
}

/** The member's grants changed (WORKSPACE_MEMBER_UPDATE with another achievementCount). */
export function invalidateMemberAchievements(workspaceId: string, userId: string): void {
  void queryClient.invalidateQueries({ queryKey: memberAchievementsKey(workspaceId, userId) });
}
