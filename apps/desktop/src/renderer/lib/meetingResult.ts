import { RecordingStatus, type FileMeta, type RecordingCard, type TranscriptSegment, type TranscriptSpeaker } from '@calaba/protocol';
import { mediaKind } from './chatMedia';
import { parseMarkdown, type MdNode } from './markdown/parse';

/**
 * The result of a recorded meeting in the chat card (docs/09 #47, docs/08 «Запись встреч»): the
 * summary's Markdown blocks, the transcript's texts, search and the segment under the player,
 * who may delete the recording (#50). Pure: unit-tested.
 */

// ---------------------------------------------------------------- summary

/**
 * A block of the summary: GPTunneL writes Markdown with `##` headings and `-` / `1.` lists
 * («Темы / Решения / Задачи…»); the inline part (bold, italic, code, links) goes through our
 * markdown-lite parser (lib/markdown) when rendered.
 */
export type SummaryBlock = { t: 'h'; text: string } | { t: 'li'; text: string; n?: string } | { t: 'p'; text: string };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;
const NUMBERED = /^(\d{1,3})[.)]\s+(.*)$/;

/** Lines → blocks; consecutive plain lines join into one paragraph, blank lines end it. */
export function summaryBlocks(md: string): SummaryBlock[] {
  const out: SummaryBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      // «## **Темы**» — the heading is bold anyway.
      const text = (h[1] ?? '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
      if (text) out.push({ t: 'h', text });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flush();
      out.push({ t: 'li', text: b[1] ?? '' });
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n) {
      flush();
      out.push({ t: 'li', text: n[2] ?? '', n: n[1] ?? '' });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** Lines of a folded summary (docs/08: 4–6 lines). */
export const SUMMARY_FOLD_LINES = 6;

/**
 * Whether the summary folds, known before layout: every block is at least one line, so more
 * blocks than SUMMARY_FOLD_LINES never fit. Fewer may still wrap past the fold — the card measures
 * those — but a long summary is folded (and has its «Показать всё») from its very first render, so
 * the virtualised feed never measures it unfolded.
 */
export function summaryFoldsUpfront(blocks: readonly SummaryBlock[]): boolean {
  return blocks.length > SUMMARY_FOLD_LINES;
}

/** Inline markdown-lite → plain text: markers dropped, a link keeps its address, mentions `@<v>`. */
function inlinePlain(nodes: MdNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code' || n.t === 'codeblock') out += n.v;
    else if (n.t === 'mention') out += `@${n.v}`;
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'link') {
      const text = inlinePlain(n.c);
      out += text && text !== n.href ? `${text} (${n.href})` : n.href;
    } else out += inlinePlain(n.c);
  }
  return out;
}

/**
 * The summary as plain text for «Копировать самари» (owner, 28.09): line by line as GPTunneL wrote
 * it, so it pastes cleanly into Telegram / notes — headings without `#` and bold, bullets as «• »,
 * numbered items as «1. », inline `**` / `__` / `*` / `` ` `` markers stripped, links «text (url)»,
 * mentions `@<id>`; runs of blank lines collapse into one.
 */
