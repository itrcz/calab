import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { FileMeta, RecordingCard } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { recordingAudio } from '../../lib/meetingResult';
import { cardStatus, durationText, recordingCardOf } from '../../lib/recording';
import type { Track } from '../../stores/player';
import { useRooms } from '../../stores/rooms';
import { useMemberName } from '../../stores/workspaces';
import { AudioAttachment } from './MediaPlayer';
import { Summary } from './RecordingCard';
import RecordingTranscript from './RecordingTranscript';

/**
 * «Запись встречи» opened from a search hit (ADR-0062 §4, docs/08 «Запись встреч»): the card's
 * message (SearchTranscriptRef.message_id: its own card or the forwarded copy in the room where
 * the caller sees it) gives the status, the audio and the summary; the transcript dialog shows
 * them above the remarks — the player (the chat's one `<audio>`, docs/02; a click on a remark
 * seeks it), the summary (folded, «Показать всё»), then the transcript centred on the hit.
 * Without the message (gone, an old hit, failed to load) it is the plain transcript.
 */
export default function RecordingResult({
  roomId,
  recordingId,
  messageId,
  offsetMs,
  startedAt,
  onClose,
}: {
  roomId: string;
  recordingId: string;
  messageId: string;
  offsetMs: number;
  startedAt: number;
  onClose: () => void;
}): ReactNode {
  const q = useQuery({
    queryKey: ['recording-message', roomId, messageId],
    queryFn: () => api.messages.get(roomId, messageId),
    enabled: !!messageId,
    staleTime: 60_000,
    retry: false, // a gone card (404) falls back to the plain transcript at once
  });
  const m = q.data;
  const card = m ? recordingCardOf(m) : null;
  const ok = !!m && !!card && card.recordingId === recordingId && !card.deletedAt;
  const started = ok && card.startedAt ? timestampDate(card.startedAt) : new Date(startedAt);
  const title = ok ? `${t('rec.card.title')} · ${durationText(card.durationSec)}` : t('rec.card.title');
  const audio = ok ? recordingAudio(card, m.attachments) : null;
  const when = fmt.dateTime(started, 'short');
  // The same track as the chat card's (file + message), so the card, the mini-player and the
  // transcript rows agree on what is playing.
  const track: Track | null = ok && audio ? { fileId: audio.id, messageId: m.id, roomId: m.roomId, name: audio.name, title: t('rec.card.label'), subtitle: when } : null;

  // One short GET: the window opens once it is answered, so it does not jump from «Транскрипт
  // встречи» to «Запись встречи» (and the hit's remark stays centred in the final list height).
  if (messageId && q.isPending) return null;
  return (
    <RecordingTranscript
      roomId={roomId}
      recordingId={recordingId}
      title={title}
      started={started}
      track={track}
      initialMs={offsetMs}
      onClose={onClose}
      lead={ok ? <Lead card={card} roomId={m.roomId} audio={audio} track={track} when={when} /> : undefined}
    />
  );
}

/** Who started it and when, the status while it matters, the player, the summary. */
function Lead({ card, roomId, audio, track, when }: { card: RecordingCard; roomId: string; audio: FileMeta | null; track: Track | null; when: string }): ReactNode {
  const workspaceId = useRooms((s) => s.byId[roomId]?.workspaceId || null);
  const by = useMemberName(workspaceId, card.startedBy);
  const status = cardStatus(card);
  const StatusIcon = status.tone === 'error' ? AlertCircle : Loader2;
  return (
    <div className="rec-card group/rec flex flex-col gap-2.5" data-testid="recording-result">
      <span className="text-caption text-muted">{t('rec.card.meta', { name: by, time: when })}</span>
      {status.tone === 'ok' ? null : (
        <span className={cx('flex items-start gap-1.5 text-caption', status.tone === 'error' ? 'text-danger-text' : 'text-muted')} data-testid="recording-result-status">
          {/* The spinner turns 10 times, then stands (no endless animation, docs/08 «Движение»). */}
          <StatusIcon className={cx('mt-px size-3.5 shrink-0', status.tone === 'busy' && 'animate-spin [animation-iteration-count:10] motion-reduce:animate-none')} aria-hidden />
          <span className="min-w-0">{t(status.key)}</span>
        </span>
      )}
      {audio && track ? (
        <AudioAttachment f={audio} messageId={track.messageId} roomId={track.roomId} label={t('rec.card.label')} subtitle={when} className="w-full" />
      ) : null}
      {card.summary ? <Summary text={card.summary} /> : null}
    </div>
  );
}
