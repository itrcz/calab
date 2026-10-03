import type { Achievement, ListAchievementsResponse } from '@calaba/protocol';
import { queryClient } from './queryClient';

/** The react-query key of the host catalog of achievements (lib/achievementCatalog, ADR-0061). */
export const CATALOG_KEY = ['achievements'] as const;

/** Outside React (notification and preview texts): the cached achievement, if the catalog is loaded. */
export function cachedAchievement(id: string): Achievement | undefined {
  return queryClient.getQueryData<ListAchievementsResponse>(CATALOG_KEY)?.achievements.find((a) => a.id === id);
}
