/**
 * In-call re-render profiler (docs/14-energy.md «Ререндеры в звонке», docs/09 #60). Launches the
 * built renderer (apps/desktop/out) against the mock API + the dev LiveKit (`pnpm infra:dev`),
 * joins «Созвон» with a silent fake mic, opens «общий» (30 messages) with the members column,
 * 5 members online, 2 in voice, and replays live events like production for `--seconds`:
 * presence change every 5 s, typing every 4 s, a voice state change every 10 s, and with
 * `--speaker` a second LiveKit participant whose fake mic beeps every second (speaking rings);
 * the call timer, the echo/level tick, the mic level reports and getStats run for real.
 *
 * Prints JSON: commits/s, React render ms/s (selfBaseDuration), top components by time and by
 * count, what woke each one (parent / props / hook index / context) and which components
 * started the commits. `--bench C|E` then keeps the scenario running and samples CPU with
 * tools/energy-bench.py (E adds a remote 720p camera; `--popover` also shows the camera grid of
 * the call's room with its notification menu open over the tile) together with WindowServer (the macOS compositor).
 *
 *   CALABA_RENDERER_MINIFY=0 CALABA_REACT_PROFILING=1 pnpm -F @calaba/desktop build:app
 *   npx tsx tools/perf-call.ts [--port 39461] [--seconds 30] [--speaker] [--cpu] [--timeline] [--no-stats] [--no-emulate]
 *   npx tsx tools/perf-call.ts --seconds 0 --bench C --bench-seconds 90 --name after   # CPU of all app processes
 *   npx tsx tools/perf-call.ts --seconds 0 --no-emulate --no-stats --recording --bench C --bench-seconds 90 --name rec-after
 *
 * `--calendar`: the day view (ADR-0038) open during the call (members column beside it); run ≥ 70 s so
 * the «now» line's minute tick falls inside the window. `--findtime`: «Подобрать время» (ADR-0041)
 * with Борис and Вера instead — BusyColumn / FreeOverlay must stay out of the voice / presence commits.
 *
 * `--boards`: the kanban (ADR-0042) open during the call; Борис renames CAL-2 every 3 s (TASK_UPDATE to
 * the board): one TaskCard per event should render.
 *
 * `--dm-call`: a one-to-one call instead (ADR-0034): Борис calls, I accept in his DM (open, with the
 * «Звонок · 00:42» header timer and the island); the same live events, typing and the voice state
 * in that DM.
 *
 * `--bench K --bg none|blur-light|blur-strong|image`: my own camera 720p15 (Chromium's fake device)
 * turned on through «Проверьте камеру» with that background (ADR-0035, docs/14 «Фон камеры»).
 * Nobody subscribes, so dynacast pauses every layer within seconds: that is the camera without an
 * encoder. `--viewer` adds a subscriber at the top layer (all layers encode, like in a call) and
 * waits 30 s for bandwidth estimation. The encoder (implementation, fps per layer) is printed before
 * and after the run: check that both variants being compared encode the same.
 *
 * `--fx touchup|lowlight|touchup+lowlight` (K) also turns on «Улучшить внешность» (strength 40) /
 * «Низкая освещённость» in the same sheet; the scenario name gets `-fx-<fx>`. `--fake-video <y4m>`: the
 * fake camera plays a file instead (a dark room: the low-light curve is on).
 *
 * `--bench F --content static|moving [--source window|screen] [--preset 720|1080] [--hint detail|motion]`:
 * I stream my screen (docs/14 «Стрим экрана: захват»), real capture (ScreenCaptureKit, no fake
 * device for video): `window` (default) shares a Chromium window this script opens — a code
 * editor page that stays still (`static`) or scrolls 30 times a second (`moving`) — so the content
 * is the same on every run; `screen` shares the whole main display as it is. A viewer watches the
 * top layer (`--viewer` is implied). Needs Screen Recording for the terminal that runs it (TCC
 * attributes a child Electron to it). Capture / encoder rates are printed before and after the run.
 * Knobs: `--no-viewer` (encoder paused by dynacast), `--hide` (app window hidden), `--fps N`
 * (frame rate lowered after publishing), `--overlay` (annotation overlay open), `--content-size WxH`,
 * `--window-name <regex>` (share another window). It opens a visible window: not on a machine
 * someone is using (docs/14 «Стрим экрана: захват»).
 *
 * `--bench G --cameras N [--view gallery|speaker] [--window 1920x1080] [--cam-res 720|360]`: the call
 * view with N remote cameras (ADR-0066 §4, docs/14 «Галерея: N камер»). N synthetic participants
 * `perfcam0…` join «Созвон» from one headless Chromium (one page each, fake camera, simulcast),
 * the app's window is resized (the gallery page size follows it: 1440×900 → 16, 1920×1080 → 25),
 * the call view opens in the gallery (or the speaker view) and, after 20 s for subscriptions and
 * bandwidth estimation, the decoded <video> sizes are printed. The publishers cost CPU too, outside
 * the app's processes: on a laptop 25 × 720p publishers load several cores — run on a quiet machine.
 *
 * `--musician` (C): «Режим музыканта» on (ADR-0052): the mic without AEC / NS / AGC, open (no VAD
 * gate), Opus 128 kbps without DTX; the scenario name gets `-musician` and the mic's outgoing
 * kbps / fmtp are printed before and after the run (docs/14 «Режим музыканта»).
 *
 * `--recording`: «Созвон» is being recorded (ROOM_RECORDING, Борис 12:34 ago) — the REC dot on the
 * card, the «Запись» pill in the island (docs/09 #64). A bench also samples WindowServer: the
 * compositor redraws blurred surfaces under an animated layer there, not in the app.
 *
 * Heavy for the machine: run it under `nice -n 19`, one run at a time.
 *
 * One test Electron at a time (CLAUDE.md «Визуальные тесты»): check `pgrep -fl "playwright|out/main"` first.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';
import { PresenceStatus } from '../packages/protocol/src/gen/calaba/v1/gateway_pb';
import { IDS } from '../apps/desktop/e2e-support/fixtures';
import { livekitRoomPrefix, startMockServer } from '../apps/desktop/e2e-support/mock-server';

const argv = process.argv;
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? (argv[i + 1] ?? def) : def;
};
const PORT = Number(opt('port', '39461'));
const SECONDS = Number(opt('seconds', '30'));
const BENCH = opt('bench', '');
const BENCH_SECONDS = Number(opt('bench-seconds', '120'));
/** `--bench K`: my own camera 720p15 (Chromium's fake device) with `--bg none|blur-light|blur-strong|image` (ADR-0035). */
const BG = opt('bg', 'none');
/** `--fx touchup|lowlight|touchup+lowlight` (K): the camera's «Внешний вид» switches (ADR-0035 addendum). */
const FX = opt('fx', '');
/** `--fake-video <file.y4m>` (K): the fake camera plays this file (e.g. a dark room for «Низкая освещённость»). */
const FAKE_VIDEO = opt('fake-video', '');
const NAME = opt('name', 'run');
const STATS = !argv.includes('--no-stats');
const EMULATE = !argv.includes('--no-emulate');
const CPU = argv.includes('--cpu');
const SPEAKER = argv.includes('--speaker');
const POPOVER = argv.includes('--popover');
const RECORDING = argv.includes('--recording');
const DM_CALL = argv.includes('--dm-call');
/** `--musician` (C): musician mode on (ADR-0052). */
const MUSICIAN = argv.includes('--musician');
/** `--calendar`: in the call, the day view (ADR-0038) is open instead of «общий» — its «now» line ticks once a minute. */
/** `--findtime`: «Подобрать время» (ADR-0041) open instead, with Борис and Вера: the busy columns must not re-render on voice / presence. */
const FINDTIME = argv.includes('--findtime');
const CALENDAR = argv.includes('--calendar') || FINDTIME;
/** `--boards`: the kanban (ADR-0042) open during the call; another user renames a task every 3 s (TASK_UPDATE). */
const BOARDS = argv.includes('--boards');
/** `--viewer` (K): a second participant watches my camera at full size, so the encoder runs (dynacast). */
const VIEWER = argv.includes('--viewer') || BENCH === 'F';
/** F: what the stream shows — a still code page or one scrolling 30×/s. */
const CONTENT = opt('content', 'static');
/** F: a window of this script (controlled content) or the whole main display. */
const SOURCE = opt('source', 'window');
/** F: the stream preset (720 / 1080) and the content hint (the picker's «Текст» / «Видео»). */
const PRESET = opt('preset', '1080');
const HINT = opt('hint', 'detail');
/** F `--source window`: share another window by its name instead (e.g. a Finder window). */
const WINDOW_NAME = opt('window-name', '');
/** G: remote cameras, the call view, the window's content size, the publishers' capture. */
const CAMERAS = Number(opt('cameras', '9'));
const VIEW = opt('view', 'gallery');
const WINDOW_SIZE = opt('window', '1440x900').split('x').map(Number) as [number, number];
const CAM_RES = opt('cam-res', '720');
const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = resolve(ROOT, 'apps/desktop');
process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ||= `perfcall${PORT}_`;

