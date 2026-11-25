import { useQuery } from '@tanstack/react-query';
import { Copy, Download, Search } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Avatar } from '../../components/Avatar';
import { Button, Input, Modal, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { remarkSpeaker, searchSegments, segmentAt, speakersByNumber, stamp, transcriptFileName, transcriptText, type RemarkSpeaker } from '../../lib/meetingResult';
import { usePlayer, type Track } from '../../stores/player';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';

/**
 * «Полный транскрипт» of a meeting recording (docs/09 #47, docs/08 «Запись встреч»): a wide
 * dialog (a sheet on phones) with the remarks — time, speaker, text — read from our server
 * (the speaker by name and avatar when the server matched them to a person, ADR-0169; else
 * «Спикер N»)
 * — GET …/recordings/{rid}/transcript; a search that keeps the matching remarks and marks the
 * words; a click on a remark plays the recording from there (the chat's player; the remark
 * being played is highlighted); «Копировать» and «Скачать .txt». The list is virtualised: a
 * 4-hour meeting has thousands of remarks.
 * With `lead` (the recording window opened from search, RecordingResult) it is «Запись встречи»:
 * the player and the summary above, the transcript under a hairline with a shorter list.
 */
export default function RecordingTranscript({
  roomId,
  recordingId,
  title,
  started,
  track,
  onClose,
  initialMs,
  lead,
}: {
  roomId: string;
  recordingId: string;
  title: string;
  started: Date;
  /** The recording's audio in the chat's player; null = no audio kept (no seeking). */
  track: Track | null;
  onClose: () => void;
  /** Open at this offset (a search hit, ADR-0062 §4): the remark there is centred and marked. */
  initialMs?: number;
  /** Above the transcript (the player, the summary); the dialog is then «Запись встречи». */
  lead?: ReactNode;
}): ReactNode {
  const q = useQuery({
    queryKey: ['recording-transcript', recordingId],
    queryFn: ({ signal }) => api.recording.transcript(roomId, recordingId, signal),
    staleTime: Infinity, // a transcript does not change once kept
  });
  const [query, setQuery] = useState('');
  const segments = useMemo(() => q.data?.segments ?? [], [q.data]);
  const byNumber = useMemo(() => speakersByNumber(q.data?.speakers ?? []), [q.data]);
  // A forwarded card may sit in a DM: names then come from the global user cache.
  const workspaceId = useRooms((s) => s.byId[roomId]?.workspaceId ?? null);
  const who = useCallback((s: (typeof segments)[number]): RemarkSpeaker | null => remarkSpeaker(s, byNumber), [byNumber]);
  // Plain labels for search, «Копировать» and «.txt» (read when used, not subscribed).
  const label = useCallback(
    (s: (typeof segments)[number]): string => {
      const w = who(s);
      if (!w) return '';
      if ('userId' in w) return memberName(workspaceId, w.userId);
      if ('name' in w) return w.name;
      return t('rec.tr.speaker', { n: w.n });
    },
    [who, workspaceId],
  );
  const shown = useMemo(() => searchSegments(segments, query, label), [segments, query, label]);
  const words = useMemo(() => searchWords(query), [query]);
  // Only the index of the remark under the player re-renders the list, not every time tick.
  const playing = usePlayer((s) => (track && s.track?.fileId === track.fileId && s.track.messageId === track.messageId ? segmentAt(segments, s.position) : -1));
  const list = useRef<VirtuosoHandle>(null);
  const focus = useMemo(() => (initialMs === undefined || !segments.length ? -1 : segmentAt(segments, initialMs / 1000)), [initialMs, segments]);
  const text = (): string => transcriptText(segments, label, `${title} — ${fmt.dateTime(started)}`);

  const copy = (): void => {
    navigator.clipboard.writeText(text()).then(
      () => toast.success(t('chat.copied')),
      (e: unknown) => toast.fail(e),
    );
  };
  const save = (): void => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = transcriptFileName(t('rec.tr.file'), started);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const seek = (ms: number): void => {
    if (track) usePlayer.getState().seek(track, ms / 1000);
  };

  return (
    <Modal open onClose={onClose} title={lead ? t('rec.card.label') : t('rec.tr.title')} description={title} wide>
      <div className="flex flex-col gap-3" data-testid="recording-transcript">
        {lead}
        {lead ? <h3 className="border-t border-line pt-3 text-body font-semibold text-fg">{t('rec.tr.title')}</h3> : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[200px] flex-1">
            <Input
              icon={<Search className="size-3.5" aria-hidden />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('rec.tr.search')}
              aria-label={t('rec.tr.search')}
              data-testid="recording-transcript-search"
            />
          </div>
          {query ? <span className="text-caption tabular-nums text-muted">{t('rec.tr.found', { n: shown.length })}</span> : null}
          <Button size="md" variant="secondary" onClick={copy} disabled={!segments.length}>
            <Copy className="size-3.5" aria-hidden />
            {t('rec.tr.copy')}
          </Button>
          <Button size="md" variant="secondary" onClick={save} disabled={!segments.length}>
            <Download className="size-3.5" aria-hidden />
            {t('rec.tr.download')}
          </Button>
        </div>
        {q.isPending ? (
          <div className="grid h-40 place-items-center">
            <Spinner />
          </div>
        ) : q.isError ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-body text-muted">
            {t('rec.tr.failed')}
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="grid h-40 place-items-center text-body text-muted">{query ? t('rec.tr.nothing') : t('rec.tr.empty')}</div>
        ) : (
          <Virtuoso
            ref={list}
            style={{ height: lead ? 'min(44vh, 440px)' : 'min(60vh, 560px)' }}
            {...(focus >= 0 && !query ? { initialTopMostItemIndex: { index: focus, align: 'center' as const } } : {})}
            data={shown}
            computeItemKey={(_i, idx) => idx}
            itemContent={(_i, idx) => {
              const s = segments[idx];
              if (!s) return null;
              const w = who(s);
              const body = (
                <>
                  <span className="w-14 shrink-0 pt-px text-caption tabular-nums text-muted">{stamp(s.startMs)}</span>
                  <span className="min-w-0 flex-1">
                    {w ? <SpeakerTag who={w} workspaceId={workspaceId} /> : null}
                    <span className="selectable break-words text-body text-fg">
                      {words.length
                        ? splitHits(s.text, words).map((p, i) =>
                            i % 2 === 1 ? (
                              <mark key={i} className="search-hit">
                                {p}
                              </mark>
                            ) : (
                              p
                            ),
                          )
                        : s.text}
                    </span>
                  </span>
                </>
              );
              const row = cx('flex w-full gap-3 rounded-[var(--radius-row)] px-2 py-1.5 text-left', (idx === playing || (playing < 0 && idx === focus)) && 'bg-accent/12');
              return track ? (
                <button type="button" className={cx(row, 'hover:bg-hover')} onClick={(e) => (dragSelectedHere(e) ? undefined : seek(s.startMs))} title={t('rec.tr.playFrom', { time: stamp(s.startMs) })} aria-current={idx === playing || undefined} data-testid="recording-transcript-row">
                  {body}
                </button>
              ) : (
                <div className={row} data-testid="recording-transcript-row">
                  {body}
                </div>
              );
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/** A mouse click that ends a drag-select inside this very row must not seek; keyboard activation (detail 0) always does. */
const dragSelectedHere = (e: MouseEvent<HTMLButtonElement>): boolean => {
  const sel = window.getSelection();
  return e.detail > 0 && !!sel && !sel.isCollapsed && (e.currentTarget.contains(sel.anchorNode) || e.currentTarget.contains(sel.focusNode));
};

/** Number → one of the 8 name colours, so a speaker keeps a colour through the transcript. */
const nameColor = (n: number | null): string | undefined => (n === null ? undefined : `var(--name-${((n - 1) % 8) + 1})`);

/** The speaker of a remark: a person (avatar and name), a named caller, or «Спикер N». */
const SpeakerTag = memo(function SpeakerTag({ who, workspaceId }: { who: RemarkSpeaker; workspaceId: string | null }): ReactNode {
  if ('userId' in who) return <PersonTag userId={who.userId} n={who.n} workspaceId={workspaceId} />;
  return (
    <span className="mr-1.5 text-caption font-semibold" style={{ color: nameColor(who.n) }}>
      {'name' in who ? who.name : t('rec.tr.speaker', { n: who.n })}
    </span>
  );
});

function PersonTag({ userId, n, workspaceId }: { userId: string; n: number | null; workspaceId: string | null }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const fileId = useWorkspaces((s) => (workspaceId ? s.byId[workspaceId]?.members[userId]?.user?.avatarFileId : undefined) || s.users[userId]?.avatarFileId || '');
  return (
    <span className="mr-1.5 text-caption font-semibold" style={{ color: nameColor(n) }} data-testid="recording-transcript-speaker">
      {/* Inline, not flex: the name stays on the text's baseline and the row keeps its height. */}
      <Avatar userId={userId} name={name} size={16} className="mr-1 align-middle" {...(fileId ? { fileId } : {})} />
      {name}
    </span>
  );
}
