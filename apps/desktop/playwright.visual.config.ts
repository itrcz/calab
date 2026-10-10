import { defineConfig, devices } from '@playwright/test';

// Visual regression + layout invariants + accessibility (docs/08, «Тесты дизайна»).
// Self-contained: starts the deterministic mock API (e2e-support/) and the production
// renderer from out/. Needs the dev LiveKit (pnpm infra:dev) for the voice/stream shots.
//   pnpm e2e:visual            — compare with the committed snapshots
//   pnpm e2e:visual:update     — re-record after an intended design change
// CALABA_VISUAL_OUT: separate result folders for parallel local runs.
// In a git worktree always run with its own mock port and LiveKit room prefix (README «Parallel
// visual runs»): CALABA_VISUAL_MOCK_PORT=39270 MOCK_LIVEKIT_ROOM_PREFIX=wt_ CALABA_VISUAL_OUT=test-results/wt
const OUT = process.env['CALABA_VISUAL_OUT'] ?? 'test-results/visual';

/**
 * screens.spec.ts: one project per configuration, one test per screen (named like its snapshot).
 *   -g "voice-camera-grid"                  every configuration that's active locally (dark-960)
 *   -g "voice-camera-grid" --project dark-960
 * Workers run screens in parallel, each with its own Electron app, mock port and LiveKit room
 * prefix (e2e-visual/app.ts). Default is 1 (never two Electron instances on the owner's machine);
 * CALABA_VISUAL_WORKERS can only raise it explicitly.
 *
 * Local default (owner, 26.09: «минимальный размер десктоп»): dark-960 only (the minimum window),
 * only the ~25 key screens (KEY in screens.spec.ts) and, from the misc project, only the web join
 * card. The other configurations (dark-1440, light-960, light-1440), every other screen, the focus
 * walk and the other web screens run only when CALABA_VISUAL_ALL=1 — nightly CI on Linux.
 */
const ALL_CONFIGS = process.env['CALABA_VISUAL_ALL'] === '1';
const CONFIGS = (
  [
    { name: 'dark-960', theme: 'dark', viewport: { width: 960, height: 600 } },
    { name: 'dark-1440', theme: 'dark', viewport: { width: 1440, height: 800 } },
    { name: 'light-960', theme: 'light', viewport: { width: 960, height: 600 } },
    { name: 'light-1440', theme: 'light', viewport: { width: 1440, height: 800 } },
  ] as const
).filter((c) => ALL_CONFIGS || c.name === 'dark-960');

/** The per-project options of e2e-visual/app.ts (kept here: the node tsconfig doesn't include e2e files). */
interface VisualOptions {
  theme: 'dark' | 'light';
  size: { width: number; height: number };
}

