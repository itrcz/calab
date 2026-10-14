import { WorkspaceRole, type PermissionBits, type RecordingCard as Card } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { AlertCircle, Copy, CornerUpLeft, FileText, Forward, Loader2, MoreHorizontal, Pause, Play, RefreshCw, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { formatTime } from '../../lib/chatMedia';
import { fmt, toDate } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { mayDeleteRecording, recordingAudio, summaryBlocks, summaryPlainText } from '../../lib/meetingResult';
import { can, mayManageRecordings } from '../../lib/permissions';
import { cardStatus, durationText, retryActions, type RetryAction } from '../../lib/recording';
import { openForward } from '../../services/forward';
import { deleteRecording, retryRecording } from '../../services/recording';
import { usePlayer, type Track } from '../../stores/player';
import { toast } from '../../stores/toasts';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { rolesOf, useMemberName, useWorkspaces } from '../../stores/workspaces';
import type { ChatMessage } from '../../stores/messages';
import { menuBox, menuItem } from '../shell/menu';
import { useReportInView } from './MediaPlayer';

const RecordingTranscript = lazy(() => import('./RecordingTranscript'));

/**
 * The chat card of a meeting recording (ADR-0025, docs/08 «Запись встреч», docs/09 #47 / #50): a
 * system message across the whole feed (no bubble). The REC glyph, «Встреча записана · 42 мин»,
 * who started it and when, the status only while it matters (Загрузка… / Обработка… / Ошибка: …;
 * no «Готово» row: owner, 28.09, #88); once done — GPTunneL's summary (6 lines, «Показать всё») and
 * «Полный транскрипт» (no «Открыть в GPTunneL»: owner, 28.09, #80). With audio the REC circle is
 * the play / pause control (the chat's player, #88; no inline player in the card). A failed
 * card offers a retry (#40, not to guests); «…» → «Переслать» (ADR-0033), «Копировать самари»
 * (#80) and «Удалить запись» (who started it, the owner, MANAGE_MESSAGES, MANAGE_RECORDINGS). A forwarded copy
 * (Message.forward) is the same card without the retry and delete actions: they belong to the
 * recording's own room.
 * MESSAGE_UPDATE replaces the message: the card follows.
 */
export function RecordingCardView({ c, card, workspaceId, perms }: { c: ChatMessage; card: Card; workspaceId: string; perms: PermissionBits }): ReactNode {
  const by = useMemberName(workspaceId, card.startedBy || c.msg.authorId);
  const deletedBy = useMemberName(workspaceId, card.deletedBy);
  const started = card.startedAt ? timestampDate(card.startedAt) : toDate(c.msg.createdAt);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const suspended = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.suspension);
  const me = useSession((s) => s.me?.user?.id ?? '');
  // ADR-0048: MANAGE_RECORDINGS of the workspace deletes any recording of a room I see (a boolean selector).
  const manageRecordings = useWorkspaces((s) => mayManageRecordings(rolesOf(s.byId[workspaceId], me)));
  const [busy, setBusy] = useState<RetryAction | null>(null);
  const [transcript, setTranscript] = useState(false);
  const title = `${t('rec.card.title')} · ${durationText(card.durationSec)}`;
  const reply = useCallback(() => useUi.getState().setReply(c.msg.roomId, c.msg.id), [c.msg.roomId, c.msg.id]);

  if (card.deletedAt) {
    return (
      <article aria-label={t('rec.card.deleted')} data-testid="recording-card" data-status="deleted" className="rec-card flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-4 py-2.5">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-hover text-muted">
          <Trash2 className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body font-semibold text-muted">{t('rec.card.deleted')}</span>
          <span className="truncate text-caption text-muted">{t('rec.card.deletedMeta', { name: deletedBy, time: fmt.dateTime(timestampDate(card.deletedAt), 'short') })}</span>
        </div>
      </article>
    );
  }

  const status = cardStatus(card);
  const StatusIcon = status.tone === 'error' ? AlertCircle : Loader2;
  const guest = role === WorkspaceRole.GUEST;
  const copy = !!c.msg.forward;
  const retries = guest || copy ? [] : retryActions(card);
  const audio = recordingAudio(card, c.msg.attachments);
  const mayDelete = !copy && mayDeleteRecording(card, me, { owner: role === WorkspaceRole.OWNER, manageMessages: can(perms, 'MANAGE_MESSAGES'), manageRecordings });
  const mayReply = c.status === 'sent' && can(perms, 'SEND_MESSAGES') && !suspended;
  const when = fmt.dateTime(started, 'short');
  const retry = (action: RetryAction): void => {
    setBusy(action);
    void retryRecording(c.msg.roomId, card.recordingId, action, workspaceId).finally(() => setBusy(null));
  };
  const track: Track | null = audio
    ? { fileId: audio.id, messageId: c.msg.id, roomId: c.msg.roomId, name: audio.name, title: t('rec.card.label'), subtitle: when }
    : null;
  const hasActions = mayReply || card.hasTranscript || retries.length > 0;

  return (
    <article
      aria-label={`${title}. ${t(status.key)}`}
      data-testid="recording-card"
      data-status={status.tone}
      className="rec-card group/rec flex w-full flex-col gap-2.5 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-4 py-3 shadow-[var(--shadow-card)] mobile:px-3"
    >
      <div className="flex items-start gap-3">
        {track ? (
          <PlayBadge track={track} />
        ) : (
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[10px] font-bold tracking-wide text-danger-text"
          >
            {t('rec.badge')}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-semibold text-fg">
            {t('rec.card.title')} · {track ? <TrackTime track={track} durationSec={card.durationSec} /> : durationText(card.durationSec)}
          </span>
          <span className="truncate text-caption text-muted">{t('rec.card.meta', { name: by, time: when })}</span>
          {/* Only while it matters (owner, 28.09, #88): no «Готово» row. */}
          {status.tone === 'ok' ? null : (
            <span
              className={cx('mt-0.5 flex items-start gap-1.5 text-caption', status.tone === 'error' ? 'text-danger-text' : 'text-muted')}
              data-testid="recording-card-status"
            >
              {/* «Идёт запись…» / processing last minutes to hours: the spinner turns 10 times, then
                  stands (no endless animation, docs/08 «Движение», docs/09 #64). */}
              <StatusIcon className={cx('mt-px size-3.5 shrink-0', status.tone === 'busy' && 'animate-spin [animation-iteration-count:10] motion-reduce:animate-none')} aria-hidden />
              <span className="min-w-0">{t(status.key)}</span>
            </span>
          )}
        </div>
        <CardMenu
          onForward={c.status === 'sent' ? () => openForward(c.msg.roomId, c.msg.id) : undefined}
          onCopy={card.summary ? () => copySummary(card.summary) : undefined}
          onDelete={mayDelete ? () => void deleteRecording(c.msg.roomId, card.recordingId) : undefined}
        />
      </div>

      {card.summary ? <Summary text={card.summary} /> : null}

      {hasActions ? (
        <div className="flex flex-wrap gap-2">
          {mayReply ? (
            <Button size="sm" variant="secondary" onClick={reply} data-testid="recording-card-reply">
              <CornerUpLeft className="size-3" aria-hidden />
              {t('chat.reply')}
            </Button>
          ) : null}
          {card.hasTranscript ? (
            <Button size="sm" variant="secondary" onClick={() => setTranscript(true)} data-testid="recording-card-transcript">
              <FileText className="size-3" aria-hidden />
              {t('rec.card.transcript')}
            </Button>
          ) : null}
          {retries.map((a) => (
            <Button key={a} size="sm" variant="secondary" busy={busy === a} disabled={busy !== null} onClick={() => retry(a)} data-testid={`recording-card-${a}`}>
              {busy === a ? null : a === 'recheck' ? <RefreshCw className="size-3" aria-hidden /> : <Upload className="size-3" aria-hidden />}
              {t(a === 'recheck' ? 'rec.card.recheck' : 'rec.card.reupload')}
            </Button>
          ))}
        </div>
      ) : null}

      {transcript ? (
        <Suspense fallback={null}>
          <RecordingTranscript roomId={c.msg.roomId} recordingId={card.recordingId} title={title} started={started} track={track} onClose={() => setTranscript(false)} />
        </Suspense>
      ) : null}
    </article>
  );
}

/** «Копировать самари» (docs/09 #80): the summary as plain text, «Скопировано» toast. */
function copySummary(text: string): void {
  navigator.clipboard.writeText(summaryPlainText(text)).then(
    () => toast.success(t('chat.copied')),
    (e: unknown) => toast.fail(e),
  );
}

/** «…» of the card: «Переслать» (ADR-0033), «Копировать самари» (#80), «Удалить запись» (docs/09 #50). */
function CardMenu({ onForward, onCopy, onDelete }: { onForward: (() => void) | undefined; onCopy: (() => void) | undefined; onDelete: (() => void) | undefined }): ReactNode {
  if (!onForward && !onCopy && !onDelete) return null;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('rec.card.menu')} size="sm" className="-mr-1.5 -mt-0.5 mobile:-my-2 mobile:-mr-3 mobile:size-11" data-testid="recording-card-menu">
          <MoreHorizontal className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={4} collisionPadding={16} className={menuBox}>
          {onForward ? (
            <Dropdown.Item className={menuItem} onSelect={onForward} data-testid="recording-card-forward">
              <Forward className="size-4" aria-hidden />
              {t('chat.forward')}
            </Dropdown.Item>
          ) : null}
          {onCopy ? (
            <Dropdown.Item className={menuItem} onSelect={onCopy} data-testid="recording-card-copy-summary">
              <Copy className="size-4" aria-hidden />
              {t('rec.card.copySummary')}
            </Dropdown.Item>
          ) : null}
          {onDelete ? (
            <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={onDelete} data-testid="recording-card-delete">
              <Trash2 className="size-4" aria-hidden />
              {t('common.delete')}
            </Dropdown.Item>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Summary lines shown folded (docs/08: 4–6 lines); 20 px each. */
const FOLDED_PX = 6 * 20;

/**
 * GPTunneL's summary: headings, lists, inline markdown-lite; folded to 6 lines with «Показать всё».
 * Also in the recording window opened from search (RecordingResult): the copy button shows on
 * hover / focus of the nearest `group/rec`.
 */
export function Summary({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setTall(el.scrollHeight > FOLDED_PX + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const blocks = summaryBlocks(text);
  const plain = (v: string): string => `@${v}`;
  return (
    <section aria-label={t('rec.card.summary')} data-testid="recording-card-summary" className="relative border-t border-line pt-2.5">
      {/* «Копировать самари» (#80): on the card's hover / focus on desktop, always on a phone (no hover). */}
      <IconButton
        label={t('rec.card.copySummary')}
        size="sm"
        className="absolute right-0 top-1.5 z-[1] size-6 opacity-0 focus-visible:opacity-100 group-focus-within/rec:opacity-100 group-hover/rec:opacity-100 mobile:top-1 mobile:size-8 mobile:opacity-100"
        onClick={() => copySummary(text)}
        data-testid="recording-card-summary-copy"
      >
        <Copy className="size-3.5" aria-hidden />
      </IconButton>
      <div
        ref={box}
        className={cx('relative pr-7 text-body leading-5 text-fg mobile:pr-9', !open && tall && 'overflow-hidden')}
        style={!open && tall ? { maxHeight: FOLDED_PX, maskImage: 'linear-gradient(to bottom, #000 70%, transparent)' } : undefined}
      >
        {blocks.map((b, i) =>
          b.t === 'h' ? (
            <h4 key={i} className={cx('text-caption font-semibold uppercase tracking-wide text-muted', i > 0 && 'mt-2')}>
              <Markdown text={b.text} mention={plain} />
            </h4>
          ) : b.t === 'li' ? (
            <div key={i} className="flex gap-1.5 pl-1">
              <span aria-hidden className="w-3 shrink-0 text-muted">
                {b.n ? `${b.n}.` : '•'}
              </span>
              <span className="min-w-0 break-words">
                <Markdown text={b.text} mention={plain} />
              </span>
            </div>
          ) : (
            <p key={i} className={cx('break-words', i > 0 && 'mt-1')}>
              <Markdown text={b.text} mention={plain} />
            </p>
          ),
        )}
      </div>
      {tall ? (
        <button type="button" className="mt-1 text-caption font-medium text-accent-text hover:underline mobile:-mb-2 mobile:min-h-8" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="recording-card-more">
          {open ? t('rec.card.less') : t('rec.card.more')}
        </button>
      ) : null}
    </section>
  );
}

const sameTrack = (a: Track | null, b: Track): boolean => !!a && a.fileId === b.fileId && a.messageId === b.messageId;

/** Progress ring: r = 19 in the 40 px circle, 2 px stroke. */
const RING_R = 19;
const RING_C = 2 * Math.PI * RING_R;
/** Ring steps (the store's position ticks ~4 Hz; the ring re-renders only when a step changes). */
const RING_STEPS = 240;

/**
 * The REC circle as the recording's play / pause (owner, 28.09, docs/09 #88): the chat's player
 * (`usePlayer`, one `<audio>`, docs/02), a thin progress ring while this track is active. Its own
 * subscriptions (booleans; the ring is a leaf of its own): a tick never re-renders the card. It
 * reports itself on screen like a message's player, so the mini-player shows only once the card
 * scrolls away. A native button: Space / Enter toggle.
 */
function PlayBadge({ track }: { track: Track }): ReactNode {
  const active = usePlayer((s) => sameTrack(s.track, track));
  const playing = usePlayer((s) => active && s.playing);
  const ref = useRef<HTMLButtonElement>(null);
  useReportInView(ref, active);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => usePlayer.getState().toggle(track)}
      aria-label={playing ? t('rec.card.pause') : t('rec.card.listen')}
      data-testid="recording-card-play"
      data-playing={playing || undefined}
      className="relative grid size-10 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-danger-text transition-colors duration-[var(--motion-fast)] hover:bg-[color-mix(in_srgb,var(--color-danger)_26%,transparent)] focus-visible:outline-offset-2 active:bg-[color-mix(in_srgb,var(--color-danger)_32%,transparent)]"
    >
      {active ? <Ring track={track} /> : null}
      {playing ? <Pause className="size-4 fill-current" aria-hidden /> : <Play className="ml-0.5 size-4 fill-current" aria-hidden />}
    </button>
  );
}

/** The progress ring of the active track (a leaf: the only thing a position tick re-renders). */
function Ring({ track }: { track: Track }): ReactNode {
  const step = usePlayer((s) => (sameTrack(s.track, track) && s.duration > 0 ? Math.round(Math.min(1, s.position / s.duration) * RING_STEPS) : 0));
  return (
    <svg aria-hidden viewBox="0 0 40 40" className="pointer-events-none absolute inset-0 size-full -rotate-90">
      <circle cx="20" cy="20" r={RING_R} fill="none" strokeWidth="2" className="stroke-[color-mix(in_srgb,var(--color-danger)_28%,transparent)]" />
      <circle
        cx="20"
        cy="20"
        r={RING_R}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - step / RING_STEPS)}
        className="stroke-[var(--color-danger)]"
      />
    </svg>
  );
}

/**
 * «42 мин» in the card's title; «2:14 / 5:12» while this track is active (a leaf: the selector
 * returns the text, so it re-renders once a second at most), «Не удалось воспроизвести» on an error.
 */
function TrackTime({ track, durationSec }: { track: Track; durationSec: number }): ReactNode {
  const text = usePlayer((s) => {
    if (!sameTrack(s.track, track)) return null;
    if (s.error) return t('media.error');
    const total = s.duration > 0 ? s.duration : durationSec > 0 ? durationSec : Number.NaN;
    return `${formatTime(s.position)} / ${formatTime(total)}`;
  });
  return text === null ? durationText(durationSec) : <span className="tabular-nums" data-testid="recording-card-time">{text}</span>;
}
