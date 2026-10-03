import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { BoardTemplate, Plan, WorkspacePlanSchema } from '@calaba/protocol';
import { ENTERPRISE_PLAN_LIMITS, IDS } from '../e2e-support/fixtures';
import type { MockServer } from '../e2e-support/mock-server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Copy } from './copy';
import type { Copy2 } from './copy2';
import { msk } from './seed';

/**
 * Calab 2.0 scene data on top of seedScene / seedBoard (landing-v2.spec.ts): board categories and
 * a few more boards, checklists with progress on the cards, the Business plan and a board webhook,
 * the built-in sticker pack. Deterministic: the clock is the visual tests' NOW.
 */
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../server/internal/builtinstickers/manifest.json'), 'utf8')) as { id: string; name: string; stickers: { id: string; name: string; emoji: string }[] };
const U = IDS.users;
const W = IDS.workspaces;

/** «Продукт» (APP) and a few siblings sorted into two categories; checklists on cards (the open task: 3/7). */
export function seedBoardsV2(mock: MockServer, c: Copy, c2: Copy2): void {
  const b = mock.boards;
  // The default seed's own categories / checklists / webhooks are not part of the story.
  b.categories.clear();
  b.checklists.clear();
  b.webhooks.clear();
  const anna = U.anna;
  const app = [...b.boards.values()].find((r) => r.board.key === 'APP');
  const mkt = [...b.boards.values()].find((r) => r.board.key === 'MKT');
  if (!app || !mkt) throw new Error('seedBoard first');
  const platform = b.createBoard(W.main, anna, { name: c2.platformBoard, key: 'PLT', emoji: '🧱', isPrivate: false, description: '', template: BoardTemplate.DEVELOPMENT });
  const content = b.createBoard(W.main, anna, { name: c2.contentBoard, key: 'CNT', emoji: '✍️', isPrivate: false, description: '', template: BoardTemplate.SIMPLE });
  const dev = b.createCategory(W.main, anna, { name: c2.categories.dev });
  const marketing = b.createCategory(W.main, anna, { name: c2.categories.marketing });
  b.setOrder(W.main, anna, {
    boards: [
      { boardId: app.board.id, categoryId: dev.id, position: 0 },
      { boardId: platform.board.id, categoryId: dev.id, position: 1 },
      { boardId: mkt.board.id, categoryId: marketing.id, position: 0 },
      { boardId: content.board.id, categoryId: marketing.id, position: 1 },
    ],
    categories: [],
  });

  const tasks = [...b.tasks.values()].filter((t) => t.task.boardId === app.board.id && !t.task.parentId);
  const byTitle = (title: string) => tasks.find((t) => t.task.title === title);
  const fill = (title: string, lists: { title: string; items: string[]; done: number }[]): void => {
    const t = byTitle(title);
    if (!t) throw new Error(`no task ${title}`);
    for (const l of lists) {
      const id = b.createChecklist(t.task.id, anna, { title: l.title }).checklist?.id ?? '';
      for (const text of l.items) b.addChecklistItem(id, anna, { text });
      const ch = b.checklists.get(t.task.id)?.find((x) => x.id === id);
      ch?.items.slice(0, l.done).forEach((it, i) => b.updateChecklistItem(it.id, i % 2 ? U.boris : anna, { done: true }));
    }
  };
  fill(c.board.tasks[4]?.title ?? '', [...c2.checklists]);
  for (const [i, l] of Object.entries(c2.cardLists)) fill(c.board.tasks[Number(i)]?.title ?? '', [l]);
  for (const t of b.tasks.values()) t.unread.clear();
}

/** Business plan on the main workspace (board webhooks) and a working webhook on «Продукт». */
export function seedWebhook(mock: MockServer, _c: Copy, c2: Copy2): void {
  const w = mock.state.workspaces.get(W.main);
  if (w) w.plan = create(WorkspacePlanSchema, { plan: Plan.ENTERPRISE, limits: ENTERPRISE_PLAN_LIMITS, validUntil: timestampFromMs(Date.parse('2026-12-31T23:59:59Z')), expired: false });
  const b = mock.boards;
  const app = [...b.boards.values()].find((r) => r.board.key === 'APP');
  if (!app) throw new Error('seedBoard first');
  b.setWebhook(app.board.id, U.anna, { url: c2.webhookUrl, secret: '' });
  const h = b.webhooks.get(app.board.id)?.hook;
  if (h) {
    h.createdAt = timestampFromMs(msk('10:05', '2026-01-13'));
    h.updatedAt = h.createdAt;
    h.lastOkAt = timestampFromMs(msk('13:12'));
  }
}

/** The global «Calab Stikers» (ADR-0057) in the mock, the first sticker of the pack in the chat. */
export function seedBuiltinStickers(mock: MockServer): void {
  mock.addBuiltinStickerPack(manifest);
}

const STICKER = (name: string): string => manifest.stickers.find((x) => x.name === name)?.id ?? '';

/** «общий»: a short release-morning thread where the team answers with built-in stickers. */
export function seedStickerChat(mock: MockServer, c: Copy): void {
  seedBuiltinStickers(mock);
  const room = IDS.rooms.general;
  mock.state.messages.set(room, []);
  const post = (k: keyof typeof U, hhmm: string, content: string, stickerId = ''): void => {
    const m = mock.injectMessage({ roomId: room, authorId: U[k], content, ...(stickerId ? { stickerId } : {}) });
    m.createdAt = timestampFromMs(msk(hhmm));
  };
  post('boris', '10:02', c.chat.kickoff);
  post('vera', '10:03', '', STICKER('fire'));
  post('grigory', '10:04', '', STICKER('clap'));
  post('dina', '10:05', c.chat.report);
  post('anna', '10:06', '', STICKER('cool'));
  post('boris', '10:07', '', STICKER('thanks'));
  const last = (rid: string): string => mock.state.messages.get(rid)?.at(-1)?.id ?? '';
  for (const k of ['anna', 'boris', 'vera', 'grigory', 'dina'] as const) mock.state.readStates.get(U[k])?.set(room, last(room));
}