/** Injected before the renderer: a React DevTools hook that attributes every commit. */
const INIT = () => {
  type F = {
    tag: number;
    flags: number;
    type: unknown;
    child: F | null;
    sibling: F | null;
    return: F | null;
    alternate: F | null;
    memoizedProps: Record<string, unknown> | null;
    memoizedState: H;
    dependencies: { firstContext: unknown } | null;
    selfBaseDuration?: number;
    actualDuration?: number;
  };
  type H = { memoizedState: unknown; next: H } | null;
  const st = {
    on: false,
    commits: 0,
    commitMs: 0,
    renders: {} as Record<string, number>,
    selfMs: {} as Record<string, number>,
    why: {} as Record<string, number>,
    origin: {} as Record<string, number>,
    sample: {} as Record<string, string>,
    mounts: {} as Record<string, number>,
    originCommits: {} as Record<string, number>,
    timeline: [] as string[],
  };
  (window as unknown as Record<string, unknown>)['__perf'] = st;
  const COMP = [0, 1, 11, 14, 15];
  const mark = new WeakMap<object, number>();
  let n = 0;
  const nameOf = (f: F): string | null => {
    const t = f.type as { displayName?: string; name?: string; render?: { name?: string; displayName?: string }; type?: { name?: string; displayName?: string } } | null;
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || 'anon';
    if (typeof t === 'object') return t.displayName || (t.render ? t.render.displayName || t.render.name || 'anon' : t.type ? t.type.displayName || t.type.name || 'anon' : null);
    return null;
  };
  const brief = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return String(v).slice(0, 40);
    if (Array.isArray(v)) return `array(${v.length})`;
    return `{${Object.keys(v).slice(0, 4).join(',')}}`;
  };
  const renderedComp = (f: F | null): boolean => !!f && COMP.includes(f.tag) && (f.flags & 1) !== 0 && mark.get(f) === n;
  (window as unknown as Record<string, unknown>)['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r: unknown) {
      const m = this.renderers as Map<number, unknown>;
      m.set(m.size + 1, r);
      return m.size;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: F }) {
      n++;
      // Pass 1: the fibers this commit touched. Like React DevTools (didFiberRender), a subtree
      // whose child list is the very one of the previous tree (`child === alternate.child`) was
      // not cloned: nothing in it rendered, and its fibers keep stale PerformedWork flags from
      // older renders, so it is not descended into. A cloned fiber that bailed out has its flags
      // reset; one that rendered (or mounted) carries PerformedWork (1).
      const done: F[] = [];
      const stack: F[] = [root.current];
      while (stack.length) {
        const f = stack.pop() as F;
        mark.set(f, n);
        if (COMP.includes(f.tag) && f.flags & 1) done.push(f);
        if (f.sibling && f !== root.current) stack.push(f.sibling);
        if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
      }
      if (!st.on) return;
      st.commits++;
      st.commitMs += root.current.actualDuration ?? 0;
      const woke = new Set<string>();
      const wokeWhy = new Set<string>();
      for (const f of done) {
        const k = nameOf(f);
        if (!k) continue;
        st.renders[k] = (st.renders[k] ?? 0) + 1;
        st.selfMs[k] = (st.selfMs[k] ?? 0) + (f.selfBaseDuration ?? 0);
        let p = f.return;
        while (p && !COMP.includes(p.tag)) p = p.return;
        const parent = renderedComp(p);
        const alt = f.alternate;
        const why: string[] = [];
        if (!alt) {
          why.push('mount');
          // The top of a mounted subtree: its parent component already existed.
          if (p?.alternate) {
            const mk = `${nameOf(p)} > ${k}`;
            st.mounts[mk] = (st.mounts[mk] ?? 0) + 1;
          }
        }
        else {
          const cur = f.memoizedProps ?? {};
          const old = alt.memoizedProps ?? {};
          const changed = Object.keys(cur).filter((x) => cur[x] !== old[x]);
          if (changed.length) why.push(`props:${changed.slice(0, 5).join(',')}`);
          let h1 = f.memoizedState;
          let h2 = alt.memoizedState;
          if (f.tag !== 1) {
            for (let i = 0; h1 && h2 && i < 60; i++, h1 = h1.next, h2 = h2.next) {
              const v = h1.memoizedState;
              if (v === h2.memoizedState) continue;
              // Effects get a new object every render and memo/callback [value, deps] follow
              // their deps: neither is a cause. State / store snapshots are.
              if (v && typeof v === 'object' && 'create' in v && 'deps' in v) continue;
              if (Array.isArray(v) && v.length === 2 && (Array.isArray(v[1]) || v[1] === null)) continue;
              why.push(`hook${i}`);
              const sk = `${k}:hook${i}`;
              const o = h2.memoizedState;
              const diff =
                v && o && typeof v === 'object' && typeof o === 'object' && !Array.isArray(v)
                  ? ` Δ${Object.keys(v).filter((x) => (v as Record<string, unknown>)[x] !== (o as Record<string, unknown>)[x]).join('+')}`
                  : ` was ${brief(o)}`;
              st.sample[sk] = brief(v) + diff;
            }
          }
          if (!why.length) why.push(parent ? 'parent(same props)' : 'context/force');
        }
        const wk = `${k} ← ${why.join('|')}`;
        st.why[wk] = (st.why[wk] ?? 0) + 1;
        // Where the update started: a rendered component whose parent component didn't render.
        if (!parent && alt) {
          st.origin[k] = (st.origin[k] ?? 0) + 1;
          woke.add(k);
          wokeWhy.add(`${k}:${why.join('|')}`);
        }
      }
      for (const k of woke) st.originCommits[k] = (st.originCommits[k] ?? 0) + 1;
      if (st.timeline.length < 400) st.timeline.push(`${Math.round(performance.now())} ${done.length} ${[...wokeWhy].slice(0, 8).join(' ; ')}`);
    },
  };
};

