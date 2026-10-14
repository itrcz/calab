import { create, type JsonObject } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskActivitySchema, TaskPriority, type TaskActivity } from '@calaba/protocol';
import { describe as group, expect, it } from 'vitest';
import { clip, describe, formatDay, groupByDay, historyPage, mergeHistory, type HistoryCtx } from './history';

const NOW = new Date(2026, 0, 15, 12, 0);

const ctx: HistoryCtx = {
  member: (id) => ({ anna: 'Анна Смирнова', boris: 'Борис', vera: 'Вера' })[id] ?? 'Неизвестный',
  status: (id) => ({ s1: 'To Do', s2: 'В работе' })[id],
  label: (id) => ({ l1: { name: 'Баг', color: 0xff0000 }, l2: { name: 'Фича', color: 0x00ff00 } })[id],
  milestone: (id) => ({ m1: 'Релиз 1.0' })[id],
  taskMilestone: (parent, id) => (parent === 'p' && id === 'tm' ? 'Бета' : undefined),
  task: (id) => (id === 't5' ? { id, key: 'CAL-5', title: 'Карточки' } : undefined),
  estimate: (n) => `${n} б.`,
};

let seq = 0;
function act(kind: string, before: JsonObject | null, after: JsonObject | null, p: { actorId?: string; at?: number; id?: string } = {}): TaskActivity {
  seq++;
  return create(TaskActivitySchema, {
    id: p.id ?? `a${String(seq).padStart(3, '0')}`,
    taskId: 't1',
    actorId: p.actorId ?? 'anna',
    kind,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    createdAt: timestampFromMs(p.at ?? NOW.getTime()),
  });
}

const text = (a: TaskActivity): string => describe(a, ctx, NOW).text;

