import { ScreenSharePreset } from '@calaba/protocol';
import { RoomEvent, Track, type LocalVideoTrack, type Room } from 'livekit-client';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { applyCameraQuality, cameraSource, captureCamera, limitCameraForCpu, preparePublish, switchCameraDevice } from '../lib/media/camera';
import type { CameraBackground } from '../lib/media/background/logic';
import type { CameraEffects } from '../lib/media/background/effects';
import { applyCameraBackground } from './cameraBackground';
import {
  CAMERA_DEFAULT_QUALITY,
  cameraNext,
  cameraStopText,
  cpuLimitStep,
  grantedCameraQuality,
  otherFacing,
  type CameraEvent,
  type CameraQuality,
} from '../lib/media/cameraLogic';
import { pickPublishCodec } from '../lib/media/codecSelect';
import { allowedCameraPreset } from '../lib/plan';
import { workspacePlan } from './plan';
import type { OutboundVideoLayer } from '../lib/media/stats';
import { isDeviceGone } from '../lib/voiceLogic';
import { prefs, usePrefs } from '../stores/prefs';
import { toast } from '../stores/toasts';
import { setVoice, useVoice } from '../stores/voice';
import { reportMediaError } from './mediaErrors';

/** LiveKit protocol TrackSource.CAMERA (grant `canPublishSources`). */
const LK_SOURCE_CAMERA = 1;

export interface CameraHost {
  readonly room: Room | null;
  readonly roomId: string | null;
}

/**
 * My webcam in the current call (docs/05 «Камеры», docs/02 «Камера», ADR-0018):
 *   capture → POST …/camera/request (reserves a slot, adds `camera` to the LiveKit grant) →
 *   wait for the grant → publish (VP9 SVC simulcast 180/360/720p) … unpublish → …/camera/stop.
 * The phase lives in the voice store (lib/media/cameraLogic.ts `cameraNext`); a generation
 * counter cancels a start that a stop / leave / server stop overtook.
 */
export class CameraController {
  private track: LocalVideoTrack | null = null;
  /** The `ended` listener of the live capture (removed on release, review L12). */
  private onEnded: (() => void) | null = null;
  private gen = 0;
  private cpuSamples = 0;
  /** When the grant withdrawal stopped the camera (quietly): the VOICE_CAMERA_STOP after it still explains why. */
  private quietStopAt = 0;
  /** Quality of the live camera: what /camera/request granted (ADR-0024). */
  private quality: CameraQuality = CAMERA_DEFAULT_QUALITY;

  constructor(private readonly host: CameraHost) {}

  private step(ev: CameraEvent): void {
    setVoice({ camera: cameraNext(useVoice.getState().camera, ev) });
  }

  private bump(): void {
    setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
  }

  /** The published camera, for the self-view tile. */
  get localTrack(): LocalVideoTrack | null {
    return this.track;
  }

  /**
   * Opens the camera for the «Проверьте камеру» sheet (or a direct start). The chosen device, or
   * the system default when it is gone. The caller owns the track until it hands it to start().
   */
  async capture(): Promise<LocalVideoTrack> {
    const want = prefs().cameraDeviceId;
    const q = this.wanted().quality;
    try {
      return await captureCamera(want, q, useVoice.getState().cameraFacing);
    } catch (err) {
      if (!want || !isDeviceGone(err)) throw err;
      log.warn('chosen camera unavailable, using the default one', err);
      toast.info(t('video.fallback'));
      return captureCamera(null, q, useVoice.getState().cameraFacing);
    }
  }

  /**
   * The quality to ask for: camera ▾ «Качество», lowered to the plan of the call's workspace
   * (camera_max_preset / camera_max_fps) — no capture above what the server would grant.
   */
  private wanted(): { preset: ScreenSharePreset; quality: CameraQuality } {
    const limits = workspacePlan(useVoice.getState().workspaceId)?.limits;
    const preset = allowedCameraPreset(prefs().cameraPreset, limits?.cameraMaxPreset);
    return { preset, quality: grantedCameraQuality(preset, { preset, fps: limits?.cameraMaxFps ?? 0 }) };
  }

  /** Camera ▾ changed the quality while the camera is on: restart it with the new one. */
  async restart(): Promise<void> {
    if (useVoice.getState().camera !== 'on') return;
    await this.stop();
    await this.start();
  }

