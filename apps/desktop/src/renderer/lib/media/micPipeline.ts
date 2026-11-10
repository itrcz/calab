import { micCaptureConstraints } from '@calaba/protocol';
import workletUrl from './worklets/mic-processor.worklet.ts?worker&url';
import { log } from '../log';
import { DUCK_GAIN, ECHO } from './echo';
import { mediaErrorDetail } from './errors';
import type { MicReport } from './micReport';
import type { DenoiseControl, DenoiseMode } from './denoiseSleep';
import { rnnoiseSupported } from './rnnoiseSupport';

/**
 * Capture pipeline (docs/02-media.md, ADR-0004):
 *
 *   getUserMedia (AEC3, AGC; built-in NS only when RNNoise is off)
 *     → [RNNoise AudioWorklet]  (when enabled)
 *     → [GainNode]              (RNNoise on, or `duckable`: the speakerphone duck, lib/media/echo.ts)
 *     → MediaStreamTrack to publish
 *
 * Everything after getUserMedia works on the AEC3 output, so RNNoise, the VAD and the duck
 * never feed the echo canceller anything but its own result (echo rule 3). The gain stage is
 * on the *input* path: it only lowers what we send, remote playback stays plain <audio>.
 * Without RNNoise and ducking the raw capture track is published as is (no WebAudio at all).
 *
 * Musician mode (ADR-0052): getUserMedia without AEC / NS / AGC (stereo if the device has it),
 * never RNNoise; the published track gets `contentHint = 'music'`. Only the input path changes.
 *
 * The worklet reports level + VAD every 20 ms for the voice gate (every 100 ms while RNNoise
 * sleeps — the mic is off air then, lib/media/denoiseSleep.ts).
 * WebAudio is used strictly on the capture side; remote audio never goes
 * through an AudioContext (echo rule 1).
 */
export interface MicPipelineOptions {
  deviceId: string | null;
  rnnoise: boolean;
  /** Musician mode (ADR-0052): raw capture, RNNoise forced off. */
  musician?: boolean;
  /** Needs the duck (speakerphone modes): without RNNoise too, publish through a gain stage. */
  duckable?: boolean;
  onReport: (r: MicReport) => void;
  /** The capture ended by itself (device unplugged / revoked) — not fired by `stop()`. */
  onEnded?: () => void;
  /**
   * The system muted / unmuted the raw capture (another app took the mic, an audio interruption,
   * a WebKit page in the background) — the track stays live, frames are silence meanwhile.
   */
  onMute?: (muted: boolean) => void;
  /** The capture AudioContext changed state ('suspended' / WebKit 'interrupted' by the system, 'running' again). */
  onContextState?: (state: string) => void;
}

/** The capture as the voice engine's health check sees it (lib/voiceRecovery.ts micFix). */
export interface MicHealth {
  ctx: string;
  ended: boolean;
  muted: boolean;
  /** Since the worklet's last report (performance.now() based); null = none yet. */
  reportAgeMs: number | null;
}

/** The RNNoise worklet could not start (the caller falls back to built-in noise suppression). */
export class RnnoiseUnavailable extends Error {}

export class MicPipeline {
  private constructor(
    /** Track to publish. With RNNoise: the worklet output; otherwise the raw capture track. */
    readonly track: MediaStreamTrack,
    readonly rnnoise: boolean,
    readonly deviceLabel: string,
    /** Musician-mode capture (ADR-0052). */
    readonly musician: boolean,
    /** Channels of the published track: 2 only for a stereo device in musician mode. */
    readonly channels: number,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly owned: MediaStreamTrack[],
    /** The duck stage; null = the raw track is published (headphones mode without RNNoise). */
    private readonly gain: GainNode | null,
    /** The getUserMedia track (its mute / end is the capture's). */
    private readonly raw: MediaStreamTrack,
    /** performance.now() of the worklet's last report (0 = none yet). */
    private readonly reports: { at: number },
  ) {}

  /** Capture health: the context runs, the raw track is live and unmuted, the worklet reports. */
  health(now: number = performance.now()): MicHealth {
    return {
      ctx: this.ctx.state,
      ended: this.raw.readyState === 'ended',
      muted: this.raw.muted,
      reportAgeMs: this.reports.at > 0 ? now - this.reports.at : null,
    };
  }

