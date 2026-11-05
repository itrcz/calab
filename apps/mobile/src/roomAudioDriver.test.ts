import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const swiftAvailable = spawnSync('swiftc', ['--version']).status === 0;
const native = (name: string) => fileURLToPath(new URL(`../modules/calab-session-activity/ios/${name}`, import.meta.url));
const test = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));
const driver = [native('CalabRoomAudioWire.swift'), native('CalabRoomAudio.swift')];

function run(sources: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'calab-room-audio-driver-'));
  try {
    const binary = join(dir, 'fixture');
    execFileSync('swiftc', [...sources, '-o', binary]);
    return execFileSync(binary, { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!swiftAvailable)('native room driver logic in actual Swift', () => {
  it('runs the voice gate', () => {
    const result = run([native('CalabVoiceGate.swift'), test('VoiceGateTests.swift')]);
    expect(result).toContain('PASS: voice opens after two frames above the threshold');
    expect(result).toContain('PASS: 400 ms hangover keeps word endings and closes after it');
    expect(result).toContain('PASS: push-to-talk follows the key and rings only with speech');
    expect(result).toContain('PASS: open never gates and still rings on speech');
    expect(result).toContain('PASS: RMS, dB and 21 level steps match the web meter');
    expect(result).toContain('PASS: the gate is plain data');
  }, 180_000);

  it('runs the room inputs, generations and controls', () => {
    const result = run([...driver, test('RoomAudioInputTests.swift')]);
    expect(result).toContain("PASS: connect reaches only the build's rtc hosts");
    expect(result).toContain('PASS: microphones and watched screen-share audio only, never the web companion');
    expect(result).toContain('PASS: complete controls converge, deafen unsubscribes, the system mute holds');
    expect(result).toContain('PASS: stale documents and connections change nothing');
    expect(result).toContain('PASS: operations are rate-limited and state is paced to one latest snapshot');
    expect(result).toContain('PASS: the capture watchdog restarts once per silence, never on a dead meter path');
    expect(result).toContain('PASS: cues resolve to bundled files by name only');
  }, 180_000);

  it('ends the reconnect schedule inside the seat grace', () => {
    const result = run([...driver, test('ReconnectScheduleTests.swift')]);
    expect(result).toContain('PASS: the delay curve mirrors computeReconnectDelay');
    expect(result).toContain("PASS: the driver's deadline and teardown end inside VOICE_LOST_GRACE");
    expect(result).toContain('PASS: a fast-failing outage is retried for 30 s and the first retry comes fast');
    expect(result).toContain('PASS: the deadline counts from the last healthy moment, also across a suspension');
  }, 180_000);
});

describe('native room driver boundaries', () => {
  const read = (name: string) => readFileSync(native(name), 'utf8');
  it('keeps the gate and the driver logic outside the SDK', () => {
    expect(read('CalabVoiceGate.swift')).not.toMatch(/LiveKit|AudioManager|#if/);
    const [logic, bound] = read('CalabRoomAudio.swift').split('#if canImport(LiveKitClient)\n');
    expect(logic).not.toMatch(/AudioManager|Room\(|LocalAudioTrack/);
    expect(bound).toContain('AudioManager.shared');
  });
  it('subscribes nothing by itself and never logs credentials', () => {
    const source = read('CalabRoomAudio.swift');
    expect(source).toContain('ConnectOptions(autoSubscribe: false');
    expect(source).not.toMatch(/logger\.[a-z]+\([^\n]*(token|url|endpoint)/i);
    expect(source).not.toMatch(/URL\(string:[^\n]*\)!/);
    // Diagnostics: every public line goes through note(), and none carries a URL, token or identity.
    expect(source).not.toMatch(/note\([^\n]*(\.url|token|identity|endpoint|absoluteString|portName)/i);
    expect(source.match(/privacy: \.public/g)).toHaveLength(1);
    expect(read('CalabRoomAudioModule.swift')).not.toMatch(/calabRoomAudioLog[^\n]*(document|input\)|url|token)/);
  });
});
