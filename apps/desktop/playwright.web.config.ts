import { defineConfig, devices } from '@playwright/test';

// Web client E2E (ADR-0015). Needs dist-web served same-origin with the API:
//   CALABA_WEB_PROXY=http://127.0.0.1:3000 pnpm preview:web   (or the stand)
//   CALABA_WEB_URL=http://localhost:4173 pnpm e2e:web
// The API must list that origin in PUBLIC_APP_URL (CSRF / cookie checks).
export default defineConfig({
  testDir: './e2e-web',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  // locale: the Russian UI on any host (ADR-0022: «as in the system» reads navigator.languages).
  use: { baseURL: process.env['CALABA_WEB_URL'] ?? 'http://localhost:4173', locale: 'ru-RU', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile\.web\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // Full Chromium in new headless mode: the default headless shell has no notifications at
        // all (Notification.permission is always «denied»), unlike a real Chrome.
        channel: 'chromium',
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] },
      },
    },
    {
      name: 'firefox',
      testIgnore: /mobile\.web\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
        },
      },
    },
    // Phone layout (ADR-0021): mobile.web.spec.ts only — self-contained (mock API + dist-web), in
    // Chromium with the phone's viewport, touch, DPR and UA (fake media: the voice path end to end)…
    ...(['iPhone 14', 'Pixel 7'] as const).map((device) => ({
      name: device.toLowerCase().replace(' ', '-'),
      testMatch: /mobile\.web\.spec\.ts/,
      use: {
        ...devices[device],
        // The screen slide (ScreenTransition) is off: every tap lands on the final screen.
        reducedMotion: 'reduce' as const,
        browserName: 'chromium' as const,
        channel: 'chromium',
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] },
      },
    })),
    // …and in WebKit, the engine of iOS Safari (no fake microphone there: voice joins listen-only).
    ...(['iPhone 14', 'iPhone SE (3rd gen)'] as const).map((device) => ({
      name: `webkit-${device.toLowerCase().replace(/[()]/g, '').replace(/ /g, '-')}`,
      testMatch: /mobile\.web\.spec\.ts/,
      use: { ...devices[device], reducedMotion: 'reduce' as const, browserName: 'webkit' as const },
    })),
  ],
});
