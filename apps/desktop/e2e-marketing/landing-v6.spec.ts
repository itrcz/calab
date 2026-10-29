import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { AiState, AttendeeStatus, Plan, RecordingStatus, WorkspaceAppSchema } from '@calaba/protocol';
import { test, type Locator } from '@playwright/test';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { fileMeta } from '../e2e-support/fixtures';
import { IDS } from '../e2e-support/mock-server';
import { NOW, PASSWORD } from '../e2e-visual/harness';
import { cameraPhoto, heroStream } from './photos';
import { decodeFrame, encodeAwareness, FRAME_SNAPSHOT, FRAME_UPDATE } from '../src/renderer/lib/wiki/frames';
import { appIconHtml, pdfBytes, render } from './art';
import { seedStoryCanvas } from './v6-canvas';
import { seedRecordingText, seedRoles, seedTelephony } from './v6-seeds';
import {
  LOCALES,
  MOD,
  PREFIX,
  R,
  SETTINGS,
  U,
  aside,
  boot,
  box,
  expect,
  fakeCamera,
  insets,
  feedBottom,
  inRoom,
  joinMeeting,
  msk,
  speaking,
  startPublisher,
  openRoom,
  resize,
  seedStoryBoard,
  seedStoryChat,

  setLocale,
  shoot,
  shutdown,
  type Ctx,
  type Seed,
} from './v6-kit';

/**
 * Landing v6 scenes (docs/plans/landing-v6.md §5): the «one day of a team» story — a request in the chat,
 * the task APP-7 made of it, the review meeting, the wiki page, the retro canvas, the phone call — and the
 * telephony / role / recording / AI windows. One source, the web build + the mock, 1440×900 CSS px, scale 2,
 * dark, four languages; data in copy4.ts (people / rooms / the board in copy.ts), shared seeds in v6-kit.ts.
 * The «-focus» scenes are their own captures in a window as wide as the panel (the crops follow its borders).
 * The whole-window scenes (WINDOW below) run in the built app instead and are OS captures of its macOS window,
 * traffic lights included (app-window.ts; `pnpm build:app` first, CALABA_LANDING_WEB=1 falls back to the web build).
 *
 *   pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_WORKERS=1 CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm exec playwright test --config playwright.marketing.config.ts landing-v6
 *
 * `-g "v6 chat-full"` one scene, CALABA_LANDING_LOCALES=ru,en some languages. The call scenes need the dev
 * LiveKit (livekit-server --dev). Raw captures: apps/landing/shots/<scene>-<locale>@2x.png (git-ignored);
 * `pnpm -F @calaba/landing assets` crops them (scripts/assets.mjs).
 */

interface Scene {
  seed?: Seed;
  ui?: { sidebarWidth?: number; membersPanel?: boolean };
  phone?: boolean;
  size?: { width: number; height: number };
  /** `focus` = the capture of its own for phones (<scene>-focus): the window as wide as the main panel (720 px). */
  run(ctx: Ctx, focus: boolean): Promise<void>;
  /** The phones' capture: its window and layout; the scene's `seed` and `run` are the same. */
  focus?: { size: { width: number; height: number }; ui?: { sidebarWidth?: number; membersPanel?: boolean }; seed?: Seed };
}

/** The raw capture's name: `chat-full`, or `chat-full-focus` for the phones' capture. */
const tag = (name: string, focus: boolean): string => (focus ? `${name}-focus` : name);

/** The story's board + chat (the task key is APP-7 whatever the language). */
const storySeed = ((mock, c, c4) => {
  const { key } = seedStoryBoard(mock, c, c4);
  seedStoryChat(mock, c, c4, key);
}) satisfies Seed;
const storyCompact = ((mock, c, c4) => {
  const { key } = seedStoryBoard(mock, c, c4);
  seedStoryChat(mock, c, c4, key, true);
}) satisfies Seed;

/** Boards mode on «Продукт» (desktop). */
async function storyWikiScene(ctx: Ctx): Promise<void> {
  await wikiScene(ctx, 'story-wiki', { width: 1440, height: 900 }, 0, true);
}

async function openBoards(ctx: Ctx): Promise<void> {
  await aside(ctx.page).getByRole('button', { name: new RegExp(ctx.c.rooms.general) }).first().click();
  await setLocale(ctx.page, ctx.short);
  await ctx.page.getByTestId('section-boards').click();
  await expect(ctx.page.getByTestId('kanban')).toBeVisible();
  await expect(ctx.page.getByTestId('task-card').first()).toBeVisible();
}

/** «общий» in the page language: the memoized feed rows keep the old language, so re-open the room after the switch. */
async function chatRu(ctx: Ctx): Promise<void> {
  await openRoom(ctx, ctx.c.rooms.general);
  await setLocale(ctx.page, ctx.short);
  await aside(ctx.page).getByRole('button', { name: new RegExp(ctx.c.rooms.dev) }).first().click();
  await openRoom(ctx, ctx.c.rooms.general);
  await expect(ctx.page.getByTestId('task-link-card')).toBeVisible({ timeout: 15_000 });
  await feedBottom(ctx.page);
  await ctx.page.mouse.move(0, 0);
}

