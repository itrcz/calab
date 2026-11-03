import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import { TaskAssigneeSchema, TaskReleaseSchema } from '@calaba/protocol';
import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';

/**
 * Harness for the design tests (docs/08, «Тесты дизайна»): the production renderer (out/)
 * against the deterministic mock API, with a fixed clock, fixed OS permission statuses
 * (CALABA_VISUAL_TEST=1), no animations.
 */

export type Theme = 'dark' | 'light';
export interface Viewport {
  width: number;
  height: number;
}
/** docs/08: the minimum window and a typical laptop window (fits a 1470×864 work area). */
export const VIEWPORTS: Viewport[] = [
  { width: 960, height: 600 },
  { width: 1440, height: 800 },
];
export const THEMES: Theme[] = ['dark', 'light'];

/**
 * A fixed port: the login screen prints the server URL, so the baseline is taken on 39170.
 * CALABA_VISUAL_MOCK_PORT lets parallel local runs coexist (their auth shots then differ).
 */
export const MOCK_PORT = Number(process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39170);
/** «Now» for the client: the fixtures are dated 2026-01-14/15. */
export const NOW = new Date('2026-01-15T13:30:00+03:00');
export const PASSWORD = 'password123';

export interface Env {
  app: ElectronApplication;
  page: Page;
  mock: MockServer;
  close(): Promise<void>;
}

export async function launch(opts: {
  theme: Theme;
  viewport: Viewport;
  scenario?: 'data' | 'empty';
  onboarded?: boolean;
  port?: number;
  /** Files main finds in userData at startup (e.g. resume-voice.json), written before the launch. */
  seedUserData?: (userData: string, serverUrl: string) => void;
}): Promise<Env> {
  const mock = await startMockServer({ port: opts.port ?? MOCK_PORT, scenario: opts.scenario ?? 'data' });
  const userData = mkdtempSync(join(tmpdir(), 'calaba-visual-'));
  opts.seedUserData?.(userData, mock.url);
  const app = await electron.launch({
    // --lang=ru: app.getLocale() → ru, so «as in the system» is Russian on any host (ADR-0022).
    // --mute-audio: no join/leave sounds through the machine's speakers during the run.
    args: ['.', '--lang=ru', '--mute-audio'],
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CALABA_SERVER_URL: mock.url,
      CALABA_USER_DATA: userData,
      CALABA_MULTI_INSTANCE: '1',
      CALABA_FAKE_MEDIA: '1',
      CALABA_VISUAL_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      TZ: 'Europe/Moscow',
      LANG: 'ru_RU.UTF-8',
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, v) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(v.width, v.height);
    w?.center();
    // The real (OS) cursor may sit over the window: Chromium then hovers whatever lands under it
    // (a list row after a popover opens, a menu item mid-transition). Only Playwright's
    // (CDP-dispatched) input reaches the page.
    w?.setIgnoreMouseEvents(true);
  }, opts.viewport);
  await page.clock.setFixedTime(NOW);
  await page.evaluate(
    ({ theme, onboarded }) => {
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme, onboarded, locale: 'ru' }, version: 1 }));
    },
    { theme: opts.theme, onboarded: opts.onboarded ?? false },
  );
  await page.reload();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(opts.viewport.width);
  return {
    app,
    page,
    mock,
    async close() {
      await app.close().catch(() => undefined);
      await mock.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function login(page: Page, email = 'owner@calaba.test'): Promise<void> {
  // The test window takes the OS focus: a key typed on this machine meanwhile lands in the field
  // (seen: «password123н»). Check the values right before submitting, re-fill if they drifted.
  const emailField = page.getByLabel('Email');
  const password = page.getByLabel('Пароль', { exact: true });
  await expect(async () => {
    await emailField.fill(email);
    await password.fill(PASSWORD);
    await expect(emailField).toHaveValue(email, { timeout: 200 });
    await expect(password).toHaveValue(PASSWORD, { timeout: 200 });
  }).toPass({ timeout: 5000 });
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/**
 * Lets fonts, images and layout settle; parks the pointer so nothing is hovered (`keepPointer`:
 * leave it — a drag in progress follows the pointer).
 */
export async function settle(page: Page, keepPointer = false): Promise<void> {
  if (!keepPointer) await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => i.addEventListener('load', r, { once: true }))),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The virtualized feed measures rows and loads previews asynchronously: wait until every
    // scroller keeps the same scrollTop / scrollHeight for 300 ms (max 5 s).
    const snapshot = (): string =>
      [...document.querySelectorAll('[data-virtuoso-scroller]')].map((e) => `${e.scrollTop}:${e.scrollHeight}`).join('|');
    // (Iteration counts, not Date.now(): the page clock is frozen by page.clock.setFixedTime.)
    let last = snapshot();
    let stable = 0;
    for (let i = 0; i < 100 && stable < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const now = snapshot();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  });
}

