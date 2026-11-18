import { describe, expect, it } from 'vitest';
import { captureOnOutputHeadset, effectiveOutputChanged, livekitOutputStale, outputSink, outputsChanged } from './outputRoute';

const out = (deviceId: string, label: string, groupId = `g-${deviceId}`) => ({ deviceId, groupId, kind: 'audiooutput' as const, label });
const inp = (deviceId: string, label: string, groupId = `g-${deviceId}`) => ({ deviceId, groupId, kind: 'audioinput' as const, label });

// Chromium on macOS: the «default» alias carries the label and group of the device it names.
const spk = out('spk', 'MacBook Pro Speakers', 'g-mbp');
const air = out('air', 'AirPods Pro', 'g-air');
const airMic = inp('air-in', 'AirPods Pro', 'g-air');
const mbpMic = inp('mbp-in', 'MacBook Pro Microphone', 'g-mbp');
const defaultTo = (d: { label: string; groupId: string }) => out('default', `Default - ${d.label}`, d.groupId);

describe('outputSink', () => {
  it('the chosen device while present', () => {
    expect(outputSink([defaultTo(spk), spk, air], 'air')).toBe('air');
  });

  it('system default = the «default» alias (what LiveKit falls back to)', () => {
    expect(outputSink([defaultTo(spk), spk, air], null)).toBe('default');
  });

  it('a list without the alias (Firefox, WebKit): the element default', () => {
    expect(outputSink([spk, air], null)).toBe('');
    expect(outputSink([spk], 'air')).toBe('');
  });

  it('unknown list (no snapshot, no permission → empty ids): the choice as is', () => {
    expect(outputSink(null, 'air')).toBe('air');
    expect(outputSink(null, null)).toBe('');
    expect(outputSink([out('', '')], 'air')).toBe('air');
  });

  it('devicechange sequence: AirPods off → default; back → AirPods; default moves → still the alias', () => {
    const seq = [
      [defaultTo(air), spk, air],
      [defaultTo(spk), spk], // AirPods out of the ear / to the iPhone
      [defaultTo(air), spk, air], // back
    ];
    expect(seq.map((l) => outputSink(l, 'air'))).toEqual(['air', 'default', 'air']);
    expect(seq.map((l) => outputSink(l, null))).toEqual(['default', 'default', 'default']);
  });

  it('a stored «default» choice is the alias, not a stale id', () => {
    expect(outputSink([defaultTo(air), spk, air], 'default')).toBe('default');
  });
});

describe('livekitOutputStale', () => {
  it('LiveKit fixed at join on another device: switch', () => {
    expect(livekitOutputStale('air', 'spk', 'spk')).toBe(true);
    expect(livekitOutputStale('default', 'air', 'air')).toBe(true);
  });

  it('options or active device lagging: switch', () => {
    expect(livekitOutputStale('air', 'air', 'default')).toBe(true);
    expect(livekitOutputStale('air', undefined, 'air')).toBe(true);
  });

  it('in sync, or LiveKit untouched on the default: nothing (no ActiveDeviceChanged loop)', () => {
    expect(livekitOutputStale('air', 'air', 'air')).toBe(false);
    expect(livekitOutputStale('default', undefined, 'default')).toBe(false);
    expect(livekitOutputStale('default', undefined, undefined)).toBe(false);
  });

  it("'' is never pushed to LiveKit", () => {
    expect(livekitOutputStale('', 'spk', 'spk')).toBe(false);
  });
});

describe('captureOnOutputHeadset', () => {
  const list = [defaultTo(air), spk, air, inp('default', 'Default - AirPods Pro', 'g-air'), airMic, mbpMic];

  it('mic on the AirPods the voices play to (chosen or via the default alias)', () => {
    expect(captureOnOutputHeadset(list, 'AirPods Pro', 'air')).toBe(true);
    expect(captureOnOutputHeadset(list, 'Default - AirPods Pro', 'default')).toBe(true);
    expect(captureOnOutputHeadset(list, 'AirPods Pro', '')).toBe(true);
  });

  it('same group, different names (a USB headset: «… Microphone» / «… Speakers»)', () => {
    const usbOut = out('usb-out', 'Jabra Evolve Speakers', 'g-usb');
    const usbIn = inp('usb-in', 'Jabra Evolve Microphone', 'g-usb');
    expect(captureOnOutputHeadset([spk, usbOut, usbIn], 'Jabra Evolve Microphone', 'usb-out')).toBe(true);
  });

  it('mic and output on different devices: no', () => {
    expect(captureOnOutputHeadset(list, 'MacBook Pro Microphone', 'air')).toBe(false);
    expect(captureOnOutputHeadset(list, 'AirPods Pro', 'spk')).toBe(false);
  });

  it('unknown: no labels, no list, the output gone', () => {
    expect(captureOnOutputHeadset(null, 'AirPods Pro', 'air')).toBe(false);
    expect(captureOnOutputHeadset(list, '', 'air')).toBe(false);
    expect(captureOnOutputHeadset([spk, mbpMic], 'AirPods Pro', 'air')).toBe(false);
  });
});

describe('outputsChanged', () => {
  const base = [defaultTo(spk), spk, air, mbpMic, airMic];
  it('an output comes or goes, or the default moves: yes', () => {
    expect(outputsChanged(base, [defaultTo(spk), spk, mbpMic])).toBe(true);
    expect(outputsChanged(base, [defaultTo(air), spk, air, mbpMic, airMic])).toBe(true);
    expect(outputsChanged(null, base)).toBe(true);
  });
  it('only inputs / cameras changed, or the order: no', () => {
    expect(outputsChanged(base, [defaultTo(spk), spk, air, mbpMic])).toBe(false);
    expect(outputsChanged(base, [air, spk, defaultTo(spk), { deviceId: 'cam', groupId: 'c', kind: 'videoinput' as never, label: 'FaceTime' }])).toBe(false);
  });
});

describe('effectiveOutputChanged', () => {
  const base = [defaultTo(spk), spk, air, mbpMic, airMic];
  it('the default moves, the chosen device goes or comes back, unknown before: yes', () => {
    expect(effectiveOutputChanged(base, [defaultTo(air), spk, air], null)).toBe(true);
    expect(effectiveOutputChanged(base, [defaultTo(spk), spk], 'air')).toBe(true);
    expect(effectiveOutputChanged([defaultTo(spk), spk], base, 'air')).toBe(true);
    expect(effectiveOutputChanged(null, base, null)).toBe(true);
  });
  it('another output comes or goes while the voices stay where they are: no', () => {
    expect(effectiveOutputChanged(base, [defaultTo(spk), spk, mbpMic], null)).toBe(false);
    expect(effectiveOutputChanged(base, [defaultTo(air), spk, air, out('hdmi', 'LG Monitor')], 'air')).toBe(false);
  });
  it('no alias (the device behind the sink unknown): any output change', () => {
    expect(effectiveOutputChanged([spk, air], [spk], null)).toBe(true);
    expect(effectiveOutputChanged([spk, air], [spk, air, mbpMic], null)).toBe(false);
  });
});
