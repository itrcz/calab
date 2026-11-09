import { PermissionTargetType, type OverrideEntry } from '@calaba/protocol';

/**
 * The levels of a tree item's «Доступ» row (TreeAccess) and their override bits: the section's
 * VIEW / WRITE pair, and MANAGE when the section has «Управление» for people (the Disk, ADR-0161;
 * not roles, not guests).
 */
export type Level = 'view' | 'edit' | 'manage' | 'deny';
export interface Draft {
  targetType: PermissionTargetType;
  targetId: string;
  level: Level;
}
export interface TreeBits {
  VIEW: bigint;
  WRITE: bigint;
  /** Set: a person's row may be «Управление» = VIEW | WRITE | MANAGE (ADR-0161). */
  MANAGE?: bigint;
}

/**
 * An override as one of the levels: «Управление» = VIEW | WRITE | MANAGE, «Правка» = VIEW | WRITE,
 * «Просмотр» = VIEW (WRITE denied), «Нет доступа» = all denied. With MANAGE a person's lower levels
 * deny it, so a row below an inherited «Управление» narrows it.
 */
export function levelOf(e: Pick<OverrideEntry, 'allow' | 'deny'>, b: TreeBits): Level {
  if (b.MANAGE && (e.allow & b.MANAGE) !== 0n) return 'manage';
  if ((e.allow & b.WRITE) !== 0n) return 'edit';
  if ((e.allow & b.VIEW) !== 0n) return 'view';
  if ((e.deny & b.VIEW) !== 0n) return 'deny';
  return 'view';
}

export function entryOf(
  d: Draft,
  b: TreeBits,
): {
  targetType: PermissionTargetType;
  targetId: string;
  allow: bigint;
  deny: bigint;
} {
  const vw = b.VIEW | b.WRITE;
  // «Управление» only for a person; a role's row never carries MANAGE (the server rejects it).
  const m = b.MANAGE && d.targetType === PermissionTargetType.USER ? b.MANAGE : 0n;
  const bits =
    d.level === 'manage' && m
      ? { allow: vw | m, deny: 0n }
      : d.level === 'edit' || d.level === 'manage'
        ? { allow: vw, deny: m }
        : d.level === 'view'
          ? { allow: b.VIEW, deny: b.WRITE | m }
          : { allow: 0n, deny: vw | m };
  return { targetType: d.targetType, targetId: d.targetId, ...bits };
}