// ---------------------------------------------------------------- layout invariants

export interface LayoutProblem {
  kind: string;
  detail: string;
}

/**
 * docs/08 «Тесты дизайна»: no horizontal scroll, text doesn't spill out of its box
 * (intended truncation with ellipsis is fine), nothing sticks out of the window, the modal
 * is centred, the stream PiP doesn't cover the composer.
 */
export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const out: { kind: string; detail: string }[] = [];
    const W = innerWidth;
    const H = innerHeight;
    const describe = (el: Element): string => {
      const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const label = el.getAttribute('aria-label') ?? '';
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> ${label || text}`;
    };
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };

    // 1. No horizontal page scroll.
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > se.clientWidth + 1) out.push({ kind: 'h-scroll', detail: `page ${se.scrollWidth} > ${se.clientWidth}` });
    for (const el of document.querySelectorAll('main, aside, section, [role="dialog"], [role="tabpanel"]')) {
      const cs = getComputedStyle(el);
      if (!visible(el) || cs.overflowX === 'hidden' || cs.overflowX === 'clip') continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push({ kind: 'h-scroll', detail: `${describe(el)}: ${el.scrollWidth} > ${el.clientWidth}` });
    }

    // 2. Text overflow in key containers: controls, headings, list rows, tabs, labels. Every
    //    text node must lie inside its container, unless an ancestor clips it on purpose —
    //    then the clip must show an ellipsis. Absolutely positioned badges are exempt.
    const keys = 'button, a, h1, h2, h3, label, [role="tab"], [role="option"], [role="menuitem"], th, td, kbd';
    const srOnly = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width <= 1 || r.height <= 1;
    };
    for (const el of document.querySelectorAll<HTMLElement>(keys)) {
      if (!visible(el) || srOnly(el) || el.closest('[data-layout-ignore]')) continue;
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue;
        const parent = n.parentElement;
        if (!parent || !visible(parent) || srOnly(parent)) continue;
        // Skip text inside absolutely positioned descendants (badges) and inside clipping boxes.
        let clipper: HTMLElement | null = null;
        let abs = false;
        for (let a: HTMLElement | null = parent; a && a !== el.parentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (a !== el && (cs.position === 'absolute' || cs.position === 'fixed')) abs = true;
          if (!clipper && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowX === 'auto')) clipper = a;
        }
        if (abs) continue;
        if (clipper) {
          const cs = getComputedStyle(clipper);
          // An intentional fade-out (mask) instead of an ellipsis counts as proper truncation.
          let faded = false;
          for (let a: HTMLElement | null = clipper; a && a !== el.parentElement; a = a.parentElement) {
            const m = getComputedStyle(a);
            const mask = m.maskImage || m.getPropertyValue('-webkit-mask-image');
            if (mask && mask !== 'none') faded = true;
          }
          if (!faded && clipper.scrollWidth > clipper.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto') {
            out.push({ kind: 'text-clipped', detail: `${describe(el)}: clipped without ellipsis` });
          }
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
          out.push({ kind: 'text-overflow', detail: `${describe(el)}: text ${Math.round(r.width)}×${Math.round(r.height)} outside ${Math.round(box.width)}×${Math.round(box.height)}` });
        }
      }
    }
    // 2b. Truncated labels must keep a readable width (a name squeezed to nothing by a
    //     neighbour is as broken as an overflowing one).
    for (const el of document.querySelectorAll<HTMLElement>('.truncate')) {
      const text = el.textContent.trim();
      if (!text || el.closest('[data-layout-ignore], .sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let hidden = false;
      for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.display === 'none' || acs.visibility === 'hidden' || Number(acs.opacity) === 0) hidden = true;
      }
      if (hidden) continue;
      const r = el.getBoundingClientRect();
      if (el.scrollWidth <= el.clientWidth) continue; // not truncated: a short name is simply short
      if (r.width < Math.min(24, text.length * 6)) out.push({ kind: 'text-squeezed', detail: `${describe(el)}: ${Math.round(r.width)} px wide` });
    }
    // 3. Nothing interactive sticks out of the window.
    for (const el of document.querySelectorAll('button, input, select, textarea, [role="dialog"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Elements inside scroll containers may legitimately be scrolled out of view.
      let p = el.parentElement;
      let scrolled = false;
      while (p) {
        const cs = getComputedStyle(p);
        const o = cs.overflowY;
        if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) scrolled = true;
        // Horizontal scrollers too (a kanban's columns).
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth) scrolled = true;
        p = p.parentElement;
      }
      if (scrolled) continue;
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
        out.push({ kind: 'offscreen', detail: `${describe(el)}: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}` });
      }
    }
    // 4. Modals centred (anchored popovers also use role="dialog", but without aria-modal).
    for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) {
      if (!visible(d) || d.hasAttribute('data-layout-anchor')) continue;
      const r = d.getBoundingClientRect();
      const dx = Math.abs(r.left + r.width / 2 - W / 2);
      const dy = Math.abs(r.top + r.height / 2 - H / 2);
      if (dx > 2 || dy > 2) out.push({ kind: 'modal-off-centre', detail: `${describe(d)}: Δx=${dx.toFixed(1)} Δy=${dy.toFixed(1)}` });
    }
    // 5. PiP vs composer.
    const pip = document.querySelector('[data-testid="stream-pip"]');
    const composer = document.querySelector('[data-testid="composer"]');
    if (pip && composer && visible(pip)) {
      const a = pip.getBoundingClientRect();
      const b = composer.getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        out.push({ kind: 'pip-over-composer', detail: `pip bottom ${Math.round(a.bottom)} > composer top ${Math.round(b.top)}` });
      }
    }
    return out;
  });
}

export async function expectLayout(page: Page, name: string): Promise<void> {
  const problems = await layoutProblems(page);
  expect.soft(problems, `layout invariants: ${name}`).toEqual([]);
}

// ---------------------------------------------------------------- accessibility

/** axe-core, WCAG 2.x A/AA: no serious or critical violations (contrast ≥ 4.5:1 is one of them). */
export async function expectAccessible(page: Page, name: string): Promise<void> {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // <video> frames / canvases are content, not UI chrome.
    .exclude('video')
    // Electron can't open the extra page axe uses to merge frame results.
    .setLegacyMode(true)
    .analyze();
  const bad = res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`) }));
  expect.soft(bad, `axe: ${name}`).toEqual([]);
}

