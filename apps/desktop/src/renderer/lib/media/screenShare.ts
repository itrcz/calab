import { SCREEN_SHARE_PRESETS, type ConcreteScreenSharePreset, type ScreenShareContentHint } from '@calaba/protocol';
import {
  AudioPresets,
  LocalAudioTrack,
  LocalVideoTrack,
  Track,
  VideoPreset,
  type LocalParticipant,
  type TrackPublishOptions,
} from 'livekit-client';
import { platform } from '../../platform';
import { publishOptionalAudio, type StreamAudioProblem } from './streamAudio';
import { t } from '../../i18n';
import { capFps } from '../plan';
import type { PublishCodec } from './codecSelect';
import { evenLayerScale, layerSize, type H264Layout, type H264Profile } from './h264';
import { alignCaptureForH264, setH264Profile } from './h264Publish';
import { log } from '../log';

export type { StreamAudioProblem } from './streamAudio';

/**
 * Screen share publishing per ADR-0012 (refines ADR-0005), codec per ADR-0032: simulcast (a
 * 640×360 thumb layer + the preset), no backup codec. The codec comes from `pickPublishCodec`
 * (lib/media/codecSelect.ts): the hardware encoder if there is one (H.264 → AV1 → VP9), else AV1.
 *
 * Why simulcast: livekit-client forces L1T3 + contentHint 'motion' on a
 * non-simulcast SVC screen share; its "SVC simulcast" path (livekit-server ≥
 * 1.13.7) keeps our contentHint and gives viewers a real 640×360 layer for
 * the PiP tile, while dynacast stops encoding the full layer nobody watches.
 * H.264 has no SVC: plain rid simulcast with the same two layers; livekit-client leaves
 * contentHint alone on that path (it only rewrites it for non-simulcast SVC).
 */
const THUMB_LAYER = { width: 640, height: 360, maxBitrate: 250_000 };

/**
 * Text in H.264 needs more bits than in AV1 for the same sharpness (ADR-0032 §4, docs/02):
 * «detail» streams get +40 % on both layers' caps.
 */
export const H264_DETAIL_BITRATE_FACTOR = 1.4;

export type ScreenCodec = PublishCodec;

/** A layer's bitrate cap for this codec and content (ADR-0032 §4). */
export function screenBitrate(base: number, codec: ScreenCodec, hint: ScreenShareContentHint): number {
  return codec === 'h264' && hint === 'detail' ? Math.round(base * H264_DETAIL_BITRATE_FACTOR) : base;
}

/**
 * Publish options of a screen share at `fps` (already capped by the grant). Pure, unit-tested.
 * `layout` (H.264 only, `h264Layout` of the aligned capture): the thumb is exactly capture / its
 * integer scale, so both layers are even (hardware H.264 takes nothing else).
 */
export function screenPublishOptions(codec: ScreenCodec, preset: ConcreteScreenSharePreset, hint: ScreenShareContentHint, fps: number, layout?: H264Layout | null): TrackPublishOptions {
  const p = SCREEN_SHARE_PRESETS[preset];
  const thumb = codec === 'h264' && layout ? layerSize(layout, 0) : THUMB_LAYER;
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8/H.264: plain simulcast (no scalabilityMode in libwebrtc); AV1/VP9 use L1T3 per simulcast layer.
    ...(codec === 'vp8' || codec === 'h264' ? {} : { scalabilityMode: 'L1T3' as const }),
    screenShareEncoding: { maxBitrate: screenBitrate(p.maxBitrate, codec, hint), maxFramerate: fps },
    screenShareSimulcastLayers: [new VideoPreset(thumb.width, thumb.height, screenBitrate(THUMB_LAYER.maxBitrate, codec, hint), fps)],
    degradationPreference: hint === 'detail' ? 'maintain-resolution' : 'balanced',
  };
}

/** What `setThumbScale` needs of an RTCRtpSender (a fake one in tests). */
export type ParamsSender = Pick<RTCRtpSender, 'getParameters' | 'setParameters'>;

