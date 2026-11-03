/**
 * A comment drawn as a chat message (owner 23.10: canvas and meeting comments look like the chat):
 * the feed row's lane, avatar column, bubble with its tail and grouping, the author line, markdown
 * with mention chips, «изм.» + time, the hover bar and the right-click / long-press menu — built
 * from MessageBubble's shared pieces, not a copy. Room-only behaviour (reactions, reply, forward,
 * pins, read ticks) is not here: a comment is not a message. The caller subscribes to its comment
 * by id and passes primitives; `onEdit` / `onDelete` must be stable.
 */
import * as ContextMenu from '../../components/radix/context-menu';
import { Copy, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt, useTimeFormat } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { hasTable } from '../../lib/markdown/table';
import { RichBody } from './RichBody';
import { toast } from '../../stores/toasts';
import { memberName, useFormerInfo, useResolveUnknown, useWorkspaces } from '../../stores/workspaces';
import { groupMetas, type GroupItem, type RowMeta } from './grouping';
import { ACTION_BAR, actionBtn, openMenuFrom } from './MessageActions';
import {
  ActionBarSlot,
  AuthorLine,
  BUBBLE_SHAPE,
  BUBBLE_TEXT,
  DatePill,
  MentionChip,
  RowAvatar,
  Tail,
  TimeMeta,
  bubbleBox,
  bubbleRadius,
  rowInner,
  rowLane,
  useActionBar,
} from './MessageBubble';
import { menuBox, menuItem, selectionWithin } from './MessageMenu';

const SEP = '\u0001';

/** One comment for the grouping, in the string a store selector returns (a primitive: edits do not re-group). */
export const commentShape = (id: string, authorId: string, ms: number): string => `${id}${SEP}${authorId}${SEP}${ms}`;

/**
 * The rows and their chat grouping from `shape` — commentShape rows joined by '\n' (the selector's
 * primitive). Metas keep their objects while unchanged, so memo rows re-render only where grouping changed.
 */
export function useCommentGroups(shape: string, firstDay = true): { items: GroupItem[]; metas: RowMeta[] } {
  const [cache] = useState(() => new Map<string, RowMeta>());
  return useMemo(() => {
    const items: GroupItem[] = shape
      ? shape.split('\n').map((row) => {
          const [key = '', authorId = '', ms = '0'] = row.split(SEP);
          return { key, authorId, ms: Number(ms) };
        })
      : [];
    return { items, metas: groupMetas(items, cache, firstDay) };
  }, [shape, cache, firstDay]);
}

export interface CommentRowProps {
  id: string;
  authorId: string;
  /** Wire text: markdown with `@<user_id>` mentions. */
  body: string;
  /** Written at, ms (a primitive: the row is memo). */
  atMs: number;
  edited: boolean;
  meta: RowMeta;
  own: boolean;
  workspaceId: string;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Being edited in the composer: the row is tinted like a chat message under its menu. */
  editing?: boolean;
  testId?: string;
}

