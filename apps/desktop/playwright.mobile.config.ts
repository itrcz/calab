import { defineConfig, devices } from '@playwright/test';

/**
 * Mobile web visual tests (ADR-0021, docs/08 «Тесты дизайна»): e2e-visual/mobile.visual.spec.ts in
 * Playwright's WebKit (the Safari engine) with the iPhone descriptors — viewport, DPR, touch, UA.
 * Self-contained: the production web build (dist-web) served same-origin by the mock API; the
 * voice screens need the dev LiveKit (pnpm infra:dev).
 *   pnpm e2e:visual:mobile            — compare with the committed snapshots (+ layout invariants, axe)
 *   pnpm e2e:visual:mobile:update     — re-record after an intended design change
 * Snapshots: iPhone 14 (390 px, dark) only, in __screenshots__/webkit-iphone/. iPhone SE (375) and
 * 14 Pro Max (430) run the same screens for the layout invariants and axe, without screenshots.
 * CALABA_MOBILE_SHOTS=<dir> also saves every screen of every device there (review, not a baseline).
 */
const OUT = process.env['CALABA_VISUAL_OUT'] ?? 'test-results/visual-mobile';
const PHONES = [
  { name: 'webkit-iphone-14', device: 'iPhone 14' },
  { name: 'webkit-iphone-se', device: 'iPhone SE (3rd gen)' },
  { name: 'webkit-iphone-14-pro-max', device: 'iPhone 14 Pro Max' },
] as const;

export default defineConfig({
  testDir: './e2e-visual',
  testMatch: /mobile\.visual\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${OUT}-report` }]],
  outputDir: OUT,
  // One engine, one device: the baseline is the same on any host with this Playwright WebKit build.
  snapshotPathTemplate: '{testDir}/__screenshots__/webkit-iphone/{arg}{ext}',
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: { trace: 'retain-on-failure', locale: 'ru-RU', timezoneId: 'Europe/Moscow', colorScheme: 'dark', reducedMotion: 'reduce' },
  projects: PHONES.map((p) => ({ name: p.name, use: { ...devices[p.device], browserName: 'webkit' as const } })),
});
