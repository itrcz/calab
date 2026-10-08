import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCallsOperation, parseCallsState } from '../../desktop/src/shared/hostCalls';
import { parseHostActivityMessage } from '../../desktop/src/shared/hostActivity';
import { ActivityProtocol } from './activityProtocol';

const eventId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const controls = { muted: false, deafened: false, volume: 1, userVolumes: {} };
const connect = { operation: 'audioConnect', eventId, connectionId, roomId, url: 'wss://rtc.example.test', token: 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0Ijp0cnVlfQ.signature', relayOnly: true, bitrate: 32000, canSpeak: true, controls };

it.skipIf(spawnSync('swiftc', ['--version']).status !== 0)('accepts Expo numeric inputs in the actual native bitrate validator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calab-call-audio-wire-'));
  try {
    const binary = join(dir, 'fixture');
    execFileSync('swiftc', [
      fileURLToPath(new URL('../modules/calab-session-activity/ios/CalabCallAudio.swift', import.meta.url)),
      fileURLToPath(new URL('../tests/CallAudioInputTests.swift', import.meta.url)), '-o', binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('PASS: native bridged bitrate validation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
const envelope = (op: object, document = eventId, seq = 1) => JSON.stringify({ v: 1, type: 'calls', host: 0, document, seq, request: seq, ...op });

describe('native call audio wire', () => {
  it('accepts a bounded server join only through the current document and sequence', () => {
    expect(parseCallsOperation(connect)).toEqual(connect);
    const p = new ActivityProtocol(0);
    expect(p.accept(envelope(connect))).toBeNull();
    p.accept(JSON.stringify({ v: 1, type: 'hello', host: 0, document: eventId }));
    expect(p.accept(envelope(connect))?.type).toBe('calls');
    expect(p.accept(envelope(connect))).toBeNull();
    expect(p.accept(envelope(connect, connectionId, 2))).toBeNull();
    p.reset();
    expect(p.accept(envelope(connect, eventId, 3))).toBeNull();
  });
  it('rejects unsafe URLs, invalid IDs, oversized credentials and extra fields', () => {
    for (const change of [{ url: 'http://rtc.test' }, { url: 'wss://u:p@rtc.test' }, { url: 'wss://rtc.test/#secret' }, { token: 'x'.repeat(4097) }, { eventId: 'bad' }, { relayOnly: 'true' }, { bitrate: 128000 }, { canSpeak: 1 }, { cookies: 'forbidden' }, { controls: { ...controls, volume: Infinity } }, { controls: { ...controls, userVolumes: { invalid: 1 } } }]) {
      expect(parseCallsOperation({ ...connect, ...change })).toBeNull();
    }
  });
  it('allows bounded JWTs beyond the old status-only envelope and rejects oversized bytes', () => {
    const longer = { ...connect, token: `header.${'x'.repeat(2800)}.signature` };
    expect(parseHostActivityMessage(envelope(longer))).not.toBeNull();
    expect(parseHostActivityMessage(envelope({ ...connect, token: 'x'.repeat(8200) }))).toBeNull();
  });
  it('accepts only scoped controls and disconnect', () => {
    expect(parseCallsOperation({ operation: 'audioControl', eventId, connectionId, controls })).not.toBeNull();
    expect(parseCallsOperation({ operation: 'audioDisconnect', eventId, connectionId })).not.toBeNull();
    expect(parseCallsOperation({ operation: 'audioDisconnect', eventId })).toBeNull();
  });
  it('counts UTF-8 bytes rather than JavaScript characters at the native boundary', () => {
    const userVolumes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`, 1]));
    const raw = envelope({ ...connect, token: `a.${'x'.repeat(3990)}.b`, url: `wss://${'я'.repeat(900)}.test`, controls: { ...controls, userVolumes } });
    expect(raw.length).toBeLessThan(8192);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(8192);
    expect(parseHostActivityMessage(raw)).toBeNull();
  });
  it('parses media readiness without leaking credentials through state events', () => {
    const media = { eventId, connectionId, phase: 'connected', microphoneReady: true, muted: false, canSpeak: true, speakers: [roomId] };
    expect(parseCallsState({ supported: true, media })?.media).toEqual(media);
    expect(parseCallsState({ supported: true, media: { ...media, token: connect.token } })).toBeNull();
    expect(parseCallsState({ supported: true, media: { ...media, speakers: ['bad'] } })).toBeNull();
    expect(parseCallsState({ supported: true, media: { ...media, phase: 'unknown' } })).toBeNull();
  });
});
