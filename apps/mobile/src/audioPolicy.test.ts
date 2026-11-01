import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const swiftAvailable = spawnSync('swiftc', ['--version']).status === 0;
const native = (name: string) => fileURLToPath(new URL(`../modules/calab-session-activity/ios/${name}`, import.meta.url));
const test = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));
const owner = [native('CalabAudioSessionPolicy.swift'), native('CalabAudioOwner.swift'), native('CalabAudioProbe.swift'), test('AudioOwnerTests.swift')];

function withBinary<T>(sources: string[], flags: string[], run: (binary: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'calab-audio-policy-'));
  try {
    const binary = join(dir, 'fixture');
    execFileSync('swiftc', [...flags, ...sources, '-o', binary]);
    return run(binary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!swiftAvailable)('native audio policy', () => {
  it('runs the session policy state machine in actual Swift', () => {
    const result = withBinary([native('CalabAudioSessionPolicy.swift'), test('AudioSessionPolicyTests.swift')], [], binary => execFileSync(binary, { encoding: 'utf8' }));
    expect(result).toContain('PASS: category, mode, options and ducking per state');
    expect(result).toContain('PASS: activation precedes the engine and leave notifies other apps');
    expect(result).toContain('PASS: interruptions reactivate, and the microphone follows the phone call rule');
    expect(result).toContain('PASS: only real drift re-applies the configuration');
    expect(result).toContain('PASS: media reset rebuilds now or after the interruption, else fails');
    expect(result).toContain('PASS: foreground verifies the session and retries a lost interruption end');
    expect(result).toContain('PASS: capture starts only in foreground and a revoked grant stops it');
    expect(result).toContain('PASS: the room yields to a call and leaves its session alone');
  }, 180_000);

  it('runs the engine owner and compiles the probe out without DEBUG', () => {
    const release = withBinary(owner, [], binary => ({ output: execFileSync(binary, { encoding: 'utf8' }), symbols: execFileSync('nm', [binary], { encoding: 'utf8', maxBuffer: 1 << 26 }) }));
    expect(release.output).toContain('PASS: mute mode, ducking and processing are set per owner');
    expect(release.output).toContain('PASS: the call takes the engine synchronously and the room resumes after it');
    expect(release.output).toContain('PASS: late callbacks of a yielded or superseded lease change nothing');
    expect(release.output).toContain('PASS: a stuck profile fails the room and never the call');
    expect(release.output).not.toContain('probe');
    expect(release.symbols).not.toContain('AudioProbe');
  }, 180_000);

  it('starts the probe only from its launch argument in a DEBUG build', () => {
    const debug = withBinary(owner, ['-D', 'DEBUG'], binary => ({ output: execFileSync(binary, { encoding: 'utf8' }), symbols: execFileSync('nm', [binary], { encoding: 'utf8', maxBuffer: 1 << 26 }) }));
    expect(debug.output).toContain('PASS: probe starts only from its launch argument');
    expect(debug.symbols).toContain('AudioProbe');
  }, 180_000);
});

describe('native audio boundaries', () => {
  const read = (name: string) => readFileSync(native(name), 'utf8');
  it('keeps LiveKit out of the logic the harness runs', () => {
    expect(read('CalabAudioSessionPolicy.swift')).not.toMatch(/LiveKit|AudioManager/);
    const [logic, bound] = read('CalabAudioOwner.swift').split('#if canImport(LiveKitClient)\n');
    expect(logic).not.toContain('AudioManager.shared.');
    expect(bound).toContain('AudioManager.shared');
  });
  it('wraps the whole probe in DEBUG, including its one call site', () => {
    const probe = read('CalabAudioProbe.swift').trim().split('\n');
    expect(probe[1]).toBe('#if DEBUG');
    expect(probe.slice(-2)).toEqual(['#endif', '#endif']);
    const calls = read('CalabIncomingCallsModule.swift');
    const call = calls.indexOf('CalabAudioProbe.startIfRequested()');
    expect(calls.lastIndexOf('#if DEBUG && (canImport(LiveKitClient) || canImport(LiveKit))', call)).toBeGreaterThan(calls.lastIndexOf('#endif', call));
  });
});
