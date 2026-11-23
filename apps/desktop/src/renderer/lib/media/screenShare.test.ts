import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: {} }));
import type { LocalVideoTrack } from 'livekit-client';
import { livekitSenderLock, ownAudioExcluded, setThumbScale, systemAudioConstraints, type SenderLock } from './screenShare';

describe('systemAudioConstraints (docs/02 echo rule 4, docs/09 #68, #122)', () => {
  it('asks Chromium to exclude our own playback and never mutes local playback (macOS and Windows alike)', () => {
    const c = systemAudioConstraints();
    // With main's plain 'loopback' this becomes `loopbackWithoutChrome`: Core Audio tap (macOS
    // 14.2+) / WASAPI process loopback EXCLUDE_TARGET_PROCESS_TREE (Windows 11).
    expect(c.restrictOwnAudio).toBe(true);
    expect(c.suppressLocalAudioPlayback).toBe(false);
  });

  it('turns voice processing off (music/game sound, not a mic)', () => {
    expect(systemAudioConstraints()).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe('ownAudioExcluded', () => {
  it('true when Chromium reports the constraint or the process-loopback device', () => {
    expect(ownAudioExcluded({ restrictOwnAudio: true })).toBe(true);
    expect(ownAudioExcluded({ deviceId: 'loopbackWithoutChrome' })).toBe(true);
  });

  it('false for plain endpoint loopback (Windows 10, macOS < 14.2: participants would hear themselves)', () => {
    expect(ownAudioExcluded({ restrictOwnAudio: false, deviceId: 'loopback' })).toBe(false);
    expect(ownAudioExcluded({ deviceId: 'loopbackWithMute' })).toBe(false);
  });
});

/**
 * A sender whose `setParameters` applies when its promise settles (in flight until then), and whose
 * `getParameters` returns the state applied so far: the window in which a read-modify-write can
 * see the state before another caller's pending write.
 */
function fakeSender(encodings: RTCRtpEncodingParameters[]) {
  let applied = encodings.map((e) => ({ ...e }));
  return {
    get applied() {
      return applied;
    },
    getParameters: () => ({ encodings: applied.map((e) => ({ ...e })) }) as unknown as RTCRtpSendParameters,
    setParameters: (p: RTCRtpSendParameters) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          applied = p.encodings.map((e) => ({ ...e }));
          resolve();
        }, 5),
      ),
  };
}

/** The shape of livekit's `@livekit/mutex`. */
function mutex(): SenderLock {
  let tail = Promise.resolve();
  return {
    lock() {
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      const wait = tail;
      tail = tail.then(() => next);
      return wait.then(() => release);
    },
  };
}

/** livekit-client 2.23 setPublishingLayersForSender, reduced: under the lock, get → toggle active → set. */
async function dynacast(sender: ReturnType<typeof fakeSender>, lock: SenderLock, active: Record<string, boolean>): Promise<void> {
  const unlock = await lock.lock();
  try {
    const params = sender.getParameters();
    for (const e of params.encodings) if (e.rid && e.rid in active) e.active = active[e.rid];
    await sender.setParameters(params);
  } finally {
    unlock();
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('setThumbScale vs dynacast (H.264 thumb rescale)', () => {
  const layers = (): RTCRtpEncodingParameters[] => [
    { rid: 'q', active: true, scaleResolutionDownBy: 3, maxBitrate: 250_000 },
    { rid: 'h', active: false, scaleResolutionDownBy: 1, maxBitrate: 2_500_000 },
  ];

  it('without the lock, a rescale read while dynacast enables the full layer writes back active:false', async () => {
    const sender = fakeSender(layers());
    const lock = mutex();
    const enable = dynacast(sender, lock, { h: true }); // its setParameters is in flight
    await tick(1);
    await Promise.all([enable, setThumbScale(sender, null, 2.5)]);
    expect(sender.applied.find((e) => e.rid === 'h')?.active).toBe(false); // the bug: viewers stuck on q
  });

  it("under livekit's lock the rescale waits for dynacast and keeps the full layer on", async () => {
    const sender = fakeSender(layers());
    const lock = mutex();
    const enable = dynacast(sender, lock, { h: true });
    await tick(1);
    const rescaled = setThumbScale(sender, lock, 2.5);
    await Promise.all([enable, rescaled]);
    expect(await rescaled).toBe(true);
    expect(sender.applied).toEqual([
      { rid: 'q', active: true, scaleResolutionDownBy: 2.5, maxBitrate: 250_000 },
      { rid: 'h', active: true, scaleResolutionDownBy: 1, maxBitrate: 2_500_000 },
    ]);
    // A later dynacast update still applies on top.
    await dynacast(sender, lock, { h: false });
    expect(sender.applied.find((e) => e.rid === 'h')?.active).toBe(false);
    expect(sender.applied.find((e) => e.rid === 'q')?.scaleResolutionDownBy).toBe(2.5);
  });

  it('touches nothing when the thumb already has that scale, and releases the lock', async () => {
    const sender = fakeSender(layers());
    const set = vi.spyOn(sender, 'setParameters');
    const lock = mutex();
    expect(await setThumbScale(sender, lock, 3)).toBe(false);
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    await dynacast(sender, lock, { h: true }); // would hang if the lock leaked
    expect(sender.applied[1]?.active).toBe(true);
  });

  it('livekitSenderLock finds the private mutex, null when it is gone', () => {
    const lock = mutex();
    expect(livekitSenderLock({ senderLock: lock } as unknown as LocalVideoTrack)).toBe(lock);
    expect(livekitSenderLock({} as unknown as LocalVideoTrack)).toBeNull();
  });
});