interface Perf {
  on: boolean;
  commits: number;
  commitMs: number;
  renders: Record<string, number>;
  selfMs: Record<string, number>;
  why: Record<string, number>;
  origin: Record<string, number>;
  sample: Record<string, string>;
  mounts: Record<string, number>;
  originCommits: Record<string, number>;
  timeline: string[];
}

/** 10 s of −70 dBFS white noise, 48 kHz mono 16-bit (Chromium loops the fake capture file). */
function silentWav(path: string): void {
  const rate = 48_000;
  const samples = rate * 10;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  const amp = 32767 * 10 ** (-70 / 20) * Math.sqrt(3);
  let seed = 1;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    b.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * amp), 44 + i * 2);
  }
  writeFileSync(path, b);
}

/** K `--viewer`: subscribes to every video in the room at the top layer and plays it (a 1280×720 element). */
async function startViewer(roomId: string): Promise<Browser> {
  const at = new AccessToken(process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey', process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret', { identity: 'bench-viewer', name: 'viewer', ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${roomId}`, canPublish: false, canSubscribe: true });
  const token = await at.toJwt();
  const browser = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 } });
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      room.on(LK.RoomEvent.TrackSubscribed, (track, pub) => {
        if (track.kind !== 'video') return;
        (pub as import('livekit-client').RemoteTrackPublication).setVideoQuality(LK.VideoQuality.HIGH);
        const el = track.attach() as HTMLVideoElement;
        el.style.width = '1280px';
        el.style.height = '720px';
        document.body.appendChild(el);
      });
      await room.connect(url, token);
    },
    { url: process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880', token },
  );
  return browser;
}

/**
 * A second participant publishing Chromium's fake devices: the microphone (a beep every second)
 * or a 720p camera (a moving test pattern). No named functions inside `evaluate` (tsx would wrap
 * them in its `__name` helper, which the page does not have).
 */
async function startSpeaker(origin: string, userId: string, name: string, roomId: string, source: 'mic' | 'camera' = 'mic'): Promise<Browser> {
  const at = new AccessToken(process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey', process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret', { identity: `${userId}:${source === 'mic' ? 'speaker' : 'camera'}`, name, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${roomId}`, canPublish: true, canSubscribe: false });
  const token = await at.toJwt();
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const page = await browser.newPage();
  // A secure context for getUserMedia: any page of the mock (localhost), not about:blank.
  await page.goto(`${origin}/__mock/ids`);
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token, camera }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const room = new LK.Room();
      await room.connect(url, token);
      if (camera) await room.localParticipant.setCameraEnabled(true, { resolution: LK.VideoPresets.h720.resolution });
      else await room.localParticipant.setMicrophoneEnabled(true);
    },
    { url: process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880', token, camera: source === 'camera' },
  );
  return browser;
}

