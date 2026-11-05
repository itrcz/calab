import type { SoundPlay } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { builtinSound } from '../lib/builtinSounds';
import { nativeCue } from '../lib/sounds';
import { ROOM_AUDIO_CUES, type HostRoomAudioCue } from '../../shared/hostRoomAudio';
import { log } from '../lib/log';
import { CHIP_MS, LATE_MS, PRESS_COOLDOWN_MS, clipVolume, createLateness, isBuiltin, toggleFavorite as toggled } from '../lib/soundboard';
import { prefs, usePrefs } from '../stores/prefs';
import { myUserId } from '../stores/session';
import { findSound, useSounds } from '../stores/sounds';
import { toast } from '../stores/toasts';
import { useVoice } from '../stores/voice';

/**
 * Soundboard (ADR-0036, docs/02 «Звуки в комнату»). A press is a request: the server tells
 * everyone in the call (SOUND_PLAY) and each client plays the clip itself — through a plain
 * <audio> element on the voice output device, never WebAudio and never the microphone track
 * (echo rules, docs/02). Deafened («звук выключен») hears nothing; «Не воспроизводить звуки
 * других» keeps only my own presses.
 */

const POOL_SIZE = 4;
const pool: HTMLAudioElement[] = [];

/** A free element of the pool (ended / never used), else the one that started first. */
function element(): HTMLAudioElement {
  const free = pool.find((a) => a.paused || a.ended);
  if (free) return free;
  if (pool.length < POOL_SIZE) {
    const a = new Audio();
    a.preload = 'auto';
    pool.push(a);
    return a;
  }
  const oldest = pool.shift() as HTMLAudioElement;
  oldest.pause();
  pool.push(oldest);
  return oldest;
}

/** The clip URL of a sound id: the bundled file, or the workspace file (auth handled by the platform). */
async function clipUrl(soundId: string): Promise<string | null> {
  if (isBuiltin(soundId)) return builtinSound(soundId)?.url ?? null;
  const s = findSound(soundId);
  if (!s) return null;
  const { platform } = await import('../platform'); // lazily: unit tests of this module run without a window
  return platform.mediaUrl(`/api/files/${s.fileId}`);
}

/** Plays a clip locally on the voice output device at the «Громкость звуков». */
export async function playClip(soundId: string): Promise<void> {
  // A native-audio room (ADR-0149 §5): built-in clips play natively by name; workspace clips not at all in v1.
  const native = nativeCue();
  if (native) {
    const p = prefs();
    if ((ROOM_AUDIO_CUES as readonly string[]).includes(soundId)) native(soundId as HostRoomAudioCue, clipVolume(p.soundboardVolume, p.outputVolume));
    return;
  }
  const url = await clipUrl(soundId);
  if (!url) return;
  const p = prefs();
  const el = element();
  el.src = url;
  el.volume = clipVolume(p.soundboardVolume, p.outputVolume);
  const sink = p.outputDeviceId ?? '';
  try {
    if (el.sinkId !== sink) await el.setSinkId(sink);
  } catch (e) {
    log.warn('soundboard: output device', e);
  }
  await el.play().catch((e: unknown) => log.warn('soundboard: play', e));
}

/** ▶ on a tile: only for me, regardless of the cooldown. */
export function previewSound(soundId: string): void {
  void playClip(soundId);
}

/** Starts / ends the favourite mark of a sound (device prefs). */
export function toggleFavorite(soundId: string): void {
  usePrefs.getState().setPrefs({ soundboardFavorites: toggled(prefs().soundboardFavorites, soundId) });
}

/**
 * A press on a tile: plays to everyone in my call. The tiles lock for PRESS_COOLDOWN_MS (the
 * server allows one per 2 s); a refusal says why.
 */
export async function pressSound(soundId: string): Promise<void> {
  const { roomId, phase } = useVoice.getState();
  if (!roomId || phase !== 'connected' || useSounds.getState().cooldown) return;
  useSounds.getState().lock(PRESS_COOLDOWN_MS);
  const usage = prefs().soundboardUsage;
  usePrefs.getState().setPrefs({ soundboardUsage: { ...usage, [soundId]: (usage[soundId] ?? 0) + 1 } });
  try {
    await api.sounds.play(roomId, soundId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      useSounds.getState().lock((e.extra.retryAfter ?? 2) * 1000);
      toast.info(t('snd.tooFast'));
    } else if (e instanceof ApiError && e.status === 404) toast.info(t('snd.gone'));
    else toast.error(t('snd.failed'));
  }
}

const lateness = createLateness();

/** SOUND_PLAY: someone in my call (me included) pressed a sound. */
export function onSoundPlay(ev: SoundPlay): void {
  const v = useVoice.getState();
  if (v.roomId !== ev.roomId || !v.workspaceId) return; // another device of mine is in that call
  const late = ev.at ? lateness(timestampMs(ev.at), Date.now()) : 0;
  if (late > LATE_MS) return;
  const s = useSounds.getState();
  s.showChip({ soundId: ev.soundId, userId: ev.userId, workspaceId: v.workspaceId });
  const key = useSounds.getState().chip?.key ?? 0;
  setTimeout(() => useSounds.getState().hideChip(key), CHIP_MS);
  if (v.deafened) return;
  if (ev.userId !== myUserId() && prefs().soundboardMuteOthers) return;
  void playClip(ev.soundId);
}
