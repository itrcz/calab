import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_WATCHERS, mayRemoveWatcher, toggleWatcher, watcherControls } from './watchers';

// ADR-0076 §4, §6, §7: who sees the «Наблюдатели» row and what they may do there.
const task = (watcherIds: string[], archived = false) => create(TaskSchema, { id: 't', watcherIds, ...(archived ? { archivedAt: timestampFromMs(1000) } : {}) });

describe('watcherControls', () => {
  it('an editor sees the row and «+ Добавить» even without watchers', () => {
    expect(watcherControls(task([]), true, 'me')).toEqual({ visible: true, add: true, watching: false });
  });
  it('a non-editor sees the row only when there are watchers, never «+ Добавить»', () => {
    expect(watcherControls(task([]), false, 'me').visible).toBe(false);
    expect(watcherControls(task(['u1']), false, 'me')).toEqual({ visible: true, add: false, watching: false });
  });
  it('a watcher (a task-scoped viewer: no edit) may stop watching', () => {
    expect(watcherControls(task(['me']), false, 'me').watching).toBe(true);
    expect(mayRemoveWatcher(task(['me']), false, 'me', 'me')).toBe(true);
    expect(mayRemoveWatcher(task(['me', 'u1']), false, 'me', 'u1')).toBe(false);
  });
  it('an editor removes anyone', () => {
    expect(mayRemoveWatcher(task(['u1']), true, 'me', 'u1')).toBe(true);
  });
  it('an archived task: read-only', () => {
    const c = watcherControls(task(['me'], true), false, 'me');
    expect(c).toEqual({ visible: true, add: false, watching: false });
    expect(mayRemoveWatcher(task(['me'], true), true, 'me', 'me')).toBe(false);
  });
  it('the cap hides «+ Добавить»', () => {
    const full = Array.from({ length: MAX_WATCHERS }, (_, i) => `u${i}`);
    expect(watcherControls(task(full), true, 'me').add).toBe(false);
  });
});

describe('toggleWatcher', () => {
  it('adds sorted, removes', () => {
    expect(toggleWatcher(['b', 'd'], 'c')).toEqual(['b', 'c', 'd']);
    expect(toggleWatcher(['b', 'c'], 'b')).toEqual(['c']);
  });
});