// ---------------------------------------------------------------- voice

/**
 * Joins the voice room «Переговорка» from the chats section (needs the dev LiveKit,
 * `livekit-server --dev` or `pnpm infra:dev`), so a following screen is captured in a call.
 */
export async function joinVoice(page: Page): Promise<void> {
  await page.getByTestId('section-chats').click();
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await page.getByRole('region', { name: 'Переговорка' }).getByRole('button', { name: 'Войти в голос', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------- one checkpoint

export interface Shot {
  page: Page;
  theme: Theme;
  viewport: Viewport;
}

/** Screenshot + layout invariants + axe for the current screen. */
export async function checkpoint(s: Shot, name: string, opts: { mask?: Locator[]; axe?: boolean; keepPointer?: boolean } = {}): Promise<void> {
  await settle(s.page, opts.keepPointer);
  await expect.soft(s.page, `screenshot: ${name}`).toHaveScreenshot(`${name}-${s.theme}-${s.viewport.width}.png`, {
    mask: opts.mask ?? [],
    maskColor: '#808080',
  });
  await expectLayout(s.page, `${name} (${s.theme}, ${s.viewport.width})`);
  if (opts.axe !== false) await expectAccessible(s.page, `${name} (${s.theme}, ${s.viewport.width})`);
}

// ---------------------------------------------------------------- day separators and assignee stacks (#87, #92)

/** Messages over several days (NOW = 15 Jan 2026 13:30 MSK): [days back, hour MSK, text]. */
const DAYS_THREAD: Array<[number, number, string]> = [
  [400, 10, 'Договор подписан в прошлом году'],
  [3, 23, 'Отправил договор на согласование'],
  [3, 23.2, 'Жду ответа'],
  [1, 9, 'Вчера утром юристы вернули правки'],
  [0, 9, 'Сегодня внёс правки, смотрите'],
  [0, 10, 'Ок, принято'],
];

/** Writes DAYS_THREAD into `roomId` with their own dates (call before the app loads the room); `onlyAuthor` keeps unread badges as they are. */
export function seedDays(mock: MockServer, roomId: string, onlyAuthor?: string): void {
  for (const [days, hour, text] of DAYS_THREAD) {
    const day = new Date(NOW.getTime() - days * 86_400_000);
    day.setUTCHours(0, 0, 0, 0);
    const m = mock.injectMessage({ roomId, authorId: onlyAuthor ?? (days % 2 ? IDS.users.boris : IDS.users.anna), content: text });
    m.createdAt = create(TimestampSchema, { seconds: BigInt(Math.floor((day.getTime() + (hour - 3) * 3_600_000) / 1000)) });
  }
}

/** CAL-1 one assignee, CAL-2 two, CAL-4 five (written straight into the mock: not everyone sees the board). */
export function seedAssigneeCounts(mock: MockServer): void {
  const u = IDS.users;
  const set = (key: string, ids: string[]): void => {
    const t = mock.boards.taskByKey(key);
    if (!t) throw new Error(`no ${key}`);
    t.task.assignees = ids.map((userId, i) => create(TaskAssigneeSchema, { userId, isLead: i === 0, assignedAt: create(TimestampSchema, { seconds: BigInt(1_768_000_000 + i * 60) }) }));
  };
  set('CAL-1', [u.anna]);
  set('CAL-2', [u.anna, u.boris]);
  set('CAL-4', [u.anna, u.boris, u.vera, u.grigory, u.dina]);
}

/**
 * Releases (board task #101): CAL-1 and CAL-3 went out in prod «4929cf3» (CAL-3 then in stage «1288»
 * too), CAL-2 in prod «4a1b2c3» the day before; the rest in none. Written straight into the mock, after open().
 */
export function seedReleases(mock: MockServer): void {
  const at = (h: number) => create(TimestampSchema, { seconds: BigInt(Math.floor(NOW.getTime() / 1000) - h * 3600) });
  const rel = (id: string, name: string, environment: string, h: number) =>
    create(TaskReleaseSchema, { releaseId: id, name, environment, url: `https://git.example.com/gptunnel/gpt/-/pipelines/${name}`, createdAt: at(h) });
  const set = (key: string, list: ReturnType<typeof rel>[]): void => {
    const t = mock.boards.taskByKey(key);
    if (!t) throw new Error(`no ${key}`);
    t.task.releases = list;
  };
  set('CAL-1', [rel('rel-prod-2', '4929cf3', 'prod', 2)]);
  set('CAL-2', [rel('rel-prod-1', '4a1b2c3', 'prod', 26)]);
  set('CAL-3', [rel('rel-stage-3', '1288', 'stage', 1), rel('rel-prod-2', '4929cf3', 'prod', 2)]);
}

/**
 * Labels past the card width (docs/08 «Лейблы»): CAL-1 two (one row), CAL-2 five (two rows),
 * CAL-4 all eleven (the «+N» group). Written straight into the mock, after open().
 */
export function seedLabelOverflow(mock: MockServer): void {
  const one = mock.boards.taskByKey('CAL-1');
  if (!one) throw new Error('no CAL-1');
  const board = one.task.boardId;
  for (const [name, color] of [['Документация', 0x30d158], ['Бэкенд', 0xff9f0a], ['Фронтенд', 0x64d2ff], ['Мобильное приложение', 0x5e5ce6], ['Безопасность', 0xff375f], ['Производительность', 0xac8e68], ['Релиз', 0xffcc00], ['API', 0x8e8e93]] as const) {
    mock.boards.createLabel(board, IDS.users.anna, { name, color });
  }
  const labels = mock.boards.getBoard(board, IDS.users.anna).labels;
  const id = (name: string): string => labels.find((l) => l.name === name)?.id ?? '';
  const set = (key: string, names: string[]): void => {
    const t = mock.boards.taskByKey(key);
    if (!t) throw new Error(`no ${key}`);
    t.task.labelIds = names.map(id);
  };
  set('CAL-1', ['Баг', 'Фича']);
  set('CAL-2', ['Баг', 'Фича', 'Дизайн', 'Бэкенд', 'API']);
  set('CAL-4', ['Баг', 'Фича', 'Дизайн', 'Документация', 'Бэкенд', 'Фронтенд', 'Мобильное приложение', 'Безопасность', 'Производительность', 'Релиз', 'API']);
}

/** The three stacks (CAL-1/2/4): one circle height, the same distance from the card's right edge, «+3» on the five. */
export async function expectAssigneeStacks(page: Page): Promise<void> {
  const stacks = page.locator('[data-testid=task-card], [data-testid=list-row]').filter({ hasText: /Экспорт доски|Тёмная тема|Карточки задач/ }).getByTestId('assignee-stack');
  // The kanban mounts only the columns near the viewport: the card with five people and at least one more.
  await expect.poll(() => stacks.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('assignee-more')).toHaveText('+3');
  const more = await page.getByTestId('assignee-more').boundingBox();
  expect([Math.round(more?.width ?? 0), Math.round(more?.height ?? 0)]).toEqual([20, 20]);
  const boxes = await stacks.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const c = e.closest('[data-testid=task-card],[data-testid=list-row]')?.getBoundingClientRect();
      return { h: Math.round(r.height), right: Math.round((c?.right ?? 0) - r.right) };
    }),
  );
  expect(new Set(boxes.map((b) => b.h)).size, JSON.stringify(boxes)).toBe(1);
  expect(new Set(boxes.map((b) => b.right)).size, JSON.stringify(boxes)).toBe(1);
}