group('history: the action sentence names the field and the values', () => {
  it('created, archived, restored, unknown', () => {
    expect(text(act('created', null, { title: 'x' }))).toBe('создал(а) задачу');
    expect(text(act('archived', null, null))).toBe('архивировал(а) задачу');
    expect(text(act('restored', null, null))).toBe('восстановил(а) задачу');
    expect(text(act('something_new', null, null))).toBe('изменил(а) задачу');
  });

  it('status, priority, estimate', () => {
    expect(text(act('status', { status_id: 's1' }, { status_id: 's2' }))).toBe('статус: To Do → В работе');
    expect(text(act('status', { status_id: 'gone' }, { status_id: 's2' }))).toBe('статус: — → В работе');
    expect(text(act('priority', { priority: TaskPriority.MEDIUM }, { priority: TaskPriority.URGENT }))).toBe('приоритет: Средний → Срочно');
    expect(text(act('estimate', { estimate: 3 }, { estimate: 5 }))).toBe('оценка: 3 б. → 5 б.');
    expect(text(act('estimate', { estimate: null }, { estimate: 2 }))).toBe('оценка: — → 2 б.');
  });

  it('dates: only what changed', () => {
    expect(text(act('dates', { start_on: null, due_on: '2026-01-12' }, { start_on: null, due_on: '2026-01-20' }))).toBe(`срок: ${formatDay('2026-01-12', NOW)} → ${formatDay('2026-01-20', NOW)}`);
    expect(text(act('dates', { start_on: '2026-01-10', due_on: null }, { start_on: null, due_on: null }))).toBe(`старт: ${formatDay('2026-01-10', NOW)} → —`);
    expect(formatDay('2026-01-12', NOW)).toMatch(/^12 янв/);
    expect(formatDay('2025-03-01', NOW)).toMatch(/2025/);
  });

  it('title: quoted values and a diff', () => {
    const e = describe(act('title', { title: 'старый' }, { title: 'новый' }), ctx, NOW);
    expect(e.text).toBe('заголовок: «старый» → «новый»');
    expect(e.detail?.diff).toEqual({ before: 'старый', after: 'новый', diffable: true });
  });

  it('description: counters from the texts, plain without them (older entries)', () => {
    const e = describe(act('description', { length: 5, text: 'Шаги в комментариях' }, { length: 9, text: 'Шаги в описании' }), ctx, NOW);
    expect(e.text).toMatch(/^описание изменено \(\+\d+ \/ −\d+\)$/);
    expect(e.detail?.diff?.before).toBe('Шаги в комментариях');
    expect(text(act('description', { length: 5 }, { length: 9 }))).toBe('изменил(а) описание');
    const long = describe(act('description', { text: 'a'.repeat(15_000) }, { text: 'b'.repeat(15_001) }), ctx, NOW);
    expect(long.detail?.diff?.diffable).toBe(false);
    expect(long.text).toBe('описание изменено (+1 / −0)');
  });

  it('assignees: ±, the lead, the notes', () => {
    const e = describe(act('assignees', { assignees: [{ user_id: 'boris', is_lead: true }] }, { assignees: [{ user_id: 'anna', is_lead: true }] }), ctx, NOW);
    expect(e.text).toBe('исполнители: +Анна Смирнова, −Борис');
    expect(e.detail?.added?.map((c) => c.id)).toEqual(['anna']);
    expect(e.detail?.removed?.map((c) => c.id)).toEqual(['boris']);
    expect(text(act('assignees', { assignees: [{ user_id: 'anna', is_lead: true }, { user_id: 'boris', is_lead: false }] }, { assignees: [{ user_id: 'anna', is_lead: false }, { user_id: 'boris', is_lead: true }] }))).toBe(
      'ответственный: Анна Смирнова → Борис',
    );
    expect(text(act('assignees', { assignees: [{ user_id: 'anna', is_lead: true, note: '' }] }, { assignees: [{ user_id: 'anna', is_lead: true, note: 'Аудио' }] }))).toBe('за что отвечает: Анна Смирнова');
  });

  it('watchers and approvers (with the quorum)', () => {
    expect(text(act('watchers', { user_ids: ['vera'] }, { user_ids: ['boris'] }))).toBe('наблюдатели: +Борис, −Вера');
    expect(text(act('approvers', { user_ids: [], required: 0 }, { user_ids: ['anna', 'boris'], required: 1 }))).toBe('согласующие: +Анна Смирнова, +Борис, нужно 1 из 2');
    expect(text(act('approvers', { user_ids: ['anna', 'boris'], required: 0 }, { user_ids: ['anna', 'boris'], required: 1 }))).toBe('нужно 1 из 2');
  });

  it('labels: snapshots first, the board by id for older entries', () => {
    const snap = describe(act('labels', { label_ids: ['l9'], labels: [{ id: 'l9', name: 'Удалённый', color: 1 }] }, { label_ids: ['l1'], labels: [{ id: 'l1', name: 'Баг', color: 2 }] }), ctx, NOW);
    expect(snap.text).toBe('лейблы: +Баг, −Удалённый');
    expect(snap.detail?.added?.[0]).toMatchObject({ kind: 'label', color: 2 });
    expect(text(act('labels', { label_ids: ['l2'] }, { label_ids: ['l1'] }))).toBe('лейблы: +Баг, −Фича');
  });

  it('attachments: names from the snapshots, counts without them', () => {
    const e = describe(act('attachments', { file_ids: ['f1'], files: [{ file_id: 'f1', name: 'old.png', size: 10, mime: 'image/png' }] }, { file_ids: ['f2'], files: [{ file_id: 'f2', name: 'отчёт.pdf', size: 20, mime: 'application/pdf' }] }), ctx, NOW);
    expect(e.text).toBe('вложения: +отчёт.pdf, −old.png');
    expect(text(act('attachments', { file_ids: [] }, { file_ids: ['f1', 'f2'] }))).toBe('вложения: 0 → 2');
  });

  it('milestone: snapshot name, fallback by id, set / cleared', () => {
    expect(text(act('milestone', { milestone_id: null }, { milestone_id: 'm1' }))).toBe('веха: Релиз 1.0');
    expect(text(act('milestone', { milestone_id: 'm1', name: 'Релиз 1.0' }, { milestone_id: null }))).toBe('веха снята: Релиз 1.0');
    expect(text(act('milestone', { milestone_id: 'mx', name: 'Альфа' }, { milestone_id: 'm1', name: 'Релиз 1.0' }))).toBe('веха: Альфа → Релиз 1.0');
  });

  it('parent and relation: key and title from the snapshot or the store', () => {
    const p = describe(act('parent', { parent_id: null }, { parent_id: 't3', key: 'CAL-3', title: 'Эхо в звонке' }), ctx, NOW);
    expect(p.text).toBe('родитель: CAL-3 «Эхо в звонке»');
    expect(p.detail?.tasks).toEqual([{ ref: { id: 't3', key: 'CAL-3', title: 'Эхо в звонке' }, removed: false }]);
    expect(text(act('parent', { parent_id: 't5' }, { parent_id: null }))).toBe('родитель снят: CAL-5 «Карточки»');
    expect(text(act('relation', null, { related_id: 't5', kind: 'blocks' }))).toBe('связь: блокирует CAL-5');
    expect(text(act('relation', { related_id: 't7', kind: 2, key: 'MKT-1', title: 'Пост' }, null))).toBe('связь убрана: связана с MKT-1');
  });

  it('moved board, approvals', () => {
    expect(text(act('moved_board', { board_id: 'b1', key: 'CAL-3' }, { board_id: 'b2', key: 'MKT-4' }))).toBe('перенёс(ла) задачу: CAL-3 → MKT-4');
    expect(text(act('moved_board', { board_id: 'b1' }, { board_id: 'b2' }))).toBe('перенёс(ла) задачу на другую доску');
    expect(text(act('approval', {}, { state: 'approved', comment: '' }))).toBe('согласовал(а)');
    const r = describe(act('approval', {}, { state: 'rejected', comment: 'Нет тестов' }), ctx, NOW);
    expect(r.text).toBe('отклонил(а): «Нет тестов»');
    expect(r.detail?.note).toBe('Нет тестов');
    expect(text(act('approval', {}, { state: 'pending' }))).toBe('отозвал(а) своё решение');
    expect(text(act('approvals_reset', { approved: 1 }, null))).toBe('согласование началось заново: задачу изменили');
  });

  it('comments: new, edited (diff and ± files), deleted (own and someone else’s)', () => {
    const c = describe(act('comment', null, { message_id: 'm1', text: 'Проверил на Mac', attachments: [{ file_id: 'f1', name: 'log.txt', size: 5, mime: 'text/plain' }] }), ctx, NOW);
    expect(c.text).toBe('комментарий: «Проверил на Mac»');
    expect(c.detail?.quote).toEqual({ text: 'Проверил на Mac', files: [{ id: 'f1', name: 'log.txt', size: 5, mime: 'text/plain' }] });
    expect(text(act('comment', null, { message_id: 'm1', text: '', attachments: [{ file_id: 'f1', name: 'log.txt' }] }))).toBe('комментарий: log.txt');
    const e = describe(
      act('comment_edit', { message_id: 'm1', text: 'было так', attachments: [{ file_id: 'f1', name: 'a.png' }] }, { message_id: 'm1', text: 'стало так', attachments: [{ file_id: 'f2', name: 'b.png' }] }),
      ctx,
      NOW,
    );
    expect(e.text).toBe('изменил(а) комментарий');
    expect(e.detail?.diff).toEqual({ before: 'было так', after: 'стало так', diffable: true });
    expect(e.detail?.added?.map((x) => x.label)).toEqual(['b.png']);
    expect(e.detail?.removed?.map((x) => x.label)).toEqual(['a.png']);
    expect(text(act('comment_delete', { message_id: 'm1', author_id: 'boris', text: 'спам' }, null, { actorId: 'anna' }))).toBe('удалил(а) комментарий (автор — Борис)');
    const own = describe(act('comment_delete', { message_id: 'm1', author_id: 'anna', text: 'опечатка' }, null), ctx, NOW);
    expect(own.text).toBe('удалил(а) свой комментарий');
    expect(own.detail?.quote?.text).toBe('опечатка');
  });

  it('checklist, milestones, git stay text, with values', () => {
    expect(text(act('checklist', null, { action: 'item_done', text: 'Windows 11', title: 'Проверка' }))).toBe('отметил(а) «Windows 11»');
    expect(text(act('milestones', null, { action: 'linked', task_milestone_id: 'tm', parent_id: 'p' }))).toBe('подзадача привязана к вехе «Бета»');
    expect(text(act('git', null, { kind: 'pr', repo: 'calaba', ref: '12', state: 'merged' }))).toBe('PR calaba#12 смержен');
  });

  it('clips long quotes to one line', () => {
    expect(clip('a\n b', 60)).toBe('a b');
    expect(clip('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

group('history: the list', () => {
  it('merges pages with live rows, drops merged ones, newest first', () => {
    const a = act('status', null, null, { id: '01', at: 1000 });
    const b = act('title', null, null, { id: '02', at: 2000 });
    const c = act('labels', null, null, { id: '03', at: 2000 });
    const b2 = act('title', { title: 'x' }, null, { id: '02', at: 2000 });
    expect(mergeHistory([b, a], [c, b2], ['01']).map((x) => x.id)).toEqual(['03', '02']);
    expect(mergeHistory([b, a], [c, b2], ['01'])[1]).toBe(b2);
    expect(mergeHistory([], undefined, undefined)).toEqual([]);
  });

  it('groups by local day', () => {
    const day = (d: number, h: number): number => new Date(2026, 0, d, h).getTime();
    const g = groupByDay([day(15, 10), day(15, 9), day(14, 23), day(13, 8)], (x) => x);
    expect(g.map((x) => [x.day, x.items.length])).toEqual([
      ['2026-01-15', 2],
      ['2026-01-14', 1],
      ['2026-01-13', 1],
    ]);
  });

  it('a page without only=journal support: comments dropped, the cursor past them', () => {
    const a = act('status', null, null, { id: '05' });
    const p = historyPage(
      [
        { item: { case: 'activity', value: a } },
        { item: { case: 'message', value: { id: '04' } } },
      ] as never,
      true,
    );
    expect(p.items).toEqual([a]);
    expect(p.cursor).toBe('04');
    expect(p.hasMore).toBe(true);
  });
});
