import { MessageSquareText } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useWorkspaces } from '../stores/workspaces';
import { cx } from './ui';

/**
 * A user's custom status as a compact mark after their name (docs/08 «Свой статус»): the emoji,
 * or a small speech glyph for a text-only status; the full «🍔 Обедаю» is the tooltip and the
 * accessible name. A leaf with primitive selectors by id: a status change re-renders only this.
 */
export const StatusEmoji = memo(function StatusEmoji({ userId, className }: { userId: string; className?: string }): ReactNode {
  const emoji = useWorkspaces((s) => s.users[userId]?.statusEmoji ?? '');
  const text = useWorkspaces((s) => s.users[userId]?.statusText ?? '');
  if (!emoji && !text) return null;
  const label = [emoji, text].filter(Boolean).join(' ');
  return (
    <span role="img" aria-label={label} title={label} data-testid="status-emoji" className={cx('inline-flex shrink-0 items-center text-[13px] leading-none', className)}>
      {emoji || <MessageSquareText className="size-3.5 text-muted" aria-hidden />}
    </span>
  );
});
