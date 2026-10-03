import { RoomType, type FileMeta, type Message, type PermissionBits } from '@calaba/protocol';
import { useRooms } from '../../stores/rooms';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { AlertCircle, Check, CheckCheck, Clock3, Download, FileText, RotateCw } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { THUMB_LARGE, thumbWidthPath, wantsLargeThumb } from '../../lib/thumbs';
import { fmt, toDate, useTimeFormat } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { firstLink, isEmojiOnly, parseMarkdown } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { can } from '../../lib/permissions';
import { retrySend, setEmbedsHidden, toggleReaction } from '../../services/chat';
import { useMessages, type ChatMessage, type PendingUpload } from '../../stores/messages';
import { useReadReceipt } from '../../stores/readReceipts';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { ReactionTip } from './ReactionTip';
import { userColorIndex, type RowMeta } from './grouping';
import { LinkPreview } from './LinkPreview';
import { MessageActions, hasMessageActions } from './MessageActions';
import { createHoverIntent, placeActionBar } from './hoverIntent';
import { previewPartsOf, useMentionLabel } from './mentionText';
import { PreviewRuns } from './PreviewRuns';
import { MessageMenu } from './MessageMenu';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { openProfile } from '../people/actions';
import { birthdayCardOf, recordingCardOf, systemPreview } from '../../lib/recording';
import { RecordingCardView } from './RecordingCard';
import { BirthdayCardView } from './BirthdayCard';
import { AchievementCardView } from './AchievementCard';
import { achievementCardOf } from '../../lib/achievements';
import { CallLogRow } from '../call/CallBits';
import { callCardOf } from '../../lib/callModel';
import { ForwardLine, forwardSentMs } from './ForwardLine';
import { mediaKind } from '../../lib/chatMedia';
import { AudioAttachment, VIDEO_WIDTH, VideoAttachment } from './MediaPlayer';
import { VoiceAttachment } from './VoiceBubble';
import { isVoice } from '../../lib/voiceNote';
import { useMobile } from '../../lib/mobile';
import { StickerImage } from './stickers/StickerImage';
import { StickerPackDialog } from './stickers/StickerPackDialog';
import { BotBadge } from '../people/MemberBits';
import { MemberBadge } from '../people/MemberBadge';
import { highlightCommand } from '../../lib/botCommands';
import { InlineKeyboardView } from './InlineKeyboard';

/** Widest image inside a bubble (docs/09 #36). */
const IMAGE_MAX = 420;
const IMAGE_MAX_H = 460;
/** A tall photo is at most this share of the screen high (on a phone 460 px is most of it). */
const IMAGE_MAX_VH = 60;

/** Mention chip in a message: my mentions (me, @everyone, @here) on a warm tint, others accent. */
function MentionChip({ workspaceId, v, own }: { workspaceId: string; v: string; own: boolean }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const label = useMentionLabel(workspaceId, v);
  const mine = !own && (v === me || v === 'everyone' || v === 'here');
  return (
    <span className={cx('rounded-[4px] px-0.5 font-medium', mine ? 'bg-warn/25 text-fg' : 'bg-accent/15 text-accent-text')} data-mention={v}>
      {label}
    </span>
  );
}

export const isImage = (f: FileMeta): boolean => f.mime.startsWith('image/') && !!f.thumbnailUrl;

export interface RowProps {
  c: ChatMessage;
  meta: RowMeta;
  own: boolean;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
  highlighted: boolean;
}

/** One feed row: optional date / «new» pills, avatar column (others), the bubble. */
export const MessageRow = memo(function MessageRow({ c, meta, own, workspaceId, roomId, perms, highlighted }: RowProps): ReactNode {
  // Memo row: re-render on a language / clock format switch too (ADR-0022, docs/09 #73).
  useLocale();
  useTimeFormat();
  const m = c.msg;
  const author = useWorkspaces((s) => s.users[m.authorId]);
  const name = memberName(workspaceId, m.authorId);
  return (
    // overflow-x-clip: nothing in a row widens the feed (no horizontal scroll, docs/09 #74); clip,
    // not hidden, so the action bar over a bubble's top edge still shows above the row.
    <div className={cx('overflow-x-clip pl-4', own ? 'pr-6' : 'pr-4', meta.first ? 'pt-2' : 'pt-0.5')} data-message-id={c.key} data-day-start={meta.day ? '1' : undefined}>
      {meta.day ? <DatePill date={toDate(m.createdAt)} /> : null}
      {meta.isNew ? <NewMessagesPill /> : null}
      <div
        className={cx(
          'flex items-end gap-3 rounded-[var(--radius-card)] transition-[background-color,box-shadow] duration-[var(--motion-fast)]',
          // Telegram tints the message whose menu is open (Radix marks the trigger data-state=open).
          'has-[>[data-state=open]]:bg-[var(--color-bubble-highlight)] has-[>[data-state=open]]:shadow-[0_0_0_4px_var(--color-bubble-highlight)]',
          own ? 'justify-end' : 'justify-start',
          highlighted && 'row-highlight',
        )}
      >
        {!own ? (
          <div className="w-9 shrink-0 self-end">
            {meta.last ? (
              <AuthorTarget workspaceId={workspaceId} userId={m.authorId} name={name} className="rounded-full">
                <Avatar userId={m.authorId} name={name} fileId={author?.avatarFileId || undefined} size={36} />
              </AuthorTarget>
            ) : null}
          </div>
        ) : null}
        <Bubble c={c} meta={meta} own={own} name={name} workspaceId={workspaceId} roomId={roomId} perms={perms} />
      </div>
      {c.status === 'failed' ? <FailedLine c={c} workspaceId={workspaceId} roomId={roomId} /> : null}
    </div>
  );
});

