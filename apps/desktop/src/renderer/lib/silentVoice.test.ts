import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SILENT_CHECK_MS,
  SILENT_OK_COOLDOWN_MS,
  SILENT_RESUBSCRIBES,
  SilentVoiceWatch,
  silentVerdict,
  type SilentStep,
  type VoiceFlow,
} from './silentVoice';

const flow = (packets: number, samples: number | null = packets * 960, bound = true): VoiceFlow => ({ packets, samples, bound });
const none = { reattaches: 0, resubscribes: 0 };

describe('silentVerdict', () => {
  it('packets in, samples pulled, element bound: ok', () => {
    expect(silentVerdict(flow(10), flow(160), none)).toBe('ok');
    // An engine without totalSamplesReceived: packets alone decide.
    expect(silentVerdict(flow(10, null), flow(160, null), none)).toBe('ok');
  });

  it('no packets (the SFU stopped forwarding): re-attach first, then resubscribe, then give up', () => {
    expect(silentVerdict(flow(10), flow(10), none)).toBe('reattach');
    expect(silentVerdict(flow(10), flow(10), { reattaches: 1, resubscribes: 0 })).toBe('resubscribe');
    expect(silentVerdict(flow(10), flow(10), { reattaches: 1, resubscribes: SILENT_RESUBSCRIBES })).toBe('give-up');
  });

  it('packets in but no player pulls them (a dead or stale element): not ok', () => {
    expect(silentVerdict(flow(10, 5000), flow(160, 5000), none)).toBe('reattach');
  });

  it('the element does not hold the track (or is paused): not ok', () => {
    expect(silentVerdict(flow(10), flow(160, 160 * 960, false), none)).toBe('reattach');
  });
});

describe('SilentVoiceWatch', () => {
  let flows: Map<string, VoiceFlow | null>;
  let speaking: Set<string>;
  let acts: Array<[string, SilentStep]>;
  let watch: SilentVoiceWatch;
  let probes: number;

  beforeEach(() => {
    vi.useFakeTimers();
    flows = new Map();
    speaking = new Set(['TR_a']);
    acts = [];
    probes = 0;
    watch = new SilentVoiceWatch({
      probe: (sid) => {
        probes++;
        return Promise.resolve(flows.get(sid) ?? null);
      },
      speaking: (sid) => speaking.has(sid),
      act: (sid, step) => acts.push([sid, step]),
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
  });

  afterEach(() => {
    watch.reset();
    vi.useRealTimers();
  });

  /** Runs the watch's timers and the probes they start. */
  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('a healthy mic: one baseline, one check, then quiet for the cooldown', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    await advance(0);
    flows.set('TR_a', flow(160));
    await advance(SILENT_CHECK_MS);
    expect(acts).toEqual([]);
    expect(probes).toBe(2);
    expect(watch.pending('TR_a')).toBe(false);
    // Speaking again within the cooldown costs nothing.
    watch.onSpeaking('TR_a');
    await advance(SILENT_CHECK_MS * 2);
    expect(probes).toBe(2);
    vi.setSystemTime(Date.now() + SILENT_OK_COOLDOWN_MS);
    watch.onSpeaking('TR_a');
    await advance(0);
    expect(probes).toBe(3);
  });

  it('a burst of speaking events arms one check', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    watch.onSpeaking('TR_a');
    await advance(0);
    watch.onSpeaking('TR_a');
    expect(probes).toBe(1);
  });

  it('a dead mic: re-attach, then resubscribe (verified while they speak), then give up — bounded', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    // Never any new packet: every step fails; each is verified after its own settle.
    for (let i = 0; i < 10; i++) await advance(SILENT_CHECK_MS);
    expect(acts.map(([, s]) => s)).toEqual(['reattach', 'resubscribe', 'resubscribe', 'give-up']);
    // Gave up: further speaking does nothing (no spin).
    const n = probes;
    watch.onSpeaking('TR_a');
    await advance(SILENT_CHECK_MS * 3);
    expect(probes).toBe(n);
  });

  it('a step that helps: the budget is restored', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    await advance(SILENT_CHECK_MS); // no packets → reattach
    expect(acts).toEqual([['TR_a', 'reattach']]);
    // The re-attached element plays: packets and samples grow from the next baseline on.
    let p = 10;
    const grow = setInterval(() => flows.set('TR_a', flow((p += 50))), 500);
    await advance(SILENT_CHECK_MS * 2);
    clearInterval(grow);
    expect(acts).toEqual([['TR_a', 'reattach']]);
    expect(watch.pending('TR_a')).toBe(false);
  });

  it('stopped speaking within the window: no verdict, no step', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    await advance(0);
    speaking.delete('TR_a');
    await advance(SILENT_CHECK_MS);
    expect(acts).toEqual([]);
    expect(watch.pending('TR_a')).toBe(false);
  });

  it('nothing to measure (no track / stats): nothing is done', async () => {
    flows.set('TR_a', null);
    watch.onSpeaking('TR_a');
    await advance(SILENT_CHECK_MS * 2);
    expect(acts).toEqual([]);
    expect(watch.pending('TR_a')).toBe(false);
  });

  it('reset drops a check in flight', async () => {
    flows.set('TR_a', flow(10));
    watch.onSpeaking('TR_a');
    await advance(0);
    watch.reset();
    await advance(SILENT_CHECK_MS * 2);
    expect(acts).toEqual([]);
  });
});