/** The week of 12–18 January: the story's review among them. */
const weekSeed: Seed = (mock, c, c4) => {
  // The daily stand-up, Monday to Friday.
  for (const d of [12, 13, 14, 15, 16]) {
    mock.addEvent({
      workspaceId: IDS.workspaces.main,
      organizerId: U.boris,
      title: c.calendar.standup,
      startMs: msk('10:30', `2026-01-${d}`),
      endMs: msk('10:45', `2026-01-${d}`),
      roomId: R.call,
      attendees: ['anna', 'vera', 'grigory'].map((k) => ({ userId: U[k as 'anna'], status: AttendeeStatus.ACCEPTED })),
    });
  }
  const ev = (title: string, d: number, from: string, to: string, org: 'anna' | 'boris' | 'grigory', who: ('anna' | 'boris' | 'vera' | 'grigory')[]): void => {
    mock.addEvent({ workspaceId: IDS.workspaces.main, organizerId: U[org], title, startMs: msk(from, `2026-01-${d}`), endMs: msk(to, `2026-01-${d}`), attendees: who.map((k) => ({ userId: U[k], status: AttendeeStatus.ACCEPTED })) });
  };
  ev(c.calendar.oneOnOne, 12, '14:00', '14:30', 'boris', ['anna']);
  ev(c.calendar.interview, 14, '14:00', '15:00', 'grigory', ['anna']);
  for (const e of c4.week) {
    const day = `2026-01-${e.day}`;
    mock.addEvent({
      workspaceId: IDS.workspaces.main,
      organizerId: U[e.organizer ?? 'anna'],
      title: e.title,
      startMs: msk(e.from, day),
      endMs: msk(e.to, day),
      ...(e.room ? { roomId: R.meeting } : {}),
      description: e.title === c4.meeting.title ? c4.meeting.description : '',
      attendees: (e.who ?? []).map((k) => ({ userId: U[k], status: e.title === c4.meeting.title && k === 'grigory' ? AttendeeStatus.MAYBE : AttendeeStatus.ACCEPTED })),
    });
  }
};

const WIKI_COVER = `<div style="width:1920px;height:480px;position:relative;overflow:hidden;background:linear-gradient(120deg,#1d2a6b 0%,#4b3fd1 48%,#c26be0 100%)">
  <div style="position:absolute;left:-120px;top:-200px;width:620px;height:620px;border-radius:50%;background:rgba(255,255,255,.12)"></div>
  <div style="position:absolute;left:520px;top:210px;width:900px;height:900px;border-radius:50%;background:rgba(10,14,60,.35)"></div>
  <div style="position:absolute;right:140px;top:40px;width:340px;height:340px;border-radius:50%;background:rgba(255,196,120,.85)"></div>
</div>`;

