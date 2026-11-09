import { DISK_BITS, PermissionTargetType, WIKI_BITS } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { entryOf, levelOf, type Draft, type Level } from './treeAccessLevels';

const DISK = { VIEW: DISK_BITS.VIEW, WRITE: DISK_BITS.WRITE, MANAGE: DISK_BITS.MANAGE };
const WIKI = { VIEW: WIKI_BITS.VIEW, WRITE: WIKI_BITS.WRITE };
const V = DISK_BITS.VIEW;
const W = DISK_BITS.WRITE;
const M = DISK_BITS.MANAGE;
const user = (level: Level): Draft => ({ targetType: PermissionTargetType.USER, targetId: 'u1', level });
const role = (level: Level): Draft => ({ targetType: PermissionTargetType.ROLE, targetId: 'r1', level });

describe('tree access levels (ADR-0161 «Управление»)', () => {
  it('a person: the four levels as bits, MANAGE denied below «Управление»', () => {
    expect(entryOf(user('manage'), DISK)).toMatchObject({ allow: V | W | M, deny: 0n });
    expect(entryOf(user('edit'), DISK)).toMatchObject({ allow: V | W, deny: M });
    expect(entryOf(user('view'), DISK)).toMatchObject({ allow: V, deny: W | M });
    expect(entryOf(user('deny'), DISK)).toMatchObject({ allow: 0n, deny: V | W | M });
  });

  it('a role never carries MANAGE: «Управление» falls back to «Правка»', () => {
    expect(entryOf(role('manage'), DISK)).toMatchObject({ allow: V | W, deny: 0n });
    expect(entryOf(role('view'), DISK)).toMatchObject({ allow: V, deny: W });
  });

  it('a section without MANAGE keeps the two-bit rows', () => {
    const wv = WIKI_BITS.VIEW;
    const ww = WIKI_BITS.WRITE;
    expect(entryOf(user('edit'), WIKI)).toMatchObject({ allow: wv | ww, deny: 0n });
    expect(entryOf(user('manage'), WIKI)).toMatchObject({ allow: wv | ww, deny: 0n });
    expect(levelOf({ allow: wv | ww | WIKI_BITS.MANAGE, deny: 0n }, WIKI)).toBe('edit');
  });

  it('round-trips through levelOf, old rows included', () => {
    for (const l of ['manage', 'edit', 'view', 'deny'] as const) expect(levelOf(entryOf(user(l), DISK), DISK)).toBe(l);
    expect(levelOf({ allow: V | W, deny: 0n }, DISK)).toBe('edit');
    expect(levelOf({ allow: V, deny: W }, DISK)).toBe('view');
    expect(levelOf({ allow: 0n, deny: V | W }, DISK)).toBe('deny');
  });
});
