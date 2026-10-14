import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { parseCallsState } from '../../desktop/src/shared/hostCalls';

const swiftAvailable = spawnSync('swiftc', ['--version']).status === 0;
it.skipIf(!swiftAvailable)('accepts every real Swift action timestamp through the strict shared parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calab-call-wire-'));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1790000000000);
  try {
    const binary = join(dir, 'fixture');
    execFileSync('swiftc', [
      fileURLToPath(new URL('../modules/calab-session-activity/ios/CalabCallReadiness.swift', import.meta.url)),
      fileURLToPath(new URL('../tests/CallWireFixture.swift', import.meta.url)), '-o', binary,
    ]);
    const state: unknown = JSON.parse(execFileSync(binary, { encoding: 'utf8' }));
    const parsed = parseCallsState(state);
    expect(parsed?.actions?.map(a => a.action)).toEqual(['ring', 'answer', 'end', 'mute', 'unmute']);
    expect(parsed?.actions?.every(a => a.expiresAt === 1790000010123)).toBe(true);
  } finally {
    clock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000); // cold swiftc on CI runners takes ~30 s+
