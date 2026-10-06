import { create } from '@bufbuild/protobuf';
import { UserSchema, WorkspaceMemberSchema, WorkspaceRole, WorkspaceSchema, WorkspaceSnapshotSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { keepContacts, useWorkspaces } from '../../stores/workspaces';
import { contactsVisible, telHref } from './contacts';

type U = { id: string; email?: string; phone?: string; emailVerified?: boolean; isBot?: boolean; isGuest?: boolean };
const user = (u: U) => create(UserSchema, { displayName: u.id, ...u });
const member = (ws: string, role: WorkspaceRole, u: U) => create(WorkspaceMemberSchema, { workspaceId: ws, role, user: user(u) });
const snap = (ws: string, myRole: WorkspaceRole, members: ReturnType<typeof member>[]) =>
  create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: ws, name: ws }), role: myRole, members });

const ANNA = { id: 'anna', email: 'anna@example.com', emailVerified: true, phone: '+7 999 123-45-67' };

beforeEach(() => useWorkspaces.getState().reset());

describe('who sees contacts (ADR-0077, as pbconv.ContactsVisible)', () => {
  const visible = (id: string): boolean => contactsVisible(useWorkspaces.getState().byId, 'me', id);

  it('a colleague: both members of a workspace, neither a guest', () => {
    useWorkspaces.getState().applySnapshot(snap('w1', WorkspaceRole.MEMBER, [member('w1', WorkspaceRole.MEMBER, { id: 'me' }), member('w1', WorkspaceRole.ADMIN, ANNA)]));
    expect(visible('anna')).toBe(true);
    expect(visible('me')).toBe(true); // my own
  });

  it('not when I am a guest there, nor when they are; not bots; not strangers', () => {
    const st = useWorkspaces.getState();
    st.applySnapshot(snap('g', WorkspaceRole.GUEST, [member('g', WorkspaceRole.GUEST, { id: 'me' }), member('g', WorkspaceRole.MEMBER, ANNA)]));
    expect(visible('anna')).toBe(false);
    st.applySnapshot(
      snap('w1', WorkspaceRole.MEMBER, [
        member('w1', WorkspaceRole.MEMBER, { id: 'me' }),
        member('w1', WorkspaceRole.GUEST, { id: 'guest', email: 'g@example.com' }),
        member('w1', WorkspaceRole.MEMBER, { id: 'bot', isBot: true }),
      ]),
    );
    expect(visible('guest')).toBe(false);
    expect(visible('bot')).toBe(false);
    expect(visible('stranger')).toBe(false);
    expect(visible('anna')).toBe(false); // only in the workspace where I am a guest
  });

  it('a guest here who is a colleague in another workspace: visible', () => {
    const st = useWorkspaces.getState();
    st.applySnapshot(snap('g', WorkspaceRole.GUEST, [member('g', WorkspaceRole.GUEST, { id: 'me' }), member('g', WorkspaceRole.MEMBER, ANNA)]));
    st.applySnapshot(snap('w2', WorkspaceRole.MEMBER, [member('w2', WorkspaceRole.MEMBER, { id: 'me' }), member('w2', WorkspaceRole.MEMBER, ANNA)]));
    expect(visible('anna')).toBe(true);
    // Leaving the shared workspace hides them again, though the store still has them.
    st.remove('w2');
    expect(visible('anna')).toBe(false);
    expect(useWorkspaces.getState().users['anna']?.email).toBe(ANNA.email);
  });
});

describe('contacts in the store (keepContacts)', () => {
  it('a copy without email keeps the known contacts, whatever the order', () => {
    const st = useWorkspaces.getState();
    // The shared workspace (with contacts) first, then the one where I am a guest (without).
    st.applySnapshot(snap('w2', WorkspaceRole.MEMBER, [member('w2', WorkspaceRole.MEMBER, { id: 'me' }), member('w2', WorkspaceRole.MEMBER, ANNA)]));
    st.applySnapshot(snap('g', WorkspaceRole.GUEST, [member('g', WorkspaceRole.GUEST, { id: 'me' }), member('g', WorkspaceRole.MEMBER, { id: 'anna' })]));
    const s = useWorkspaces.getState();
    expect(s.users['anna']?.phone).toBe(ANNA.phone);
    expect(s.byId['g']?.members['anna']?.user?.email).toBe(ANNA.email);
    // A stripped USER_UPDATE (name change seen through the guest workspace) keeps them.
    st.upsertUser(user({ id: 'anna' }));
    expect(useWorkspaces.getState().users['anna']?.email).toBe(ANNA.email);
    // A full one replaces them: the phone cleared.
    st.upsertUser(user({ ...ANNA, phone: '' }));
    expect(useWorkspaces.getState().users['anna']?.phone).toBe('');
    expect(useWorkspaces.getState().byId['w2']?.members['anna']?.user?.phone).toBe('');
  });

  it('keepContacts returns the same object when there is nothing to keep', () => {
    const next = user({ id: 'x' });
    expect(keepContacts(undefined, next)).toBe(next);
    expect(keepContacts(user({ id: 'x' }), next)).toBe(next);
    const full = user(ANNA);
    expect(keepContacts(user({ id: 'anna' }), full)).toBe(full);
  });
});

describe('telHref', () => {
  it('keeps digits and the plus', () => {
    expect(telHref('+7 (999) 123-45-67')).toBe('tel:+79991234567');
  });
});
