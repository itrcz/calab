import type { Achievement, ListAchievementsResponse } from '@calaba/protocol';
import { queryClient } from './queryClient';

/**
 * The react-query keys of the achievement catalogs (lib/achievementCatalog, ADR-0061 amendment 1):
 * one catalog per workspace, `['achievements', workspaceId]`; the prefix matches them all.
 */
export const CATALOG_PREFIX = ['achievements'] as const;
export const catalogKey = (workspaceId: string) => ['achievements', workspaceId] as const;

type CatalogEntry = readonly [queryKey: readonly unknown[], data: ListAchievementsResponse | undefined];

/**
 * The achievement among cached catalogs: the given workspace's one when known, otherwise any
 * cached catalog (ids are unique across workspaces). Pure: unit-tested.
 */
export function findAchievement(entries: readonly CatalogEntry[], id: string, workspaceId?: string): Achievement | undefined {
  if (!id) return undefined;
  for (const [key, data] of entries) {
    if (workspaceId && key[1] !== workspaceId) continue;
    const a = data?.achievements.find((x) => x.id === id);
    if (a) return a;
  }
  return undefined;
}

/** Outside React (notification and preview texts): the cached achievement, if its catalog is loaded. */
export function cachedAchievement(id: string, workspaceId?: string): Achievement | undefined {
  const entries = queryClient.getQueriesData<ListAchievementsResponse>({ queryKey: workspaceId ? catalogKey(workspaceId) : CATALOG_PREFIX });
  return findAchievement(entries, id, workspaceId);
}