export function summaryPlainText(md: string): string {
  const lines: string[] = [];
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    const plain = (s: string): string => inlinePlain(parseMarkdown(s)).trim();
    const h = HEADING.exec(line);
    const b = h ? null : BULLET.exec(line);
    const n = h || b ? null : NUMBERED.exec(line);
    if (h) lines.push(plain((h[1] ?? '').replace(/^\*\*(.*)\*\*$/, '$1')));
    else if (b) lines.push(`• ${plain(b[1] ?? '')}`);
    else if (n) lines.push(`${n[1] ?? ''}. ${plain(n[2] ?? '')}`);
    else lines.push(plain(line));
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------- card

/** The recording's audio: the audio attachment of the card message (kept RECORDING_KEEP_DAYS). */
export function recordingAudio(card: Pick<RecordingCard, 'audioUntil' | 'deletedAt'>, files: readonly FileMeta[]): FileMeta | null {
  if (!card.audioUntil || card.deletedAt) return null;
  return files.find((f) => mediaKind(f) === 'audio' || f.mime === 'audio/mp4') ?? null;
}

/**
 * «Удалить запись» (#50): who started it, the owner, MANAGE_MESSAGES in the room or workspace
 * MANAGE_RECORDINGS (ADR-0048; the card is in a room I see); not while it records.
 */
export function mayDeleteRecording(
  card: Pick<RecordingCard, 'status' | 'startedBy' | 'deletedAt'>,
  me: string,
  opts: { owner: boolean; manageMessages: boolean; manageRecordings?: boolean },
): boolean {
  if (card.deletedAt || card.status === RecordingStatus.RECORDING) return false;
  return (!!me && card.startedBy === me) || opts.owner || opts.manageMessages || !!opts.manageRecordings;
}

// ---------------------------------------------------------------- transcript

/** «1:05», «1:02:03» from milliseconds. */
export function stamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The speaker's number for people: recognition counts from 0, people from 1; -1 = unknown. */
export const speakerNumber = (speaker: number): number | null => (speaker >= 0 ? speaker + 1 : null);

/**
 * Who said a remark (ADR-0169): a person of the workspace (the client shows their name and
 * avatar), someone named by the server (a phone caller), or the recognition's number (from 1);
 * null = nobody known.
 */
export type RemarkSpeaker = { userId: string; n: number | null } | { name: string; n: number | null } | { n: number };

/** The speakers of a transcript by number (GetRecordingTranscriptResponse.speakers). */
export function speakersByNumber(speakers: readonly Pick<TranscriptSpeaker, 'speaker' | 'userId' | 'name'>[]): ReadonlyMap<number, { userId: string; name: string }> {
  return new Map(speakers.map((s) => [s.speaker, { userId: s.userId, name: s.name }]));
}

/** The remark's own person first (a merged number is decided per remark), then its number's. */
export function remarkSpeaker(s: Pick<TranscriptSegment, 'speaker' | 'userId'>, byNumber: ReadonlyMap<number, { userId: string; name: string }>): RemarkSpeaker | null {
  const n = speakerNumber(s.speaker);
  if (s.userId) return { userId: s.userId, n };
  const known = byNumber.get(s.speaker);
  if (known?.userId) return { userId: known.userId, n };
  if (known?.name) return { name: known.name, n };
  return n === null ? null : { n };
}

/**
 * Indexes of the segments that contain every word of the query (case-insensitive) in the text
 * or, given `label`, in the speaker's name.
 */
export function searchSegments<S extends Pick<TranscriptSegment, 'text'>>(segments: readonly S[], query: string, label?: (s: S) => string): number[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return segments.map((_, i) => i);
  const out: number[] = [];
  segments.forEach((s, i) => {
    const text = (label ? `${label(s)} ${s.text}` : s.text).toLocaleLowerCase();
    if (words.every((w) => text.includes(w))) out.push(i);
  });
  return out;
}

/** The segment being played at `sec` (the last one that started at or before it), -1 = none. */
export function segmentAt(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], sec: number): number {
  const ms = sec * 1000;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid]?.startMs ?? 0) <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Past the end of the last remark by more than a few seconds: a pause, nothing highlighted.
  if (found >= 0 && ms > (segments[found]?.endMs ?? 0) + 5000) return -1;
  return found;
}

/**
 * The transcript as plain text for «Копировать» / «Скачать .txt»: «[1:05] Анна: …», «[1:07]
 * Спикер 2: …»; `label` names the remark's speaker ('' = nobody known).
 */
export function transcriptText<S extends Pick<TranscriptSegment, 'startMs' | 'text'>>(segments: readonly S[], label: (s: S) => string, header = ''): string {
  const lines = segments.map((s) => {
    const who = label(s);
    return `[${stamp(s.startMs)}] ${who ? `${who}: ` : ''}${s.text}`;
  });
  return (header ? `${header}\n\n` : '') + lines.join('\n') + '\n';
}

/** A file name for the transcript: «Транскрипт 2026-09-27 15-04.txt» (no path characters). */
export function transcriptFileName(label: string, started: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = `${started.getFullYear()}-${p(started.getMonth() + 1)}-${p(started.getDate())} ${p(started.getHours())}-${p(started.getMinutes())}`;
  return `${label.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()} ${d}.txt`;
}
