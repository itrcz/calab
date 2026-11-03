import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHostActivityMessage } from '../../desktop/src/shared/hostActivity';
import { ROOM_AUDIO_ERRORS, ROOM_AUDIO_MUTE_ORIGINS, ROOM_AUDIO_PHASES, ROOM_AUDIO_ROUTES, parseRoomAudioOperation, parseRoomAudioState, type HostRoomAudioOperation } from '../../desktop/src/shared/hostRoomAudio';
import { ACCEPTED, OVER_MESSAGE_BOUND, REJECTED, connect, connectionId, disconnect } from '../../desktop/src/shared/hostRoomAudio.fixtures';

const envelope = (operation: object) => JSON.stringify({ v: 1, type: 'roomAudio', host: 0, document: '11111111-1111-4111-8111-111111111111', seq: 1, request: 1, ...operation });
const swiftAvailable = spawnSync('swiftc', ['--version']).status === 0;

// Swift prints each fixture back as parsed, or null when rejected, plus the states it would emit.
it.skipIf(!swiftAvailable)('TS and Swift accept and reject the same fixtures, and TS accepts what Swift emits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calab-room-audio-wire-'));
  try {
    const binary = join(dir, 'fixture');
    execFileSync('swiftc', [
      fileURLToPath(new URL('../modules/calab-session-activity/ios/CalabRoomAudioWire.swift', import.meta.url)),
      fileURLToPath(new URL('../tests/RoomAudioWireFixture.swift', import.meta.url)), '-o', binary,
    ]);
    const fixtures = [...ACCEPTED, ...REJECTED, ...OVER_MESSAGE_BOUND];
    const output = JSON.parse(execFileSync(binary, { encoding: 'utf8', input: JSON.stringify(fixtures) })) as {
      operations: unknown[]; samples: unknown[]; phases: unknown[]; routes: unknown[]; origins: unknown[]; errors: unknown[];
    };
    expect(output.operations).toHaveLength(fixtures.length);
    const swiftAccepts = (i: number) => i < ACCEPTED.length || i >= ACCEPTED.length + REJECTED.length;
    fixtures.forEach((fixture, i) => {
      const name = JSON.stringify(fixture).slice(0, 200);
      expect(parseHostActivityMessage(envelope(fixture)) !== null, name).toBe(i < ACCEPTED.length);
      // Compared through JSON: a fixture's undefined field is absent on the wire.
      expect(output.operations[i], name).toEqual(swiftAccepts(i) ? JSON.parse(JSON.stringify(fixture)) : null);
    });
    const samples = output.samples.map(parseRoomAudioState);
    expect(samples[0]).toMatchObject({ phase: 'connected', microphoneReady: true, speaking: true, route: 'bluetooth', level: 20 });
    expect(samples[1]).toMatchObject({ muted: true, muteOrigin: 'system', phoneCall: true });
    expect(samples[2]).toMatchObject({ error: 'audio', level: 20 });
    expect(samples[3]?.speakers).toHaveLength(64);
    // Every value Swift can emit passes the TS parser, and neither side has a value the other lacks.
    const emitted = (states: unknown[], field: 'phase' | 'route' | 'muteOrigin' | 'error') => states.map(state => parseRoomAudioState(state)?.[field]).sort();
    expect(emitted(output.phases, 'phase')).toEqual([...ROOM_AUDIO_PHASES].sort());
    expect(emitted(output.routes, 'route')).toEqual([...ROOM_AUDIO_ROUTES].sort());
    expect(emitted(output.origins, 'muteOrigin')).toEqual([...ROOM_AUDIO_MUTE_ORIGINS].sort());
    expect(emitted(output.errors, 'error')).toEqual([...ROOM_AUDIO_ERRORS].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000); // cold swiftc on CI runners takes ~30 s+

it('forwards the message type through the iOS WebView allowlist', () => {
  const patch = readFileSync(fileURLToPath(new URL('../../../patches/react-native-webview@13.16.1.patch', import.meta.url)), 'utf8');
  expect(patch).toMatch(/isEqualToString:@"roomAudio"\][^\n]*calabForwardMessage/);
});