  /** Turns the camera on; `captured` is the preview's track (released here on any failure). */
  async start(captured?: LocalVideoTrack): Promise<void> {
    const { room, roomId } = this.host;
    if (!room || !roomId || useVoice.getState().camera !== 'off') {
      captured?.stop();
      return;
    }
    const gen = ++this.gen;
    this.cpuSamples = 0;
    setVoice({ cameraCpuLimited: false });
    this.step('request');
    const stale = (): boolean => gen !== this.gen || this.host.room !== room;
    let track: LocalVideoTrack | null = captured ?? null;
    let reserved = false;
    let step: 'capture' | 'request' | 'publish' = 'capture';
    try {
      // 1) Capture first: a denied OS permission must not cost a camera slot.
      track ??= await this.capture();
      if (stale()) return;
      // The background (ADR-0035): the preview's track has it already (a no-op then); a direct
      // start gets it here, before publishing — frames pass through until the model is loaded.
      await applyCameraBackground(track, prefs().cameraBackground, prefs().cameraEffects);
      if (stale()) return;
      // 2) Reserve a slot + the camera grant (409 = limit reached / cameras off in the room);
      //    the answer is the quality the plan allows — capture and encode no more than that.
      step = 'request';
      const want = this.wanted();
      const granted = await api.voice.requestCamera(roomId, { preset: want.preset });
      reserved = true;
      if (stale()) return;
      const q = grantedCameraQuality(want.preset, granted);
      if (q.height < want.quality.height || (q.fps > 0 && (want.quality.fps === 0 || q.fps < want.quality.fps))) {
        await applyCameraQuality(track, q).catch((e: unknown) => log.warn('camera: granted quality constraint failed', e));
      }
      this.quality = q;
      // Codec by hardware (ADR-0032); cached after the first call, probed while the grant arrives.
      const codec = pickPublishCodec('camera');
      await waitForGrant(room, LK_SOURCE_CAMERA);
      if (stale()) return;
      // 3) Publish.
      step = 'publish';
      await room.localParticipant.publishTrack(track, await preparePublish(track, this.quality, await codec));
      if (stale()) {
        await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
        return;
      }
      this.track = track;
      const live = track;
      track = null; // owned by this.track now
      // Camera unplugged / taken away by the OS: stop cleanly.
      this.onEnded = () => {
        if (this.track === live) void this.stop(t('video.lost'));
      };
      cameraSource(live).addEventListener('ended', this.onEnded);
      this.step('published');
      this.bump();
    } catch (err) {
      if (gen === this.gen) this.step('failed');
      if (err instanceof ApiError && err.status === 409) toast.info(t('video.limit'));
      else if (err instanceof ApiError && err.is('ERROR_CODE_FORBIDDEN')) toast.info(t('video.forbidden'));
      else reportMediaError(err, step === 'capture' ? 'camera' : 'cameraPublish');
      log.warn(`camera start failed at ${step}`, err);
    } finally {
      // Not published (failure or overtaken): release the capture and the reservation.
      if (track) track.stop();
      if (reserved && this.track === null && this.host.roomId === roomId) void api.voice.stopCamera(roomId).catch(() => undefined);
    }
  }

  /** The user turns the camera off (or it was lost: `notice` is shown). */
  async stop(notice?: string): Promise<void> {
    const phase = useVoice.getState().camera;
    if (phase === 'off' || phase === 'stopping') return;
    this.gen++;
    this.step('stop');
    const room = this.host.room;
    const roomId = this.host.roomId;
    await this.release(room);
    if (roomId) await api.voice.stopCamera(roomId).catch((e: unknown) => log.warn('camera/stop failed', e));
    this.step('stopped');
    if (notice) toast.info(notice);
  }

  /**
   * VOICE_CAMERA_STOP for me: the server muted the camera (limit or moderator) and withdrew the
   * grant. Stop locally; a new /camera/request is needed to turn it on again.
   */
  onServerStop(reason: 'limit' | 'moderator' | 'other', trackSid = ''): void {
    // The same user on another device: its camera, not this one.
    const mine = this.track?.sid;
    if (trackSid && mine && trackSid !== mine) return;
    const justStopped = Date.now() - this.quietStopAt < 15_000;
    this.quietStopAt = 0;
    // Nothing on here, and not just stopped by the grant withdrawal: another device of mine.
    if (!this.track && useVoice.getState().camera === 'off' && !justStopped) return;
    toast.info(t(cameraStopText(reason)));
    if (useVoice.getState().camera === 'off') return;
    this.gen++;
    this.step('server-stop');
    void this.release(this.host.room);
  }

  /** Our grant no longer lists the camera, or LiveKit unpublished it for us: stop quietly. */
  onGrantLost(): void {
    // While starting, the grant is still on its way; without a live track there is nothing to stop.
    if (!this.track || useVoice.getState().camera === 'starting') return;
    this.quietStopAt = Date.now();
    this.gen++;
    this.step('server-stop');
    void this.release(this.host.room);
  }

  /** Left / lost the call: the room is gone (its disconnect unpublished everything). */
  onLeave(): void {
    this.gen++;
    if (this.track && this.onEnded) cameraSource(this.track).removeEventListener('ended', this.onEnded);
    this.onEnded = null;
    this.track?.stop();
    this.track = null;
    this.cpuSamples = 0;
    setVoice({ camera: cameraNext(useVoice.getState().camera, 'left'), cameraCpuLimited: false, cameraFacing: null });
  }

