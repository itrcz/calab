import { useQuery } from '@tanstack/react-query';
import { Copy, Download, Search } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button, Input, Modal, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { searchSegments, segmentAt, speakerNumber, stamp, transcriptFileName, transcriptText } from '../../lib/meetingResult';
import { usePlayer, type Track } from '../../stores/player';
import { toast } from '../../stores/toasts';

/**
 * «Полный транскрипт» of a meeting recording (docs/09 #47, docs/08 «Запись встреч»): a wide
 * dialog (a sheet on phones) with the remarks — time, speaker, text — read from our server
 * (GET …/recordings/{rid}/transcript); a search that keeps the matching remarks and marks the
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
  const shown = useMemo(() => searchSegments(segments, query), [segments, query]);
  const words = useMemo(() => searchWords(query), [query]);
  // Only the index of the remark under the player re-renders the list, not every time tick.
  const playing = usePlayer((s) => (track && s.track?.fileId === track.fileId && s.track.messageId === track.messageId ? segmentAt(segments, s.position) : -1));
  const list = useRef<VirtuosoHandle>(null);
  const focus = useMemo(() => (initialMs === undefined || !segments.length ? -1 : segmentAt(segments, initialMs / 1000)), [initialMs, segments]);
  const speaker = (n: number): string => t('rec.tr.speaker', { n });
  const text = (): string => transcriptText(segments, speaker, `${title} — ${fmt.dateTime(started)}`);

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
              const n = speakerNumber(s.speaker);
              const body = (
                <>
                  <span className="w-14 shrink-0 pt-px text-caption tabular-nums text-muted">{stamp(s.startMs)}</span>
                  <span className="min-w-0 flex-1">
                    {n !== null ? (
                      <span className="mr-1.5 text-caption font-semibold" style={{ color: `var(--name-${((n - 1) % 8) + 1})` }}>
                        {speaker(n)}
                      </span>
                    ) : null}
                    <span className="break-words text-body text-fg">
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
                <button type="button" className={cx(row, 'hover:bg-hover')} onClick={() => seek(s.startMs)} title={t('rec.tr.playFrom', { time: stamp(s.startMs) })} aria-current={idx === playing || undefined} data-testid="recording-transcript-row">
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
