import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';

/**
 * The Android manifest contributions without an Android SDK (board #141): `expo prebuild` writes the
 * app manifest from app.config.ts, gradle merges the module's manifest into it.
 */
const moduleManifest = readFileSync(fileURLToPath(new URL('../modules/calab-session-activity/android/src/main/AndroidManifest.xml', import.meta.url)), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_CALAB_URL', 'https://calab.example.com');
});

it('declares a not exported microphone foreground service with its permissions, and no phoneCall type', () => {
  const service = /<service\s+android:name="io\.calab\.host\.CalabMediaSessionService"[^>]*\/>/.exec(moduleManifest)?.[0] ?? '';
  expect(service).toContain('android:exported="false"');
  expect(service).toContain('android:foregroundServiceType="microphone"');
  for (const permission of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE', 'POST_NOTIFICATIONS'])
    expect(moduleManifest).toContain(`<uses-permission android:name="android.permission.${permission}" />`);
  expect(moduleManifest).not.toMatch(/phoneCall|FOREGROUND_SERVICE_PHONE_CALL|MANAGE_OWN_CALLS|USE_FULL_SCREEN_INTENT/);
});

it('keeps what the WebView needs and removes unused template permissions', async () => {
  const { default: config } = await import('../app.config');
  expect(config.android?.permissions).toEqual(['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'CAMERA', 'POST_NOTIFICATIONS']);
  expect(config.android?.blockedPermissions).toEqual(['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW']);
});