describe('native room audio glue', () => {
  afterEach(() => { vi.doUnmock('expo'); vi.doUnmock('react-native'); vi.resetModules(); });
  const load = async (os: string, module: object | null) => {
    vi.resetModules();
    const requireOptionalNativeModule = vi.fn(() => module);
    vi.doMock('expo', () => ({ requireOptionalNativeModule }));
    vi.doMock('react-native', () => ({ Platform: { OS: os } }));
    return { glue: await import('./roomAudio'), requireOptionalNativeModule };
  };
  const operation = parseRoomAudioOperation(disconnect) as HostRoomAudioOperation;
  const connectOperation = parseRoomAudioOperation(connect) as HostRoomAudioOperation;
  const nativeModule = (roomAudioEnabled: unknown) => ({
    roomAudioEnabled, operation: vi.fn(() => Promise.resolve()), state: vi.fn((): Promise<unknown> => Promise.resolve({ supported: true })),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  });

  it('reports no support without the native module, so no build changes today', async () => {
    const { glue } = await load('ios', null);
    expect(glue.roomAudioEnabled).toBe(false);
    await expect(glue.roomAudioOperation('document', operation)).resolves.toEqual({ supported: false });
    expect(glue.subscribeRoomAudio(vi.fn())).toBeTypeOf('function');
  });
  it('stays off and never reaches a native module that does not report support', async () => {
    for (const value of [undefined, false, 1, 'true']) {
      const native = nativeModule(value);
      const { glue } = await load('ios', native);
      expect(glue.roomAudioEnabled).toBe(false);
      await expect(glue.roomAudioOperation('document', operation)).resolves.toEqual({ supported: false });
      glue.subscribeRoomAudio(vi.fn());
      expect(native.operation).not.toHaveBeenCalled();
      expect(native.state).not.toHaveBeenCalled();
      expect(native.addListener).not.toHaveBeenCalled();
    }
  });
  it('never asks for the module on Android', async () => {
    const { glue, requireOptionalNativeModule } = await load('android', nativeModule(true));
    expect(glue.roomAudioEnabled).toBe(false);
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });
  it('hands a reporting module the operation and reads status without one', async () => {
    const native = nativeModule(true);
    const { glue } = await load('ios', native);
    expect(glue.roomAudioEnabled).toBe(true);
    await expect(glue.roomAudioOperation('document', operation)).resolves.toEqual({ supported: true });
    expect(native.operation).toHaveBeenCalledExactlyOnceWith('document', operation);
    await glue.roomAudioOperation('document', { operation: 'status' });
    expect(native.operation).toHaveBeenCalledOnce();
  });
  it('reports a failure with the native state, never as unsupported', async () => {
    const native = nativeModule(true);
    const { glue } = await load('ios', native);
    const media = { connectionId, phase: 'connecting', microphoneReady: false, muted: false, canSpeak: true, speaking: false, speakers: [], route: 'other', phoneCall: false };
    native.operation.mockRejectedValueOnce(new Error('connect rejected'));
    native.state.mockResolvedValueOnce({ supported: true, media });
    await expect(glue.roomAudioOperation('document', connectOperation)).resolves.toEqual({ supported: true, media, failed: true });
    expect(native.state).toHaveBeenCalledOnce();
    native.operation.mockRejectedValueOnce(new Error('connect rejected'));
    native.state.mockRejectedValueOnce(new Error('state rejected'));
    await expect(glue.roomAudioOperation('document', connectOperation)).resolves.toEqual({ supported: true, failed: true });
    native.state.mockRejectedValueOnce(new Error('state rejected'));
    await expect(glue.roomAudioOperation('document', connectOperation)).resolves.toEqual({ supported: true, failed: true });
    native.state.mockRejectedValueOnce(new Error('state rejected'));
    await expect(glue.roomAudioOperation('document', { operation: 'status' })).resolves.toEqual({ supported: true, failed: true });
    for (const state of [{ supported: true, token: connect.token }, { supported: true, media: { ...media, url: connect.url } }, { supported: false }, null]) {
      native.state.mockResolvedValueOnce(state);
      await expect(glue.roomAudioOperation('document', connectOperation)).resolves.toEqual({ supported: true, failed: true });
    }
  });
  it('passes on only parsed state events', async () => {
    const native = nativeModule(true);
    const { glue } = await load('ios', native);
    const listener = vi.fn();
    glue.subscribeRoomAudio(listener);
    const emit = (native.addListener.mock.calls as unknown as [[string, (value: unknown) => void]])[0][1];
    emit({ document: 'document', state: { supported: true } });
    emit({ document: 'document', state: { supported: true, media: { connectionId, url: connect.url } } });
    expect(listener).toHaveBeenCalledExactlyOnceWith('document', { supported: true });
  });
  it('replies through a page event scoped to host, document and request', async () => {
    const { glue } = await load('ios', null);
    const reply = glue.roomAudioReply(3, 'document', 7, { supported: false });
    expect(reply).toContain("'calab-host-room-audio'");
    expect(reply).toContain('{"v":1,"host":3,"document":"document","request":7,"state":{"supported":false}}');
  });
});