export default defineConfig<VisualOptions>({
  testDir: './e2e-visual',
  timeout: 120_000,
  // Default 1 (owner's machine: never two Electron instances at once); CALABA_VISUAL_WORKERS
  // can only raise it explicitly (a worktree run with its own port/prefix, see README).
  workers: Number(process.env['CALABA_VISUAL_WORKERS'] ?? 1),
  projects: [
    ...CONFIGS.map((c) => ({ name: c.name, testMatch: /screens\.spec\.ts/, use: { theme: c.theme, size: c.viewport } })),
    // Stream UX (docs/09 #17, #18): the minimal desktop size only (dark 960×600).
    { name: 'stream-dark-960', testMatch: /stream\.visual\.spec\.ts/, use: { theme: 'dark', size: { width: 960, height: 600 } } },
    // Member picker (docs/09 #33): the minimal desktop size only.
    { name: 'picker-dark-960', testMatch: /picker\.visual\.spec\.ts/, use: { theme: 'dark', size: { width: 960, height: 600 } } },
    // Text selection in the feed (issue #13): behaviour only, no screenshots.
    { name: 'selection', testMatch: /selection\.spec\.ts/ },
    // A dialog's «×» hit at its icon centre, clear of window drag regions (docs/09 #105): behaviour only.
    { name: 'modal-close', testMatch: /modal-close\.spec\.ts/, use: { theme: 'dark', size: { width: 960, height: 600 } } },
    // A mouse click leaves no focus outline, Tab shows the ring (docs/08 «Фокус», docs/09 #138): behaviour only.
    { name: 'focus-pointer', testMatch: /focus-pointer\.spec\.ts/, use: { theme: 'dark', size: { width: 960, height: 600 } } },
    // «Поздравить» → the greeting room with a ready mention (docs/09 #120): behaviour only.
    { name: 'birthday-congratulate', testMatch: /birthday-congratulate\.spec\.ts/, use: { theme: 'dark', size: { width: 1440, height: 800 } } },
    // The emoji picker's list scrolls in the composer and inside a modal sheet (docs/09 #118): behaviour only.
    { name: 'emoji-scroll', testMatch: /emoji-scroll\.spec\.ts/, use: { theme: 'dark', size: { width: 960, height: 600 } } },
    // After a restart for an update: back into the stored room (docs/09 #126): behaviour only.
    { name: 'resume-voice', testMatch: /resume-voice\.spec\.ts/ },
    // Deafen holds for late voices (docs/09 #70): behaviour only, web build + dev LiveKit.
    { name: 'deafen', testMatch: /deafen\.spec\.ts/ },
    // Calendar (ADR-0038, docs/20 (c)): create, drag, RSVP, reminders, zones, deep link — behaviour
    // only, the web build in Chromium in the Moscow zone.
    {
      name: 'calendar',
      testMatch: /calendar-[a-z-]+\.spec\.ts/,
      use: { browserName: 'chromium', timezoneId: 'Europe/Moscow', colorScheme: 'dark', viewport: { width: 1280, height: 800 } },
    },
    // Task boards (ADR-0042, docs/21): kanban, d&d, the panel, filter, views, list — behaviour
    // only, the web build in Chromium.
    {
      name: 'boards',
      testMatch: /boards-[a-z-]+\.spec\.ts/,
      use: { browserName: 'chromium', timezoneId: 'Europe/Moscow', colorScheme: 'dark', viewport: { width: 1280, height: 800 } },
    },
    { name: 'inline-buttons', testMatch: /inline-buttons\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 960, height: 600 } } },
    // A room switch never hangs in «Подключение…» (docs/09 #131): behaviour only, web build + dev LiveKit.
    { name: 'voice-switch', testMatch: /voice-switch\.spec\.ts/ },
    // Balance billing screens (ADR-0080, owner 10.10 allowed visual runs for them): the web build with
    // VITE_BILLING_MOCK=1 (`pnpm e2e:visual:billing`) in Chromium (desktop dark 960×600, light 960 for
    // the plan dialog) and WebKit on an iPhone 14 (390). The in-memory billing mock needs no server.
    { name: 'billing-dark-960', testMatch: /billing\.visual\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 960, height: 600 }, colorScheme: 'dark', timezoneId: 'Europe/Moscow' } },
    { name: 'billing-light-960', testMatch: /billing\.visual\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 960, height: 600 }, colorScheme: 'light', timezoneId: 'Europe/Moscow' } },
    {
      name: 'billing-phone-390',
      testMatch: /billing\.visual\.spec\.ts/,
      use: { ...devices['iPhone 14'], browserName: 'webkit', colorScheme: 'dark', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' },
    },
    // Focus walk and the web client's own screens (they start their own mock / app). Locally only
    // web.spec.ts, where everything but the dark-960 join card is skipped (see above).
    { name: 'misc', testMatch: ALL_CONFIGS ? /(focus|web)\.spec\.ts/ : /web\.spec\.ts/ },
  ],
  // Electron + LiveKit on one machine: one retry; a retried test is reported as «flaky».
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${OUT}-report` }]],
  outputDir: OUT,
  // Snapshots are per-OS (fonts/rendering differ); the committed baseline is macOS.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  // locale: web.spec.ts browsers show the Russian UI on any host (ADR-0022).
  use: { trace: 'retain-on-failure', locale: 'ru-RU', launchOptions: { args: ['--mute-audio'] } },
});