/** Board #115: CAL-3 made by the «Погода» bot, which asks me (an assignee) to act on my behalf. Call after open(). */
export function seedBotAuthoredTask(mock: MockServer): void {
  mock.seedBots();
  const t = mock.boards.taskByKey('CAL-3');
  if (!t) throw new Error('no CAL-3');
  t.task.createdBy = IDS.bots.weather;
}

/**
 * ADR-0156: CAL-3 worked on through MCP — in the history the description edit by Анна through
 * «Погода» and the title by «Деплой» itself; three comments: Борис through «Погода», «Деплой»
 * itself, mine through «Погода» (the bots must be seeded: mock.seedBots()).
 */
export function seedViaMcp(mock: MockServer): void {
  const t = mock.boards.taskByKey('CAL-3');
  if (!t) throw new Error('no CAL-3');
  const acts = mock.boards.activity.filter((a) => a.taskId === t.task.id);
  const desc = acts.find((a) => a.kind === 'description');
  const title = acts.find((a) => a.kind === 'title');
  if (!desc || !title) throw new Error('no CAL-3 history');
  desc.viaBotId = IDS.bots.weather;
  desc.via = 'mcp';
  title.actorId = IDS.bots.deploy;
  title.via = 'mcp';
  const say = (authorId: string, content: string, viaBotId: string): void => {
    mock.injectMessage({ roomId: t.task.roomId, authorId, content, viaBotId, via: 'mcp' });
  };
  say(IDS.users.boris, 'Взял в работу — разберу логи эха до вечера.', IDS.bots.weather);
  say(IDS.bots.deploy, 'Ветка fix/echo-cancel привязана, сборка 3.2.2 собрана.', '');
  say(IDS.users.anna, 'Поставила срок на пятницу.', IDS.bots.weather);
}