/**
 * G: `n` participants `perfcam0…` publishing Chromium's fake camera (a moving test pattern) into
 * `roomId`, one page each in one headless browser. Same rules as startSpeaker (no named functions
 * inside `evaluate`).
 */
async function startCameras(origin: string, n: number, roomId: string, res: string): Promise<Browser> {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const umd = createRequire(import.meta.url).resolve('livekit-client').replace(/[^/]+$/, 'livekit-client.umd.js');
  for (let i = 0; i < n; i++) {
    const at = new AccessToken(process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey', process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret', { identity: `perfcam${i}:camera`, name: `Камера ${i + 1}`, ttl: '30m' });
    at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${roomId}`, canPublish: true, canSubscribe: false });
    const token = await at.toJwt();
    const page = await browser.newPage();
    await page.goto(`${origin}/__mock/ids`);
    await page.addScriptTag({ path: umd });
    await page.evaluate(
      async ({ url, token, res }) => {
        const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
        const room = new LK.Room({ dynacast: true });
        await room.connect(url, token);
        await room.localParticipant.setCameraEnabled(true, { resolution: (res === '360' ? LK.VideoPresets.h360 : LK.VideoPresets.h720).resolution }, { simulcast: true });
      },
      { url: process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880', token, res },
    );
  }
  return browser;
}

const CONTENT_TITLE = 'Calab bench content';

/**
 * F: a code editor page in a Chromium window of its own (1280×800, dark, monospace): still, or
 * scrolled by 4 px 30 times a second (`moving`). Occluded windows keep painting (Playwright's
 * `--disable-backgrounding-occluded-windows`), so the app window may cover it.
 */
async function openContent(moving: boolean): Promise<Browser> {
  // `--content-size WxH`: another window size (points), e.g. one whose capture needs H.264 alignment.
  const browser = await chromium.launch({ headless: false, args: ['--mute-audio', '--window-position=40,40', `--window-size=${opt('content-size', '1280x800').replace('x', ',')}`] });
  const page = await browser.newPage({ viewport: null });
  const lines = Array.from({ length: 400 }, (_, i) => {
    const n = String(i + 1).padStart(4, ' ');
    const code = ['func handle(w http.ResponseWriter, r *http.Request) {', '\tctx := r.Context()', '\tuser, err := auth.FromContext(ctx)', '\tif err != nil {', '\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)', '\t\treturn', '\t}', '\trows, err := db.Query(ctx, `SELECT id, name FROM rooms WHERE ws = $1`, user.WS)', '}', ''][i % 10];
    return `<div><span style="color:#6e7681">${n}</span>  ${code.replace(/</g, '&lt;')}</div>`;
  }).join('');
  await page.setContent(
    `<!doctype html><title>${CONTENT_TITLE}</title><style>html,body{margin:0;height:100%;background:#1e1f22;color:#d4d4d8;font:14px/20px Menlo,monospace}#s{height:100%;overflow:hidden;white-space:pre;padding:8px 16px}</style><div id="s">${lines}</div>` +
      (moving ? `<script>const s=document.getElementById('s');setInterval(()=>{s.scrollTop=(s.scrollTop+4)%(s.scrollHeight-s.clientHeight)},33)</script>` : ''),
  );
  return browser;
}

async function launch(url: string, userData: string, wav: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // K: the fake camera delivers GPU buffers like a real macOS camera (IOSurface, zero-copy capture);
    // without it every frame is copied from CPU memory into WebGL and the background looks dearer.
    args: ['.', '--lang=ru', '--mute-audio', `--use-file-for-fake-audio-capture=${wav}`, '--disable-features=AudioServiceOutOfProcess', ...(BENCH === 'K' ? ['--video-capture-use-gpu-memory-buffer'] : []), ...(FAKE_VIDEO ? [`--use-file-for-fake-video-capture=${FAKE_VIDEO}`] : [])],
    cwd: DESKTOP,
    env: { ...process.env, CALABA_SERVER_URL: url, CALABA_USER_DATA: userData, CALABA_MULTI_INSTANCE: '1', CALABA_FAKE_MEDIA: '1', ELECTRON_RENDERER_URL: '', LANG: 'ru_RU.UTF-8', ...(BENCH === 'F' ? { CALABA_REAL_SCREEN: '1' } : {}) },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1280, 800);
    w?.setIgnoreMouseEvents(true);
  });
  return { app, page };
}

const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