/** A mutex in the shape of `@livekit/mutex`: `lock()` resolves with the unlock function. */
export interface SenderLock {
  lock(): Promise<() => void>;
}

/**
 * livekit-client's per-track sender mutex (`LocalVideoTrack.senderLock`, private; livekit-client is
 * pinned exactly, re-check on upgrade). Dynacast (`setPublishingLayersForSender`: `encodings[].active`
 * on every subscribed-quality update), `refreshSenderEncodings` and `prioritizePerformance` hold it
 * from their `getParameters()` until their `setParameters()` settles. Null if it is gone.
 */
export function livekitSenderLock(track: LocalVideoTrack): SenderLock | null {
  const l = (track as unknown as { senderLock?: Partial<SenderLock> }).senderLock;
  return l && typeof l.lock === 'function' ? (l as SenderLock) : null;
}

/**
 * Sets the thumb layer's (`rid` q) `scaleResolutionDownBy` and nothing else, under livekit's sender
 * lock: dynacast's own read-modify-write of `active` / `maxBitrate` is then never in flight while we
 * read the parameters, so writing them back cannot restore a stale `active: false` on the full
 * layer (viewers stuck on the thumb until the stream restarts). False = already that scale.
 */
export async function setThumbScale(sender: ParamsSender, lock: SenderLock | null, scale: number): Promise<boolean> {
  const unlock = lock ? await lock.lock() : null;
  try {
    // Read right before the write (no await in between): `active` / `maxBitrate` stay as they are now.
    const params = sender.getParameters();
    const thumb = params.encodings.find((e) => e.rid === 'q');
    if (!thumb || thumb.scaleResolutionDownBy === scale) return false;
    thumb.scaleResolutionDownBy = scale;
    await sender.setParameters(params);
    return true;
  } finally {
    unlock?.();
  }
}

export interface DesktopSource {
  id: string;
  name: string;
  /** A whole screen's display id (desktop): the presenter's annotation overlay covers it (ADR-0028). */
  displayId?: string;
}

export interface ScreenShareOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
  /** Codec to publish with: `pickPublishCodec('screen', pref)` (ADR-0032). Default AV1. */
  codec?: ScreenCodec;
  /** H.264 profile of that pick: High («Авто», hardware) or Constrained Baseline (default). */
  h264Profile?: H264Profile;
  /**
   * Frame rate granted by /stream/request (the plan's stream_max_fps, ADR-0024): capture and
   * encoding never go above it. Unset / 0 = the preset's own.
   */
  fps?: number;
}

export interface ActiveScreenShare {
  video: LocalVideoTrack;
  /**
   * H.264: after the capture changed size and left the thumb layer odd (`hasOddH264Layer`, OpenH264
   * in software), gives that layer a scale with even sides (`evenLayerScale`) — the capture itself
   * is not touched. False when nothing was changed.
   */
  realign(): Promise<boolean>;
  /** Listener of the SFU's layer requests (dynacast `subscribedCodecs`), for the diagnostics log. */
  onSfuRequest(fn: ((subscribedCodecs: unknown) => void) | null): void;
  audio: LocalAudioTrack | null;
  audioProblem: StreamAudioProblem;
  sourceName: string;
  stop(): Promise<void>;
}

/** Chromium-only audio constraints not yet in lib.dom. */
interface DisplayAudioConstraints extends MediaTrackConstraints {
  restrictOwnAudio?: boolean;
  suppressLocalAudioPlayback?: boolean;
}

function videoConstraints(preset: ConcreteScreenSharePreset, grantedFps?: number): MediaTrackConstraints {
  const p = SCREEN_SHARE_PRESETS[preset];
  const fps = capFps(p.fps, grantedFps);
  const c: MediaTrackConstraints = { frameRate: { ideal: fps, max: fps } };
  // width/height 0 = "original": native resolution.
  if (p.width > 0) c.width = { max: p.width };
  if (p.height > 0) c.height = { max: p.height };
  return c;
}

