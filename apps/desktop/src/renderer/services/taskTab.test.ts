import type { Task } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTaskAnywhere = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => ({ on: false }));
vi.mock('./boards', () => ({ openTaskAnywhere, openBoard: vi.fn() }));
vi.mock('../lib/mobile', () => ({ isMobileNow: () => mobile.on }));
vi.mock('./boardsApi', () => ({ boardsApi: {} }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

import { useBoardsUi } from '../stores/boardsUi';
import { useTaskTabs } from '../stores/taskTabs';
import { openFoundTask } from './taskSearch';
import { openTaskOrTab, wantsTab } from './taskTab';

const task = { id: 't1', workspaceId: 'w', boardId: 'b', key: 'K-1', title: 'One' } as unknown as Task;
const plain = { metaKey: false, ctrlKey: false };

describe('openTaskOrTab', () => {
  beforeEach(() => {
    openTaskAnywhere.mockClear();
    mobile.on = false;
    useTaskTabs.setState({ tabs: [], cur: null });
    useBoardsUi.setState({ taskId: null });
  });

  it('wantsTab: meta or ctrl, not on the phone', () => {
    expect(wantsTab({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(wantsTab({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(wantsTab(plain)).toBe(false);
    expect(wantsTab(undefined)).toBe(false);
    mobile.on = true;
    expect(wantsTab({ metaKey: true, ctrlKey: false })).toBe(false);
  });

  it('meta / ctrl: a pinned background tab, nothing opened in place', () => {
    expect(openTaskOrTab(task, { metaKey: true, ctrlKey: false })).toBe(true);
    expect(openTaskOrTab({ ...task, id: 't2' }, { metaKey: false, ctrlKey: true })).toBe(true);
    expect(openTaskAnywhere).not.toHaveBeenCalled();
    expect(useTaskTabs.getState().tabs.map((x) => [x.id, x.pinned])).toEqual([['t1', true], ['t2', true]]);
  });

  it('plain click or no event: opens in place, no tab (#137)', () => {
    expect(openTaskOrTab(task, plain)).toBe(false);
    expect(openTaskOrTab(task)).toBe(false);
    expect(openTaskAnywhere).toHaveBeenCalledTimes(2);
    expect(useTaskTabs.getState().tabs).toEqual([]);
  });

  it('phone: meta is ignored', () => {
    mobile.on = true;
    expect(openTaskOrTab(task, { metaKey: true, ctrlKey: false })).toBe(false);
    expect(openTaskAnywhere).toHaveBeenCalledTimes(1);
    expect(useTaskTabs.getState().tabs).toEqual([]);
  });

  it('a ⌘-click on a search result adds a pinned tab and leaves the open task alone', () => {
    expect(openFoundTask(task, 'query', { metaKey: true, ctrlKey: false })).toBe(true);
    expect(openTaskAnywhere).not.toHaveBeenCalled();
    expect(useBoardsUi.getState().taskId).toBeNull();
    expect(useTaskTabs.getState().tabs).toMatchObject([{ id: 't1', pinned: true }]);
    expect(openFoundTask(task, '', plain)).toBe(false);
    expect(openTaskAnywhere).toHaveBeenCalledTimes(1);
  });
});
