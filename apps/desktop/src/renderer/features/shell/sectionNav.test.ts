import { WorkspaceRole } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardsUi } from '../../stores/boardsUi';
import { HOME } from '../../stores/dms';
import { useSections } from '../../stores/sections';
import { useUi } from '../../stores/ui';
import { useWebApps } from '../../stores/webApps';
import { useWorkspaces } from '../../stores/workspaces';
import { openSection, openWorkspace } from './sectionNav';

/** The memory is written once per synchronous batch (a microtask). */
const settle = (): Promise<void> => Promise.resolve();

const entry = (id: string, role = WorkspaceRole.MEMBER) => ({ ws: { id, name: id.toUpperCase() }, role }) as never;

describe('desktop sections (ADR-0074)', () => {
  beforeEach(async () => {
    useBoardsUi.setState({ active: false });
    useWebApps.setState({ open: null });
    useWorkspaces.setState({ order: ['a', 'b', 'g'], byId: { a: entry('a'), b: entry('b'), g: entry('g', WorkspaceRole.GUEST) } });
    useUi.setState({ activeWorkspaceId: 'a', calDay: null, calEvent: null, miniCal: false, lastRoom: { a: 'r1', b: 'r2' } });
    await settle();
    useSections.setState({ of: {}, lastWs: 'a' });
  });

  it('switches sections inside the open workspace', () => {
    openSection('boards');
    expect(useBoardsUi.getState().active).toBe(true);
    openSection('calendar');
    expect(useBoardsUi.getState().active).toBe(false);
    expect(useUi.getState().calDay).not.toBeNull();
    openSection('chats');
    expect(useUi.getState().calDay).toBeNull();
    expect(useUi.getState().activeWorkspaceId).toBe('a');
  });

  it('remembers the section per workspace and restores it on a switch', async () => {
    openSection('boards');
    await settle();
    openWorkspace('b');
    await settle();
    expect(useBoardsUi.getState().active).toBe(false);
    expect(useSections.getState().of).toEqual({ a: 'boards', b: 'chats' });
    openSection('calendar');
    await settle();
    openWorkspace('a');
    await settle();
    expect(useUi.getState().activeWorkspaceId).toBe('a');
    expect(useBoardsUi.getState().active).toBe(true);
    openWorkspace('b');
    expect(useUi.getState().calDay).not.toBeNull();
  });

  it('«Личные» is HOME; the workspace sections return to the last workspace used', async () => {
    openWorkspace('b');
    await settle();
    openSection('dms');
    expect(useUi.getState().activeWorkspaceId).toBe(HOME);
    await settle();
    expect(useSections.getState().lastWs).toBe('b');
    openSection('boards');
    expect(useUi.getState().activeWorkspaceId).toBe('b');
    expect(useBoardsUi.getState().active).toBe(true);
  });

  it('a guest workspace opens on its rooms only', () => {
    useSections.setState({ of: { g: 'boards' } });
    useBoardsUi.setState({ active: true });
    openWorkspace('g');
    expect(useBoardsUi.getState().active).toBe(false);
    openSection('calendar');
    expect(useUi.getState().calDay).toBeNull();
  });

  it('a section click closes an open web app of the same workspace', () => {
    useWebApps.setState({ open: 'app1' });
    openSection('chats');
    expect(useWebApps.getState().open).toBeNull();
  });

  it('a navigation that flips several flags remembers only where it ends', async () => {
    openSection('boards');
    await settle();
    // openRoom turns the boards off before it switches the workspace: «a» keeps «Доски».
    useUi.getState().openRoom('b', 'r2');
    await settle();
    expect(useSections.getState().of).toEqual({ a: 'boards', b: 'chats' });
  });
});