/**
 * A system message (Message.kind SYSTEM, ADR-0025): no bubble or avatar — the date / «new» pills
 * and the event's card across the feed (docs/09 #47). A payload this client does not know shows nothing.
 */
export const SystemRow = memo(function SystemRow({ c, meta, workspaceId, perms, highlighted }: Pick<RowProps, 'c' | 'meta' | 'workspaceId' | 'perms' | 'highlighted'>): ReactNode {
  useLocale();
  useTimeFormat();
  const card = recordingCardOf(c.msg);
  const bday = birthdayCardOf(c.msg);
  const ach = achievementCardOf(c.msg);
  // A DM call log line (ADR-0034): one line like Telegram, on the caller's side.
  const call = callCardOf(c.msg);
  return (
    <div className={cx('px-4', meta.day || meta.isNew || card || bday || ach || call ? 'pt-2' : '')} data-message-id={c.key} data-day-start={meta.day ? '1' : undefined}>
      {meta.day ? <DatePill date={toDate(c.msg.createdAt)} /> : null}
      {meta.isNew ? <NewMessagesPill /> : null}
      {card ? (
        <div className={cx('flex flex-col gap-1 rounded-[var(--radius-card)]', highlighted && 'row-highlight')}>
          {c.msg.forward ? (
            <ForwardLine authorId={c.msg.forward.authorId} forwardedAtMs={forwardSentMs(c.msg.createdAt)} sentAtMs={forwardSentMs(c.msg.forward.sentAt)} workspaceId={workspaceId} className="px-1 text-muted" />
          ) : null}
          <RecordingCardView c={c} card={card} workspaceId={workspaceId} perms={perms} />
        </div>
      ) : bday ? (
        <div className={cx('flex rounded-[var(--radius-card)]', highlighted && 'row-highlight')}>
          <BirthdayCardView authorId={c.msg.authorId} card={bday} workspaceId={workspaceId} />
        </div>
      ) : ach ? (
        <div className={cx('flex rounded-[var(--radius-card)]', highlighted && 'row-highlight')}>
          <AchievementCardView authorId={c.msg.authorId} card={ach} workspaceId={workspaceId} roomId={c.msg.roomId} messageId={c.msg.id} createdAt={c.msg.createdAt} />
        </div>
      ) : call ? (
        <div className={cx('rounded-[var(--radius-card)]', highlighted && 'row-highlight')}>
          <CallLogRow card={call} at={c.msg.createdAt} />
        </div>
      ) : (
        <div className="h-px" aria-hidden />
      )}
    </div>
  );
});

/**
 * The author's avatar / name in the feed (docs/09 #20): click → the profile, right click → the
 * member menu (not the message menu around it). In a workspace only (a DM peer has no member
 * menu); out of the Tab order — the feed's keyboard path is the message itself.
 */
function AuthorTarget({ workspaceId, userId, name, className, children }: { workspaceId: string; userId: string; name: string; className?: string; children: ReactNode }): ReactNode {
  if (!workspaceId) return children;
  return (
    <MemberContextMenu workspaceId={workspaceId} userId={userId}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('people.openProfile', { name })}
        className={cx('inline-block cursor-pointer align-bottom', className)}
        onClick={(e) => {
          e.stopPropagation();
          openProfile(workspaceId, userId);
        }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {children}
      </button>
    </MemberContextMenu>
  );
}

/** Date / «new» pills: 24 px, 12/500, the opaque popover colour with a 0.5 px hairline (UX review). */
const pill = 'mat-glass inline-flex h-6 items-center rounded-full px-2.5 text-caption font-medium';

export function DatePill({ date, floating }: { date: Date; floating?: boolean }): ReactNode {
  if (floating) {
    return (
      <span className={cx(pill, 'text-fg')} aria-hidden data-testid="sticky-date">
        {fmt.dayLabel(date)}
      </span>
    );
  }
  return (
    <div className="flex justify-center py-2" role="separator" aria-label={fmt.dayLabel(date)}>
      <span className={cx(pill, 'text-fg')}>{fmt.dayLabel(date)}</span>
    </div>
  );
}

/** «Новые сообщения» (Telegram): accent text on the pill, hairlines to both sides. */
function NewMessagesPill(): ReactNode {
  const line = 'h-px flex-1 bg-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]';
  return (
    <div className="flex items-center gap-3 py-2" role="separator" aria-label={t('chat.newPill')}>
      <span className={line} aria-hidden />
      <span className={cx(pill, 'text-accent-text')}>{t('chat.newPill')}</span>
      <span className={line} aria-hidden />
    </div>
  );
}