  /**
   * The context back to running after the system suspended / interrupted it (the reports — and so
   * the voice gate — are frozen meanwhile). True when it runs.
   */
  async resumeContext(): Promise<boolean> {
    const state = (): string => this.ctx.state;
    if (state() === 'closed') return false;
    if (state() !== 'running') {
      try {
        await this.ctx.resume();
      } catch (e) {
        log.info('[mic] AudioContext.resume failed', e);
      }
    }
    return state() === 'running';
  }

  /** The duck can act on this pipeline (a gain stage exists). */
  get duckable(): boolean {
    return this.gain !== null;
  }

  private ducked = false;
  private denoise = '';

  /**
   * RNNoise on demand (lib/media/denoiseSleep.ts). Deduplicated: the worklet restarts its quiet
   * timer only on a mode change, so repeating the same control is harmless but pointless.
   */
  setDenoise(mode: DenoiseMode, wakeDb: number): void {
    const key = `${mode}:${wakeDb}`;
    if (key === this.denoise) return;
    this.denoise = key;
    const msg: DenoiseControl = { type: 'denoise', mode, wakeDb };
    this.node.port.postMessage(msg);
  }

  /** Speakerphone duck: −18 dB with a 20 ms attack, back to 0 dB with a 300 ms release. */
  setDuck(on: boolean): void {
    const g = this.gain;
    if (!g || on === this.ducked) return;
    this.ducked = on;
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    // setTargetAtTime reaches 95 % after 3 time constants.
    g.gain.setTargetAtTime(on ? DUCK_GAIN : 1, now, (on ? ECHO.attackMs : ECHO.releaseMs) / 3000);
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  /**
   * Firefox cannot connect a MediaStream whose sample rate differs from the AudioContext
   * (NotSupportedError). RNNoise needs 48 kHz, so on such devices we fall back to the
   * built-in noise suppression and analyse at the device rate (web client, ADR-0015).
   */
  static async start(options: MicPipelineOptions): Promise<MicPipeline> {
    // WebKit / Android keep their own NS on: RNNoise on top only distorts (lib/media/rnnoiseSupport.ts, board #114).
    const opts = options.rnnoise && !rnnoiseSupported() ? { ...options, rnnoise: false } : options;
    try {
      return await MicPipeline.startWith(opts, 48000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotSupportedError') {
        return MicPipeline.startWith({ ...opts, rnnoise: false }, undefined);
      }
      if (err instanceof RnnoiseUnavailable && opts.rnnoise) {
        // e.g. a CSP without 'wasm-unsafe-eval' (web): keep the mic working with built-in NS.
        console.warn('RNNoise unavailable, falling back to built-in noise suppression:', err.message);
        return MicPipeline.startWith({ ...opts, rnnoise: false }, 48000);
      }
      throw err;
    }
  }

  private static async startWith(options: MicPipelineOptions, sampleRate: number | undefined): Promise<MicPipeline> {
    const musician = options.musician === true;
    const opts = musician ? { ...options, rnnoise: false } : options;
    const constraints: MediaTrackConstraints = {
      ...micCaptureConstraints({ rnnoise: opts.rnnoise, musician }),
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    };
    const t0 = performance.now();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (err) {
      // Issue #322: name + Chromium's message + how long it took (a ~10 s wait = start timeout).
      log.warn('[mic] getUserMedia failed', { ...mediaErrorDetail(err), ms: Math.round(performance.now() - t0), device: opts.deviceId ? 'chosen' : 'default', rnnoise: opts.rnnoise, musician });
      throw err;
    }
    const raw = stream.getAudioTracks()[0];
    if (!raw) throw new Error('getUserMedia returned no audio track');
    const onEnded = opts.onEnded;
    if (onEnded) raw.addEventListener('ended', () => onEnded());
    const onMute = opts.onMute;
    if (onMute) {
      raw.addEventListener('mute', () => onMute(true));
      raw.addEventListener('unmute', () => onMute(false));
    }
    // What the browser actually applied (docs/02, «Эхо: колонки» — how to verify AEC is on).
    const st = raw.getSettings();
    log.info('[mic] capture settings', { echoCancellation: st.echoCancellation, autoGainControl: st.autoGainControl, noiseSuppression: st.noiseSuppression, sampleRate: st.sampleRate, channelCount: st.channelCount, musician, device: raw.label });
    const captured = musician && (st.channelCount ?? 1) >= 2 ? 2 : 1;

    // RNNoise is trained for 48 kHz; Chromium resamples the device if needed.
    const ctx = new AudioContext({ ...(sampleRate ? { sampleRate } : {}), latencyHint: 'interactive' });
    const onContextState = opts.onContextState;
    if (onContextState) ctx.addEventListener('statechange', () => onContextState(ctx.state));
    const reports = { at: 0 };
    try {
      // The worklet's 480-sample frames are 10 ms only at 48 kHz: never run RNNoise at another rate.
      if (opts.rnnoise && ctx.sampleRate !== 48000) throw new RnnoiseUnavailable(`AudioContext runs at ${ctx.sampleRate} Hz`);
      await ctx.audioWorklet.addModule(workletUrl);

      // With a graph (RNNoise or the duck) the published track is the graph's output. Without
      // one we publish the raw track, and the gate / mute set raw.enabled=false — which would
      // silence our own analysis and the gate could never reopen: analyse a clone instead.
      const graph = opts.rnnoise || opts.duckable === true;
      const analysisTrack = graph ? raw : raw.clone();
      const source = ctx.createMediaStreamSource(new MediaStream([analysisTrack]));
      const node = new AudioWorkletNode(ctx, 'calaba-mic', {
        numberOfInputs: 1,
        // 0 outputs = analysis-only node; Chromium still pulls it.
        numberOfOutputs: opts.rnnoise ? 1 : 0,
        ...(opts.rnnoise ? { outputChannelCount: [1] } : {}),
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { denoise: opts.rnnoise },
      });
      // The worklet reports every 20 ms once running. A processor that failed to construct
      // (WASM blocked by CSP, …) never reports: detect it instead of shipping a dead meter.
      const alive = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new RnnoiseUnavailable('no reports from the worklet')), 2000);
        node.onprocessorerror = () => {
          window.clearTimeout(timer);
          reject(new RnnoiseUnavailable('worklet processor error'));
        };
        node.port.onmessage = (e: MessageEvent<MicReport>) => {
          window.clearTimeout(timer);
          resolve();
          reports.at = performance.now();
          opts.onReport(e.data);
          node.port.onmessage = (ev: MessageEvent<MicReport>) => {
            reports.at = performance.now();
            opts.onReport(ev.data);
          };
        };
      });
      source.connect(node);

      let publishTrack = raw;
      let gain: GainNode | null = null;
      if (graph) {
        // Worklet (level/VAD) → gain: the gate and the meter see the level before the duck.
        gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = captured; // mono, except a stereo device in musician mode
        (opts.rnnoise ? node : source).connect(gain);
        gain.connect(dest);
        const t = dest.stream.getAudioTracks()[0];
        if (!t) throw new Error('MediaStreamDestination has no track');
        publishTrack = t;
      }
      // A hint for the browser; the encoder's AUDIO application comes from `stereo=1` (opusTier.ts).
      if (musician) publishTrack.contentHint = 'music';
      if (ctx.state !== 'running') await ctx.resume();
      // Only the RNNoise path needs WASM; analysis-only never blocks start-up.
      if (opts.rnnoise) await alive;
      else alive.catch(() => undefined);

      const owned = graph ? [raw, publishTrack] : [raw, analysisTrack];
      return new MicPipeline(publishTrack, opts.rnnoise, raw.label, musician, captured, ctx, node, owned, gain, raw, reports);
    } catch (err) {
      raw.stop();
      void ctx.close();
      throw err;
    }
  }

  stop(): void {
    this.node.port.postMessage('destroy');
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.gain?.disconnect();
    for (const t of this.owned) t.stop();
    void this.ctx.close();
  }
}