  /**
   * LiveKit came back after a full reconnect (new signalling session): the server dropped our
   * camera reservation with the old participant, and the re-join grant has no camera source, so
   * the republished camera would be refused. Ask for the slot again and republish the same track;
   * if that is impossible (limit taken meanwhile, no VIDEO), stop with a notice (review L11).
   */
  async restore(): Promise<void> {
    const { room, roomId } = this.host;
    const track = this.track;
    if (!room || !roomId || !track || useVoice.getState().camera !== 'on') return;
    // A plain resume keeps the publication and the grant: nothing to do.
    const live = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (live?.track === track && !cameraGrantMissing(room.localParticipant.permissions)) return;
    const gen = this.gen;
    try {
      await api.voice.requestCamera(roomId, { preset: this.quality.height === 1080 ? ScreenSharePreset.H1080 : ScreenSharePreset.H720, fps: this.quality.fps });
      await waitForGrant(room, LK_SOURCE_CAMERA);
      if (gen !== this.gen || this.track !== track) return;
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (!pub || pub.track !== track) await room.localParticipant.publishTrack(track, await preparePublish(track, this.quality, await pickPublishCodec('camera')));
      this.bump();
    } catch (err) {
      log.warn('camera restore after reconnect failed', err);
      if (gen !== this.gen) return;
      this.gen++;
      this.step('server-stop');
      await this.release(room);
      toast.info(t('video.rejoin'));
    }
  }

  /** Settings / ▾ menu changed the device: switch the live camera in place. */
  async setDevice(deviceId: string | null): Promise<void> {
    const track = this.track;
    if (!track) return;
    try {
      await switchCameraDevice(track, deviceId, this.quality, useVoice.getState().cameraFacing);
      // The restart captures at the full quality again: keep the CPU limit of this session (review L3).
      if (useVoice.getState().cameraCpuLimited) await limitCameraForCpu(track, this.quality);
      // A new capture: the processor follows by itself (restart), the camera's own blur does not.
      await applyCameraBackground(track, prefs().cameraBackground, prefs().cameraEffects);
      this.bump();
    } catch (err) {
      reportMediaError(err, 'camera');
    }
  }

  /**
   * «Переключить камеру» (phones): front ↔ back. The side wins over a chosen device, so that is
   * cleared; the live track switches in place (the prefs subscription does it when a device was
   * chosen, here otherwise). Without a published track (the preview) the new side is just picked.
   */
  flip(): void {
    setVoice({ cameraFacing: otherFacing(useVoice.getState().cameraFacing) });
    if (prefs().cameraDeviceId) usePrefs.getState().setPrefs({ cameraDeviceId: null });
    else void this.setDevice(null);
  }

  /** «Фон» or «Внешний вид» changed (picker, island menu): applied to the live camera in place. */
  async setBackground(bg: CameraBackground, fx: CameraEffects): Promise<void> {
    if (this.track) await applyCameraBackground(this.track, bg, fx);
  }

  /** Outbound camera layers from getStats (every 2 s): CPU-bound for 3 samples → 360p capture. */
  onStats(layers: readonly OutboundVideoLayer[]): void {
    const track = this.track;
    if (!track || useVoice.getState().cameraCpuLimited) return;
    const step = cpuLimitStep(this.cpuSamples, layers.some((l) => l.qualityLimitation === 'cpu'));
    this.cpuSamples = step.count;
    if (!step.limit) return;
    setVoice({ cameraCpuLimited: true });
    log.info('camera: encoder is CPU-bound, capturing at 360p');
    void limitCameraForCpu(track, this.quality)
      .then(() => toast.info(t('video.cpu')))
      .catch((e: unknown) => log.warn('camera 360p constraint failed', e));
  }

  private async release(room: Room | null): Promise<void> {
    const track = this.track;
    this.track = null;
    if (!track) return;
    if (this.onEnded) cameraSource(track).removeEventListener('ended', this.onEnded);
    this.onEnded = null;
    if (room) await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    track.stop();
    this.bump();
  }
}

/** The server updates the LiveKit grant after /camera/request; wait (≤ 4 s) until it arrives. */
async function waitForGrant(room: Room, source: number): Promise<void> {
  const ok = (): boolean => {
    const sources = room.localParticipant.permissions?.canPublishSources ?? [];
    return sources.length === 0 || sources.includes(source);
  };
  if (ok()) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      room.off(RoomEvent.ParticipantPermissionsChanged, check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (ok()) done();
    };
    const timer = window.setTimeout(done, 4000);
    room.on(RoomEvent.ParticipantPermissionsChanged, check);
  });
}

/** Grant lists sources and the camera is not among them. */
export function cameraGrantMissing(p: { canPublishSources: readonly number[] } | undefined): boolean {
  const s = p?.canPublishSources ?? [];
  return s.length > 0 && !s.includes(LK_SOURCE_CAMERA);
}