/** The wiki of the story: «Экспорт в CSV» under «Продукт», a cover, a work-plan checklist, a table; two colleagues' carets. */
async function wikiScene(ctx: Ctx, scene: string, size: { width: number; height: number }, scrollBy: number, cards = false): Promise<void> {
  const { page, mock, c, c4, short } = ctx;
  const k = c4.wiki;
  const ws = IDS.workspaces.main;
  const w = mock.wiki;
  const old = [...w.pages.values()].find((p) => p.cover);
  w.pages.clear();
  w.docs.clear();
  w.links.clear();
  w.perms.clear();
  w.versions.clear();
  const stamp = (iso: string) => timestampFromMs(Date.parse(iso));
  const cover = old?.cover;
  if (cover) {
    const png = await render(ctx.browser, WIKI_COVER, 1920, 480);
    const rec = mock.state.files.get(cover.id);
    if (rec) {
      rec.bytes = png;
      rec.thumbnail = { bytes: png, mime: 'image/png' };
    }
    cover.size = BigInt(png.length);
    cover.width = 1920;
    cover.height = 480;
  }
  const taskKey = [...mock.boards.tasks.values()].find((t) => t.task.title === c4.task.title)?.task.key ?? 'APP-7';
  const canvasId = [...mock.canvas.items.values()].find((i) => i.name === c4.canvas.name)?.id ?? '';
  const links = [`${k.taskCard} [${taskKey} · ${c4.task.title}](https://calab.test/t/${taskKey})`, `${k.canvasCard} [${c4.canvas.name}](${mock.url}/canvas/${canvasId})`];
  const md = [
    k.intro,
    `## ${k.steps}`,
    `- [x] ${k.tasks[0]}`,
    `- [x] ${k.tasks[1]}`,
    `- [ ] ${k.tasks[2]}`,
    `- [ ] ${k.tasks[3]}`,
    ...(cards ? [] : [`## ${k.who}`]),
    ...(cards ? links : [`| ${k.table[0][0]} | ${k.table[0][1]} |\n| --- | --- |\n${k.table
      .slice(1)
      .map((r) => `| ${r[0]} | ${r[1]} |`)
      .join('\n')}`]),
  ].join('\n\n');
  const base = { workspaceId: ws, ownerId: U.anna } as const;
  const handbook = w.put({ ...base, title: k.tree.handbook, icon: '📘' }, k.tree.handbook);
  const product = w.put({ ...base, parentId: handbook.id, title: k.tree.product, icon: '🚀' }, k.tree.product);
  const page0 = w.put({ ...base, parentId: product.id, title: k.title, icon: '📤', ...(cover ? { cover } : {}), createdAt: stamp('2026-01-14T09:00:00Z'), updatedAt: stamp('2026-01-15T07:20:00Z'), updatedBy: U.vera, preview: k.intro.slice(0, 80) }, md);
  const onboarding = w.put({ ...base, parentId: handbook.id, title: k.tree.onboarding, icon: '🧭' }, k.tree.onboarding);
  w.put({ ...base, parentId: onboarding.id, title: k.tree.day }, k.tree.day);
  const processes = w.put({ ...base, parentId: handbook.id, title: k.tree.processes, icon: '⚙️', ownerId: U.boris }, k.tree.processes);
  w.put({ ...base, parentId: processes.id, title: k.tree.releases }, k.tree.releases);
  w.put({ ...base, parentId: processes.id, title: k.tree.review, ownerId: U.boris }, k.tree.review);
  w.put({ ...base, parentId: handbook.id, title: k.tree.glossary, icon: '📖', ownerId: U.vera }, k.tree.glossary);
  const meetings = w.put({ ...base, title: k.tree.meetings, icon: '🗓️', ownerId: U.boris }, k.tree.meetings);
  w.put({ ...base, parentId: meetings.id, title: k.tree.retro, ownerId: U.boris }, k.tree.retro);
  w.put({ ...base, title: k.tree.drafts, icon: '📝', restricted: true }, k.tree.drafts);
  await setLocale(page, short);
  await resize(ctx, size);
  await page.getByTestId('section-wiki').click();
  const nodes = page.getByTestId('wiki-node');
  await expect(nodes.first()).toContainText(k.tree.handbook);
  await nodes.filter({ hasText: k.tree.handbook }).first().getByTestId('wiki-node-toggle').click();
  await nodes.filter({ hasText: k.tree.product }).first().getByTestId('wiki-node-toggle').click();
  await nodes.filter({ hasText: k.tree.processes }).first().getByTestId('wiki-node-toggle').click();
  await nodes.filter({ hasText: k.title }).first().click();
  await expect(page.getByTestId('wiki-title')).toHaveValue(k.title);
  await expect(page.locator('.wiki-prose')).toContainText(k.steps);
  await page.waitForTimeout(800);
  const origin = mock.url;
  const peers: WebSocket[] = [];
  const join = async (user: 'boris' | 'vera', where: 'intro' | 'task', offset: number) => {
    const res = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${user}@calaba.test`, password: PASSWORD }) });
    const token = ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
    const sock = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/wiki/pages/${page0.id}/sync`);
    peers.push(sock);
    const doc = new Y.Doc();
    const ready = new Promise<void>((done) => {
      sock.on('message', (data: Buffer) => {
        const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (!f) return;
        if (f.type === FRAME_SNAPSHOT) {
          Y.applyUpdate(doc, f.state);
          done();
        } else if (f.type === FRAME_UPDATE) Y.applyUpdate(doc, f.update);
      });
    });
    await new Promise<void>((r) => sock.once('open', () => r()));
    sock.send(token);
    await ready;
    const frag = doc.getXmlFragment('default');
    const texts = (el: Y.XmlFragment | Y.XmlElement | Y.XmlText): Y.XmlText[] => (el instanceof Y.XmlText ? [el] : (el.toArray() as Array<Y.XmlElement | Y.XmlText>).flatMap(texts));
    const all = frag.toArray() as Y.XmlElement[];
    const target = where === 'intro' ? texts(all[0] as Y.XmlElement)[0] : texts(all.filter((e) => e.nodeName.toLowerCase() === 'tasklist')[2] as Y.XmlElement)[0];
    if (!target) throw new Error(`no caret target ${where} ${all.map((e) => `${e.nodeName}:${e.toArray().length}`).join(',')}`);
    const pos: unknown = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(target, Math.min(offset, target.length)));
    const aw = new Awareness(doc);
    aw.setLocalState({ user: { id: U[user], name: c.people[user].name.split(' ')[0], color: '#8e8e93' }, cursor: { anchor: pos, head: pos } });
    sock.send(encodeAwareness(encodeAwarenessUpdate(aw, [aw.clientID])));
  };
  if (cards) {
    await page.waitForTimeout(1200);
    await page.mouse.move(0, size.height - 1);
    console.log(scene, 'boxes', 'title', await box(page, '[data-testid="wiki-title"]'), 'prose', await box(page, '.wiki-prose'));
    await shoot(ctx, scene);
    return;
  }
  try {
    await join('boris', 'intro', 60);
    await join('vera', 'task', 12);
    await expect(page.locator('.wiki-caret')).toHaveCount(2, { timeout: 10_000 });
    if (scrollBy) await page.locator('.wiki-prose').first().evaluate((el, by) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop = by; break; }
    }, scrollBy);
    await page.mouse.move(0, size.height - 1);
    await page.waitForTimeout(500);
    console.log(scene, 'boxes', 'aside', await box(page, 'aside'), 'content', await box(page, '[data-testid="wiki-title"]'), 'tree', await box(page, '[data-testid="wiki-node"]'), 'title', await box(page, '[data-testid="wiki-title"]'));
    await shoot(ctx, scene);
  } finally {
    for (const p of peers) p.close();
  }
}