/**
 * Board #148: CAL-3's comments with a picture and pipe tables (a narrow one, a wide one that must scroll
 * sideways inside the bubble). Returns the wide table's author text marker for the spec to find it.
 */
export function seedRichComments(mock: MockServer): void {
  const t = mock.boards.taskByKey('CAL-3');
  if (!t) throw new Error('no CAL-3');
  const room = t.task.roomId;
  mock.injectMessage({ roomId: room, authorId: IDS.users.vera, content: 'Скриншот ошибки', attachments: [IDS.files.portrait] });
  mock.injectMessage({ roomId: room, authorId: IDS.users.anna, content: 'Итоги замеров:\n\n| Сборка | CPU, % | Эхо |\n| --- | --- | --- |\n| 3.2.1 | 4.8 | да |\n| 3.2.2 | 2.1 | нет |' });
  const wide = ['Окружение', 'Версия клиента', 'Версия ОС', 'Процессор', 'Память, ГБ', 'Сеть', 'Комментарий'];
  mock.injectMessage({ roomId: room, authorId: IDS.users.boris, content: `Широкая таблица:\n\n| ${wide.join(' | ')} |\n| ${wide.map(() => '---').join(' | ')} |\n| ${wide.map((w) => `${w} — значение`).join(' | ')} |` });
}

