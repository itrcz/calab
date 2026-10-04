import { useQuery } from '@tanstack/react-query';
import type { Achievement, ListAchievementsResponse } from '@calaba/protocol';
import { useCallback } from 'react';
import { api } from './api/endpoints';
import { queryClient } from './queryClient';
import { catalogKey } from './achievementCache';

export { catalogKey };

/**
 * The achievement catalog of a workspace (ADR-0061, amendment 1) in the react-query cache:
 * `['achievements', workspaceId]`, loaded on first use (a card, a profile, the grant dialog, the
 * settings tab), revalidated by the server's ETag (the browser's HTTP cache answers 304), archived
 * ones kept so old cards and grants still resolve. WORKSPACE_ACHIEVEMENTS_UPDATE invalidates it
 * (services/dispatch). Member grants are a per-profile query (`memberAchievementsKey`),
 * invalidated by WORKSPACE_MEMBER_UPDATE with a changed `achievementCount`.
 */
export const memberAchievementsKey = (workspaceId: string, userId: string) => ['member-achievements', workspaceId, userId] as const;

const CATALOG_STALE_MS = 10 * 60_000;

function catalogQuery(workspaceId: string) {
  return {
    queryKey: catalogKey(workspaceId),
    queryFn: ({ signal }: { signal: AbortSignal }) => api.achievements.catalog(workspaceId, signal),
    staleTime: CATALOG_STALE_MS,
  };
}

const selectList = (d: ListAchievementsResponse): readonly Achievement[] => d.achievements;

/** The workspace's whole catalog (archived included), by position; undefined while loading. */
export function useAchievementCatalog(workspaceId: string, enabled = true): readonly Achievement[] | undefined {
  return useQuery({ ...catalogQuery(workspaceId), enabled: enabled && !!workspaceId, select: selectList }).data;
}

/** The catalog query itself (the settings tab: loading / error states). */
export function useAchievementCatalogQuery(workspaceId: string) {
  return useQuery({ ...catalogQuery(workspaceId), enabled: !!workspaceId, select: selectList });
}

/** One achievement of the workspace's catalog by id (undefined while loading or when unknown). */
export function useAchievement(workspaceId: string, id: string): Achievement | undefined {
  const select = useCallback((d: ListAchievementsResponse) => d.achievements.find((a) => a.id === id), [id]);
  return useQuery({ ...catalogQuery(workspaceId), enabled: !!workspaceId && !!id, select }).data;
}

/** The workspace's catalog changed (WORKSPACE_ACHIEVEMENTS_UPDATE, or a change of mine). */
export function invalidateCatalog(workspaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: catalogKey(workspaceId) });
}

/** The member's grants changed (WORKSPACE_MEMBER_UPDATE with another achievementCount). */
export function invalidateMemberAchievements(workspaceId: string, userId: string): void {
  void queryClient.invalidateQueries({ queryKey: memberAchievementsKey(workspaceId, userId) });
}