/** The retro canvas open and fitted; the voice island below the list; Дина's cursor on a sticky. */
async function canvasScene(ctx: Ctx, scene: string): Promise<void> {
  const { page, mock, c, c4, short } = ctx;
  await openRoom(ctx, c.rooms.general);
  await joinMeeting(ctx);
  await setLocale(page, short);
  await page.getByTestId('section-canvas').click();
  const tree = page.getByTestId('canvas-node');
  await expect(tree.first()).toBeVisible();
  await tree.filter({ hasText: c4.canvas.folder }).first().getByTestId('canvas-node-toggle').click();
  await tree.filter({ hasText: c4.canvas.name }).first().getByTestId('canvas-node-open').click();
  await expect(page.getByTestId('canvas-title')).toHaveText(c4.canvas.name);
  await expect(page.getByTestId('canvas-connecting')).toHaveCount(0);
  await page.getByTestId('canvas-fit-all').click();
  await page.waitForTimeout(900);
  const item = [...mock.canvas.items.values()].find((i) => i.name === c4.canvas.name);
  const stickyId = item ? mock.canvas.objects(item.id).find((o) => o.text === c4.canvas.stickies[7])?.id : undefined;
  if (item) mock.canvas.peer(item.id, 424242, { user: { id: U.dina, name: c.people.dina.name.split(' ')[0] ?? '', color: '#e5484d' }, canvas: { cursor: { x: 520, y: 335 }, selection: stickyId ? [stickyId] : [] } });
  await page.waitForTimeout(500);
  await page.mouse.move(0, 0);
  console.log(scene, 'boxes', 'surface', await box(page, '[data-testid="canvas-surface"]'), 'toolbar', await box(page, '[data-testid="canvas-toolbar"]'), 'aside', await box(page, 'aside'));
  await shoot(ctx, scene);
}

/** Telephony of the workspace with its three live calls and the journal (the settings frames). */
const seedTelephony6: Seed = (mock, c, c4) => seedTelephony(mock, c, c4, true);

