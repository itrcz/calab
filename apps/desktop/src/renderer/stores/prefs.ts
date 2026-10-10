import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  PresenceStatus,
  ScreenSharePreset,
  type ConcreteScreenSharePreset,
  type ScreenShareContentHint,
} from '@calaba/protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PttBinding } from '../../shared/ipc';
import { PTT_RELEASE_DEFAULT_MS } from '../lib/pttRelease';
import type { EchoMode } from '../lib/media/echo';
import type { CodecPref } from '../lib/media/codecSelect';
import type { CameraPreset } from '../lib/plan';
import { NO_BACKGROUND, SEG_FPS, normalizeSegFps, type CameraBackground, type SegFpsOption } from '../lib/media/background/logic';
import { DEFAULT_CAMERA_EFFECTS, type CameraEffects } from '../lib/media/background/effects';
import type { LocalePref } from '../i18n/types';
import type { OpenChatSound } from '../lib/chatSound';
import type { SoundName } from '../lib/sounds';
import type { Combo, HotkeyAction } from '../lib/shortcuts';
import type { StatusChoice } from '../services/customStatus';
import type { UpdateNag } from '../features/shell/updateBarModel';
import type { CallView } from '../features/voice/tileLayout';

/**
 * Device-local preferences (localStorage — nothing secret here). Settings that
 * the server syncs across devices (UserSettings: noise suppression, RED, PTT)
 * are mirrored here and pushed with PATCH /api/me (services/profile.ts).
 */
export type Theme = 'dark' | 'light' | 'system';
export type MicMode = 'voice' | 'ptt';

export interface Prefs {
  theme: Theme;
  /** UI language (ADR-0022): 'auto' follows the OS until the user picks one. */
  locale: LocalePref;
  micDeviceId: string | null;
  outputDeviceId: string | null;
  cameraDeviceId: string | null;
  /** The «Проверьте камеру» preview was confirmed once: later the button turns the camera on directly. */
  cameraChecked: boolean;
  /** Camera ▾ «Качество»: 720p (default) or 1080p; the plan may lower it (ADR-0024). */
  cameraPreset: CameraPreset;
  /** Camera «Фон» (ADR-0035): blur or a picture, for every room and call on this device. */
  cameraBackground: CameraBackground;
  /** Camera «Внешний вид» (ADR-0035 addendum): touch-up + its strength, low-light lift; independent of the background. */
  cameraEffects: CameraEffects;
  /** Background mask rate, segmentations/s: 8 · 16 · 20 (default) · 25 — smoothness vs CPU (ADR-0035 2.1). */
  cameraBgFps: SegFpsOption;
  /** «Экономить трафик»: only the featured / PiP camera is received, at most 360p. */
  saveTraffic: boolean;
  /** userId → «Не показывать видео»: their camera is not subscribed (an avatar tile instead). */
  hiddenVideo: Record<string, true>;
  /** Call view «Галерея | Спикер» (ADR-0066 §1), per device. */
  callView: CallView;
  /** «Скрыть себя» in the call view: my tile goes, a small «Вы» badge stays. */
  hideSelf: boolean;
  /** «Скрыть участников без видео» in the call view. */
  hideNoVideo: boolean;
  /** Volume of everyone in voice, 0..1 (headphones ▾); multiplies the per-user volume, element.volume only. */
  outputVolume: number;
  micMode: MicMode;
  thresholdDb: number;
  pttBinding: PttBinding | null;
  /** PTT «Задержка отпускания» (lib/pttRelease.ts): the mic stays on this long after a hold key-up. */
  pttReleaseMs: number;
  rnnoise: boolean;
  red: boolean;
  /** «Как вы слушаете» (docs/02 «Эхо: колонки»): per device — a laptop on speakers, a desk with headphones. */
  echoMode: EchoMode;
  /**
   * «Режим музыканта» (ADR-0052): the mic without AEC / NS / AGC / RNNoise, music Opus profile, no
   * VAD gating. Not persisted: it lasts until I leave voice (or land in a room whose plan lacks it).
   */
  musicianMode: boolean;
  streamPreset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  /** «Кодек стрима» (ADR-0032): auto = by hardware (H.264 unless AV1/VP9 is the hardware encoder). */
  streamCodec: CodecPref;
  notifyMentions: boolean;
  notifyAll: boolean;
  /** Master switch for event sounds (docs/09 #29, «Звуки»). */
  voiceSounds: boolean;
  /** Per-event sound toggles; a missing key = on. */
  sounds: Partial<Record<SoundName, boolean>>;
  /** Event sound volume 0..1. */
  soundVolume: number;
  /** «В открытом чате» (docs/09 P1 #13): a message in the chat on screen — a quieter cue or none. */
  messageSoundOpenChat: OpenChatSound;
  /** userId → playback volume 0..2 (docs/09 #20); `element.volume` caps at 1, above 100 % only offsets the headphones ▾ volume (no WebAudio: AEC). */
  userVolumes: Record<string, number>;
  /** userId → muted for me only («Заглушить для меня»); their <audio> stays attached, muted. */
  mutedUsers: Record<string, true>;
  /** userId → «Не слышать» for me only: their voice and their stream's sound (element.muted). */
  deafUsers: Record<string, true>;
  /** Rebound in-window shortcuts (lib/shortcuts.ts); missing actions use the defaults. */
  hotkeys: Partial<Record<HotkeyAction, Combo>>;
  devStats: boolean;
  /** Chosen presence (PresenceStatus value): a copy of the server's per-user manual status (READY / USER_UPDATE, docs/05). */
  presence: PresenceStatus;
  /** When the chosen status ends (epoch ms; status menu «1 час»…, docs/09 #29) → back to «В сети». null = until changed. */
  presenceUntil: number | null;
  /** false = `presence` was chosen here while offline (or predates server-side statuses): the next READY sends it instead of taking the server's. */
  presenceSynced: boolean;
  /** My last custom statuses (status menu «Свой статус», newest first, ≤ 3; presets excluded). */
  recentStatuses: StatusChoice[];
  /** Personal voice bitrate cap (UserSettings.audio_bitrate_kbps); null = room setting. */
  personalBitrateKbps: number | null;
  /** First-run onboarding finished on this device (docs/08, «Онбординг»). */
  onboarded: boolean;
  /** This device already offered native notifications (including an explicit Later choice). */
  nativeNotifyOffered: boolean;
  /** The onboarding step shown last (features/onboarding/steps.ts): a relaunch resumes there. empty = from the start. */
  onboardingStep: string;
  /** AFK: minutes without input before presence becomes idle; 0 = off (docs/09 #34). */
  afkMinutes: number;
  /** The viewer's last stream layout per voice room (docs/09 #56): PiP or expanded stage. */
  streamStage: Record<string, 'pip' | 'expanded'>;
  /** «Громкость звуков» of the soundboard (ADR-0036), 0..2; × the headphones ▾ volume, element.volume caps at 1. */
  soundboardVolume: number;
  /** «Не воспроизводить звуки других»: only my own presses play. */
  soundboardMuteOthers: boolean;
  /** Starred sounds (ids: `builtin:<id>` or a workspace sound id), in the order starred. */
  soundboardFavorites: string[];
  /** Presses per sound id on this device («Часто используемые»). */
  soundboardUsage: Record<string, number>;
  /** The update bar's «Позже» / «×» (features/shell/updateBarModel.ts, docs/09 #125); null = never pressed. */
  updateNag: UpdateNag | null;
}