/**
 * Whether Chromium honoured `restrictOwnAudio` for the loopback track: it reports the constraint
 * back and switches the device to `loopbackWithoutChrome`. False on older macOS (no process taps,
 * the ScreenCaptureKit fallback) — then the stream may carry participants' voices.
 */
export function ownAudioExcluded(settings: MediaTrackSettings & { restrictOwnAudio?: boolean }): boolean {
  return settings.restrictOwnAudio === true || settings.deviceId === 'loopbackWithoutChrome';
}

/**
 * getDisplayMedia() audio constraints for a desktop stream's system audio. The same on macOS and
 * Windows: exclude our own output (other participants' voices) — echo rule 4. With the main
 * process's plain 'loopback' Chromium opens `loopbackWithoutChrome`: a Core Audio process tap
 * without our audio service (macOS 14.2+, measured −65 dB vs −32 dB, docs/02) / WASAPI process
 * loopback `EXCLUDE_TARGET_PROCESS_TREE` (Windows 11; Chromium 152 drops the constraint on
 * Windows 10, main reports 'experimental' there, docs/09 #122). Local playback is never muted
 * (docs/09 #68); no processing on music/game sound.
 */
export function systemAudioConstraints(): DisplayAudioConstraints {
  return {
    restrictOwnAudio: true,
    suppressLocalAudioPlayback: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

async function captureDesktop(
  source: DesktopSource,
  preset: ConcreteScreenSharePreset,
  systemAudio: boolean,
): Promise<CapturedScreen> {
  const video = videoConstraints(preset);
  if (systemAudio) {
    const audio = systemAudioConstraints();
    try {
      await platform.capture.selectSource({ sourceId: source.id, audio: true });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
      const track = stream.getAudioTracks()[0];
      if (track) {
        if (!ownAudioExcluded(track.getSettings())) console.warn('[stream] system audio may include our own playback', track.getSettings());
        return { stream, audioProblem: null };
      }
      return { stream, audioProblem: { code: 'no-loopback', raw: null } };
    } catch (err) {
      // Known: custom picker + audio on macOS (electron#52738). Retry video-only.
      await platform.capture.selectSource({ sourceId: source.id, audio: false });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      return { stream, audioProblem: { code: 'failed', raw: err } };
    }
  }
  await platform.capture.selectSource({ sourceId: source.id, audio: false });
  const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  return { stream, audioProblem: null };
}

export interface CapturedScreen {
  stream: MediaStream;
  audioProblem: StreamAudioProblem;
}

/**
 * Step 1: capture. Must run first, straight from the user's click: browsers require
 * transient activation for getDisplayMedia() (web client, ADR-0015).
 */
export function captureScreen(opts: ScreenShareOptions): Promise<CapturedScreen> {
  return captureDesktop(opts.source, opts.preset, opts.systemAudio);
}

/** Re-applies the (possibly lower, server-granted) preset and frame rate to an already captured track. */
export async function applyPreset(cap: CapturedScreen, preset: ConcreteScreenSharePreset, fps?: number): Promise<void> {
  const t = cap.stream.getVideoTracks()[0];
  if (t) await t.applyConstraints(videoConstraints(preset, fps)).catch(() => undefined);
}

/** Step 2: publish (after the stream slot is reserved). */
export async function startScreenShare(
  lp: LocalParticipant,
  opts: ScreenShareOptions,
  onEnded: () => void,
  captured?: CapturedScreen,
): Promise<ActiveScreenShare> {
  // Never encode above the frame rate the server granted (the plan's cap, ADR-0024).
  const fps = capFps(SCREEN_SHARE_PRESETS[opts.preset].fps, opts.fps);
  const cap = captured ?? (await captureDesktop(opts.source, opts.preset, opts.systemAudio));
  const videoTrack = cap.stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('getDisplayMedia returned no video track');
  const audioTrack = cap.stream.getAudioTracks()[0] ?? null;

  // Encoder hint: 'detail' keeps text sharp (drops fps), 'motion' keeps fps.
  videoTrack.contentHint = opts.contentHint;
  const codec = opts.codec ?? 'av1';
  // H.264: even layers (hardware encoders take nothing else) and the profile (lib/media/h264.ts).
  const layout = codec === 'h264' ? await alignCaptureForH264(videoTrack, [THUMB_LAYER.height], fps) : null;
  const video = new LocalVideoTrack(videoTrack, undefined, true);
  setH264Profile(video, codec === 'h264' ? opts.h264Profile : undefined);
  // Diagnostics (docs/02 «Стрим: диагностика качества»): every dynacast update of the SFU reaches
  // the track as `setPublishingCodecs(subscribedCodecs)` (livekit-client internals, pinned; the same
  // track object is republished after a full reconnect, so this outlives a recreated engine).
  // Installed before publishing: the first update may come before startScreenShare returns.
  let onSfuRequest: ((subscribedCodecs: unknown) => void) | null = null;
  let lastSfuRequest: unknown = undefined;
  const lk = video as unknown as { setPublishingCodecs?: (codecs: unknown) => Promise<unknown> };
  const setPublishingCodecs = lk.setPublishingCodecs?.bind(video);
  if (setPublishingCodecs) {
    lk.setPublishingCodecs = (codecs) => {
      lastSfuRequest = codecs;
      try {
        onSfuRequest?.(codecs);
      } catch {
        // diagnostics only
      }
      return setPublishingCodecs(codecs);
    };
  }

  const publishOpts = screenPublishOptions(codec, opts.preset, opts.contentHint, fps, layout);
  try {
    await lp.publishTrack(video, publishOpts);
  } catch (err) {
    cap.stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  let audio: LocalAudioTrack | null = null;
  let audioProblem = cap.audioProblem;
  if (audioTrack) {
    const track = new LocalAudioTrack(audioTrack, undefined, true);
    // Optional: a failed audio publish must not leave the video half-published (continue video-only).
    const problem = await publishOptionalAudio(
      () => lp.publishTrack(track, { source: Track.Source.ScreenShareAudio, audioPreset: AudioPresets.musicStereo, dtx: false, red: false }),
      () => {
        void lp.unpublishTrack(track, true).catch(() => undefined);
        audioTrack.stop();
      },
    );
    if (problem) audioProblem = problem;
    else audio = track;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await lp.unpublishTrack(video, true).catch(() => undefined);
    if (audio) await lp.unpublishTrack(audio, true).catch(() => undefined);
  };
  // User stopped sharing from the OS UI, or the shared window closed.
  videoTrack.addEventListener('ended', () => {
    void stop().then(onEnded);
  });

  let realigning = false;
  const senderLock = livekitSenderLock(video);
  if (codec === 'h264' && !senderLock) log.warn('stream: livekit sender lock not found, the thumb rescale may race dynacast');
  const realign = async (): Promise<boolean> => {
    const sender = video.sender;
    if (codec !== 'h264' || !sender || realigning || stopped) return false;
    const { width = 0, height = 0 } = videoTrack.getSettings();
    const scale = evenLayerScale(width, height, THUMB_LAYER.height);
    if (!scale) return false;
    realigning = true;
    try {
      return await setThumbScale(sender, senderLock, scale);
    } catch (err) {
      // The next stats tick retries.
      log.warn('stream: could not rescale the thumb layer', err);
      return false;
    } finally {
      realigning = false;
    }
  };

  // Web: the browser picked the source; its label is the best name we have.
  const sourceName = opts.source.name || videoTrack.label || t('common.screen');
  const onSfuRequestSet = (fn: ((subscribedCodecs: unknown) => void) | null): void => {
    onSfuRequest = fn;
    if (fn && lastSfuRequest !== undefined) fn(lastSfuRequest);
  };
  return { video, audio, audioProblem, sourceName, stop, realign, onSfuRequest: onSfuRequestSet };
}