/** Settings opened from the title bar; the dialog. */
async function openSettings(ctx: Ctx): Promise<Locator> {
  const { page, short } = ctx;
  await setLocale(page, short);
  await page.getByTestId('titlebar-title').click();
  await page.getByRole('menuitem', { name: SETTINGS[short], exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  console.log('tabs', JSON.stringify(await dialog.getByRole('tab').allInnerTexts()));
  return dialog;
}

/** «Телефония» and one of its segments (0 calls, 1 numbers, 2 groups, 3 IVR, 4 settings). */
async function telephonyTab(ctx: Ctx, segment: number): Promise<Locator> {
  const dialog = await openSettings(ctx);
  await dialog.getByRole('tab').filter({ hasText: /^(Телефония|Telephony|Telefonía|电话)$/ }).click();
  await expect(dialog.getByTestId('sip-tabs')).toBeVisible();
  await dialog.getByTestId('sip-tabs').getByRole('radio').nth(segment).click();
  await setLocale(ctx.page, ctx.short);
  await ctx.page.waitForTimeout(400);
  return dialog;
}

/** A window of the app captured whole; its box (CSS px) is logged — the crop in assets.mjs is that plus its shadow. */
async function modalShot(ctx: Ctx, scene: string, sel = '[role="dialog"]'): Promise<void> {
  await ctx.page.mouse.move(0, 0);
  await ctx.page.waitForTimeout(300);
  console.log(scene, 'dialog box', await box(ctx.page, sel));
  await shoot(ctx, scene);
}

/** An inbound call taken: the island says «Звонок · номер» with «Перевести»; the chat of the day behind. */
async function phoneCallScene(ctx: Ctx, scene: string): Promise<void> {
  const { page, mock, c4 } = ctx;
  await chatRu(ctx);
  mock.ringSipInbound(U.anna, c4.tel.calls[0], c4.tel.groups[0]);
  await page.getByTestId('sip-accept').click();
  await expect(page.getByTestId('sip-transfer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sip-transfer')).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+m`);
  await page.waitForTimeout(800);
  await feedBottom(page);
  await page.mouse.move(0, 0);
  console.log(scene, 'boxes', 'aside', await box(page, 'aside'), 'feed', await box(page, '[data-virtuoso-scroller]'));
  await shoot(ctx, scene);
}

const scenes: Record<string, Scene> = {
  // «Переговорка»: Вера shares her browser, Борис and Григорий on camera, my own camera, Дина listening (as landing.spec.ts «voice»;
  // this file re-takes it for the phones' capture, <scene>-focus).
  voice: {
    focus: { size: { width: 1049, height: 599 } },
    async run(ctx, f) {
      const { page, mock, c } = ctx;
      await openRoom(ctx, c.rooms.general);
      await fakeCamera(page, cameraPhoto('anna'));
      await joinMeeting(ctx);
      await aside(page).getByTestId('voice-status-row').click();
      await aside(page).getByTestId('voice-status-input').fill(c.voiceStatus);
      await aside(page).getByTestId('voice-status-input').press('Enter');
      inRoom(mock, 'dina', { muted: true });
      await page.getByTestId('camera-button').click();
      await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('camera-preview-enable').click();
      await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      for (const k of ['boris', 'grigory'] as const) {
        ctx.pubs.push(await startPublisher({ userId: U[k], name: c.people[k].name, roomId: R.meeting, source: 'camera', image: cameraPhoto(k) }));
        inRoom(mock, k, { camera: true, muted: k === 'grigory' });
      }
      ctx.pubs.push(await startPublisher({ userId: U.vera, name: c.people.vera.name, roomId: R.meeting, image: heroStream() }));
      inRoom(mock, 'vera', { streaming: true });
      const stage = page.getByTestId('stream-stage').or(page.getByTestId('stream-pip'));
      const chip = page.getByRole('button', { name: c.people.vera.name, exact: true });
      await expect(stage.or(chip).first()).toBeVisible({ timeout: 30_000 });
      if ((await stage.count()) === 0) await chip.first().click();
      const expand = page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' });
      if (await expand.count()) await expand.first().click();
      await expect(page.getByTestId('stream-stage')).toBeVisible();
      await expect.poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
      await speaking(page, [U.boris]);
      await setLocale(page, ctx.short);
      await page.waitForTimeout(1500);
      await shoot(ctx, tag('voice', f));
    },
  },

  // «общий»: the pinned note, the request, a reply with a quote, reactions, a voice note, a sticker, the task card, the composer.
  'chat-full': {
    seed: storySeed,
    focus: { size: { width: 1049, height: 599 }, ui: { membersPanel: false }, seed: storyCompact },
    async run(ctx, f) {
      await chatRu(ctx);
      console.log(tag('chat-full', f), 'boxes', 'aside', await box(ctx.page, 'aside'), 'feed', await box(ctx.page, '[data-virtuoso-scroller]'), 'composer', await box(ctx.page, '[data-testid="composer"]'));
      await shoot(ctx, tag('chat-full', f));
    },
  },

  // The same chat, the panel only: the window as wide as the chat column without the members' list (940 px).
  'chat-focus': {
    seed: storyCompact,
    ui: { membersPanel: false },
    size: { width: 1189, height: 577 },
    async run(ctx) {
      await chatRu(ctx);
      console.log('chat-focus boxes', 'aside', await box(ctx.page, 'aside'), 'feed', await box(ctx.page, '[data-virtuoso-scroller]'), 'composer', await box(ctx.page, '[data-testid="composer"]'));
      await shoot(ctx, 'chat-focus');
    },
  },

  // «Продукт»: four columns of 3–4 cards, filters, the story's APP-7 in «В работе».
  'kanban-full': {
    seed: storySeed,
    ui: { sidebarWidth: 200 },
    // The phones' capture: the columns under the board's header (its title and toolbar do not fit 720 px).
    focus: { size: { width: 1049, height: 649 }, ui: {} },
    async run(ctx, f) {
      await openBoards(ctx);
      await ctx.page.mouse.move(0, 0);
      await shoot(ctx, tag('kanban-full', f));
    },
  },

  // The week with the review meeting (the room, «now» line, the mini month).
  'calendar-week': {
    seed: weekSeed,
    ui: { membersPanel: false, sidebarWidth: 232 },
    focus: { size: { width: 1049, height: 599 }, ui: { membersPanel: false } },
    async run(ctx, f) {
      const { page, short } = ctx;
      await setLocale(page, short);
      const mini = page.getByTestId('mini-calendar');
      if (!(await mini.isVisible())) await page.getByTestId('section-calendar').click();
      await mini.locator('[data-cal-day="2026-01-15"]').click();
      // The phones' capture is the day (a week of 7 columns does not fit 720 px).
      await page.getByTestId('cal-view').getByRole('radio').nth(f ? 1 : 0).click();
      const week = page.getByTestId(f ? 'day-view' : 'week-view');
      await expect(week).toBeVisible();
      await expect(week.getByTestId('now-line')).toBeVisible();
      if (!f) await expect(week.getByTestId('event-block')).toHaveCount(ctx.c4.week.length + 7);
      await page.waitForTimeout(500);
      await page.mouse.move(0, 0);
      await shoot(ctx, tag('calendar-week', f));
    },
  },

  // The retro canvas «Ретро спринта 12» (hero 6): stickies of three colours, shapes, arrows, a finished vote, the timer,
  // Дина's cursor, the voice island (I am in «Переговорка»).
  canvas: {
    seed: (mock, _c, c4) => {
      seedStoryCanvas(mock, c4);
      inRoom(mock, 'boris');
      inRoom(mock, 'dina', { muted: true });
    },
    focus: { size: { width: 1053, height: 599 } },
    async run(ctx, f) {
      await canvasScene(ctx, tag('canvas', f));
    },
  },

  // The same canvas for the catalogue (860 × 538, the surface only).
  'canvas-panel': {
    seed: (mock, _c, c4) => {
      seedStoryCanvas(mock, c4);
      inRoom(mock, 'boris');
      inRoom(mock, 'dina', { muted: true });
    },
    size: { width: 1193, height: 577 },
    async run(ctx) {
      await canvasScene(ctx, 'canvas-panel');
    },
  },

  // A phone call taken in the app: «Звонок · +7 916 …», «Перевести» (hero 7), the chat of the day behind.
  'phone-call': {
    seed: (mock, c, c4) => {
      storySeed(mock, c, c4);
      seedTelephony(mock, c, c4, false);
    },
    focus: { size: { width: 1053, height: 599 }, ui: { membersPanel: false } },
    async run(ctx, f) {
      await phoneCallScene(ctx, tag('phone-call', f));
    },
  },

  // An incoming call to the team's number, ringing in the app (hero «Телефония и IVR», story 8): the call sheet
  // over the chat of the day, before it is answered.
  'phone-incoming': {
    seed: (mock, c, c4) => {
      storySeed(mock, c, c4);
      seedTelephony(mock, c, c4, false);
    },
    async run(ctx) {
      const { page, mock, c4 } = ctx;
      await chatRu(ctx);
      mock.ringSipInbound(U.anna, c4.tel.calls[0], c4.tel.groups[0]);
      await expect(page.getByTestId('sip-accept')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(900);
      await page.mouse.move(0, 0);
      console.log('phone-incoming boxes', 'accept', await box(page, '[data-testid="sip-accept"]'), 'dialog', await box(page, '[role="dialog"]'));
      await shoot(ctx, 'phone-incoming');
    },
  },

  // The sidebar with the call island and the top of the chat (940 px, from the rail's edge).
  'phone-call-panel': {
    seed: (mock, c, c4) => {
      storyCompact(mock, c, c4);
      seedTelephony(mock, c, c4, false);
    },
    ui: { membersPanel: false },
    size: { width: 933, height: 577 },
    async run(ctx) {
      await phoneCallScene(ctx, 'phone-call-panel');
    },
  },

  // Settings → «Телефония» → «IVR»: two menus, «Новое меню».
  'telephony-ivr': {
    seed: seedTelephony6,
    async run(ctx) {
      const dialog = await telephonyTab(ctx, 3);
      await expect(dialog.getByTestId('sip-menu-row')).toHaveCount(2);
      await dialog.getByTestId('sip-menu-add').scrollIntoViewIfNeeded();
      await modalShot(ctx, 'telephony-ivr');
    },
  },

  // «Группы»: «Продажи — все сразу, 20 с → Поддержка», «Поддержка — по очереди».
  'telephony-groups': {
    seed: seedTelephony6,
    async run(ctx) {
      const dialog = await telephonyTab(ctx, 2);
      await expect(dialog.getByTestId('sip-group-row')).toHaveCount(2);
      await modalShot(ctx, 'telephony-groups');
    },
  },

  // «Активные звонки»: the menu → the group → the talk, and the journal under them.
  'telephony-call': {
    seed: seedTelephony6,
    async run(ctx) {
      const dialog = await telephonyTab(ctx, 0);
      await expect(dialog.getByTestId('sip-call-row')).toHaveCount(3);
      await expect(dialog.getByTestId('sip-journal-row').first()).toBeVisible();
      await modalShot(ctx, 'telephony-call');
    },
  },

  // Settings → «Роли» → the custom role: the permission matrix and its members.
  roles: {
    seed: seedRoles,
    async run(ctx) {
      const { page, short, c4 } = ctx;
      const dialog = await openSettings(ctx);
      await dialog.getByRole('tab').filter({ hasText: /^(Роли|Roles|角色)$/ }).click();
      await dialog.getByRole('button', { name: c4.role.name, exact: true }).click();
      await expect(dialog.getByTestId('role-title')).toHaveText(c4.role.name);
      await expect(dialog.getByTestId('role-member')).toHaveCount(2);
      await setLocale(page, short);
      await modalShot(ctx, 'roles');
    },
  },

  // «Временная комната»: the result with the link and the term (1 day).
  'temp-room': {
    async run(ctx) {
      const { page, short, c4 } = ctx;
      await setLocale(page, short);
      await page.getByTestId('sidebar-create').click();
      await page.getByRole('menuitem', { name: /^(Временная комната|Temporary room|Sala temporal|临时房间)$/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').first().fill(c4.temp.name);
      await dialog.getByRole('radio').nth(3).click();
      await dialog.getByRole('button').last().click();
      await expect(dialog.getByTestId('temp-room-result')).toBeVisible();
      // The link carries the mock's random port: a real-looking address instead.
      await dialog.locator('input[readonly]').first().evaluate((el) => {
        const input = el as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'https://app.calab.io/r/k7m2x9qf');
      });
      await modalShot(ctx, 'temp-room');
    },
  },

  // The meeting room's chat: a recording card — a three-line summary, the audio, «Транскрипт».
  'recording-focus': {
    seed: (mock, _c, c4) => {
      seedRecordingText(c4);
      mock.injectRecordingCard({ roomId: R.meeting, byUserId: U.boris, durationSec: 42 * 60 + 10, status: RecordingStatus.DONE, webUrl: 'https://gptunnel.example/meetings/1', result: true });
    },
    ui: { membersPanel: false },
    size: { width: 1189, height: 577 },
    async run(ctx) {
      const { page, c, short } = ctx;
      await setLocale(page, short);
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
      await expect(page.getByTestId('recording-card')).toBeVisible();
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.dev) }).first().click();
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
      await expect(page.getByTestId('recording-card')).toBeVisible();
      await feedBottom(page);
      await page.mouse.move(0, 0);
      await shoot(ctx, 'recording-focus');
    },
  },

  // The transcript dialog with a search that finds two remarks.
  'recording-transcript': {
    seed: (mock, _c, c4) => {
      seedRecordingText(c4);
      mock.injectRecordingCard({ roomId: R.meeting, byUserId: U.boris, durationSec: 42 * 60 + 10, status: RecordingStatus.DONE, webUrl: 'https://gptunnel.example/meetings/1', result: true });
    },
    async run(ctx) {
      const { page, c, c4, short } = ctx;
      await setLocale(page, short);
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.dev) }).first().click();
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
      const card = page.getByTestId('recording-card');
      await expect(card).toBeVisible();
      await card.getByRole('button').filter({ has: page.locator('svg') }).first().isVisible();
      await card.getByTestId('recording-card-transcript').click();
      const dialog = page.getByRole('dialog');
      const rows = dialog.getByTestId('recording-transcript-row');
      await expect(rows.first()).toBeVisible();
      await dialog.getByRole('textbox').first().fill(c4.rec.query);
      await expect(rows).toHaveCount(2);
      await modalShot(ctx, 'recording-transcript');
    },
  },

  // «Умная задача»: the text, two files, the priority.
  aitask: {
    seed: (mock, c, c4) => {
      storySeed(mock, c, c4);
      const ws = IDS.workspaces.main;
      mock.setPlanKind(ws, Plan.ENTERPRISE);
      mock.setAiState(ws, AiState.READY);
    },
    async run(ctx) {
      const { page, c4 } = ctx;
      await openBoards(ctx);
      await page.getByTestId('section-create-board').click();
      await page.getByTestId('boards-create-smart').click();
      const dialog = page.getByTestId('smart-task');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('smart-task-text').fill(c4.ai.text);
      await dialog.locator('input[type=file]').setInputFiles([
        { name: c4.ai.files[0], mimeType: 'application/pdf', buffer: pdfBytes(c4.ai.files[0]) },
        { name: c4.ai.files[1], mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') },
      ]);
      await page.waitForTimeout(500);
      await modalShot(ctx, 'aitask', '[data-testid="smart-task"]');
    },
  },

  // The rail with its sections and badges.
  rail: {
    seed: storySeed,
    async run(ctx) {
      const { page, mock, c4, short } = ctx;
      for (const [i, name] of c4.apps.entries()) {
        const icon = await render(ctx.browser, appIconHtml(i ? 'support' : 'sales'), 128, 128, { transparent: true });
        const fileId = `00000000-0000-7000-8000-00000000a1${i + 1}`;
        mock.state.files.set(fileId, {
          meta: fileMeta(fileId, IDS.workspaces.main, U.anna, `app${i}.png`, 'image/png', icon, timestampFromMs(NOW.getTime() - 5 * 86_400_000), { width: 128, height: 128 }),
          bytes: icon,
          thumbnail: { bytes: icon, mime: 'image/png' },
        });
        mock.dispatch({
          event: {
            case: 'workspaceAppUpsert',
            value: { app: create(WorkspaceAppSchema, { id: `00000000-0000-7000-8000-00000000a0${i + 1}`, workspaceId: IDS.workspaces.main, name, url: 'https://sales.example/app', iconFileId: fileId, iconUrl: `/api/files/${fileId}`, position: i + 1, createdBy: U.anna, createdAt: timestampFromMs(NOW.getTime() - 5 * 86_400_000), updatedAt: timestampFromMs(NOW.getTime() - 5 * 86_400_000) }) },
          },
        });
      }
      await setLocale(page, short);
      await expect(page.getByTestId('rail-app')).toHaveCount(2, { timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.mouse.move(700, 450);
      console.log('rail boxes', 'aside', await box(page, 'aside'));
      await shoot(ctx, 'rail');
    },
  },

  // One request, five frames: the message with the hover bar and «Создать задачу» in its menu.
  'story-message': {
    seed: storySeed,
    ui: { membersPanel: false },
    size: { width: 1189, height: 899 },
    async run(ctx) {
      const { page, c4 } = ctx;
      await chatRu(ctx);
      const msg = page.locator('[data-message-id]').filter({ hasText: c4.chat.request }).first();
      await msg.hover();
      // The menu opens at the pointer, right of the bubble (not over its text).
      const text = msg.getByText(c4.chat.request).first();
      const tb = await text.boundingBox();
      if (!tb) throw new Error('no text');
      await text.click({ button: 'right', position: { x: tb.width - 4, y: tb.height / 2 } });
      const item = page.getByRole('menuitem', { name: /^(Создать задачу|Create task|Crear tarea|创建任务)$/ });
      await expect(item).toBeVisible();
      await item.hover();
      await msg.hover();
      await item.hover();
      await page.waitForTimeout(300);
      console.log('story-message boxes', 'msg', await box(page, `[data-message-id="${await msg.getAttribute('data-message-id')}"]`), 'menu', await box(page, '[role="menu"]'));
      await shoot(ctx, 'story-message', true);
    },
  },

  // The task made of it: APP-7 in the panel — the executor, the date, the checklist 2/4, the approver.
  'story-task': {
    seed: storySeed,
    size: { width: 1189, height: 899 },
    async run(ctx) {
      const { page, c4 } = ctx;
      await openBoards(ctx);
      await page.getByTestId('task-card').filter({ hasText: c4.task.title }).getByTestId('card-title').click();
      const panel = page.getByTestId('task-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('checklist-title').first()).toBeVisible();
      await setLocale(page, ctx.short);
      await page.waitForTimeout(500);
      await page.mouse.move(0, 0);
      console.log('story-task boxes', 'panel', await box(page, '[data-testid="task-panel"]'));
      await shoot(ctx, 'story-task');
    },
  },

  // The review in the calendar: the meeting room, four invited with their answers.
  'story-meeting': {
    seed: weekSeed,
    ui: { membersPanel: false },
    async run(ctx) {
      const { page, c4, short } = ctx;
      await setLocale(page, short);
      const mini = page.getByTestId('mini-calendar');
      if (!(await mini.isVisible())) await page.getByTestId('section-calendar').click();
      await mini.locator('[data-cal-day="2026-01-15"]').click();
      await page.getByTestId('event-block').filter({ hasText: c4.meeting.title }).first().click();
      await expect(page.getByTestId('event-panel').getByTestId('event-title')).toHaveText(c4.meeting.title);
      await setLocale(page, short);
      await page.waitForTimeout(500);
      await page.mouse.move(0, 0);
      console.log('story-meeting boxes', 'panel', await box(page, '[data-testid="event-panel"]'));
      await shoot(ctx, 'story-meeting');
    },
  },

  // The wiki page with the task's card and the retro canvas' card.
  'story-wiki': {
    seed: (mock, c, c4) => {
      storySeed(mock, c, c4);
      seedStoryCanvas(mock, c4);
    },
    async run(ctx) {
      await storyWikiScene(ctx);
    },
  },

  // The retro canvas on the phone: opened in view mode, «Править» in the header.
  'phone-canvas': {
    phone: true,
    seed: (mock, _c, c4) => {
      seedStoryCanvas(mock, c4, true);
    },
    async run(ctx) {
      const { page, short, c4 } = ctx;
      await setLocale(page, short);
      await page.reload();
      await insets(page);
      await expect(page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('phone-tab-more').tap();
      await page.getByTestId('more-row-canvas').tap();
      await page.getByTestId('phone-canvas-row').filter({ hasText: c4.canvas.folder }).getByRole('button').tap();
      await page.getByTestId('phone-canvas-row').filter({ hasText: c4.canvas.name }).getByRole('button').tap();
      const screen = page.getByTestId('phone-canvas-screen');
      const view = screen.getByTestId('canvas-view');
      await expect(view.getByTestId('canvas-zoom')).toBeVisible();
      await expect(screen.getByTestId('phone-canvas-edit')).toBeVisible();
      await page.waitForTimeout(800);
      await view.getByTestId('canvas-fit-all').tap();
      await page.waitForTimeout(900);
      await shoot(ctx, 'phone-canvas');
    },
  },

  // The timeline (for the phones' capture, timeline-focus): the week scale.
  timeline: {
    seed: storySeed,
    focus: { size: { width: 1053, height: 649 } },
    async run(ctx, f) {
      const { page, short } = ctx;
      await openBoards(ctx);
      await page.keyboard.press('3');
      await expect(page.getByTestId('timeline')).toBeVisible();
      await page.getByText({ ru: 'Неделя', en: 'Week', es: 'Semana', zh: '周' }[short], { exact: true }).first().click({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await page.mouse.move(0, 0);
      await shoot(ctx, tag('timeline', f));
    },
  },

  'wiki-full': {
    focus: { size: { width: 1053, height: 649 } },
    async run(ctx, f) {
      await wikiScene(ctx, tag('wiki-full', f), f ? { width: 1053, height: 649 } : { width: 1440, height: 900 }, f ? 40 : 0);
    },
  },

  'wiki-focus': {
    async run(ctx) {
      await wikiScene(ctx, 'wiki-focus', { width: 1193, height: 577 }, 100);
    },
  },
};

/** The scenes whose crop is the whole window: captured from the real app window (app-window.ts), traffic lights included. */
const WINDOW = new Set(['voice', 'chat-full', 'kanban-full', 'calendar-week', 'canvas', 'phone-call', 'phone-incoming', 'wiki-full']);

const only = process.env['CALABA_V6_SCENES']?.split(',').map((s) => s.trim());

for (const [name, scene] of Object.entries(scenes)) {
  for (const f of scene.focus ? [false, true] : [false]) {
    const raw = tag(name, f);
    if (only && !only.includes(raw)) continue;
    for (const short of LOCALES) {
      test(`landing v6 ${raw} ${short}`, async () => {
        test.setTimeout(Number(process.env['CALABA_V6_TIMEOUT'] ?? 240_000));
        process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${PREFIX}v6_${raw}_${short}_${Date.now().toString(36)}_`;
        let ctx: Ctx | undefined;
        const size = f ? scene.focus?.size : scene.size;
        const ui = f ? scene.focus?.ui ?? scene.ui : scene.ui;
        try {
          ctx = await boot(short, f ? scene.focus?.seed ?? scene.seed : scene.seed, { phone: scene.phone ?? false, window: !f && WINDOW.has(name), ...(size ? { size } : {}), ...(ui ? { ui } : {}) });
          await scene.run(ctx, f);
        } finally {
          await shutdown(ctx);
        }
      });
    }
  }
}