async function main(): Promise<void> {
  const mock = await startMockServer({ port: PORT, scenario: 'data', quiet: true } as never);
  const userData = mkdtempSync(join(tmpdir(), 'calaba-perfcall-'));
  const wav = join(userData, 'silence.wav');
  silentWav(wav);
  const timers: NodeJS.Timeout[] = [];
  let publisher: Browser | null = null;
  let speaker: Browser | null = null;
  let viewer: Browser | null = null;
  let content: Browser | null = null;
  let app: ElectronApplication | null = null;
  try {
    // Sign in once, then relaunch with the hook installed from the first script.
    {
      const l = await launch(mock.url, userData, wav);
      const p = l.page;
      // F: the stream preset and content hint the picker starts with.
      const stream = BENCH === 'F' ? { streamPreset: PRESET === 'eco' ? 1 : PRESET === '720' ? 2 : 3, contentHint: HINT } : {};
      await p.evaluate(({ stats, stream }) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru', devStats: stats, ...stream }, version: 1 })), { stats: STATS, stream });
      await p.reload();
      await p.getByLabel('Email').fill('owner@calaba.test');
      await p.getByLabel('Пароль', { exact: true }).fill('password123');
      await p.getByRole('button', { name: 'Войти', exact: true }).click();
      await p.locator('aside').first().waitFor({ timeout: 30_000 });
      await p.waitForTimeout(1000);
      await l.app.close();
    }
    const l = await launch(mock.url, userData, wav);
    app = l.app;
    const page = l.page;
    const cdp = await page.context().newCDPSession(page);
    // The profiler hook only for a profile: a CPU bench (--seconds 0) measures the app as shipped.
    if (SECONDS > 0) {
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `var __name = (f) => f; (${INIT.toString()})()` });
      await page.reload();
    }
    // K / F / C: keep the peer connections reachable, to report what the encoder / the mic really does.
    if (BENCH === 'K' || BENCH === 'F' || BENCH === 'C') {
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => { const P = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new P(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = P.prototype; })()`,
      });
      await page.reload();
    }
    const aside = page.locator('aside').first();
    await aside.waitFor({ timeout: 30_000 });

    // The scene: Vera leaves «Переговорка», Борис is in «Созвон» (unmuted) with me; 5 online.
    mock.setVoiceState({ userId: IDS.users.vera, roomId: '' });
    mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: false });
    for (const u of [IDS.users.boris, IDS.users.vera, IDS.users.grigory, IDS.users.dina]) mock.setPresence(u, PresenceStatus.ONLINE);
    for (let i = 0; i < 5; i++) mock.injectMessage({ roomId: IDS.rooms.general, authorId: i % 2 ? IDS.users.vera : IDS.users.boris, content: `perf call message ${i}` });
    if (DM_CALL) {
      // ADR-0034: Борис's DM open, he calls, I accept — the call's voice session in the DM.
      mock.setVoiceState({ userId: IDS.users.boris, roomId: '' });
      await page.getByTestId('rail-home').getByRole('button').click();
      await page.getByTestId('dm-list').getByRole('button', { name: /Борис Петров/ }).click();
      await page.getByTestId('dm-header').waitFor();
      mock.ringCall(IDS.users.boris, IDS.users.anna);
      await page.getByTestId('call-accept').click();
      await page.getByTestId('dm-call-active').waitFor({ timeout: 15_000 });
      await page.getByText('Голос подключён').first().waitFor({ timeout: 30_000 });
    } else {
      await aside.getByRole('button', { name: /Созвон/ }).first().click();
      await page.getByText('Голос подключён').first().waitFor({ timeout: 30_000 });
      await aside.getByRole('button', { name: /общий/ }).first().click();
      await page.getByRole('heading', { name: 'общий' }).first().waitFor();
    }
    if (CALENDAR) {
      // Today's meetings (one past, one ahead, one overlapping it) and the day view with the members column.
      // Meetings of today even late in the evening (the last one ends by 23:00).
      const now = Math.min(Date.now(), new Date().setHours(21, 0, 0, 0));
      const W = IDS.workspaces.main;
      mock.addEvent({ workspaceId: W, title: 'Стендап', startMs: now - 90 * 60_000, endMs: now - 60 * 60_000, attendees: [{ userId: IDS.users.boris }] });
      mock.addEvent({ workspaceId: W, title: 'Планёрка', startMs: now + 30 * 60_000, endMs: now + 90 * 60_000, roomId: IDS.rooms.meeting, attendees: [{ userId: IDS.users.boris }, { userId: IDS.users.vera }] });
      mock.addEvent({ workspaceId: W, organizerId: IDS.users.boris, title: 'Ревью', startMs: now + 60 * 60_000, endMs: now + 120 * 60_000, attendees: [{ userId: IDS.users.anna }] });
      await page.getByTestId('calendar-button').click();
      const d = new Date(now);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.locator(`[data-cal-day="${day}"]`).click();
      await page.getByTestId('now-line').waitFor({ timeout: 15_000 });
      await page.getByTestId('event-block').filter({ hasText: 'Ревью' }).waitFor({ timeout: 15_000 });
      if (FINDTIME) {
        await page.getByTestId('day-find').click();
        await page.getByTestId('find-people-add').click();
        const picker = page.getByTestId('find-people-picker');
        await picker.getByRole('option', { name: /Борис/ }).click();
        await picker.getByRole('option', { name: /Вера/ }).click();
        await page.keyboard.press('Escape');
        await page.getByTestId('busy-column').nth(2).waitFor({ timeout: 15_000 });
      }
    }
    if (BOARDS) {
      await page.getByTestId('boards-button').click();
      await page.getByTestId('kanban').waitFor({ timeout: 15_000 });
      await page.getByTestId('task-card').first().waitFor({ timeout: 15_000 });
    }
    await page.getByRole('button', { name: /^Качество связи/ }).first().waitFor({ timeout: 15_000 });
    // Musician mode is per call (not persisted, ADR-0052): turned on from the voice panel's «…».
    if (MUSICIAN) {
      await page.getByRole('button', { name: 'Ещё', exact: true }).last().click();
      await page.getByRole('menuitemcheckbox', { name: 'Режим музыканта' }).click();
      await page.keyboard.press('Escape');
      await page.getByTestId('musician-self').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(3000); // the capture swap and the renegotiation
    }
    const membersOpen = await page.getByRole('complementary').filter({ hasText: /В сети|Участники/ }).count();

    if (RECORDING) {
      mock.setRecording(IDS.rooms.call, { byUserId: IDS.users.boris, agoMs: 754_000 });
      await page.getByTestId('voice-rec-pill').first().waitFor({ timeout: 15_000 });
    }

    if (BENCH === 'K') {
      // My camera through the first-start sheet, with the background picked there (bg-03 for `image`).
      await page.getByTestId('camera-button').click();
      await page.getByTestId('camera-preview-enable').waitFor({ timeout: 15_000 });
      const section = page.getByTestId('camera-bg');
      if (BG === 'blur-light') await section.getByRole('radio', { name: 'Лёгкое' }).click();
      if (BG === 'blur-strong') await section.getByRole('radio', { name: 'Сильное' }).click();
      if (BG === 'image') await section.getByRole('radio', { name: 'Графит' }).click();
      const fx = page.getByTestId('camera-fx');
      if (FX.includes('touchup')) await fx.getByRole('switch', { name: 'Улучшить внешность' }).click();
      if (FX.includes('lowlight')) await fx.getByRole('switch', { name: 'Низкая освещённость' }).click();
      await page.waitForTimeout(2000);
      await page.getByTestId('camera-preview-enable').click();
      await page.getByTestId('camera-button').and(page.locator('[aria-pressed="true"]')).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(5000);
      // The viewer: bandwidth estimation ramps every layer up in the first ~30 s (keyframes, reconfigs).
      if (VIEWER) {
        viewer = await startViewer(IDS.rooms.call);
        await page.waitForTimeout(30_000);
      }
    }
    if (BENCH === 'F') {
      // The content: a Chromium window of its own (not the app's processes), then my stream of it.
      if (SOURCE === 'window' && !WINDOW_NAME) content = await openContent(CONTENT === 'moving');
      await page.getByRole('button', { name: 'Показать экран' }).first().click();
      const picker = page.getByTestId('stream-picker');
      await picker.getByTestId('stream-source').first().waitFor({ timeout: 15_000 });
      if (SOURCE === 'window') {
        await picker.getByRole('radio', { name: 'Приложения' }).click();
        await picker.getByRole('button', { name: new RegExp(`^${WINDOW_NAME || CONTENT_TITLE}`) }).first().click({ force: true });
      } else {
        await picker.getByTestId('stream-source').first().getByRole('button').first().click({ force: true });
      }
      // A forced click lands on the card's hover «Стримить» (starts at once); else «Начать стрим».
      if (await picker.isVisible()) await page.getByRole('button', { name: 'Начать стрим' }).click({ timeout: 3000 }).catch(() => undefined);
      await page.getByRole('button', { name: 'Остановить показ' }).first().waitFor({ timeout: 20_000 });
      // `--no-viewer`: nobody watches — dynacast pauses the encoder (capture and preview only).
      if (!argv.includes('--no-viewer')) viewer = await startViewer(IDS.rooms.call);
      await page.waitForTimeout(30_000);
      // `--fps N` (experiment): the capture's frame rate lowered after publishing.
      const fpsCap = Number(opt('fps', '0'));
      if (fpsCap > 0)
        await page.evaluate(async (fps) => {
          for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [])
            for (const x of pc.getSenders()) if (x.track?.kind === 'video') await x.track.applyConstraints({ ...x.track.getConstraints(), frameRate: { max: fps } });
        }, fpsCap);
      // `--overlay` (screen): the presenter's annotation overlay open, as after a viewer's first stroke.
      if (argv.includes('--overlay'))
        process.stdout.write(
          `overlay: ${await page.evaluate(async () => {
            type Api = { capture: { listSources(t: unknown): Promise<Array<{ id: string; kind: string; displayId: string }>> }; annotOverlay: { open(t: unknown): Promise<boolean> } };
            const api = (window as unknown as { calaba: Api }).calaba;
            const s = (await api.capture.listSources({ screen: { width: 8, height: 8 }, window: { width: 8, height: 8 } })).find((x) => x.kind === 'screen');
            return s ? api.annotOverlay.open({ sourceId: s.id, displayId: s.displayId }) : false;
          })}\n`,
        );
      // `--hide`: the app window closed to the tray while streaming (the usual case: I show another app).
      if (argv.includes('--hide')) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    }
    if (BENCH === 'E') {
      mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: false, camera: true });
      publisher = await startSpeaker(mock.url, IDS.users.boris, 'Борис Петров', IDS.rooms.call, 'camera');
    }
    if (BENCH === 'G') {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), WINDOW_SIZE);
      for (let i = 0; i < CAMERAS; i++) mock.setVoiceState({ userId: `perfcam${i}`, roomId: IDS.rooms.call, muted: true, camera: true });
      publisher = await startCameras(mock.url, CAMERAS, IDS.rooms.call, CAM_RES);
    }

    // Live events, like production.
    if (EMULATE) {
      let k = 0;
      timers.push(setInterval(() => mock.setPresence(IDS.users.grigory, k++ % 2 ? PresenceStatus.ONLINE : PresenceStatus.IDLE), 5000));
      let m = 0;
      const voiceRoom = DM_CALL ? IDS.dms.boris : IDS.rooms.call;
      const typing = DM_CALL ? { roomId: IDS.dms.boris, userId: IDS.users.boris } : { roomId: IDS.rooms.general, userId: IDS.users.vera };
      timers.push(setInterval(() => mock.setVoiceState({ userId: IDS.users.boris, roomId: voiceRoom, muted: m++ % 2 === 0, ...(BENCH === 'E' ? { camera: true } : {}) }), 10_000));
      timers.push(setInterval(() => void fetch(`${mock.url}/__mock/typing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(typing) }), 4000));
      if (BOARDS) {
        const cal2 = mock.boards.taskByKey('CAL-2')?.task.id ?? '';
        let n = 0;
        timers.push(setInterval(() => mock.updateTaskAs(IDS.users.boris, cal2, { title: `Тёмная тема ${++n}` }), 3000));
      }
    }
    // A real remote speaker: Chromium's fake microphone beeps once a second, so LiveKit's active
    // speakers and the level-driven rings flip on and off like in a conversation.
    if (EMULATE && SPEAKER) speaker = await startSpeaker(mock.url, IDS.users.boris, 'Борис Петров', IDS.rooms.call);
    await page.waitForTimeout(3000);
    // A menu over the playing video (docs/09 #65): the call's own room (camera grid), with the
    // room's notification menu dropped over the tile.
    if (BENCH === 'G') {
      await aside.getByRole('button', { name: /Созвон/ }).first().click();
      // The first camera may have opened the call view already (a near-empty chat); else «Видео · N».
      const grid = page.getByTestId('video-grid');
      await page.waitForTimeout(2000);
      if (!(await grid.isVisible())) await page.getByTestId('header-video').click();
      await grid.waitFor({ timeout: 30_000 });
      if (VIEW === 'speaker') await page.getByRole('radio', { name: 'Спикер' }).click();
      await page.waitForTimeout(20_000);
      const seen = await page.evaluate(() => ({
        tiles: document.querySelectorAll('[data-testid="video-tile"]').length,
        decoded: [...document.querySelectorAll<HTMLVideoElement>('video[data-testid="camera-video"]')].filter((v) => v.videoWidth > 0).map((v) => `${v.videoWidth}x${v.videoHeight}`),
      }));
      process.stdout.write(`call view: ${JSON.stringify(seen)}\n`);
    }
    if (POPOVER) {
      await aside.getByRole('button', { name: /Созвон/ }).first().click();
      await page
        .getByTestId('camera-video')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(async (e: unknown) => {
          if (process.env['PERF_CALL_SHOT']) await page.screenshot({ path: process.env['PERF_CALL_SHOT'] });
          throw e;
        });
      await page.waitForTimeout(2000);
      await page.getByRole('button', { name: /^Уведомления/ }).first().click();
      await page.getByRole('menu', { name: 'Уведомления' }).waitFor();
      if (process.env['PERF_CALL_SHOT']) await page.screenshot({ path: process.env['PERF_CALL_SHOT'] });
    }

    const out: Record<string, unknown> = { membersOpen, stats: STATS, emulate: EMULATE, seconds: SECONDS };
    if (SECONDS > 0) {
      await cdp.send('Performance.enable');
      const metrics = async (): Promise<Record<string, number>> =>
        Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((x) => [x.name, x.value]));
      await page.evaluate(() => {
        const p = (window as unknown as { __perf: Perf }).__perf;
        Object.assign(p, { on: true, commits: 0, commitMs: 0, renders: {}, selfMs: {}, why: {}, origin: {}, sample: {}, mounts: {}, originCommits: {}, timeline: [] });
      });
      const m0 = await metrics();
      // --cpu: a sampling JS profile of the same window, summarised by self time per function.
      if (CPU) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
        await cdp.send('Profiler.start');
      }
      await page.waitForTimeout(SECONDS * 1000);
      const m1 = await metrics();
      if (CPU) {
        type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
        const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
        const byId = new Map(profile.nodes.map((x) => [x.id, x]));
        const self = new Map<string, number>();
        profile.samples.forEach((id, i) => {
          const node = byId.get(id);
          if (!node) return;
          const f = node.callFrame;
          const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber + 1}`;
          self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
        });
        out['cpuSelfMsPerSec'] = [...self.entries()]
          .filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([k, v]) => [k, round(v / SECONDS, 2)]);
        out['cpuGcMsPerSec'] = round((self.get('(garbage collector) :0') ?? 0) / SECONDS, 2);
        out['cpuProgramMsPerSec'] = round((self.get('(program) :0') ?? 0) / SECONDS, 2);
      }
      const p = await page.evaluate(() => {
        const x = (window as unknown as { __perf: Perf }).__perf;
        x.on = false;
        return JSON.parse(JSON.stringify(x)) as Perf;
      });
      const d = (k: string): number => (m1[k] ?? 0) - (m0[k] ?? 0);
      // Running CSS animations / transitions at the end (each one restyles every frame).
      out['animations'] = await page.evaluate(() =>
        document.getAnimations().map((a) => {
          const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
          return `${(a as CSSAnimation).animationName ?? a.constructor.name} ${el?.tagName.toLowerCase() ?? ''}.${String(el?.className ?? '').slice(0, 40)}`;
        }),
      );
      const skip = /^(Primitive|Popper|Tooltip|Menu|ContextMenu|DropdownMenu|Presence|Slot|Dismissable|Focus|Portal|Collection|Roving|Popover|Dialog|anon)/;
      const comps = Object.keys(p.renders).filter((c) => !skip.test(c));
      const totalMs = Object.values(p.selfMs).reduce((a, b) => a + b, 0);
      Object.assign(out, {
        commits: p.commits,
        commitsPerSec: round(p.commits / SECONDS, 2),
        reactMsPerSec: round(p.commitMs / SECONDS, 2),
        selfMsPerSec: round(totalMs / SECONDS, 2),
        rendersPerSec: round(Object.values(p.renders).reduce((a, b) => a + b, 0) / SECONDS, 1),
        scriptMsPerSec: round((d('ScriptDuration') * 1000) / SECONDS, 2),
        taskMsPerSec: round((d('TaskDuration') * 1000) / SECONDS, 2),
        layoutsPerSec: round(d('LayoutCount') / SECONDS, 2),
        styleRecalcsPerSec: round(d('RecalcStyleCount') / SECONDS, 2),
        topByTime: comps
          .sort((a, b) => (p.selfMs[b] ?? 0) - (p.selfMs[a] ?? 0))
          .slice(0, 15)
          .map((c) => [c, round(p.selfMs[c] ?? 0, 2), p.renders[c]]),
        topByCount: comps
          .sort((a, b) => (p.renders[b] ?? 0) - (p.renders[a] ?? 0))
          .slice(0, 15)
          .map((c) => [c, p.renders[c], round(p.selfMs[c] ?? 0, 2)]),
        origins: Object.entries(p.origin)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([k, v]) => [k, v, p.originCommits[k] ?? 0]),
        why: Object.entries(p.why)
          .filter(([k]) => !skip.test(k))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40),
        mountRoots: Object.entries(p.mounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20),
        hookSamples: p.sample,
        ...(argv.includes('--timeline') ? { timeline: p.timeline } : {}),
      });
    }
    process.stdout.write(`{\n${Object.entries(out).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`);

    const encoder = async (): Promise<void> => {
      type Enc = { frames: number; impl: string; w: number; limit: string; bytes?: number; pkts?: number };
      const enc = async (): Promise<Record<string, Enc>> =>
        page.evaluate(async () => {
          const o: Record<string, { frames: number; impl: string; w: number; limit: string; bytes?: number; pkts?: number }> = {};
          for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []) {
            const st = await pc.getStats();
            st.forEach((r: Record<string, unknown>) => {
              if (r['type'] === 'outbound-rtp' && r['kind'] === 'video') o[String(r['rid'] ?? r['ssrc'])] = { frames: Number(r['framesEncoded'] ?? 0), impl: String(r['encoderImplementation'] ?? ''), w: Number(r['frameWidth'] ?? 0), limit: String(r['qualityLimitationReason'] ?? ''), bytes: Number(r['bytesSent'] ?? 0) + Number(r['headerBytesSent'] ?? 0), pkts: Number(r['packetsSent'] ?? 0) };
              if (r['type'] === 'candidate-pair' && r['nominated']) o[`pair-${String(r['id'])}`] = { frames: 0, impl: 'pair', w: 0, limit: '', bytes: Number(r['bytesSent'] ?? 0), pkts: Number(r['packetsSent'] ?? 0) };
              // What the capturer delivers (frames into the track), before any encoder.
              if (r['type'] === 'media-source' && r['kind'] === 'video') o[`src-${String(r['id'])}`] = { frames: Number(r['frames'] ?? 0), impl: 'capture', w: Number(r['width'] ?? 0), limit: `${String(r['width'] ?? '')}x${String(r['height'] ?? '')}` };
            });
          }
          return o;
        });
      const a = await enc();
      if (BENCH === 'F') {
        const tracks = await page.evaluate(() =>
          ((window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []).flatMap((pc) =>
            pc.getSenders().flatMap((x) => (x.track?.kind === 'video' ? [{ hint: x.track.contentHint, ...x.track.getSettings() }] : [])),
          ),
        );
        process.stdout.write(`track: ${JSON.stringify(tracks)}\n`);
      }
      await page.waitForTimeout(5000);
      const b = await enc();
      process.stdout.write(`encoder: ${JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v, fps: round((v.frames - (a[k]?.frames ?? 0)) / 5), kbps: round((((v.bytes ?? 0) - (a[k]?.bytes ?? 0)) * 8) / 5000), pps: round(((v.pkts ?? 0) - (a[k]?.pkts ?? 0)) / 5) }])))}\n`);
    };
    // The mic on the wire (musician mode vs voice): outgoing kbps over 5 s and the negotiated fmtp.
    const mic = async (): Promise<void> => {
      const read = async (): Promise<{ bytes: number; fmtp: string; enabled: boolean | null }> =>
        page.evaluate(async () => {
          const o = { bytes: 0, fmtp: '', enabled: null as boolean | null };
          for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []) {
            for (const s of pc.getSenders()) if (s.track?.kind === 'audio') o.enabled = s.track.enabled;
            const st = await pc.getStats();
            st.forEach((r: Record<string, unknown>) => {
              if (r['type'] !== 'outbound-rtp' || r['kind'] !== 'audio') return;
              o.bytes += Number(r['bytesSent'] ?? 0) + Number(r['headerBytesSent'] ?? 0);
              const c = typeof r['codecId'] === 'string' ? (st.get(r['codecId']) as Record<string, unknown> | undefined) : undefined;
              o.fmtp = String(c?.['sdpFmtpLine'] ?? o.fmtp);
            });
          }
          return o;
        });
      const a = await read();
      await page.waitForTimeout(5000);
      const b = await read();
      process.stdout.write(`mic: ${JSON.stringify({ kbps: round(((b.bytes - a.bytes) * 8) / 5000), fmtp: b.fmtp, enabled: b.enabled })}\n`);
    };
    if (BENCH === 'C') await mic();
    // K: what the encoder does (dynacast pauses every layer while nobody watches) before and after.
    if (BENCH === 'K' || BENCH === 'F') await encoder();
    if (BENCH) {
      const bundle = resolve(ROOT, 'node_modules/electron/dist/Electron.app');
      const outDir = opt('bench-out', join(tmpdir(), 'calaba-energy'));
      const scenario = (BENCH === 'F' ? `F-stream-${PRESET}p-${SOURCE}-${CONTENT}-${HINT}` : BENCH === 'K' ? `K-camera-720p15-bg-${BG}${FX ? `-fx-${FX}` : ''}` : BENCH === 'E' ? 'E-watch-video' : BENCH === 'G' ? `G-${VIEW}-${CAMERAS}cams-${WINDOW_SIZE.join('x')}` : RECORDING ? 'C-voice-quiet-rec' : 'C-voice-quiet') + (POPOVER ? '-popover' : '') + (MUSICIAN ? '-musician' : '');
      const r = spawnSync('python3', [join(ROOT, 'tools/energy-bench.py'), bundle, `calab-${NAME}`, scenario, '--seconds', String(BENCH_SECONDS), '--out', outDir, '--with', 'WindowServer', ...(BENCH === 'F' ? ['--with', 'replayd'] : [])], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exitCode = 1;
      if (BENCH === 'K' || BENCH === 'F') await encoder();
      if (BENCH === 'C') await mic();
    }
  } finally {
    for (const t of timers) clearInterval(t);
    await publisher?.close().catch(() => undefined);
    await speaker?.close().catch(() => undefined);
    await viewer?.close().catch(() => undefined);
    await content?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await mock.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

void main();