/**
 * Board #117: every visible control of a toolbar (buttons, fields, segmented controls) is one
 * height - `--control-h-bar` - within 0.5 px, and sits centred on the toolbar's midline.
 */
export async function expectToolbarHeights(bar: Locator, name: string): Promise<void> {
  const rows = await bar.evaluate((root) => {
    const rb = root.getBoundingClientRect();
    const out: Array<{ what: string; h: number; mid: number }> = [];
    root.querySelectorAll<HTMLElement>('button, input, select, [role=radiogroup]').forEach((el) => {
      const inner = el.parentElement?.getBoundingClientRect().height ?? 0;
      if (el.getAttribute('role') !== 'radiogroup' && Math.abs(inner - el.getBoundingClientRect().height - 4) < 0.6 && el.parentElement?.matches('div, span')) return; // a segment inside its 2 px padded track
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') return;
      out.push({ what: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? el.tagName, h: r.height, mid: r.top + r.height / 2 - (rb.top + rb.height / 2) });
    });
    return out;
  });
  expect(rows.length, `${name}: controls found`).toBeGreaterThan(2);
  const target = rows.find((r) => r.what === 'new-task')?.h ?? rows[0]?.h ?? 0;
  for (const r of rows) {
    expect(Math.abs(r.h - target), `${name}: ${r.what} is ${r.h}px, expected ${target}px`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.mid), `${name}: ${r.what} is off the bar's midline by ${r.mid}px`).toBeLessThanOrEqual(1);
  }
}
