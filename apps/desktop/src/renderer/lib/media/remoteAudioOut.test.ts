import { describe, expect, it } from 'vitest';
import { type AudioOutState, RemoteAudioOut } from './remoteAudioOut';

/**
 * A stand-in <audio>: muted / volume like the DOM, `volumechange` fired synchronously on a real
 * change (the DOM queues it; order is the same), `setSinkId` records the device and — like a
 * renderer rebuilt on a sink switch — can drop the element back to «audible» (`resetOnSink`).
 */
class FakeAudio {
  private m = false;
  private v = 1;
  sinkId = '';
  resetOnSink = false;
  pushes = 0;
  private readonly listeners = new Set<() => void>();

  get muted(): boolean {
    return this.m;
  }
  set muted(x: boolean) {
    if (x === this.m) return;
    this.m = x;
    this.fire();
  }
  get volume(): number {
    return this.v;
  }
  set volume(x: number) {
    if (x === this.v) return;
    this.v = x;
    this.pushes++;
    this.fire();
  }
  setSinkId(id: string): Promise<undefined> {
    this.sinkId = id;
    if (this.resetOnSink) {
      // Behind our back, as Room.startAudio() / a rebuilt renderer would.
      this.m = false;
      this.v = 1;
    }
    return Promise.resolve(undefined);
  }
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  private fire(): void {
    for (const fn of [...this.listeners]) fn();
  }
  /** An outside write that does fire `volumechange` (LiveKit `el.muted = false`). */
  unmuteFromOutside(): void {
    this.muted = false;
  }
}

function setup(init: Partial<AudioOutState> = {}) {
  const state: AudioOutState = { deafened: false, userVolumes: {}, mutedUsers: {}, deafUsers: {}, streamVolume: {}, outputVolume: 1, ...init };
  const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement>(() => state);
  const el = (): FakeAudio & HTMLMediaElement => new FakeAudio() as FakeAudio & HTMLMediaElement;
  /** An engine without per-element output selection (WebKit with the setting off): no `setSinkId`. */
  const noSinkEl = (): FakeAudio & HTMLMediaElement => Object.defineProperty(el(), 'setSinkId', { value: undefined });
  return { state, out, el, noSinkEl };
}

describe('RemoteAudioOut — deafen holds on every path', () => {
  it('deafen → output device switch → every element still muted', async () => {
    const { state, out, el } = setup();
    const a = el();
    const b = el();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', true);
    state.deafened = true;
    out.applyAll();
    expect([a.muted, b.muted]).toEqual([true, true]);
    // The sink switch resets the elements (charger / dock on macOS): deafen is put back.
    a.resetOnSink = true;
    b.resetOnSink = true;
    await out.setSink('usb-headset');
    expect([a.sinkId, b.sinkId]).toEqual(['usb-headset', 'usb-headset']);
    expect([a.muted, b.muted]).toEqual([true, true]);
  });

  it('deafen → a new participant joins → their element is muted from the start, on our sink', async () => {
    const { state, out, el } = setup({ deafened: true });
    await out.setSink('speakers');
    const c = el();
    out.add('TR_c', c, 'u3', false);
    expect(c.muted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.sinkId).toBe('speakers');
    expect(c.muted).toBe(true);
    state.deafened = false;
    out.applyAll();
    expect(c.muted).toBe(false);
  });

  it('something else unmutes an element while deafened (Room.startAudio) → muted again', () => {
    const { out, el } = setup({ deafened: true });
    const a = el();
    out.add('TR_a', a, 'u1', false);
    a.unmuteFromOutside();
    expect(a.muted).toBe(true);
  });

  it('undeafen restores the per-user volumes and «mute for me»', () => {
    const { state, out, el } = setup({ userVolumes: { u1: 0.5 }, mutedUsers: { u2: true }, outputVolume: 0.8 });
    const a = el();
    const b = el();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', false);
    expect([a.muted, a.volume, b.muted]).toEqual([false, 0.4, true]);
    state.deafened = true;
    out.applyAll();
    expect([a.muted, b.muted]).toEqual([true, true]);
    state.deafened = false;
    out.applyAll();
    expect([a.muted, a.volume, b.muted]).toEqual([false, 0.4, true]);
  });

  it('a sink switch re-pushes the volume to the player even when the attributes already match', async () => {
    const { out, el } = setup({ userVolumes: { u1: 0.5 } });
    const a = el();
    out.add('TR_a', a, 'u1', false);
    const before = a.pushes;
    await out.setSink('');
    expect(a.pushes).toBeGreaterThan(before);
    expect(a.volume).toBe(0.5);
  });

  it('a removed element is no longer touched', async () => {
    const { state, out, el } = setup();
    const a = el();
    out.add('TR_a', a, 'u1', false);
    expect(out.remove('TR_a')).toBe(a);
    state.deafened = true;
    out.applyAll();
    await out.setSink('x');
    expect([a.muted, a.sinkId]).toEqual([false, '']);
    expect(out.size).toBe(0);
  });
});

describe('RemoteAudioOut — engines without setSinkId', () => {
  it('setSink resolves (devicechange, default and chosen id), the output stays the OS one, deafen is re-asserted', async () => {
    const { state, out, noSinkEl } = setup({ userVolumes: { u1: 0.5 } });
    const a = noSinkEl();
    out.add('TR_a', a, 'u1', false);
    const before = a.pushes;
    await expect(out.setSink('')).resolves.toBeUndefined();
    expect(a.pushes).toBeGreaterThan(before);
    expect(a.volume).toBe(0.5);
    state.deafened = true;
    await expect(out.setSink('usb-headset')).resolves.toBeUndefined();
    expect(a.sinkId).toBe('');
    expect(a.muted).toBe(true);
  });

  it('a new element on a remembered sink: no rejection, muted from the start while deafened', async () => {
    const { out, noSinkEl } = setup({ deafened: true });
    await out.setSink('speakers');
    const c = noSinkEl();
    out.add('TR_c', c, 'u3', false);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.muted).toBe(true);
    expect(c.sinkId).toBe('');
  });

  it('mixed with a supporting element: that one still switches, both keep deafen', async () => {
    const { state, out, el, noSinkEl } = setup();
    const a = el();
    const b = noSinkEl();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', false);
    state.deafened = true;
    a.resetOnSink = true;
    await out.setSink('usb-headset');
    expect([a.sinkId, b.sinkId]).toEqual(['usb-headset', '']);
    expect([a.muted, b.muted]).toEqual([true, true]);
  });
});