const DEFAULTS: Prefs = {
  theme: 'dark',
  locale: 'auto',
  micDeviceId: null,
  outputDeviceId: null,
  cameraDeviceId: null,
  cameraChecked: false,
  cameraPreset: ScreenSharePreset.H720,
  cameraBackground: NO_BACKGROUND,
  cameraEffects: DEFAULT_CAMERA_EFFECTS,
  cameraBgFps: SEG_FPS,
  saveTraffic: false,
  hiddenVideo: {},
  callView: 'gallery',
  hideSelf: false,
  hideNoVideo: false,
  outputVolume: 1,
  micMode: 'voice',
  thresholdDb: -50,
  pttBinding: null,
  pttReleaseMs: PTT_RELEASE_DEFAULT_MS,
  rnnoise: false, // off by default (owner, 27.09): Chromium's noiseSuppression is on instead, RNNoise costs CPU
  red: false,
  echoMode: 'headphones',
  musicianMode: false,
  streamPreset: ScreenSharePreset.H1080,
  contentHint: 'detail',
  streamCodec: 'auto',
  notifyMentions: true,
  notifyAll: false,
  voiceSounds: true,
  sounds: {},
  soundVolume: 0.5,
  messageSoundOpenChat: 'off',
  streamStage: {},
  userVolumes: {},
  mutedUsers: {},
  deafUsers: {},
  hotkeys: {},
  devStats: false,
  presence: PresenceStatus.ONLINE,
  presenceUntil: null,
  presenceSynced: true,
  recentStatuses: [],
  personalBitrateKbps: null,
  onboarded: false,
  nativeNotifyOffered: false,
  onboardingStep: '',
  afkMinutes: 10,
  soundboardVolume: 1,
  soundboardMuteOthers: false,
  soundboardFavorites: [],
  soundboardUsage: {},
  updateNag: null,
};

interface PrefsState extends Prefs {
  setPrefs: (p: Partial<Prefs>) => void;
}

export const usePrefs = create<PrefsState>()(
  persist((set) => ({ ...DEFAULTS, setPrefs: (p) => set(p) }), {
    name: 'calaba-prefs',
    version: 4,
    // v2: statuses moved to the server — a status chosen on this device before is sent once.
    // v3: RNNoise off for everyone (it was on by default and costs CPU); re-enable in settings.
    migrate: (state, version) => {
      let s = state as Partial<Prefs>;
      if (version < 2) s = { ...s, presenceSynced: (s.presence ?? PresenceStatus.ONLINE) === PresenceStatus.ONLINE };
      if (version < 3) s = { ...s, rnnoise: false };
      // v4: cameraBgFps; anything outside 8/16/20/25 is the default.
      return { ...s, cameraBgFps: normalizeSegFps(s.cameraBgFps) };
    },
    // Whatever the stored value, the rate is one of the options.
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as Partial<Prefs>;
      return { ...current, ...p, cameraBgFps: normalizeSegFps(p.cameraBgFps) };
    },
    // Musician mode is never stored on (ADR-0052: it lasts until I leave voice).
    partialize: ({ setPrefs: _s, ...rest }) => ({ ...rest, musicianMode: false }),
  }),
);

export const prefs = (): Prefs => usePrefs.getState();
export { DEFAULT_AUDIO_BITRATE_KBPS };
