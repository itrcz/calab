import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const swiftAvailable = spawnSync('swiftc', ['--version']).status === 0;
const native = (name: string) => fileURLToPath(new URL(`../modules/calab-session-activity/ios/${name}`, import.meta.url));
const test = (name: string) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url));

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
});

describe('native room driver boundaries', () => {
  const read = (name: string) => readFileSync(native(name), 'utf8');
  it('keeps the gate outside the SDK', () => {
    expect(read('CalabVoiceGate.swift')).not.toMatch(/LiveKit|AudioManager|#if/);
  });
});
