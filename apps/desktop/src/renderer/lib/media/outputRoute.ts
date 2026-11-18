import { deviceName, type AudioDevice } from '../deviceSwitch';

/**
 * Where remote voices play (CBF-108; docs/02 echo rule 2 — `setSinkId` on the same <audio>).
 * Pure: the caller passes the last `enumerateDevices()` snapshot and the choice from the prefs.
 *
 * Why this exists. Chromium mixes every remote WebRTC track of the page into ONE output
 * (`WebRtcAudioRenderer`): `setSinkId` on any single remote element moves all remote voices,
 * while the other elements keep reporting their old `sinkId`. A later `setSinkId` with that
 * unchanged id is a no-op by spec, so the voices stay where the stray call put them. UI sounds
 * are fresh elements on the chosen device — heard, while the voices are not. The stray writer
 * was LiveKit: its output id is fixed at `new Room()` and it re-applies it to every new remote
 * track (a participant joins, a reconnect re-subscribes). So LiveKit and our elements must
 * always get the same id, and that id must name a device that exists now:
 *  - the chosen device while it is present;
 *  - otherwise the system default — `'default'` where Chromium lists that alias (it follows the
 *    OS default and is what LiveKit falls back to), `''` elsewhere;
 *  - the list unknown (no snapshot yet, no device ids before permission): the choice as is.
 * A chosen device that went away (AirPods off) is thus left explicitly, not kept as the sink of a
 * renderer on a dead device; it is taken back when the device returns (`devicechange`).
 */

type Device = Pick<AudioDevice, 'deviceId' | 'groupId' | 'kind' | 'label'>;

export const DEFAULT_SINK = 'default';

/** The sink id for remote audio (and LiveKit's audio output). '' = the element's default. */
export function outputSink(list: readonly Device[] | null, chosen: string | null): string {
  const outs = (list ?? []).filter((d) => d.kind === 'audiooutput' && d.deviceId !== '');
  if (outs.length === 0) return chosen ?? '';
  if (chosen && outs.some((d) => d.deviceId === chosen)) return chosen;
  return outs.some((d) => d.deviceId === DEFAULT_SINK) ? DEFAULT_SINK : '';
}

/**
 * LiveKit's idea of the output (`room.options.audioOutput.deviceId` — what new remote tracks get
 * — and its active device) differs from `sink`: switch it. '' is never pushed: LiveKit would see
 * an id missing from the device list and switch to the first device on every `devicechange`.
 */
export function livekitOutputStale(sink: string, options: string | undefined, active: string | undefined): boolean {
  if (sink === '') return false;
  return (options ?? DEFAULT_SINK) !== sink || (active ?? DEFAULT_SINK) !== sink;
}

/**
 * The capture just opened on the same headset the voices play to (AirPods, a USB headset: the
 * input and output share a group id, or at least the name). On macOS opening a Bluetooth
 * headset's mic switches it from A2DP to the HFP profile; the output's format changes under the
 * running WebRTC renderer without a `devicechange`, and the voices can go silent while fresh
 * elements (UI sounds) play. The caller re-binds the remote elements once the route has settled.
 */
export function captureOnOutputHeadset(list: readonly Device[] | null, micLabel: string, sink: string): boolean {
  if (!list || !micLabel) return false;
  const outs = list.filter((d) => d.kind === 'audiooutput');
  // The output the voices actually use: the sink, or the device the default alias names.
  const out =
    sink && sink !== DEFAULT_SINK
      ? outs.find((d) => d.deviceId === sink)
      : outs.find((d) => d.deviceId === DEFAULT_SINK) ?? outs.find((d) => d.deviceId !== 'communications');
  if (!out) return false;
  const outName = deviceName(out.label);
  const micName = deviceName(micLabel);
  if (!outName || !micName) return false;
  if (outName === micName) return true;
  // Same group: the physical device of the output also has the capture's input (Chromium gives
  // the «default» alias the group id of the device it names).
  if (!out.groupId) return false;
  return list.some((d) => d.kind === 'audioinput' && d.groupId === out.groupId && deviceName(d.label) === micName);
}

/**
 * A `devicechange` touched the outputs: a device came or went, or the OS default moved (the
 * «default» alias names another device). Input / camera changes do not — re-binding then would
 * reopen every remote renderer for nothing. An unknown previous list counts as a change.
 */
export function outputsChanged(prev: readonly Device[] | null, next: readonly Device[]): boolean {
  if (!prev) return true;
  const key = (l: readonly Device[]): string =>
    l
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => (d.deviceId === DEFAULT_SINK || d.deviceId === 'communications' ? `${d.deviceId}=${d.groupId}|${deviceName(d.label)}` : d.deviceId))
      .sort()
      .join('\n');
  return key(prev) !== key(next);
}

/**
 * The output the voices actually play to moved (CBF-193 review): the sink id changed, the chosen
 * device came back or went, or — on the «default» alias — the OS default names another device.
 * A device that comes or goes elsewhere (a monitor with speakers, a second headset while the
 * voices stay on the speakers) leaves the shared renderer alone: re-binding then would cut every
 * voice for nothing. Where the device behind the sink is unknown (no alias, no ids yet) any
 * output change counts (`outputsChanged`). A renderer that dies anyway reports `error` on its
 * elements, and the owner re-binds then.
 */
export function effectiveOutputChanged(prev: readonly Device[] | null, next: readonly Device[], chosen: string | null): boolean {
  if (!prev) return true;
  const target = (l: readonly Device[]): string | null => {
    const outs = l.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '');
    if (outs.length === 0) return null;
    const sink = outputSink(l, chosen);
    if (sink !== '' && sink !== DEFAULT_SINK) return `id:${sink}`;
    const def = outs.find((d) => d.deviceId === DEFAULT_SINK);
    return def ? `default:${def.groupId}|${deviceName(def.label)}` : null;
  };
  const a = target(prev);
  const b = target(next);
  if (a === null || b === null) return outputsChanged(prev, next);
  return a !== b;
}
