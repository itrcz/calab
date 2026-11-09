import { WorkspaceRole } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/workspaces', () => ({ useWorkspaces: () => undefined }));
import { RoleMark, hasRoleMark, nameMarkKind, roleTextClass, roleTextStyle } from './MemberBits';

const mark = (role: WorkspaceRole, extra: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(RoleMark, { role, ...extra }));

describe('RoleMark (docs/09 #26)', () => {
  it('owner: a crown in the owner colour, tooltip «Владелец»', () => {
    const html = mark(WorkspaceRole.OWNER);
    expect(html).toContain('data-role-mark="owner"');
    expect(html).toContain('lucide-crown');
    expect(html).toContain('title="Владелец"');
    expect(html).toContain('aria-label="Владелец"');
    expect(html).toContain('text-role-owner');
  });

  it('admin: a 14 px shield in the admin colour, tooltip «Администратор»', () => {
    const html = mark(WorkspaceRole.ADMIN);
    expect(html).toContain('data-role-mark="admin"');
    expect(html).toContain('lucide-shield');
    expect(html).toContain('size-3.5');
    expect(html).toContain('title="Администратор"');
    expect(html).toContain('text-role-admin');
  });

  it('members and guests carry no mark', () => {
    expect(mark(WorkspaceRole.MEMBER)).toBe('');
    expect(mark(WorkspaceRole.GUEST)).toBe('');
    expect(mark(WorkspaceRole.UNSPECIFIED)).toBe('');
    expect(hasRoleMark(undefined)).toBe(false);
  });

  it('tones: muted (offline), inherit (selected row), a custom label', () => {
    expect(mark(WorkspaceRole.OWNER, { tone: 'muted' })).toContain('text-muted');
    const inherit = mark(WorkspaceRole.ADMIN, { tone: 'inherit' });
    expect(inherit).not.toContain('text-role-admin');
    expect(mark(WorkspaceRole.OWNER, { label: 'Владелец · Команда' })).toContain('title="Владелец · Команда"');
  });

  it('custom role (ADR-0026): a colour dot with the role name, the name in its colour; owner / admin keep theirs', () => {
    const custom = { name: 'Дизайн', color: 0x0a84ff };
    const html = mark(WorkspaceRole.MEMBER, { custom });
    expect(html).toContain('data-role-mark="custom"');
    expect(html).toContain('title="Дизайн"');
    expect(html).toContain('background:#0a84ff');
    expect(mark(WorkspaceRole.ADMIN, { custom })).toContain('data-role-mark="admin"');
    expect(roleTextClass(WorkspaceRole.MEMBER, 'role', custom)).toBe('role-tint');
    expect(Object.keys(roleTextStyle(WorkspaceRole.MEMBER, 'role', custom) ?? {}).sort()).toEqual(['--rc-d', '--rc-l']);
    expect(roleTextStyle(WorkspaceRole.MEMBER, 'role', custom)).toBe(roleTextStyle(WorkspaceRole.MEMBER, 'role', custom));
    expect(roleTextStyle(WorkspaceRole.MEMBER, 'inherit', custom)).toBeUndefined();
    expect(roleTextStyle(WorkspaceRole.OWNER, 'role', custom)).toBeUndefined();
    expect(roleTextStyle(WorkspaceRole.MEMBER, 'role')).toBeUndefined();
  });

  it('name colour per role', () => {
    expect(roleTextClass(WorkspaceRole.OWNER)).toBe('text-role-owner');
    expect(roleTextClass(WorkspaceRole.ADMIN)).toBe('text-role-admin');
    expect(roleTextClass(WorkspaceRole.MEMBER)).toBe('text-fg');
    expect(roleTextClass(WorkspaceRole.GUEST)).toBe('text-fg');
    expect(roleTextClass(WorkspaceRole.OWNER, 'muted')).toBe('text-muted');
    expect(roleTextClass(WorkspaceRole.OWNER, 'inherit')).toBe('');
  });
});

describe('nameMarkKind (docs/09 #129: the badge replaces the role mark)', () => {
  const custom = { name: 'Дизайн', color: 0x3a86ff };
  it('a badge wins over any role mark', () => {
    expect(nameMarkKind(true, WorkspaceRole.OWNER)).toBe('badge');
    expect(nameMarkKind(true, WorkspaceRole.ADMIN)).toBe('badge');
    expect(nameMarkKind(true, WorkspaceRole.MEMBER, custom)).toBe('badge');
    expect(nameMarkKind(true, WorkspaceRole.MEMBER)).toBe('badge');
  });
  it('no badge: the role mark for owner / admin / a custom role, nothing otherwise', () => {
    expect(nameMarkKind(false, WorkspaceRole.OWNER)).toBe('role');
    expect(nameMarkKind(false, WorkspaceRole.ADMIN)).toBe('role');
    expect(nameMarkKind(false, WorkspaceRole.MEMBER, custom)).toBe('role');
    expect(nameMarkKind(false, WorkspaceRole.MEMBER)).toBeNull();
    expect(nameMarkKind(false, WorkspaceRole.GUEST)).toBeNull();
    expect(nameMarkKind(false, undefined)).toBeNull();
  });
});