function Bubble({
  c,
  meta,
  own,
  name,
  workspaceId,
  roomId,
  perms,
}: {
  c: ChatMessage;
  meta: RowMeta;
  own: boolean;
  name: string;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
}): ReactNode {
  const m = c.msg;
  const mention = useCallback((v: string, key: string) => <MentionChip key={key} workspaceId={workspaceId} v={v} own={own} />, [workspaceId, own]);
  const nodes = useMemo(() => parseMarkdown(m.content), [m.content]);
  // A leading bot command (ADR-0031) reads as inline code; the message stays ordinary text.
  const shown = useMemo(() => highlightCommand(m.content), [m.content]);
  const authorBot = useWorkspaces((s) => s.users[m.authorId]?.isBot ?? false);
  // In-room search: 0 = not a hit, 1 = hit, 2 = the current hit (primitive → no extra renders).
  const hit = useChatView((s) => (s.searchHits?.roomId === roomId && s.searchHits.ids.has(m.id) ? (s.searchHits.current === m.id ? 2 : 1) : 0));
  const words = useChatView((s) => s.searchHits?.words);
  const highlight = useMemo(() => (hit && words?.length ? { words, current: hit === 2 } : undefined), [hit, words]);
  // Hidden previews (Message.embeds_hidden) are not rendered at all, for everyone.
  const link = useMemo(() => (m.embedsHidden ? null : firstLink(nodes)), [nodes, m.embedsHidden]);
  const canHideEmbed = c.status === 'sent' && (own || can(perms, 'MANAGE_MESSAGES'));
  const bar = useActionBar(hasMessageActions(c));
  const images = m.attachments.filter(isImage);
  const files = m.attachments.filter((f) => !isImage(f));
  // Videos are full-bleed boxes like images; audio players and other files are rows (docs/08 «Медиа в чате»).
  const videos = files.filter((f) => !isVoice(f) && mediaKind(f) === 'video');
  const rows = files.filter((f) => isVoice(f) || mediaKind(f) !== 'video');
  const uploads = c.uploads && c.status !== 'sent' ? c.uploads : [];
  const hasText = !!m.content.trim();
  // A sticker message (ADR-0030): the sticker alone, no bubble; one whose sticker is gone
  // (its workspace was deleted) keeps an empty body — a placeholder stands in.
  const stickerMsg = m.sticker ?? null;
  const stickerGone = !stickerMsg && !hasText && !m.attachments.length && !uploads.length;
  // A forwarded copy (ADR-0033) keeps its bubble: the «Переслано от» line needs one.
  const fwd = m.forward;
  const sticker = hasText && !fwd && !images.length && !files.length && !uploads.length && !m.replyToId && !m.reactions.length && isEmojiOnly(m.content);
  const showName = !own && meta.first && !sticker;
  const imageOnly = images.length > 0 && !hasText && !files.length && !m.replyToId && !showName && !fwd && !m.reactions.length;
  // A lone voice message carries the time in its own last line (Telegram).
  const voiceOnly = rows.length === 1 && !!rows[0] && isVoice(rows[0]) && c.status === 'sent' && !hasText && !images.length && !videos.length && !m.reactions.length;
  const width = images.length ? imageBoxWidth(images) : videos.length ? VIDEO_WIDTH : undefined;

  const metaNode = <MetaInfo c={c} own={own} />;
  const tail = meta.last && !sticker;

  // Corner radii: large outside, small where bubbles of one group touch, none under the tail.
  const r = 'var(--radius-bubble)';
  const ri = 'var(--radius-bubble-inner)';
  const radius: CSSProperties = own
    ? { borderRadius: `${r} ${meta.first ? r : ri} ${tail ? '0' : ri} ${r}` }
    : { borderRadius: `${meta.first ? r : ri} ${r} ${r} ${tail ? '0' : ri}` };
  if (meta.last && !tail) Object.assign(radius, own ? { borderBottomRightRadius: r } : { borderBottomLeftRadius: r });

  // A sticker message (Telegram Desktop): the picture alone, no bubble; the time + status and the
  // reactions ride dark pills over its bottom-right corner, like on a lone image.
  const body = stickerMsg || stickerGone ? (
    <div className={cx('flex flex-col gap-1 py-1', own ? 'items-end' : 'items-start')} data-testid="sticker-message">
      {fwd ? <ForwardLine authorId={fwd.authorId} forwardedAtMs={forwardSentMs(m.createdAt)} sentAtMs={forwardSentMs(fwd.sentAt)} workspaceId={workspaceId} className="max-w-[256px] text-muted" /> : null}
      {m.replyToId ? (
        <div className="max-w-[260px] overflow-hidden rounded-[var(--radius-bubble)] bg-[var(--bubble-bg)] pb-1.5 shadow-[var(--shadow-bubble)]">
          <ReplyQuote roomId={roomId} workspaceId={workspaceId} replyToId={m.replyToId} padTop />
        </div>
      ) : null}
      <div className="relative">
        {stickerMsg ? (
          <StickerTarget sticker={stickerMsg} />
        ) : (
          <span className="grid size-[256px] place-items-center rounded-[var(--radius-card)] border border-dashed border-line text-caption text-muted mobile:size-[200px]">{t('stk.unavailable')}</span>
        )}
        <div className="pointer-events-none absolute bottom-1.5 right-1.5 flex max-w-[calc(100%-12px)] flex-wrap items-center justify-end gap-1">
          {m.reactions.map((re) => (
            <ReactionChip key={re.emoji} roomId={roomId} workspaceId={workspaceId} m={m} emoji={re.emoji} count={re.count} me={re.me} canReact={c.status === 'sent'} onMedia />
          ))}
          <span className="rounded-full bg-[rgb(0_0_0/50%)] px-1.5 py-1 [--bubble-meta:var(--color-on-accent)]" data-testid="sticker-meta">
            {metaNode}
          </span>
        </div>
      </div>
    </div>
  ) : sticker ? (
    <div className="flex flex-col items-end gap-1">
      <span className="text-[44px] leading-none">{m.content.trim()}</span>
      <span className="rounded-full bg-[var(--bubble-bg)] px-2 py-0.5 shadow-[var(--shadow-bubble)]">{metaNode}</span>
    </div>
  ) : (
    // data-focus-shape: keyboard focus draws the ring on this shape (body + tail), app/styles.css.
    <div
      // max-w-full: a media box's fixed width never outgrows the bubble (a phone's 70 % lane, #9).
      className="relative max-w-full bg-[var(--bubble-bg)] shadow-[var(--shadow-bubble)]"
      style={{ ...radius, ...(width ? { width } : {}) }}
      data-focus-shape
    >
      {tail ? <Tail own={own} /> : null}
      <div className="overflow-hidden" style={radius}>
        {showName ? (
          <div className="truncate px-3 pt-1.5 text-body font-semibold leading-[18px]" style={{ color: `var(--name-${userColorIndex(m.authorId) + 1})` }} title={name}>
            <AuthorTarget workspaceId={workspaceId} userId={m.authorId} name={name} className="max-w-full truncate hover:underline">
              {name}
            </AuthorTarget>
            <MemberBadge workspaceId={workspaceId} userId={m.authorId} className="ml-1.5 inline-block align-[-3px]" />
            {authorBot ? <BotBadge className="ml-1.5 align-[1px]" /> : null}
          </div>
        ) : null}
        {fwd ? (
          <ForwardLine
            authorId={fwd.authorId}
            forwardedAtMs={forwardSentMs(m.createdAt)}
            sentAtMs={forwardSentMs(fwd.sentAt)}
            workspaceId={workspaceId}
            className={cx('px-3 text-[color:var(--bubble-meta)]', showName ? 'pt-0.5' : 'pt-1.5')}
          />
        ) : null}
        {m.replyToId ? <ReplyQuote roomId={roomId} workspaceId={workspaceId} replyToId={m.replyToId} padTop={!showName} /> : null}
        {images.length ? (
          <ImageGrid files={images} padTop={showName || !!m.replyToId || !!fwd} overlay={imageOnly ? metaNode : null} />
        ) : null}
        {videos.length ? (
          <div className={cx('flex flex-col gap-0.5', (showName || !!m.replyToId || !!fwd || images.length > 0) && 'pt-1.5')}>
            {videos.map((f) => (
              <VideoAttachment key={f.id} f={f} />
            ))}
          </div>
        ) : null}
        {uploads.length ? <Uploads uploads={uploads} /> : null}
        {hasText ? (
          <div className={cx('selectable whitespace-pre-wrap break-words px-3 pb-1.5 text-list leading-5 [overflow-wrap:anywhere]', fwd ? 'pt-0.5' : 'pt-1.5')}>
            <Markdown text={shown} mention={mention} highlight={highlight} />
            {!link && !files.length && !m.reactions.length ? (
              // Reserve room for the time on the last line (it is drawn absolutely, Telegram-style).
              <span className="invisible ml-2 inline-flex select-none" aria-hidden>
                {metaNode}
              </span>
            ) : null}
          </div>
        ) : null}
        {link && hasText ? (
          <div className="px-3 pb-1">
            <LinkPreview url={link} onHide={canHideEmbed ? () => void setEmbedsHidden(m, true) : undefined} />
          </div>
        ) : null}
        {rows.length ? (
          <div className={cx('flex flex-col gap-1 px-3 pb-1', hasText || showName || m.replyToId || fwd ? 'pt-0.5' : 'pt-2')}>
            {rows.map((f) =>
              isVoice(f) && c.status === 'sent' ? (
                <VoiceAttachment key={f.id} f={f} messageId={m.id} roomId={roomId} author={name} meta={voiceOnly ? metaNode : undefined} />
              ) : mediaKind(f) === 'audio' && c.status === 'sent' ? (
                <AudioAttachment key={f.id} f={f} messageId={m.id} roomId={roomId} />
              ) : (
                <FileRow key={f.id} f={f} />
              ),
            )}
          </div>
        ) : null}
        {m.reactions.length ? (
          <div className="flex flex-wrap items-end gap-1 px-2.5 pb-1.5 pt-0.5">
            {m.reactions.map((re) => (
              <ReactionChip key={re.emoji} roomId={roomId} workspaceId={workspaceId} m={m} emoji={re.emoji} count={re.count} me={re.me} canReact={c.status === 'sent'} />
            ))}
            <span className="ml-auto pl-2">{metaNode}</span>
          </div>
        ) : imageOnly || voiceOnly ? null : hasText && !link && !files.length ? (
          <span className="absolute bottom-1 right-3">{metaNode}</span>
        ) : (
          <div className="flex justify-end px-3 pb-1.5">{metaNode}</div>
        )}
      </div>
    </div>
  );

  return (
    <ContextMenu.Root modal={false} onOpenChange={bar.setMenu}>
      <ContextMenu.Trigger asChild disabled={c.status !== 'sent'}>
        <div
          className={cx(
            'relative min-w-0 max-w-[min(70%,640px)] rounded-[var(--radius-bubble)]',
            own ? 'bubble-out' : 'bubble-in',
            c.status === 'pending' && 'opacity-80',
          )}
          data-testid="message-bubble"
          data-own={own || undefined}
          // Keyboard: Tab reaches the message, which shows its action bar (docs/09 #47).
          tabIndex={bar.enabled ? 0 : undefined}
          role={bar.enabled ? 'article' : undefined}
          aria-label={bar.enabled ? `${name}, ${fmt.time(toDate(m.createdAt))}` : undefined}
          {...bar.handlers}
        >
          {body}
          {m.inlineKeyboard?.rows.length && !m.forward && c.status === 'sent' ? (
            <InlineKeyboardView key={`${m.id}:${m.keyboardRevision}`} messageId={m.id} roomId={roomId} revision={m.keyboardRevision} keyboard={m.inlineKeyboard} canSend={can(perms, 'SEND_MESSAGES')} />
          ) : null}
          {bar.visible ? (
            <ActionBarSlot own={own}>
              <MessageActions c={c} roomId={roomId} perms={perms} onPickerOpenChange={bar.setPicker} />
            </ActionBarSlot>
          ) : null}
        </div>
      </ContextMenu.Trigger>
      <MessageMenu c={c} own={own} roomId={roomId} perms={perms} />
    </ContextMenu.Root>
  );
}

