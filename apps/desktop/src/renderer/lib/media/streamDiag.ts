/**
 * Screen-share quality diagnostics for main.log (docs/02-media.md «Стрим: диагностика качества»).
 * Fed from the existing 2 s stats tick (services/voice.ts collectStats) and from livekit's
 * subscribed-quality updates: no timers of its own. A line is written only when the state
 * changes, never periodically. Pure, unit-tested.
 */

import type { InboundVideoStats, OutboundVideoLayer } from './stats';

/** livekit VideoQuality (protocol): LOW / MEDIUM / HIGH → simulcast rid (videoQualityForRid). */
const RID_OF_QUALITY: Record<number, string> = { 0: 'q', 1: 'h', 2: 'f' };

/** Minor changes (fps, target bitrate) are logged at most this often; layer/size changes at once. */
export const MINOR_LOG_MS = 30_000;
/** A requested layer that is still off (or the reverse) after this long is flagged `MISMATCH`. */
export const MISMATCH_GRACE_MS = 4_000;
/** The viewer side logs a received-resolution change at most this often per stream. */
export const VIEWER_LOG_MS = 10_000;

interface QualityLike {
  quality?: number;
  enabled?: boolean;
}

/**
 * The layers the SFU asks for: `subscribedCodecs` of a livekit `SubscribedQualityUpdate` (what
 * `LocalVideoTrack.setPublishingCodecs` gets on every dynacast update), as sorted rids: ['h', 'q'].
 */
export function requestedRids(subscribedCodecs: unknown): string[] {
  // One codec per screen share (no backup codec, ADR-0032): the first one's qualities.
  const codecs = Array.isArray(subscribedCodecs) ? (subscribedCodecs as Array<{ qualities?: QualityLike[] } | null>) : [];
  const qualities = codecs[0]?.qualities ?? [];
  const rids = new Set<string>();
  for (const q of qualities) {
    const rid = q.quality === undefined ? undefined : RID_OF_QUALITY[q.quality];
    if (q.enabled && rid) rids.add(rid);
  }
  return [...rids].sort();
}

function round(v: number | null): string {
  return v === null ? '?' : String(Math.round(v));
}

function layerText(l: OutboundVideoLayer): string {
  const rid = l.rid ?? '-';
  if (l.active === false) return `${rid}:off`;
  return `${rid}:on ${round(l.width)}x${round(l.height)}@${round(l.fps)} t${round(l.targetKbps)}k`;
}

/** Coarse buckets so that jitter in fps / BWE target does not count as a change. */
function fpsBucket(fps: number | null): number {
  return fps === null || fps < 1 ? 0 : Math.round(Math.log2(fps));
}
function kbpsBucket(kbps: number | null): number {
  return kbps === null || kbps < 1 ? 0 : Math.round(Math.log(kbps) / Math.log(1.5));
}

/**
 * Publisher side: one line per change of the stream's encoder state. Major changes (a layer on/off,
 * its frame size, `qualityLimitationReason`, the SFU's request, a mismatch between the two) are
 * logged at once; minor ones (fps, target bitrate by ×1.5 steps) at most every MINOR_LOG_MS.
 */
export class PublisherDiag {
  private requested: string[] | null = null;
  private requestedAt = 0;
  private major = '';
  private minor = '';
  private loggedAt = -Infinity;

  /** Records the SFU's request; returns its log line, null when it repeats the last one. */
  request(rids: string[], now: number): string | null {
    if (this.requested && this.requested.join() === rids.join()) return null;
    this.requested = rids;
    this.requestedAt = now;
    return `stream: SFU requests ${rids.length ? rids.join(',') : 'none'}`;
  }

  /** The stream stopped: the next one starts with a fresh line. */
  reset(): void {
    this.requested = null;
    this.major = '';
    this.minor = '';
    this.loggedAt = -Infinity;
  }

  /** The line to log for this stats tick, or null when nothing changed. */
  tick(layers: readonly OutboundVideoLayer[], now: number): string | null {
    if (layers.length === 0) return null;
    const sorted = [...layers].sort((a, b) => (a.rid ?? '').localeCompare(b.rid ?? ''));
    const limits = [...new Set(sorted.filter((l) => l.active !== false).map((l) => l.qualityLimitation))];
    const lim = limits.length ? limits.join('/') : '-';
    const sfu = this.requested ? (this.requested.length ? this.requested.join(',') : 'none') : '?';
    const mismatch = this.requested !== null && now - this.requestedAt >= MISMATCH_GRACE_MS && this.mismatched(sorted, this.requested);
    const major = [...sorted.map((l) => (l.active === false ? `${l.rid}:off` : `${l.rid}:${l.width}x${l.height}`)), lim, sfu, mismatch].join('|');
    const minor = sorted.map((l) => `${fpsBucket(l.fps)}/${kbpsBucket(l.targetKbps)}`).join('|');
    if (major === this.major && (minor === this.minor || now - this.loggedAt < MINOR_LOG_MS)) return null;
    this.major = major;
    this.minor = minor;
    this.loggedAt = now;
    return `stream out: ${sorted.map(layerText).join(' | ')} | lim=${lim} | sfu=${sfu}${mismatch ? ' | MISMATCH' : ''}`;
  }

  /** A layer the SFU wants that the encoder does not send, or the reverse (stats `active`). */
  private mismatched(layers: readonly OutboundVideoLayer[], requested: readonly string[]): boolean {
    return layers.some((l) => l.rid !== null && l.active !== null && l.active !== requested.includes(l.rid));
  }
}

/**
 * Viewer side: the received resolution of the watched stream (which simulcast layer arrives), one
 * line per change, at most every VIEWER_LOG_MS per stream; a change inside the window is logged
 * on the first tick after it if it still holds.
 */
export class ViewerDiag {
  private sid: string | null = null;
  private logged = '';
  private loggedAt = -Infinity;

  tick(sid: string | null, v: InboundVideoStats | null, now: number): string | null {
    if (sid !== this.sid) {
      this.sid = sid;
      this.logged = '';
      this.loggedAt = -Infinity;
    }
    if (!sid || !v || v.width === null || v.height === null) return null;
    const size = `${v.width}x${v.height}`;
    if (size === this.logged || now - this.loggedAt < VIEWER_LOG_MS) return null;
    const was = this.logged;
    this.logged = size;
    this.loggedAt = now;
    return `stream in: ${sid} ${size}@${round(v.fps)} ${v.codec} ${round(v.kbps)}k${was ? ` (was ${was})` : ''}`;
  }
}
