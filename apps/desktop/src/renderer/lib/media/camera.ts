import { LocalVideoTrack, Track, VideoPreset, createLocalVideoTrack, type TrackPublishOptions } from 'livekit-client';
import { CAMERA_CPU_CAPTURE, CAMERA_DEFAULT_QUALITY, cameraCapture, cameraLayers, cameraTarget, type CameraFacing, type CameraQuality } from './cameraLogic';
import { BACKGROUND_PROCESSOR } from './background/logic';
import type { CodecPick, PublishCodec } from './codecSelect';
import { layerSize, type H264Layout } from './h264';
import { alignCaptureForH264, setH264Profile } from './h264Publish';

/**
 * Webcam capture and publishing (docs/02 «Камера», ADR-0018). LiveKit-specific glue only; the
 * numbers are pure and unit-tested in cameraLogic.ts, the codec comes from `pickPublishCodec`
 * (lib/media/codecSelect.ts, ADR-0032: the hardware encoder in the order H.264 → AV1 → VP9;
 * none in hardware → VP9, the cheapest software one).
 *
 * rid simulcast q/h/f: H.264 / VP8 plain; VP9 / AV1 "SVC simulcast" (`simulcast: true` + `L1T3`,
 * each rid its own L1T3 stream, livekit-server > 1.13.6). A 180p tile gets a real 180p stream
 * and dynacast stops encoding the layers nobody watches.
 */

/**
 * The capture behind a camera track. With a processor (the background, ADR-0035) LiveKit's
 * `mediaStreamTrack` is the processed output, a generated track: constraints (size, frame rate,
 * H.264 alignment, `backgroundBlur`), `contentHint` and `ended` belong to the capture.
 * livekit-client 2.22 keeps it in `_mediaStreamTrack` (no public getter; re-check on upgrade).
 */
export function cameraSource(track: LocalVideoTrack): MediaStreamTrack {
  return (track as unknown as { _mediaStreamTrack?: MediaStreamTrack })._mediaStreamTrack ?? track.mediaStreamTrack;
}

/** Opens the camera (preview sheet or straight publish). `motion`: faces and gestures, keep fps. */
export async function captureCamera(deviceId: string | null, q: CameraQuality = CAMERA_DEFAULT_QUALITY, facing: CameraFacing | null = null): Promise<LocalVideoTrack> {
  const c = cameraCapture(q);
  const track = await createLocalVideoTrack({
    ...cameraTarget(deviceId, facing),
    resolution: { width: c.width, height: c.height, frameRate: c.fps },
  });
  track.mediaStreamTrack.contentHint = 'motion';
  return track;
}

/**
 * Publish options for a quality: its ladder, every layer ≤ the granted fps (ADR-0024).
 * `layout` (H.264 only, `h264Layout` of the aligned capture): the lower layers are exactly capture /
 * their integer scale, so all three are even (hardware H.264 takes nothing else).
 * `background` (the camera starts with our background processor, ADR-0035): two layers, the low and
 * the top one — the processed RGBA frame is converted for the encoder per layer in the GPU process,
 * the 360p layer costs ≈ 3 % of a core on M4 (docs/02 «Камера: фон», docs/14 «Фон камеры»).
 */
export function cameraPublishOptions(q: CameraQuality = CAMERA_DEFAULT_QUALITY, codec: PublishCodec = 'vp9', layout?: H264Layout | null, background = false): TrackPublishOptions {
  const [low, mid, top] = cameraLayers(q);
  const lowSize = codec === 'h264' && layout ? layerSize(layout, 0) : low;
  const midSize = codec === 'h264' && layout ? layerSize(layout, 1) : mid;
  return {
    source: Track.Source.Camera,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8 / H.264: plain simulcast; VP9 / AV1: one L1T3 stream per rid (see the module doc).
    ...(codec === 'vp8' || codec === 'h264' ? {} : { scalabilityMode: 'L1T3' as const }),
    videoEncoding: { maxBitrate: top.maxBitrate, maxFramerate: top.fps },
    videoSimulcastLayers: [
      new VideoPreset(lowSize.width, lowSize.height, low.maxBitrate, low.fps),
      ...(background ? [] : [new VideoPreset(midSize.width, midSize.height, mid.maxBitrate, mid.fps)]),
    ],
    degradationPreference: 'balanced',
  };
}

/**
 * `publishTrack` options for `pick` (ADR-0032). H.264: aligns the capture so every layer is even and
 * marks the track for the High profile when the pick says so (lib/media/h264.ts).
 */
export async function preparePublish(track: LocalVideoTrack, q: CameraQuality, pick: CodecPick): Promise<TrackPublishOptions> {
  const h264 = pick.codec === 'h264';
  const [low, mid] = cameraLayers(q);
  const layout = h264 ? await alignCaptureForH264(cameraSource(track), [low.height, mid.height], cameraCapture(q).fps) : null;
  setH264Profile(track, h264 ? pick.profile : undefined);
  // The layers are fixed at publish: an effect switched on later keeps three until the camera restarts.
  return cameraPublishOptions(q, pick.codec, layout, track.getProcessor()?.name === BACKGROUND_PROCESSOR);
}

/**
 * The encoder is CPU-bound (`qualityLimitationReason: cpu`): capture at 360p instead of 720p —
 * the top layer becomes 360p, the lower ones scale down with it, encoding costs about a quarter.
 */
export async function limitCameraForCpu(track: LocalVideoTrack, q: CameraQuality = CAMERA_DEFAULT_QUALITY): Promise<void> {
  const fps = q.fps > 0 ? Math.min(CAMERA_CPU_CAPTURE.fps, q.fps) : CAMERA_CPU_CAPTURE.fps;
  await cameraSource(track).applyConstraints({
    width: { ideal: CAMERA_CPU_CAPTURE.width },
    height: { ideal: CAMERA_CPU_CAPTURE.height },
    frameRate: { ideal: fps, max: fps },
  });
}

/** Re-applies a (lower, server-granted) quality to a live capture: size and frame rate. */
export async function applyCameraQuality(track: LocalVideoTrack, q: CameraQuality): Promise<void> {
  const c = cameraCapture(q);
  await cameraSource(track).applyConstraints({
    width: { ideal: c.width },
    height: { ideal: c.height },
    frameRate: { ideal: c.fps, max: c.fps },
  });
}

/** Switches the capture device of a live (possibly published) camera track in place. */
export async function switchCameraDevice(track: LocalVideoTrack, deviceId: string | null, q: CameraQuality = CAMERA_DEFAULT_QUALITY, facing: CameraFacing | null = null): Promise<void> {
  const c = cameraCapture(q);
  await track.restartTrack({
    ...cameraTarget(deviceId, facing),
    resolution: { width: c.width, height: c.height, frameRate: c.fps },
  });
  cameraSource(track).contentHint = 'motion';
}
