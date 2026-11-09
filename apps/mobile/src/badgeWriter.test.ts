import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(spawnSync('swiftc', ['--version']).status !== 0)('serializes actual Swift badge writes across logout and rejects invalid counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calab-badge-swift-'));
  try {
    const binary = join(dir, 'test');
    execFileSync('swiftc', ['modules/calab-session-activity/ios/CalabBadgeWriter.swift', 'tests/badge-writer.swift', '-o', binary]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('zero clears');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