export const CommentRow = memo(function CommentRow({ id, authorId, body, atMs, edited, meta, own, workspaceId, canEdit, canDelete, onEdit, onDelete, editing = false, testId }: CommentRowProps): ReactNode {
  // Memo row: re-render on a language / clock format switch too (ADR-0022).
  useLocale();
  useTimeFormat();
  const avatar = useWorkspaces((s) => (authorId ? (s.byId[workspaceId]?.members[authorId]?.user?.avatarFileId ?? s.users[authorId]?.avatarFileId) : undefined));
  const bot = useWorkspaces((s) => s.users[authorId]?.isBot ?? false);
  useResolveUnknown(workspaceId, authorId); // an author who left: the profile comes by id (ADR-0097)
  const former = !!useFormerInfo(workspaceId, authorId);
  const name = memberName(workspaceId, authorId);
  const at = useMemo(() => new Date(atMs), [atMs]);
  const mention = useCallback((v: string, key: string) => <MentionChip key={key} workspaceId={workspaceId} v={v} own={own} />, [workspaceId, own]);
  const tabled = useMemo(() => hasTable(body), [body]);
  const bar = useActionBar(true);
  const showName = !own && meta.first;
  const tail = meta.last;
  const radius = bubbleRadius(own, meta.first, meta.last, tail);
  const metaNode = <TimeMeta at={at} edited={edited} />;
  const copy = (): void => {
    void navigator.clipboard.writeText(selectionWithin(id) || body).then(() => toast.success(t('chat.copied')));
  };
  return (
    <div className={rowLane(own, meta.first, true)} data-message-id={id} data-testid={testId} data-can-edit={canEdit || undefined} data-can-delete={canDelete || undefined}>
      {meta.day ? <DatePill date={at} /> : null}
      <div className={rowInner(own, editing)}>
        {!own ? <RowAvatar workspaceId={workspaceId} userId={authorId} name={name} fileId={avatar} former={former} show={meta.last} /> : null}
        <ContextMenu.Root modal={false} onOpenChange={bar.setMenu}>
          <ContextMenu.Trigger asChild>
            <div
              className={bubbleBox(own, true)}
              data-testid="comment-bubble"
              data-own={own || undefined}
              tabIndex={0}
              role="article"
              aria-label={`${name}, ${fmt.time(at)}`}
              {...bar.handlers}
            >
              <div className={BUBBLE_SHAPE} style={radius} data-focus-shape>
                {tail ? <Tail own={own} /> : null}
                <div className="overflow-hidden" style={radius}>
                  {showName ? <AuthorLine workspaceId={workspaceId} userId={authorId} name={name} bot={bot} /> : null}
                  <div className={cx(BUBBLE_TEXT, 'pt-1.5')}>
                    {tabled ? <RichBody workspaceId={workspaceId} text={body} /> : <Markdown text={body} mention={mention} />}
                    {/* Room for the time on the last line (drawn absolutely, Telegram-style). */}
                    <span className="invisible ml-2 inline-flex select-none" aria-hidden>
                      {metaNode}
                    </span>
                  </div>
                  <span className="absolute bottom-1 right-3">{metaNode}</span>
                </div>
              </div>
              {bar.visible ? (
                <ActionBarSlot own={own}>
                  <CommentActions id={id} canEdit={canEdit} canDelete={canDelete} onEdit={onEdit} onDelete={onDelete} />
                </ActionBarSlot>
              ) : null}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={menuBox} aria-label={t('chat.menu')} collisionPadding={8}>
              <ContextMenu.Item className={menuItem} onSelect={copy}>
                <Copy className="size-4" aria-hidden /> {t('chat.copy')}
              </ContextMenu.Item>
              {canEdit ? (
                <ContextMenu.Item className={menuItem} onSelect={() => onEdit(id)} data-testid="comment-menu-edit">
                  <Pencil className="size-4" aria-hidden /> {t('chat.edit')}
                </ContextMenu.Item>
              ) : null}
              {canDelete ? (
                <>
                  <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
                  <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => onDelete(id)} data-testid="comment-menu-delete">
                    <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                  </ContextMenu.Item>
                </>
              ) : null}
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>
    </div>
  );
});

/** The hover bar of a comment: «Изменить», «Удалить» (what the rights allow) and «Ещё…» (the menu). */
function CommentActions({ id, canEdit, canDelete, onEdit, onDelete }: { id: string; canEdit: boolean; canDelete: boolean; onEdit: (id: string) => void; onDelete: (id: string) => void }): ReactNode {
  return (
    <div role="group" aria-label={t('chat.actions')} data-testid="comment-actions" className={ACTION_BAR}>
      {canEdit ? (
        <Tip label={t('chat.edit')}>
          <button type="button" aria-label={t('chat.edit')} onClick={() => onEdit(id)} className={actionBtn} data-testid="comment-edit">
            <Pencil className="size-4" aria-hidden />
          </button>
        </Tip>
      ) : null}
      {canDelete ? (
        <Tip label={t('common.delete')}>
          <button type="button" aria-label={t('common.delete')} onClick={() => onDelete(id)} className={actionBtn} data-testid="comment-delete">
            <Trash2 className="size-4" aria-hidden />
          </button>
        </Tip>
      ) : null}
      <Tip label={t('chat.more')}>
        <button type="button" aria-label={t('chat.more')} aria-haspopup="menu" onClick={openMenuFrom} className={actionBtn}>
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
