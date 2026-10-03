import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { AchievementSchema, ListAchievementsResponseSchema, MemberAchievementSchema, MessageKind, MessageSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { cachedAchievement, catalogKey, findAchievement } from './achievementCache';
import { queryClient } from './queryClient';
import { achievementCardOf, achievementForMe, grantable, gridStep, movePositions, noteValid, stackGrants, thumbsRow, NOTE_MAX, POSITION_STEP } from './achievements';

const card = { achievementId: 'a1', grantId: 'g1', note: 'за релиз 2.0', grantedBy: 'u-boss' };
const msg = (over: { kind?: MessageKind; system?: { payload: { case: 'birthday'; value: { day: number; month: number } } }; forward?: { authorId: string } } = {}) =>
  create(MessageSchema, { authorId: 'u-me', kind: MessageKind.SYSTEM, system: { payload: { case: 'achievement', value: card } }, ...over });

describe('achievementCardOf', () => {
  it('reads system.achievement of a system message', () => {
    expect(achievementCardOf(msg())).toMatchObject(card);
  });
  it('ignores other payloads and plain messages', () => {
    expect(achievementCardOf(create(MessageSchema, { content: 'hi' }))).toBeNull();
    expect(achievementCardOf(msg({ system: { payload: { case: 'birthday', value: { day: 3, month: 10 } } } }))).toBeNull();
    // A user message cannot carry a card.
    expect(achievementCardOf(msg({ kind: MessageKind.UNSPECIFIED }))).toBeNull();
  });
});

describe('achievementForMe', () => {
  it('only my own card, never a forwarded copy', () => {
    expect(achievementForMe(msg(), 'u-me')).toBe(true);
    expect(achievementForMe(msg(), 'u-other')).toBe(false);
    expect(achievementForMe(msg({ forward: { authorId: 'u-me' } }), 'u-me')).toBe(false);
    expect(achievementForMe({ authorId: 'u-me' }, 'u-me')).toBe(false);
  });
});

describe('noteValid', () => {
  it('1..120 characters after trimming', () => {
    expect(noteValid('')).toBe(false);
    expect(noteValid('   ')).toBe(false);
    expect(noteValid('ok')).toBe(true);
    expect(noteValid('x'.repeat(NOTE_MAX))).toBe(true);
    expect(noteValid(` ${'x'.repeat(NOTE_MAX)} `)).toBe(true);
    expect(noteValid('x'.repeat(NOTE_MAX + 1))).toBe(false);
  });
});

describe('stackGrants', () => {
  const g = (id: string, achievementId: string, at: number) => create(MemberAchievementSchema, { id, achievementId, note: id, grantedAt: timestampFromMs(at) });
  it('groups repeats, newest grant first, stacks by their newest grant', () => {
    const s = stackGrants([g('g4', 'b', 40), g('g3', 'a', 30), g('g2', 'b', 20), g('g1', 'c', 10)]);
    expect(s.map((x) => x.achievementId)).toEqual(['b', 'a', 'c']);
    expect(s[0]?.grants.map((x) => x.id)).toEqual(['g4', 'g2']);
  });
});

describe('grantable', () => {
  const a = (id: string, title: string, position: number, archived = false) =>
    create(AchievementSchema, { id, title, position, workspaceId: 'w1', ...(archived ? { archivedAt: timestampFromMs(1) } : {}) });
  it('live ones by position, filtered by title (any case)', () => {
    const cat = [a('2', 'Больше года', 2), a('1', 'Премия', 1), a('3', 'Старое', 0, true)];
    expect(grantable(cat).map((x) => x.id)).toEqual(['1', '2']);
    expect(grantable(cat, 'БОЛЬШЕ').map((x) => x.id)).toEqual(['2']);
    expect(grantable(cat, 'стар')).toEqual([]);
  });
});

describe('thumbsRow', () => {
  it('up to 6, the rest as +N', () => {
    expect(thumbsRow([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(thumbsRow([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ shown: [1, 2, 3, 4, 5, 6], more: 2 });
  });
});

describe('gridStep', () => {
  it('arrows move within the grid and stop at its edges', () => {
    expect(gridStep(-1, 'ArrowRight', 7, 4)).toBe(0);
    expect(gridStep(0, 'ArrowRight', 7, 4)).toBe(1);
    expect(gridStep(0, 'ArrowLeft', 7, 4)).toBe(0);
    expect(gridStep(1, 'ArrowDown', 7, 4)).toBe(5);
    expect(gridStep(5, 'ArrowDown', 7, 4)).toBe(5);
    expect(gridStep(5, 'ArrowUp', 7, 4)).toBe(1);
    expect(gridStep(0, 'ArrowUp', 0, 4)).toBe(-1);
  });
});

describe('movePositions', () => {
  const L = (...ps: number[]) => ps.map((position, i) => ({ id: String.fromCharCode(97 + i), position }));
  it('takes a free position between the new neighbours', () => {
    expect(movePositions(L(1024, 2048, 3072), 2, 0)).toEqual([{ id: 'c', position: 0 }]);
    expect(movePositions(L(1024, 2048, 3072), 0, 2)).toEqual([{ id: 'a', position: 3072 + POSITION_STEP }]);
    expect(movePositions(L(1024, 2048, 3072), 0, 1)).toEqual([{ id: 'a', position: 2560 }]);
  });
  it('renumbers when there is no gap', () => {
    expect(movePositions(L(0, 1, 2), 2, 1)).toEqual([
      { id: 'a', position: POSITION_STEP },
      { id: 'c', position: 2 * POSITION_STEP },
      { id: 'b', position: 3 * POSITION_STEP },
    ]);
  });
  it('nothing to do for the same place', () => {
    expect(movePositions(L(1, 2), 1, 1)).toEqual([]);
  });
});

describe('per-workspace catalog cache (ADR-0061 amendment 1)', () => {
  const list = (ws: string, ...ids: string[]) =>
    create(ListAchievementsResponseSchema, { achievements: ids.map((id) => create(AchievementSchema, { id, title: `${ws}:${id}`, workspaceId: ws, fileId: `f-${id}` })) });
  const entries = [
    [catalogKey('w1'), list('w1', 'a1', 'a2')],
    [catalogKey('w2'), list('w2', 'b1')],
    [catalogKey('w3'), undefined],
  ] as const;

  it('finds an id in any cached catalog without a workspace', () => {
    expect(findAchievement(entries, 'b1')?.title).toBe('w2:b1');
    expect(findAchievement(entries, 'a2')?.workspaceId).toBe('w1');
    expect(findAchievement(entries, 'zz')).toBeUndefined();
    expect(findAchievement(entries, '')).toBeUndefined();
  });

  it('with a workspace, looks only in its catalog', () => {
    expect(findAchievement(entries, 'a1', 'w1')?.title).toBe('w1:a1');
    expect(findAchievement(entries, 'b1', 'w1')).toBeUndefined();
    expect(findAchievement(entries, 'a1', 'w3')).toBeUndefined();
  });

  it('cachedAchievement reads the react-query cache by key prefix', () => {
    queryClient.setQueryData(catalogKey('w1'), list('w1', 'a1'));
    queryClient.setQueryData(catalogKey('w2'), list('w2', 'b1'));
    expect(cachedAchievement('b1')?.title).toBe('w2:b1');
    expect(cachedAchievement('b1', 'w2')?.fileId).toBe('f-b1');
    expect(cachedAchievement('b1', 'w1')).toBeUndefined();
    queryClient.clear();
  });
});
