/**
 * The task panel's lower section (ADR-0091 §1): «Комментарии» (the task room, as a chat) and
 * «История» (the journal timeline). Remembered; pure.
 */
export type ActivityTab = 'comments' | 'history';

export const ACTIVITY_TABS: readonly ActivityTab[] = ['comments', 'history'];

export function isActivityTab(v: unknown): v is ActivityTab {
  return v === 'comments' || v === 'history';
}

/**
 * A stored tab of an older build: «Все» / «Комментарии» → «Комментарии», «Изменения» →
 * «История»; anything else → the default «Комментарии».
 */
export function migrateActivityTab(v: unknown): ActivityTab {
  if (isActivityTab(v)) return v;
  return v === 'changes' ? 'history' : 'comments';
}