/**
 * The sticker of a sticker message: 256 px on the longer side (a phone: 200), no background, a
 * light drop shadow (docs/08 «Стикеры»). A click opens its pack (Telegram: «Добавить пак»).
 */
function StickerTarget({ sticker }: { sticker: NonNullable<Message['sticker']> }): ReactNode {
  const [open, setOpen] = useState(false);
  const mobile = useMobile();
  return (
    <>
      <button
        type="button"
        className="rounded-[var(--radius-card)] focus-visible:outline-offset-2"
        aria-label={t('stk.sticker', { emoji: sticker.emoji })}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <StickerImage sticker={sticker} size={mobile ? 200 : 256} className="[filter:drop-shadow(0_1px_3px_rgb(0_0_0/0.22))]" />
      </button>
      {open ? <StickerPackDialog sticker={sticker} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Hover / keyboard-focus state of the action bar (docs/09 #47, #74): shown 150 ms after the
 * pointer settles, hidden 200 ms after it leaves (a return cancels that; the bar and the bridge
 * to it are inside the bubble, so moving onto the bar is no leave at all); never hidden while its
 * emoji picker or the «…» menu is open; hidden while the primary button is held (a text
 * selection may be in progress) and while the feed scrolls (back 150 ms after it stops).
 * Keyboard focus shows it at once (focus-visible only, so a click on the text doesn't pin it).
 * The state is this bubble's own: hovering a message re-renders that bubble only.
 *
 * The bubble is a Tab stop (tabIndex 0) only for the keyboard: a mouse press would focus it as
 * the nearest focusable ancestor of the text, and a later key press (Ctrl+C after selecting) then
 * turns that into :focus-visible and draws the ring. So a focus that a press put on the bubble
 * itself is dropped when the button is released (blur, as if the bubble weren't focusable).
 * Not in the focus handler itself: Chromium cancels the mousedown's default action — the start
 * of a text selection — when a focus handler moves the focus (issue #13); preventDefault on
 * mousedown would kill it too. A blur after the release leaves the selection alone.
 * Presses on the controls inside (reactions, links, the action bar) focus those as usual.
 */
function useActionBar(enabled: boolean): {
  enabled: boolean;
  visible: boolean;
  setPicker: (open: boolean) => void;
  setMenu: (open: boolean) => void;
  handlers: {
    onPointerEnter?: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave?: (e: PointerEvent<HTMLDivElement>) => void;
    onMouseDown?: () => void;
    onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
    onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
    onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
  };
} {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  // The picker also keeps a keyboard-opened bar (focus moves into its portal: a blur here).
  const [picker, setPickerOpen] = useState(false);
  const [hov] = useState(() => {
    // Feed scrolls reach the intent only while it is active: one window capture listener per
    // hovered message, not one per row.
    let row: Element | null = null;
    let watching = false;
    const unwatch = (): void => {
      if (!watching) return;
      watching = false;
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
    const onScroll = (e: Event): void => {
      if (row && e.target instanceof Node && e.target.contains(row)) intent.scroll();
      if (!intent.active()) unwatch();
    };
    const intent = createHoverIntent((v) => {
      setHover(v);
      if (!intent.active()) unwatch();
    });
    return {
      intent,
      unwatch,
      watch(el: Element): void {
        row = el;
        if (watching) return;
        watching = true;
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
      },
    };
  });
  const intent = hov.intent;
  const setPicker = useCallback(
    (open: boolean) => {
      setPickerOpen(open);
      intent.hold('picker', open);
    },
    [intent],
  );
  const setMenu = useCallback((open: boolean) => intent.hold('menu', open), [intent]);
  // True from a mouse press until the end of its task: the focus it causes runs in between.
  const pressing = useRef(false);
  useEffect(
    () => () => {
      intent.dispose();
      hov.unwatch();
    },
    [intent, hov],
  );
  if (!enabled) return { enabled, visible: false, setPicker, setMenu, handlers: {} };
  const press = (): void => {
    intent.press();
    const up = (): void => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      intent.release();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return {
    enabled,
    visible: hover || focused || picker,
    setPicker,
    setMenu,
    handlers: {
      // A mouse only: a tap on a phone (iOS emulates hover on touch) would open the bar beside
      // the bubble, past the screen's edge — touch has the long-press menu instead.
      onPointerEnter: (e) => {
        if (e.pointerType !== 'mouse') return;
        // A selection dragged in from another message: stay hidden until the button is released.
        if (e.buttons & 1) press();
        hov.watch(e.currentTarget);
        intent.enter();
      },
      onPointerLeave: (e) => {
        if (e.pointerType !== 'mouse') return;
        intent.leave();
        if (!intent.active()) hov.unwatch();
      },
      onMouseDown: () => {
        pressing.current = true;
        setTimeout(() => {
          pressing.current = false;
        }, 0);
      },
      onPointerDown: (e) => {
        if (e.button !== 0 || (e.target as Element).closest('[data-message-actions]')) return;
        press();
      },
      onFocus: (e) => {
        const keyboard = (e.target as Element).matches(':focus-visible');
        if (pressing.current && !keyboard && e.target === e.currentTarget) {
          const el = e.currentTarget;
          const drop = (): void => {
            window.removeEventListener('pointerup', drop);
            window.removeEventListener('pointercancel', drop);
            if (document.activeElement === el) el.blur();
          };
          window.addEventListener('pointerup', drop);
          window.addEventListener('pointercancel', drop);
          return;
        }
        setFocused(keyboard);
      },
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      },
    },
  };
}

/**
 * The action bar's place (docs/09 #74), inside the bubble — the hover wrapper — so the pointer
 * moving onto the bar never leaves the message. `beside` (the CSS default): next to the bubble
 * on the free side of the row, level with its top; the slot is as tall as the bubble and its
 * padding is the gap, so the whole strip between the bubble and the bar is an invisible bridge.
 * When that doesn't fit in the feed (a wide bubble, a narrow window) the bar sits over the
 * bubble's top edge instead, clamped into the feed (placeActionBar). Measured once per showing,
 * before paint, and applied to the DOM directly: no second render.
 */
function ActionBarSlot({ own, children }: { own: boolean; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    const bubble = slot?.parentElement;
    const lane = slot?.closest('[data-message-id]');
    const bar = slot?.firstElementChild;
    if (!slot || !bubble || !lane || !(bar instanceof HTMLElement)) return;
    const b = bubble.getBoundingClientRect();
    const p = placeActionBar(b, lane.getBoundingClientRect(), { width: bar.offsetWidth, height: bar.offsetHeight }, own);
    if (p.mode === 'beside') return;
    slot.dataset['place'] = 'corner';
    Object.assign(slot.style, { left: `${p.left}px`, right: 'auto', top: `${p.top}px`, bottom: 'auto', padding: '0' });
  }, [own]);
  return (
    <div
      ref={ref}
      data-message-actions
      data-place="beside"
      className={cx('absolute inset-y-0 z-[var(--z-sticky)] flex w-max items-start', own ? 'right-full pr-1.5' : 'left-full pl-1.5')}
    >
      {children}
    </div>
  );
}

/** Bubble tail (Telegram): a curved corner piece in the bubble colour at the bottom. */
function Tail({ own }: { own: boolean }): ReactNode {
  return (
    <svg
      aria-hidden
      width="10"
      height="16"
      viewBox="0 0 10 16"
      className={cx('absolute bottom-0 fill-[var(--bubble-bg)]', own ? '-right-[9px]' : '-left-[9px] -scale-x-100')}
    >
      <path d="M0 0v16h10c-5.5-1.2-9.2-5.6-10-12z" />
    </svg>
  );
}

function MetaInfo({ c, own }: { c: ChatMessage; own: boolean }): ReactNode {
  const d = toDate(c.msg.createdAt);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-caption leading-none text-[color:var(--bubble-meta)]">
      {c.msg.editedAt ? <span>{t('chat.editedShort')}</span> : null}
      <Tip label={fmt.full(d)}>
        <span>{fmt.time(d)}</span>
      </Tip>
      {own ? (
        c.status === 'pending' ? (
          <Clock3 className="size-3.5" aria-label={t('chat.statusPending')} />
        ) : c.status === 'failed' ? (
          <AlertCircle className="size-3.5 text-danger" aria-label={t('chat.failed')} />
        ) : (
          <Ticks roomId={c.msg.roomId} messageId={c.msg.id} />
        )
      ) : null}
    </span>
  );
}

/**
 * docs/08 «Галочки» (docs/09 #92): ✓ — the server has the message, ✓✓ — someone else read it
 * (the DM peer / another member). A leaf with a boolean selector: a READ_RECEIPT re-renders
 * only the ticks it flips, not the bubble or the feed.
 */
function Ticks({ roomId, messageId }: { roomId: string; messageId: string }): ReactNode {
  const read = useReadReceipt(roomId, messageId);
  // A notes shelf (ADR-0039) has no readers: no ticks at all.
  const shelf = useRooms((s) => s.byId[roomId]?.type === RoomType.NOTES);
  if (shelf) return null;
  return read ? (
    <CheckCheck className="size-4" aria-label={t('chat.statusRead')} />
  ) : (
    <Check className="size-4" aria-label={t('chat.statusSent')} />
  );
}

/**
 * `onMedia`: over a sticker — a dark translucent pill like the time next to it.
 * The Tip shows who reacted (issue #32); it wakes lazily and the names load only while open.
 */
function ReactionChip({ roomId, workspaceId, m, emoji, count, me, canReact, onMedia = false }: { roomId: string; workspaceId: string; m: Message; emoji: string; count: number; me: boolean; canReact: boolean; onMedia?: boolean }): ReactNode {
  return (
    <Tip label={<ReactionTip workspaceId={workspaceId} messageId={m.id} emoji={emoji} count={count} />}>
      <button
        type="button"
        disabled={!canReact}
        aria-pressed={me}
        aria-label={t('chat.reactionLabel', { emoji, count })}
        onClick={() => void toggleReaction(roomId, m, emoji)}
        className={cx(
          'inline-flex items-center gap-1 rounded-full leading-none transition-colors duration-[var(--motion-fast)]',
          onMedia ? 'pointer-events-auto h-6 px-1.5 text-caption' : 'h-7 px-2 text-body',
          onMedia
            ? me
              ? 'bg-accent-strong text-accent-fg'
              : 'bg-[rgb(0_0_0/50%)] text-[color:var(--color-on-accent)] hover:bg-[rgb(0_0_0/62%)]'
            : me
              ? 'bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]'
              : 'bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)] text-fg hover:bg-[color-mix(in_srgb,var(--bubble-accent)_22%,transparent)]',
        )}
      >
        <span className={onMedia ? 'text-body' : 'text-headline'}>{emoji}</span>
        <span className={cx('font-semibold tabular-nums', onMedia ? 'text-caption' : 'text-body')}>{count}</span>
      </button>
    </Tip>
  );
}

function ReplyQuote({ roomId, workspaceId, replyToId, padTop }: { roomId: string; workspaceId: string; replyToId: string; padTop: boolean }): ReactNode {
  const target = useMessages((s) => s.rooms[roomId]?.items.find((c) => c.key === replyToId)?.msg);
  const gone = useMessages((s) => !!s.gone[replyToId]);
  const jump = useChatView((s) => s.requestJump);
  const sys = target ? systemPreview(target) : '';
  const parts = target && !sys ? previewPartsOf(workspaceId, target.content, 140) : [];
  const snippet = sys || (parts.length ? <PreviewRuns parts={parts} /> : target?.attachments.length ? t('chat.attachment') : '');
  const deleted = !target && gone;
  const who = target ? memberName(workspaceId, target.authorId) : t('chat.reply');
  return (
    <div className={cx('px-2 pb-0.5', padTop ? 'pt-2' : 'pt-1')}>
      <button
        type="button"
        disabled={deleted}
        onClick={() => jump(roomId, replyToId)}
        className="flex w-full min-w-0 flex-col rounded-[var(--radius-row)] border-l-[3px] border-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_12%,transparent)] px-2 py-1 text-left hover:bg-[color-mix(in_srgb,var(--bubble-accent)_18%,transparent)]"
      >
        <span className="truncate text-body font-semibold text-[color:var(--bubble-accent)]">{who}</span>
        <span className="truncate text-body text-fg">{target ? snippet : deleted ? t('chat.replyDeleted') : t('chat.replyOpen')}</span>
      </button>
    </div>
  );
}

/**
 * CSS width of the image box: the photo's own width up to IMAGE_MAX, narrower when it would be
 * taller than IMAGE_MAX_H px or (portrait) IMAGE_MAX_VH of the screen — proportions kept.
 */
function imageBoxWidth(files: FileMeta[]): string {
  const px = imageBoxPx(files);
  const f = files[0];
  if (files.length > 1 || !f?.width || !f.height) return `${px}px`;
  return f.height > f.width ? `min(${px}px, calc(${IMAGE_MAX_VH}dvh * ${f.width} / ${f.height}))` : `${px}px`;
}

/** imageBoxWidth in px, at most (the dvh cap and a narrow screen only make it smaller). */
function imageBoxPx(files: FileMeta[]): number {
  if (files.length > 1) return IMAGE_MAX;
  const f = files[0];
  if (!f?.width || !f.height) return 320;
  const w = Math.min(IMAGE_MAX, f.width);
  const h = (w * f.height) / f.width;
  return Math.max(200, Math.round(h > IMAGE_MAX_H ? (IMAGE_MAX_H * f.width) / f.height : w));
}

/** The chat thumbnail of an image, with the 1024 px one for 2× screens when it is sharper (docs/09 #62). */
function Thumb({ f, boxW, boxH }: { f: FileMeta; boxW: number; boxH: number }): ReactNode {
  const path = thumbnailPath(f.id);
  const hi = wantsLargeThumb(f.width, f.height, boxW, boxH) ? thumbWidthPath(path, THUMB_LARGE) : undefined;
  // 1× keeps the bare path (= w=512): the same URL as the lightbox placeholder, loaded once.
  return (
    <MediaImg
      path={path}
      hiDpiPath={hi}
      alt={f.name}
      loading="lazy"
      decoding="async"
      className="block size-full object-cover"
      draggable={false}
    />
  );
}

function ImageGrid({ files, padTop, overlay }: { files: FileMeta[]; padTop: boolean; overlay: ReactNode }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const single = files.length === 1 ? files[0] : undefined;
  const aspect = single?.width && single.height ? `${single.width} / ${single.height}` : undefined;
  const boxPx = single ? imageBoxPx(files) : (IMAGE_MAX - 2) / 2; // grid: square cells, gap-0.5
  return (
    <div className={cx('relative grid gap-0.5', files.length > 1 && 'grid-cols-2', padTop && 'pt-1.5')} style={{ width: '100%' }}>
      {files.map((f, index) => (
        <button
          key={f.id}
          type="button"
          aria-label={t('chat.openImage', { name: f.name })}
          onClick={() => open({ kind: 'image', images: files.map((g) => ({ fileId: g.id, name: g.name, width: g.width, height: g.height })), index })}
          className="block overflow-hidden bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] focus-visible:outline-offset-[-2px]"
          style={single ? { aspectRatio: aspect ?? '4 / 3', maxHeight: IMAGE_MAX_H, width: '100%' } : { aspectRatio: '1 / 1' }}
        >
          <Thumb f={f} boxW={boxPx} boxH={single ? (single.width && single.height ? (boxPx * single.height) / single.width : boxPx * 0.75) : boxPx} />
        </button>
      ))}
      {overlay ? (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-[rgb(0_0_0/50%)] px-1.5 py-1 [--bubble-meta:var(--color-on-accent)]">{overlay}</span>
      ) : null}
    </div>
  );
}

function FileRow({ f }: { f: FileMeta }): ReactNode {
  const download = (): void =>
    void platform.files.download({ fileId: f.id, name: f.name }).then(
      () => toast.success(t('chat.downloaded', { name: f.name })),
      (e: unknown) => toast.fail(e, t('err.ctx.download')),
    );
  return (
    <div className="group/file flex min-w-[min(220px,100%)] items-center gap-3 py-1">
      <Tip label={t('chat.download')}>
        <button
          type="button"
          onClick={download}
          aria-label={`${t('chat.download')} ${f.name}`}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]"
        >
          <FileText className="size-5 group-hover/file:hidden" aria-hidden />
          <Download className="hidden size-5 group-hover/file:block" aria-hidden />
        </button>
      </Tip>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium" title={f.name}>
          {f.name}
        </div>
        <div className="text-caption text-[color:var(--bubble-meta)]">{fmt.size(f.size)}</div>
      </div>
    </div>
  );
}

function Uploads({ uploads }: { uploads: PendingUpload[] }): ReactNode {
  return (
    <div className="flex min-w-[min(240px,100%)] flex-col gap-1.5 px-3 pt-2">
      {uploads.map((u) => (
        <div key={u.key}>
          <div className="flex justify-between gap-3 text-caption">
            <span className="truncate">{u.name}</span>
            <span className="shrink-0 text-[color:var(--bubble-meta)]">{Math.round(u.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-[color-mix(in_srgb,var(--bubble-accent)_20%,transparent)]">
            <div className="h-full rounded-full bg-[color:var(--bubble-accent)] transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FailedLine({ c, workspaceId, roomId }: { c: ChatMessage; workspaceId: string; roomId: string }): ReactNode {
  return (
    <div className="mt-1 flex items-center justify-end gap-2 text-caption text-danger-text">
      <span className="truncate">
        {t('chat.failed')}
        {c.error ? `: ${c.error}` : ''}
      </span>
      <button type="button" className="inline-flex items-center gap-0.5 font-semibold hover:underline" onClick={() => void retrySend(workspaceId, roomId, c)}>
        <RotateCw className="size-3" aria-hidden /> {t('common.retry')}
      </button>
      <button type="button" className="hover:underline" onClick={() => useMessages.getState().dropPending(roomId, c.key)}>
        {t('common.delete')}
      </button>
    </div>
  );
}
