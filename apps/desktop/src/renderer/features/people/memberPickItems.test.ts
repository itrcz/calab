import { create } from '@bufbuild/protobuf';
import { UserSchema, WorkspaceMemberSchema, WorkspaceRole, type WorkspaceMember } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { buildRows, filterItems } from '../../components/picker/pickerModel';
import { memberItems, splitGuests, userItems } from './memberPickItems';

const m = (id: string, name: string, role: WorkspaceRole, nickname = ''): WorkspaceMember =>
  create(WorkspaceMemberSchema, { workspaceId: 'w', role, nickname, user: create(UserSchema, { id, displayName: name }) });

// The mock fixture's main workspace (e2e-support/fixtures.ts): owner, admin, two members, a guest.
const team = [
  m('dina', 'Дина', WorkspaceRole.GUEST),
  m('vera', 'Вера', WorkspaceRole.MEMBER),
  m('boris', 'Борис', WorkspaceRole.ADMIN),
  m('grigory', 'Григорий', WorkspaceRole.MEMBER, 'Гриша'),
  m('anna', 'Анна', WorkspaceRole.OWNER),
];

describe('memberItems', () => {
  it('finds by phone, email, username and extension; the matched contact becomes the hint (CBF-175)', () => {
    const ivan = create(WorkspaceMemberSchema, {
      workspaceId: 'w',
      role: WorkspaceRole.MEMBER,
      extension: '204',
      user: create(UserSchema, { id: 'ivan', displayName: 'Иван Фёдоров', username: 'ivanf', email: 'if@calab.io', phone: '+7 (916) 555-01-02' }),
    });
    const items = memberItems([ivan, ...team]);
    expect(filterItems(items, '8 916 555').map((i) => i.userId)).toEqual(['ivan']);
    expect(filterItems(items, '8 916 555')[0]?.matchedBy).toBe('+7 (916) 555-01-02');
    expect(filterItems(items, 'if@calab')[0]?.matchedBy).toBe('if@calab.io');
    expect(filterItems(items, '204')[0]?.matchedBy).toBe('204');
    expect(filterItems(items, 'ivanf')[0]?.matchedBy).toBeUndefined();
    expect(filterItems(items, 'федоров иван').map((i) => i.userId)).toEqual(['ivan']);
    // No contact sent to this viewer: nothing to find (the server decides, ADR-0077).
    expect(filterItems(memberItems(team), '555')).toEqual([]);
  });

  it('lists every member — owner and admins too (docs/09 #33) — owner → admins → members → guests', () => {
    expect(memberItems(team).map((i) => i.userId)).toEqual(['anna', 'boris', 'vera', 'grigory', 'dina']);
  });

  it('marks owner and admins as full access (not choosable) via decorate', () => {
    const items = memberItems(team, {
      decorate: (x) => (x.role === WorkspaceRole.OWNER || x.role === WorkspaceRole.ADMIN ? { note: 'полный доступ', disabled: true } : undefined),
    });
    expect(items.filter((i) => i.disabled).map((i) => i.userId)).toEqual(['anna', 'boris']);
    expect(items[0]?.note).toBe('полный доступ');
    expect(items.find((i) => i.userId === 'dina')?.guest).toBe(true);
  });

  it('shows the nickname with the profile name muted and finds by either, or by email', () => {
    const items = memberItems(team, { emails: { vera: 'vera@calab.io' } });
    const gr = items.find((i) => i.userId === 'grigory');
    expect(gr).toMatchObject({ name: 'Гриша', secondary: 'Григорий' });
    expect(filterItems(items, 'григ').map((i) => i.userId)).toEqual(['grigory']);
    expect(filterItems(items, 'ГРИША').map((i) => i.userId)).toEqual(['grigory']);
    expect(filterItems(items, 'vera@').map((i) => i.userId)).toEqual(['vera']);
    expect(items.find((i) => i.userId === 'vera')?.secondary).toBe('vera@calab.io');
  });

  it('leaves out excluded ids', () => {
    expect(memberItems(team, { exclude: new Set(['anna']) }).map((i) => i.userId)).not.toContain('anna');
  });
});

describe('userItems', () => {
  it('maps server candidates with the shared role', () => {
    const users = [create(UserSchema, { id: 'boris', displayName: 'Борис' })];
    expect(userItems(users, () => WorkspaceRole.ADMIN)[0]).toMatchObject({ userId: 'boris', role: WorkspaceRole.ADMIN, guest: false });
  });
});

describe('splitGuests', () => {
  it('moves guest accounts out of the member list, keeping order', () => {
    const { members, guests } = splitGuests(memberItems(team));
    expect(members.map((i) => i.userId)).toEqual(['anna', 'boris', 'vera', 'grigory']);
    expect(guests.map((i) => i.userId)).toEqual(['dina']);
  });

  it('no guests: everything stays in the main list', () => {
    const { members, guests } = splitGuests(memberItems(team.filter((x) => x.role !== WorkspaceRole.GUEST)));
    expect(members).toHaveLength(4);
    expect(guests).toEqual([]);
  });

  it('a search still finds a guest, and a collapsible group shows its items then', () => {
    const { guests } = splitGuests(memberItems(team));
    const groups = [{ id: 'guests', label: 'G', items: guests, collapsible: true }];
    expect(buildRows(groups, '', { alwaysHeaders: true }).map((r) => r.kind)).toEqual(['header']);
    expect(buildRows(groups, '', { alwaysHeaders: true, open: new Set(['guests']) }).map((r) => r.kind)).toEqual(['header', 'item']);
    expect(buildRows(groups, 'дин', { alwaysHeaders: true }).map((r) => r.kind)).toEqual(['header', 'item']);
  });
});
