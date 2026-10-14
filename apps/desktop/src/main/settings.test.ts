import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = { path: '' };

vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: false, setLoginItemSettings: () => undefined },
}));

/** A fresh module per test: settings.ts caches the file it read. */
async function load(): Promise<typeof import('./settings')> {
  vi.resetModules();
  return import('./settings');
}

describe('app settings: «Источник обновлений» (owner 12.10)', () => {
  beforeEach(() => {
    dir.path = mkdtempSync(join(tmpdir(), 'calab-settings-'));
  });
  afterEach(() => {
    rmSync(dir.path, { recursive: true, force: true });
  });

  it('first run → github', async () => {
    const { getSettings } = await load();
    expect(getSettings().updateChannel).toBe('github');
  });

  it('a file from before the setting (no key) → github, other values kept', async () => {
    writeFileSync(join(dir.path, 'settings.json'), JSON.stringify({ serverUrl: 'https://app.calab.io', autoUpdate: false }));
    const { getSettings } = await load();
    expect(getSettings()).toMatchObject({ updateChannel: 'github', autoUpdate: false, serverUrl: 'https://app.calab.io' });
  });

  it('a saved s3 stays s3; an unknown / hand-edited value → github', async () => {
    writeFileSync(join(dir.path, 'settings.json'), JSON.stringify({ updateChannel: 's3' }));
    expect((await load()).getSettings().updateChannel).toBe('s3');
    writeFileSync(join(dir.path, 'settings.json'), JSON.stringify({ updateChannel: 'https://evil.example/' }));
    expect((await load()).getSettings().updateChannel).toBe('github');
  });

  it('the choice is persisted', async () => {
    const { updateSettings } = await load();
    updateSettings({ updateChannel: 's3' });
    expect(JSON.parse(readFileSync(join(dir.path, 'settings.json'), 'utf8'))).toMatchObject({ updateChannel: 's3' });
    expect((await load()).getSettings().updateChannel).toBe('s3');
  });
});
